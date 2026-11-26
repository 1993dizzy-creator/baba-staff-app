-- BABA-NOTIFICATION-01A: common in-app notification foundation.
--
-- * Everything lives in the private schema notification_private. Tables have RLS enabled and NO
--   policies, and every privilege is revoked from public/anon/authenticated/service_role. The app
--   (service_role) reaches the data only through the security-definer public.notification_*_v1
--   RPCs. Actor RPCs re-derive role/part from public.users (active + app login enabled);
--   the caller never supplies them.
-- * Business state (notifications.status open/resolved) and per-user read state
--   (recipients.read_at) are separate facts. Reading never resolves; resolving never reads.
-- * One OPEN notification per (type_code, dedupe_key), enforced by a partial unique index and an
--   atomic INSERT .. ON CONFLICT. Re-observing an open event only touches last_observed_at /
--   observation_count / severity / body and never resets read_at. After it is resolved, the same
--   dedupe_key may open a NEW notification (a distinct occurrence).
-- * Recipients are fixed when the event is created (policy revision recorded). Display re-checks,
--   every time, the CURRENT account state, the type's access ceiling (types.access_roles = the
--   business screen's existing permission) and the CURRENT policy. A policy change therefore
--   never back-fills older events to new recipients, and someone who lost access stops seeing
--   older events and their unread count.
-- * Recipient rules (policies.rules):
--     {"groups":[{"roles":[..],"parts":[..]}, ..], "userIds":[..]}
--   Inside one group the attributes are ANDed; groups are ORed; userIds are an extra allow list.
--   "roles" is the staff rank (직급). users.role is the single source of rank and permission
--   (lib/common/roles.ts); the legacy users.position mirror is deliberately not used.
--   An empty/missing attribute list means "any value, NULL included". A non-empty list never
--   matches NULL. A group with every list empty means "every active staff member". Everything is
--   still intersected with types.access_roles, so a rule can never widen business access.
-- * Inactive (is_active=false) or login-disabled (app_login_enabled=false) accounts never receive
--   and never see notifications.
-- * Event ids follow commit order: every first observation takes one transaction-scoped advisory
--   lock before its INSERT, so an uncommitted event can never hold a lower id than a committed one.
--   "Mark all read up to id N" therefore never reaches an event the user could not have seen.
-- * Resolution names the occurrence (notification id + type + key), so a duplicate or delayed
--   resolution of an earlier occurrence can never resolve a recurrence with the same key.
-- * No retention cron, no realtime publication, no push delivery (01-B adds push tables/columns).
-- * Writes no existing table. Does not touch any existing function, role or row.

create schema notification_private;
revoke all on schema notification_private from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

-- Catalog of stable notification type codes. Managed by migrations only (no RPC writes it), so
-- the access ceiling can only change through a reviewed migration.
create table notification_private.types (
  code text primary key constraint types_code_check
    check (code ~ '^[a-z][a-z0-9_]{0,39}(\.[a-z][a-z0-9_]{0,59})+$' and char_length(code) <= 100),
  domain text not null constraint types_domain_check check (domain in
    ('attendance', 'inventory', 'sales', 'pos', 'tables', 'reservations', 'payroll', 'ledger', 'system')),
  -- Roles that may access the related business screen today (business permission ceiling).
  access_roles text[] not null constraint types_access_roles_check check (
    cardinality(access_roles) >= 1
    and access_roles <@ array['owner', 'master', 'manager', 'leader', 'staff']::text[]),
  default_severity text not null default 'normal'
    constraint types_default_severity_check check (default_severity in ('urgent', 'warning', 'normal')),
  created_at timestamptz not null default now(),
  -- Sensitive domains stay owner/master only.
  constraint types_sensitive_domain_ceiling check (
    domain not in ('payroll', 'ledger') or access_roles <@ array['owner', 'master']::text[])
);

-- One receiving policy per type.
create table notification_private.policies (
  type_code text primary key references notification_private.types(code),
  enabled boolean not null default false,
  in_app_enabled boolean not null default true,
  rules jsonb not null default '{"groups":[],"userIds":[]}'::jsonb,
  revision integer not null default 1 constraint policies_revision_check check (revision >= 1),
  updated_by bigint references public.users(id),
  updated_at timestamptz not null default now()
);

-- Append-only audit of every policy change.
create table notification_private.policy_audit (
  id bigint generated always as identity primary key,
  type_code text not null references notification_private.types(code),
  revision integer not null,
  before_policy jsonb not null,
  after_policy jsonb not null,
  actor_user_id bigint not null references public.users(id),
  changed_at timestamptz not null default now()
);
create index policy_audit_type_idx on notification_private.policy_audit (type_code, id desc);

-- Notification events (one row per business occurrence).
create table notification_private.notifications (
  id bigint generated always as identity primary key,
  type_code text not null references notification_private.types(code),
  domain text not null,
  dedupe_key text not null constraint notifications_dedupe_key_check
    check (dedupe_key ~ '^[A-Za-z0-9:_./-]{1,200}$'),
  severity text not null constraint notifications_severity_check check (severity in ('urgent', 'warning', 'normal')),
  title_ko text not null constraint notifications_title_ko_check check (char_length(btrim(title_ko)) between 1 and 120),
  title_vi text not null constraint notifications_title_vi_check check (char_length(btrim(title_vi)) between 1 and 120),
  body_ko text constraint notifications_body_ko_check check (char_length(body_ko) <= 500),
  body_vi text constraint notifications_body_vi_check check (char_length(body_vi) <= 500),
  subject_type text constraint notifications_subject_type_check check (subject_type ~ '^[a-z][a-z0-9_]{0,39}$'),
  subject_id text constraint notifications_subject_id_check check (subject_id ~ '^[A-Za-z0-9:_.-]{1,100}$'),
  -- Internal app path only: one leading '/', no scheme/host, no '//', no '..', no backslash.
  href text constraint notifications_href_check check (
    char_length(href) <= 300 and href ~ '^/[A-Za-z0-9/_.~%=&?#-]*$' and href !~ '//' and href !~ '\.\.'),
  status text not null default 'open' constraint notifications_status_check check (status in ('open', 'resolved')),
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  observation_count integer not null default 1 constraint notifications_observation_count_check check (observation_count >= 1),
  resolved_at timestamptz,
  resolution_reason text constraint notifications_resolution_reason_check check (resolution_reason ~ '^[a-z][a-z0-9_]{0,59}$'),
  resolution_evidence jsonb constraint notifications_resolution_evidence_check check (
    resolution_evidence is null or (jsonb_typeof(resolution_evidence) = 'object' and char_length(resolution_evidence::text) <= 2000)),
  policy_revision integer not null,
  recipient_count integer not null default 0,
  constraint notifications_resolved_shape check (
    (status = 'resolved') = (resolved_at is not null and resolution_reason is not null)),
  constraint notifications_observed_order check (last_observed_at >= first_observed_at)
);
-- At most one open notification per business event; a resolved one may recur.
create unique index notifications_open_event_unique
  on notification_private.notifications (type_code, dedupe_key) where status = 'open';

-- Recipients fixed at creation + per-user read state.
create table notification_private.recipients (
  notification_id bigint not null references notification_private.notifications(id),
  user_id bigint not null references public.users(id),
  delivered_at timestamptz not null default now(),
  read_at timestamptz,
  primary key (notification_id, user_id)
);
create index recipients_user_idx on notification_private.recipients (user_id, notification_id desc);
create index recipients_user_unread_idx on notification_private.recipients (user_id, notification_id desc)
  where read_at is null;

alter table notification_private.types enable row level security;
alter table notification_private.policies enable row level security;
alter table notification_private.policy_audit enable row level security;
alter table notification_private.notifications enable row level security;
alter table notification_private.recipients enable row level security;

create function notification_private.reject_audit_mutation() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'notification policy_audit is append-only' using errcode = '42501';
end $$;
create trigger policy_audit_append_only before update or delete on notification_private.policy_audit
  for each row execute function notification_private.reject_audit_mutation();
create trigger policy_audit_no_truncate before truncate on notification_private.policy_audit
  for each statement execute function notification_private.reject_audit_mutation();

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

create function notification_private.norm(p_value text) returns text
language sql immutable set search_path = pg_catalog as $$
  select nullif(lower(btrim(p_value)), '')
$$;

-- Active, login-enabled staff member; no row otherwise.
create function notification_private.actor(p_user_id bigint)
returns table (id bigint, role text, part text)
language sql stable security definer set search_path = pg_catalog, public as $$
  select u.id::bigint, notification_private.norm(u.role), notification_private.norm(u.part)
  from public.users u
  where u.id = p_user_id and u.is_active is true and u.app_login_enabled is true
$$;

create function notification_private.is_policy_admin(p_user_id bigint) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce((select a.role in ('owner', 'master') from notification_private.actor(p_user_id) a), false)
$$;

-- Attribute list: empty/missing = any (NULL included); non-empty never matches NULL.
create function notification_private.attr_match(p_list jsonb, p_value text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select case
    when p_list is null or jsonb_typeof(p_list) <> 'array' or jsonb_array_length(p_list) = 0 then true
    when p_value is null then false
    else p_list ? p_value end
$$;

create function notification_private.rules_match(
  p_rules jsonb, p_user_id bigint, p_role text, p_part text
) returns boolean language sql immutable set search_path = pg_catalog as $$
  select coalesce(
    (jsonb_typeof(p_rules -> 'userIds') = 'array' and (p_rules -> 'userIds') @> to_jsonb(p_user_id))
    or exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(p_rules -> 'groups') = 'array'
        then p_rules -> 'groups' else '[]'::jsonb end) g
      where jsonb_typeof(g) = 'object'
        and notification_private.attr_match(g -> 'roles', p_role)
        and notification_private.attr_match(g -> 'parts', p_part)),
    false)
$$;

-- Display gate shared by list/count/read: current account state x access ceiling x current policy.
create function notification_private.can_see(
  p_access_roles text[], p_enabled boolean, p_in_app boolean, p_rules jsonb,
  p_user_id bigint, p_role text, p_part text
) returns boolean language sql immutable set search_path = pg_catalog as $$
  select coalesce(p_enabled and p_in_app and p_role = any(p_access_roles)
    and notification_private.rules_match(p_rules, p_user_id, p_role, p_part), false)
$$;

-- Normalizes and validates a rules object; null when invalid.
create function notification_private.normalize_rules(p_rules jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  v_groups jsonb := '[]'::jsonb; v_group jsonb; v_out jsonb; v_key text; v_list jsonb; v_allowed text[];
  v_user_ids jsonb; v_id jsonb; v_ids bigint[] := '{}';
begin
  if p_rules is null or jsonb_typeof(p_rules) <> 'object' then return null; end if;
  if exists (select 1 from jsonb_object_keys(p_rules) k where k not in ('groups', 'userIds')) then return null; end if;
  if p_rules ? 'groups' then
    if jsonb_typeof(p_rules -> 'groups') <> 'array' or jsonb_array_length(p_rules -> 'groups') > 20 then return null; end if;
    for v_group in select value from jsonb_array_elements(p_rules -> 'groups') loop
      if jsonb_typeof(v_group) <> 'object' then return null; end if;
      if exists (select 1 from jsonb_object_keys(v_group) k where k not in ('roles', 'parts')) then return null; end if;
      v_out := '{}'::jsonb;
      foreach v_key in array array['roles', 'parts'] loop
        v_allowed := case v_key
          when 'roles' then array['owner', 'master', 'manager', 'leader', 'staff']
          else array['owner', 'hall', 'bar', 'kitchen', 'cleaning', 'etc'] end;
        v_list := coalesce(v_group -> v_key, '[]'::jsonb);
        if jsonb_typeof(v_list) <> 'array' then return null; end if;
        if exists (select 1 from jsonb_array_elements(v_list) e
          where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any(v_allowed))) then return null; end if;
        v_out := v_out || jsonb_build_object(v_key, coalesce((select jsonb_agg(x order by array_position(v_allowed, x))
          from (select distinct e #>> '{}' x from jsonb_array_elements(v_list) e) s), '[]'::jsonb));
      end loop;
      if not v_groups @> jsonb_build_array(v_out) then v_groups := v_groups || jsonb_build_array(v_out); end if;
    end loop;
  end if;
  v_user_ids := coalesce(p_rules -> 'userIds', '[]'::jsonb);
  if jsonb_typeof(v_user_ids) <> 'array' or jsonb_array_length(v_user_ids) > 100 then return null; end if;
  for v_id in select value from jsonb_array_elements(v_user_ids) loop
    if jsonb_typeof(v_id) <> 'number' or (v_id #>> '{}') !~ '^[1-9][0-9]{0,15}$' then return null; end if;
    if not exists (select 1 from public.users u where u.id = (v_id #>> '{}')::bigint) then return null; end if;
    if not ((v_id #>> '{}')::bigint = any(v_ids)) then v_ids := v_ids || (v_id #>> '{}')::bigint; end if;
  end loop;
  return jsonb_build_object('groups', v_groups,
    'userIds', coalesce((select jsonb_agg(x order by x) from unnest(v_ids) x), '[]'::jsonb));
end $$;

create function notification_private.item_json(p_id bigint, p_user_id bigint) returns jsonb
language sql stable security definer set search_path = pg_catalog, public as $$
  select jsonb_build_object('id', n.id, 'typeCode', n.type_code, 'domain', n.domain, 'severity', n.severity,
    'titleKo', n.title_ko, 'titleVi', n.title_vi, 'bodyKo', n.body_ko, 'bodyVi', n.body_vi,
    'subjectType', n.subject_type, 'subjectId', n.subject_id, 'href', n.href, 'status', n.status,
    'firstObservedAt', n.first_observed_at, 'lastObservedAt', n.last_observed_at,
    'resolvedAt', n.resolved_at, 'readAt', r.read_at)
  from notification_private.notifications n
  join notification_private.recipients r on r.notification_id = n.id and r.user_id = p_user_id
  where n.id = p_id
$$;

-- ---------------------------------------------------------------------------------------------
-- Server-internal writer contract (no browser route calls these)
-- ---------------------------------------------------------------------------------------------

-- p_payload: {severity?, titleKo, titleVi, bodyKo?, bodyVi?, subjectType?, subjectId?, href?}
create function public.notification_upsert_v1(p_type_code text, p_dedupe_key text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_type notification_private.types; v_policy notification_private.policies;
  v_severity text; v_id bigint; v_inserted boolean; v_count integer;
begin
  select * into v_type from notification_private.types where code = p_type_code;
  if not found then return jsonb_build_object('status', 'unknown_type'); end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or exists (select 1 from jsonb_object_keys(p_payload) k where k not in
      ('severity', 'titleKo', 'titleVi', 'bodyKo', 'bodyVi', 'subjectType', 'subjectId', 'href')) then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  if exists (select 1 from jsonb_each(p_payload) e where jsonb_typeof(e.value) not in ('string', 'null')) then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  v_severity := coalesce(p_payload ->> 'severity', v_type.default_severity);

  begin
    -- 1) Re-observation of the open event: never touches recipients/read state.
    update notification_private.notifications n set
      last_observed_at = greatest(n.last_observed_at, now()),
      observation_count = n.observation_count + 1,
      severity = v_severity,
      body_ko = case when p_payload ? 'bodyKo' then p_payload ->> 'bodyKo' else n.body_ko end,
      body_vi = case when p_payload ? 'bodyVi' then p_payload ->> 'bodyVi' else n.body_vi end
    where n.type_code = p_type_code and n.dedupe_key = p_dedupe_key and n.status = 'open'
    returning n.id into v_id;
    if v_id is not null then return jsonb_build_object('status', 'observed', 'id', v_id); end if;

    select * into v_policy from notification_private.policies where type_code = p_type_code;
    if not found or not v_policy.enabled then return jsonb_build_object('status', 'disabled'); end if;

    -- 2) Atomic first observation; a concurrent winner turns this into an observation.
    --    The advisory lock (held until commit) serializes id allocation with commit order.
    perform pg_advisory_xact_lock(20261126, 1);
    insert into notification_private.notifications as n (type_code, domain, dedupe_key, severity, title_ko, title_vi,
      body_ko, body_vi, subject_type, subject_id, href, policy_revision)
    values (p_type_code, v_type.domain, p_dedupe_key, v_severity, p_payload ->> 'titleKo', p_payload ->> 'titleVi',
      p_payload ->> 'bodyKo', p_payload ->> 'bodyVi', p_payload ->> 'subjectType', p_payload ->> 'subjectId',
      p_payload ->> 'href', v_policy.revision)
    on conflict (type_code, dedupe_key) where status = 'open' do update set
      last_observed_at = greatest(n.last_observed_at, now()),
      observation_count = n.observation_count + 1,
      severity = excluded.severity
    returning n.id, (n.xmax = 0) into v_id, v_inserted;
  exception
    when check_violation or not_null_violation or string_data_right_truncation then
      return jsonb_build_object('status', 'invalid_input');
  end;
  if not v_inserted then return jsonb_build_object('status', 'observed', 'id', v_id); end if;

  insert into notification_private.recipients (notification_id, user_id)
  select v_id, a.id from public.users u
  cross join lateral notification_private.actor(u.id) a
  where notification_private.can_see(v_type.access_roles, true, true, v_policy.rules,
    a.id, a.role, a.part);
  get diagnostics v_count = row_count;
  update notification_private.notifications set recipient_count = v_count where id = v_id;
  return jsonb_build_object('status', 'created', 'id', v_id, 'recipientCount', v_count);
end $$;

-- Resolves ONE occurrence (business fact). The caller names the occurrence it verified
-- (notification id returned by notification_upsert_v1) together with its type and key, after
-- re-checking the source business state. A duplicate or delayed request for an earlier occurrence
-- returns already_resolved and never touches a recurrence that reuses the same dedupe_key.
-- Never changes anyone's read state.
create function public.notification_resolve_v1(
  p_notification_id bigint, p_type_code text, p_dedupe_key text, p_reason text, p_evidence jsonb
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_row notification_private.notifications;
begin
  if p_notification_id is null or p_notification_id < 1 or p_reason is null or p_reason !~ '^[a-z][a-z0-9_]{0,59}$'
    or (p_evidence is not null and (jsonb_typeof(p_evidence) <> 'object' or char_length(p_evidence::text) > 2000)) then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  -- Row lock: concurrent resolutions of the same occurrence serialize; the loser sees 'resolved'.
  select * into v_row from notification_private.notifications
  where id = p_notification_id and type_code = p_type_code and dedupe_key = p_dedupe_key
  for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_row.status = 'resolved' then
    return jsonb_build_object('status', 'already_resolved', 'id', v_row.id, 'resolvedAt', v_row.resolved_at);
  end if;
  update notification_private.notifications set status = 'resolved', resolved_at = now(),
    resolution_reason = p_reason, resolution_evidence = p_evidence
  where id = v_row.id;
  return jsonb_build_object('status', 'resolved', 'id', v_row.id);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Actor RPCs (the server passes the authenticated user id; everything else is re-derived here)
-- ---------------------------------------------------------------------------------------------

-- p_filter: all | unread | open | resolved. Keyset pagination on id (newest first).
create function public.notification_list_v1(p_actor_user_id bigint, p_filter text, p_before_id bigint, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_actor record; v_limit integer; v_items jsonb; v_has_more boolean;
begin
  select * into v_actor from notification_private.actor(p_actor_user_id);
  if not found then return jsonb_build_object('status', 'forbidden'); end if;
  if coalesce(p_filter, '') not in ('all', 'unread', 'open', 'resolved')
    or (p_before_id is not null and p_before_id < 1) or p_limit is null or p_limit < 1 or p_limit > 50 then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  v_limit := p_limit;
  with page as (
    select n.id, n.type_code, n.domain, n.severity, n.title_ko, n.title_vi, n.body_ko, n.body_vi,
      n.subject_type, n.subject_id, n.href, n.status, n.first_observed_at, n.last_observed_at, n.resolved_at, r.read_at
    from notification_private.recipients r
    join notification_private.notifications n on n.id = r.notification_id
    join notification_private.types t on t.code = n.type_code
    join notification_private.policies p on p.type_code = n.type_code
    where r.user_id = v_actor.id
      and (p_before_id is null or r.notification_id < p_before_id)
      and (p_filter <> 'unread' or r.read_at is null)
      and (p_filter not in ('open', 'resolved') or n.status = p_filter)
      and notification_private.can_see(t.access_roles, p.enabled, p.in_app_enabled, p.rules,
        v_actor.id, v_actor.role, v_actor.part)
    order by r.notification_id desc
    limit v_limit + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'typeCode', type_code, 'domain', domain, 'severity', severity,
      'titleKo', title_ko, 'titleVi', title_vi, 'bodyKo', body_ko, 'bodyVi', body_vi,
      'subjectType', subject_type, 'subjectId', subject_id, 'href', href, 'status', status,
      'firstObservedAt', first_observed_at, 'lastObservedAt', last_observed_at,
      'resolvedAt', resolved_at, 'readAt', read_at) order by id desc) filter (where rn <= v_limit), '[]'::jsonb),
    count(*) > v_limit
  into v_items, v_has_more
  from (select page.*, row_number() over (order by id desc) rn from page) s;
  return jsonb_build_object('status', 'ok', 'items', v_items, 'hasMore', v_has_more,
    'nextBeforeId', case when v_has_more then (v_items -> (jsonb_array_length(v_items) - 1) ->> 'id')::bigint end);
end $$;

-- Unread count, capped at 100 (the UI shows 99+).
create function public.notification_unread_count_v1(p_actor_user_id bigint)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_actor record; v_count integer;
begin
  select * into v_actor from notification_private.actor(p_actor_user_id);
  if not found then return jsonb_build_object('status', 'forbidden'); end if;
  select count(*) into v_count from (
    select 1 from notification_private.recipients r
    join notification_private.notifications n on n.id = r.notification_id
    join notification_private.types t on t.code = n.type_code
    join notification_private.policies p on p.type_code = n.type_code
    where r.user_id = v_actor.id and r.read_at is null
      and notification_private.can_see(t.access_roles, p.enabled, p.in_app_enabled, p.rules,
        v_actor.id, v_actor.role, v_actor.part)
    limit 100) s;
  return jsonb_build_object('status', 'ok', 'unreadCount', v_count, 'capped', v_count >= 100);
end $$;

-- Marks one visible notification read for the actor only. Hidden/foreign ids are not_found.
create function public.notification_mark_read_v1(p_actor_user_id bigint, p_notification_id bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor record; v_visible boolean;
begin
  select * into v_actor from notification_private.actor(p_actor_user_id);
  if not found then return jsonb_build_object('status', 'forbidden'); end if;
  if p_notification_id is null or p_notification_id < 1 then return jsonb_build_object('status', 'invalid_input'); end if;
  select notification_private.can_see(t.access_roles, p.enabled, p.in_app_enabled, p.rules,
      v_actor.id, v_actor.role, v_actor.part)
  into v_visible
  from notification_private.recipients r
  join notification_private.notifications n on n.id = r.notification_id
  join notification_private.types t on t.code = n.type_code
  join notification_private.policies p on p.type_code = n.type_code
  where r.notification_id = p_notification_id and r.user_id = v_actor.id;
  if not coalesce(v_visible, false) then return jsonb_build_object('status', 'not_found'); end if;
  update notification_private.recipients set read_at = now()
  where notification_id = p_notification_id and user_id = v_actor.id and read_at is null;
  return jsonb_build_object('status', 'ok', 'item', notification_private.item_json(p_notification_id, v_actor.id));
end $$;

-- Marks every visible unread notification with id <= p_up_to_id (the newest id the client has
-- shown). Anything created later stays unread.
create function public.notification_mark_all_read_v1(p_actor_user_id bigint, p_up_to_id bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor record; v_count integer;
begin
  select * into v_actor from notification_private.actor(p_actor_user_id);
  if not found then return jsonb_build_object('status', 'forbidden'); end if;
  if p_up_to_id is null or p_up_to_id < 1 then return jsonb_build_object('status', 'invalid_input'); end if;
  update notification_private.recipients r set read_at = now()
  from notification_private.notifications n, notification_private.types t, notification_private.policies p
  where r.user_id = v_actor.id and r.read_at is null and r.notification_id <= p_up_to_id
    and n.id = r.notification_id and t.code = n.type_code and p.type_code = n.type_code
    and notification_private.can_see(t.access_roles, p.enabled, p.in_app_enabled, p.rules,
      v_actor.id, v_actor.role, v_actor.part);
  get diagnostics v_count = row_count;
  return jsonb_build_object('status', 'ok', 'updated', v_count);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Policy administration (owner/master)
-- ---------------------------------------------------------------------------------------------

create function public.notification_policy_list_v1(p_actor_user_id bigint)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if not notification_private.is_policy_admin(p_actor_user_id) then return jsonb_build_object('status', 'forbidden'); end if;
  return jsonb_build_object('status', 'ok',
    'types', coalesce((select jsonb_agg(jsonb_build_object(
        'code', t.code, 'domain', t.domain, 'accessRoles', to_jsonb(t.access_roles), 'defaultSeverity', t.default_severity,
        'enabled', p.enabled, 'inAppEnabled', p.in_app_enabled, 'rules', p.rules, 'revision', p.revision,
        'updatedAt', p.updated_at,
        'updatedByName', (select coalesce(nullif(u.name, ''), nullif(u.full_name, ''), u.username) from public.users u where u.id = p.updated_by),
        'matchedUserIds', coalesce((select jsonb_agg(a.id order by a.id) from public.users u
            cross join lateral notification_private.actor(u.id) a
            where notification_private.can_see(t.access_roles, true, true, p.rules, a.id, a.role, a.part)), '[]'::jsonb))
        order by t.domain, t.code)
      from notification_private.types t join notification_private.policies p on p.type_code = t.code), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', a.id,
        'name', coalesce(nullif(u.name, ''), nullif(u.full_name, ''), u.username),
        'role', a.role, 'part', a.part) order by a.id)
      from public.users u cross join lateral notification_private.actor(u.id) a), '[]'::jsonb),
    'audit', coalesce((select jsonb_agg(x order by (x ->> 'id')::bigint desc) from (
        select jsonb_build_object('id', l.id, 'typeCode', l.type_code, 'revision', l.revision, 'changedAt', l.changed_at,
          'actorName', (select coalesce(nullif(u.name, ''), nullif(u.full_name, ''), u.username) from public.users u where u.id = l.actor_user_id)) x
        from notification_private.policy_audit l order by l.id desc limit 20) s), '[]'::jsonb));
end $$;

-- p_policy: {enabled, inAppEnabled, rules}. Optimistic concurrency on revision. Applies to events
-- created afterwards; existing events are only re-filtered at display time.
create function public.notification_policy_update_v1(
  p_actor_user_id bigint, p_type_code text, p_expected_revision integer, p_policy jsonb
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_before notification_private.policies; v_rules jsonb; v_after notification_private.policies;
begin
  if not notification_private.is_policy_admin(p_actor_user_id) then return jsonb_build_object('status', 'forbidden'); end if;
  if p_policy is null or jsonb_typeof(p_policy) <> 'object'
    or exists (select 1 from jsonb_object_keys(p_policy) k where k not in ('enabled', 'inAppEnabled', 'rules'))
    or jsonb_typeof(p_policy -> 'enabled') is distinct from 'boolean'
    or jsonb_typeof(p_policy -> 'inAppEnabled') is distinct from 'boolean' then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  v_rules := notification_private.normalize_rules(p_policy -> 'rules');
  if v_rules is null then return jsonb_build_object('status', 'invalid_input'); end if;
  select * into v_before from notification_private.policies where type_code = p_type_code for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if p_expected_revision is distinct from v_before.revision then
    return jsonb_build_object('status', 'version_conflict', 'latestRevision', v_before.revision);
  end if;
  update notification_private.policies set enabled = (p_policy ->> 'enabled')::boolean,
    in_app_enabled = (p_policy ->> 'inAppEnabled')::boolean, rules = v_rules,
    revision = revision + 1, updated_by = p_actor_user_id, updated_at = now()
  where type_code = p_type_code returning * into v_after;
  insert into notification_private.policy_audit (type_code, revision, before_policy, after_policy, actor_user_id)
  values (p_type_code, v_after.revision,
    jsonb_build_object('enabled', v_before.enabled, 'inAppEnabled', v_before.in_app_enabled, 'rules', v_before.rules, 'revision', v_before.revision),
    jsonb_build_object('enabled', v_after.enabled, 'inAppEnabled', v_after.in_app_enabled, 'rules', v_after.rules, 'revision', v_after.revision),
    p_actor_user_id);
  return jsonb_build_object('status', 'ok', 'revision', v_after.revision, 'rules', v_after.rules);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Catalog seed: types the follow-up stages will write. Disabled until an owner/master enables
-- them; no writer calls them in 01-A. Ceilings mirror the existing screens' permissions.
-- ---------------------------------------------------------------------------------------------

insert into notification_private.types (code, domain, access_roles, default_severity) values
  -- leave approval (lib/attendance/api-policy.ts isAttendanceAdminRole: owner/master)
  ('attendance.leave_request_pending', 'attendance', array['owner', 'master'], 'warning'),
  -- POS deduction review list (app/api/admin/sales/inventory-deductions/*: owner/master/manager/leader)
  ('inventory.pos_deduction_pending', 'inventory', array['owner', 'master', 'manager', 'leader'], 'warning');

insert into notification_private.policies (type_code, enabled, in_app_enabled, rules)
select code, false, true, '{"groups":[{"roles":["owner","master"],"parts":[]}],"userIds":[]}'::jsonb
from notification_private.types;

-- ---------------------------------------------------------------------------------------------
-- Privileges: private schema closed to every API role; RPCs callable by service_role only.
-- ---------------------------------------------------------------------------------------------

revoke all on all tables in schema notification_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema notification_private from public, anon, authenticated, service_role;
revoke all on all functions in schema notification_private from public, anon, authenticated, service_role;

revoke all on function public.notification_upsert_v1(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.notification_resolve_v1(bigint, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.notification_list_v1(bigint, text, bigint, integer) from public, anon, authenticated;
revoke all on function public.notification_unread_count_v1(bigint) from public, anon, authenticated;
revoke all on function public.notification_mark_read_v1(bigint, bigint) from public, anon, authenticated;
revoke all on function public.notification_mark_all_read_v1(bigint, bigint) from public, anon, authenticated;
revoke all on function public.notification_policy_list_v1(bigint) from public, anon, authenticated;
revoke all on function public.notification_policy_update_v1(bigint, text, integer, jsonb) from public, anon, authenticated;

grant execute on function public.notification_upsert_v1(text, text, jsonb) to service_role;
grant execute on function public.notification_resolve_v1(bigint, text, text, text, jsonb) to service_role;
grant execute on function public.notification_list_v1(bigint, text, bigint, integer) to service_role;
grant execute on function public.notification_unread_count_v1(bigint) to service_role;
grant execute on function public.notification_mark_read_v1(bigint, bigint) to service_role;
grant execute on function public.notification_mark_all_read_v1(bigint, bigint) to service_role;
grant execute on function public.notification_policy_list_v1(bigint) to service_role;
grant execute on function public.notification_policy_update_v1(bigint, text, integer, jsonb) to service_role;
