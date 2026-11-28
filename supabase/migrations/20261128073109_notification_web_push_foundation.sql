-- BABA-NOTIFICATION-01B: common background Web Push foundation (on top of 01-A 20261126124217).
--
-- * Adds a per-type push channel switch (policies.push_enabled, default OFF), per-device push
--   subscriptions bound to the server session that registered them, and a per (notification x
--   subscription) delivery queue with bounded retries. 01-A tables/RPCs keep their contracts;
--   the two policy RPCs are replaced with versions that also read/write pushEnabled (an update
--   that omits pushEnabled keeps the stored value, so the 01-A app keeps working unchanged).
-- * Atomic enqueue: a statement trigger on recipients inserts the delivery rows in the SAME
--   transaction that creates the event and fixes its recipients (notification_upsert_v1 is not
--   modified). Only first observations insert recipients, so re-observing an open event never
--   enqueues again; a recurrence after resolution is a new event and enqueues normally.
-- * No back-fill: deliveries are created only at event creation, only for subscriptions active at
--   that moment, and only while the type is enabled AND push_enabled. Registering a device or
--   switching push on later never sends older events.
-- * Send-time gate (claim): the event is still open, the delivery TTL (1 hour from creation) has not
--   passed, the subscription is still active, unexpired and owned by the recipient, the recipient
--   is still active + login-enabled, and the CURRENT role ceiling / rules / enabled / push_enabled
--   still allow it. in_app_enabled is NOT a push condition (separate channel).
-- * Claims use FOR UPDATE SKIP LOCKED + a claim token, so concurrent senders never claim the same
--   row. A claim whose result was never reported (process died after the push service accepted it)
--   is re-claimable after its lease; that re-send may duplicate on the device (same Topic/tag).
-- * Max 3 attempts (backoff 1 min, 5 min; Retry-After honoured), 404/410 revokes the subscription,
--   401/403/400/413 and configuration errors never retry. History is kept (no retention job).
-- * No cron, no realtime publication, no queue service. Writes no existing row.

-- ---------------------------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------------------------

alter table notification_private.policies add column push_enabled boolean not null default false;

-- One row per (device installation x login session). Only standard push services are accepted.
create table notification_private.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.users(id),
  -- iat of the signed server session that registered (or last re-bound) this device.
  session_iat bigint not null constraint push_subscriptions_session_iat_check check (session_iat > 0),
  endpoint text not null constraint push_subscriptions_endpoint_check check (
    char_length(endpoint) <= 1024
    and endpoint ~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]{1,63}\.push\.apple\.com|[a-z0-9-]{1,63}\.notify\.windows\.com)/[A-Za-z0-9_~:./%=?&+-]+$'
    and endpoint !~ '\.\.'),
  p256dh text not null constraint push_subscriptions_p256dh_check check (p256dh ~ '^[A-Za-z0-9_-]{86,88}={0,2}$'),
  auth text not null constraint push_subscriptions_auth_check check (auth ~ '^[A-Za-z0-9_-]{21,24}={0,2}$'),
  lang text not null default 'ko' constraint push_subscriptions_lang_check check (lang in ('ko', 'vi')),
  status text not null default 'active' constraint push_subscriptions_status_check check (status in ('active', 'revoked')),
  -- Equal to the registering session's idle expiry; extended when that session is refreshed.
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text constraint push_subscriptions_revoked_reason_check check (revoked_reason ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint push_subscriptions_revoked_shape check (
    (status = 'revoked') = (revoked_at is not null and revoked_reason is not null))
);
-- An endpoint belongs to at most one active owner (account switch on a device revokes the old one).
create unique index push_subscriptions_active_endpoint_unique
  on notification_private.push_subscriptions (endpoint) where status = 'active';
create index push_subscriptions_user_active_idx
  on notification_private.push_subscriptions (user_id, session_iat) where status = 'active';

create table notification_private.push_deliveries (
  id bigint generated always as identity primary key,
  notification_id bigint not null references notification_private.notifications(id),
  subscription_id bigint not null references notification_private.push_subscriptions(id),
  user_id bigint not null references public.users(id),
  -- pending (due at next_attempt_at) -> sending (claimed) -> accepted | pending (retry) | failed;
  -- skipped = gate refused at claim time; expired = TTL passed before acceptance.
  status text not null default 'pending' constraint push_deliveries_status_check check (
    status in ('pending', 'sending', 'accepted', 'failed', 'skipped', 'expired')),
  attempt_count integer not null default 0 constraint push_deliveries_attempt_check check (attempt_count between 0 and 3),
  next_attempt_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claim_token uuid,
  claimed_at timestamptz,
  last_http_status integer constraint push_deliveries_http_check check (last_http_status between 100 and 599),
  last_error text constraint push_deliveries_error_check check (last_error ~ '^[a-z][a-z0-9_]{0,59}$'),
  accepted_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  constraint push_deliveries_unique unique (notification_id, subscription_id),
  constraint push_deliveries_claim_shape check ((status = 'sending') = (claim_token is not null and claimed_at is not null))
);
create index push_deliveries_due_idx on notification_private.push_deliveries (next_attempt_at, id) where status = 'pending';
create index push_deliveries_sending_idx on notification_private.push_deliveries (claimed_at, id) where status = 'sending';
create index push_deliveries_subscription_idx on notification_private.push_deliveries (subscription_id);

alter table notification_private.push_subscriptions enable row level security;
alter table notification_private.push_deliveries enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

-- Push gate: same account/ceiling/rules contract as can_see, but the channel switch is
-- push_enabled (in_app_enabled is deliberately not an input).
create function notification_private.can_push(
  p_access_roles text[], p_enabled boolean, p_push boolean, p_rules jsonb,
  p_user_id bigint, p_role text, p_part text
) returns boolean language sql immutable set search_path = pg_catalog as $$
  select coalesce(p_enabled and p_push and p_role = any(p_access_roles)
    and notification_private.rules_match(p_rules, p_user_id, p_role, p_part), false)
$$;

create function notification_private.revoke_subscription(p_id bigint, p_reason text) returns void
language sql security definer set search_path = pg_catalog, public as $$
  update notification_private.push_subscriptions set status = 'revoked', revoked_at = now(),
    revoked_reason = p_reason, updated_at = now()
  where id = p_id and status = 'active'
$$;

-- Serializes every write that touches one endpoint (register / sync / renew).
create function notification_private.lock_endpoint(p_endpoint text) returns void
language sql set search_path = pg_catalog as $$
  select pg_advisory_xact_lock(20261128, hashtext(coalesce(p_endpoint, '')))
$$;

-- Enqueue in the event's own transaction (statement trigger on the recipients fan-out).
create function notification_private.enqueue_push_deliveries() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into notification_private.push_deliveries (notification_id, subscription_id, user_id, expires_at)
  select r.notification_id, s.id, r.user_id, n.first_observed_at + interval '1 hour'
  from new_recipients r
  join notification_private.notifications n on n.id = r.notification_id and n.status = 'open'
  join notification_private.types t on t.code = n.type_code
  join notification_private.policies p on p.type_code = n.type_code
  join notification_private.push_subscriptions s
    on s.user_id = r.user_id and s.status = 'active' and s.expires_at > now()
  cross join lateral notification_private.actor(r.user_id) a
  where notification_private.can_push(t.access_roles, p.enabled, p.push_enabled, p.rules, a.id, a.role, a.part)
  on conflict on constraint push_deliveries_unique do nothing;
  return null;
end $$;
create trigger recipients_enqueue_push after insert on notification_private.recipients
  referencing new table as new_recipients
  for each statement execute function notification_private.enqueue_push_deliveries();

create function notification_private.valid_session_expiry(p_expires_at timestamptz) returns boolean
language sql stable set search_path = pg_catalog as $$
  select p_expires_at is not null and p_expires_at > now() and p_expires_at <= now() + interval '181 days'
$$;

-- ---------------------------------------------------------------------------------------------
-- Policy RPCs (replaced: same contract + pushEnabled)
-- ---------------------------------------------------------------------------------------------

create or replace function public.notification_policy_list_v1(p_actor_user_id bigint)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if not notification_private.is_policy_admin(p_actor_user_id) then return jsonb_build_object('status', 'forbidden'); end if;
  return jsonb_build_object('status', 'ok',
    'types', coalesce((select jsonb_agg(jsonb_build_object(
        'code', t.code, 'domain', t.domain, 'accessRoles', to_jsonb(t.access_roles), 'defaultSeverity', t.default_severity,
        'enabled', p.enabled, 'inAppEnabled', p.in_app_enabled, 'pushEnabled', p.push_enabled, 'rules', p.rules, 'revision', p.revision,
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

-- p_policy: {enabled, inAppEnabled, rules, pushEnabled?}. pushEnabled omitted = keep stored value.
create or replace function public.notification_policy_update_v1(
  p_actor_user_id bigint, p_type_code text, p_expected_revision integer, p_policy jsonb
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_before notification_private.policies; v_rules jsonb; v_after notification_private.policies;
begin
  if not notification_private.is_policy_admin(p_actor_user_id) then return jsonb_build_object('status', 'forbidden'); end if;
  if p_policy is null or jsonb_typeof(p_policy) <> 'object'
    or exists (select 1 from jsonb_object_keys(p_policy) k where k not in ('enabled', 'inAppEnabled', 'pushEnabled', 'rules'))
    or jsonb_typeof(p_policy -> 'enabled') is distinct from 'boolean'
    or jsonb_typeof(p_policy -> 'inAppEnabled') is distinct from 'boolean'
    or (p_policy ? 'pushEnabled' and jsonb_typeof(p_policy -> 'pushEnabled') is distinct from 'boolean') then
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
    in_app_enabled = (p_policy ->> 'inAppEnabled')::boolean,
    push_enabled = case when p_policy ? 'pushEnabled' then (p_policy ->> 'pushEnabled')::boolean else push_enabled end,
    rules = v_rules, revision = revision + 1, updated_by = p_actor_user_id, updated_at = now()
  where type_code = p_type_code returning * into v_after;
  insert into notification_private.policy_audit (type_code, revision, before_policy, after_policy, actor_user_id)
  values (p_type_code, v_after.revision,
    jsonb_build_object('enabled', v_before.enabled, 'inAppEnabled', v_before.in_app_enabled, 'pushEnabled', v_before.push_enabled,
      'rules', v_before.rules, 'revision', v_before.revision),
    jsonb_build_object('enabled', v_after.enabled, 'inAppEnabled', v_after.in_app_enabled, 'pushEnabled', v_after.push_enabled,
      'rules', v_after.rules, 'revision', v_after.revision),
    p_actor_user_id);
  return jsonb_build_object('status', 'ok', 'revision', v_after.revision, 'rules', v_after.rules);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Device RPCs (the server passes the authenticated user id + its verified session iat/expiry)
-- ---------------------------------------------------------------------------------------------

-- Registers this device for the actor's current session. Any other active row with the same
-- endpoint (another account on this device, or an older registration) is revoked first.
-- p_old_endpoint (pushsubscriptionchange renewal): must be an active row of the same actor.
create function public.notification_push_subscribe_v1(
  p_actor_user_id bigint, p_session_iat bigint, p_session_expires_at timestamptz,
  p_endpoint text, p_p256dh text, p_auth text, p_lang text, p_old_endpoint text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor record; v_old notification_private.push_subscriptions; v_row record; v_expires timestamptz;
begin
  select * into v_actor from notification_private.actor(p_actor_user_id);
  if not found then return jsonb_build_object('status', 'forbidden'); end if;
  if p_session_iat is null or p_session_iat < 1 or not notification_private.valid_session_expiry(p_session_expires_at)
    or (p_lang is not null and p_lang not in ('ko', 'vi')) or p_endpoint is null
    or (p_old_endpoint is not null and p_old_endpoint = p_endpoint) then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  if p_old_endpoint is not null then
    perform notification_private.lock_endpoint(p_old_endpoint);
    select * into v_old from notification_private.push_subscriptions
    where endpoint = p_old_endpoint and status = 'active' and user_id = v_actor.id for update;
    if not found then return jsonb_build_object('status', 'not_found'); end if;
  end if;
  perform notification_private.lock_endpoint(p_endpoint);
  for v_row in select id, user_id from notification_private.push_subscriptions
    where endpoint = p_endpoint and status = 'active' for update loop
    perform notification_private.revoke_subscription(v_row.id,
      case when v_row.user_id = v_actor.id then 'replaced' else 'owner_changed' end);
  end loop;
  if v_old.id is not null then perform notification_private.revoke_subscription(v_old.id, 'renewed'); end if;
  begin
    insert into notification_private.push_subscriptions (user_id, session_iat, endpoint, p256dh, auth, lang, expires_at)
    values (v_actor.id, p_session_iat, p_endpoint, p_p256dh, p_auth, coalesce(p_lang, v_old.lang, 'ko'), p_session_expires_at)
    returning expires_at into v_expires;
  exception when check_violation or not_null_violation or string_data_right_truncation then
    return jsonb_build_object('status', 'invalid_input');
  end;
  -- At most 10 active devices per staff member: the oldest registrations are retired.
  perform notification_private.revoke_subscription(s.id, 'device_limit')
  from (select id from notification_private.push_subscriptions
        where user_id = v_actor.id and status = 'active' order by id desc offset 10) s;
  return jsonb_build_object('status', 'ok', 'expiresAt', v_expires);
end $$;

-- Removes this device for the actor (only rows the actor owns).
create function public.notification_push_unsubscribe_v1(p_actor_user_id bigint, p_endpoint text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor record; v_count integer := 0; v_row record;
begin
  select * into v_actor from notification_private.actor(p_actor_user_id);
  if not found then return jsonb_build_object('status', 'forbidden'); end if;
  if p_endpoint is null or char_length(p_endpoint) > 1024 then return jsonb_build_object('status', 'invalid_input'); end if;
  perform notification_private.lock_endpoint(p_endpoint);
  for v_row in select id from notification_private.push_subscriptions
    where endpoint = p_endpoint and status = 'active' and user_id = v_actor.id for update loop
    perform notification_private.revoke_subscription(v_row.id, 'user_disabled');
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('status', 'ok', 'revoked', v_count);
end $$;

-- Login / app start on a device that already holds a browser subscription:
--   foreign (another account owned it -> revoked; the client must unsubscribe locally),
--   registered (same account -> bound to the current session and its expiry), not_registered.
create function public.notification_push_sync_v1(
  p_actor_user_id bigint, p_session_iat bigint, p_session_expires_at timestamptz, p_endpoint text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_actor record; v_row notification_private.push_subscriptions;
begin
  select * into v_actor from notification_private.actor(p_actor_user_id);
  if not found then return jsonb_build_object('status', 'forbidden'); end if;
  if p_session_iat is null or p_session_iat < 1 or not notification_private.valid_session_expiry(p_session_expires_at)
    or p_endpoint is null or char_length(p_endpoint) > 1024 then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  perform notification_private.lock_endpoint(p_endpoint);
  select * into v_row from notification_private.push_subscriptions
  where endpoint = p_endpoint and status = 'active' for update;
  if not found then return jsonb_build_object('status', 'ok', 'device', 'not_registered'); end if;
  if v_row.user_id <> v_actor.id then
    perform notification_private.revoke_subscription(v_row.id, 'owner_changed');
    return jsonb_build_object('status', 'ok', 'device', 'foreign');
  end if;
  if v_row.expires_at <= now() then
    perform notification_private.revoke_subscription(v_row.id, 'expired');
    return jsonb_build_object('status', 'ok', 'device', 'not_registered');
  end if;
  update notification_private.push_subscriptions set session_iat = p_session_iat,
    expires_at = p_session_expires_at, updated_at = now()
  where id = v_row.id;
  return jsonb_build_object('status', 'ok', 'device', 'registered', 'expiresAt', p_session_expires_at);
end $$;

-- Logout: every device row bound to that session stops receiving immediately.
create function public.notification_push_session_revoke_v1(p_user_id bigint, p_session_iat bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_count integer;
begin
  if p_user_id is null or p_user_id < 1 or p_session_iat is null or p_session_iat < 1 then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  update notification_private.push_subscriptions set status = 'revoked', revoked_at = now(),
    revoked_reason = 'logout', updated_at = now()
  where user_id = p_user_id and session_iat = p_session_iat and status = 'active';
  get diagnostics v_count = row_count;
  return jsonb_build_object('status', 'ok', 'revoked', v_count);
end $$;

-- Normal session refresh: the device rows of that session follow the new idle expiry.
create function public.notification_push_session_touch_v1(p_user_id bigint, p_session_iat bigint, p_session_expires_at timestamptz)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_count integer;
begin
  if p_user_id is null or p_user_id < 1 or p_session_iat is null or p_session_iat < 1
    or not notification_private.valid_session_expiry(p_session_expires_at) then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  update notification_private.push_subscriptions set expires_at = p_session_expires_at, updated_at = now()
  where user_id = p_user_id and session_iat = p_session_iat and status = 'active'
    and expires_at > now() and expires_at < p_session_expires_at;
  get diagnostics v_count = row_count;
  return jsonb_build_object('status', 'ok', 'updated', v_count);
end $$;

-- Device panel: whether push storage is installed + how many active devices the actor has.
create function public.notification_push_status_v1(p_actor_user_id bigint)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_actor record;
begin
  select * into v_actor from notification_private.actor(p_actor_user_id);
  if not found then return jsonb_build_object('status', 'forbidden'); end if;
  return jsonb_build_object('status', 'ok', 'activeDevices', (select count(*)::integer
    from notification_private.push_subscriptions s
    where s.user_id = v_actor.id and s.status = 'active' and s.expires_at > now()));
end $$;

-- Push click: the actor must be a recipient and still allowed on at least one channel; returns the
-- internal href only (no notification content).
create function public.notification_push_open_v1(p_actor_user_id bigint, p_notification_id bigint)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v_actor record; v_href text; v_ok boolean;
begin
  select * into v_actor from notification_private.actor(p_actor_user_id);
  if not found then return jsonb_build_object('status', 'forbidden'); end if;
  if p_notification_id is null or p_notification_id < 1 then return jsonb_build_object('status', 'invalid_input'); end if;
  select n.href,
    notification_private.can_push(t.access_roles, p.enabled, p.push_enabled, p.rules, v_actor.id, v_actor.role, v_actor.part)
    or notification_private.can_see(t.access_roles, p.enabled, p.in_app_enabled, p.rules, v_actor.id, v_actor.role, v_actor.part)
  into v_href, v_ok
  from notification_private.recipients r
  join notification_private.notifications n on n.id = r.notification_id
  join notification_private.types t on t.code = n.type_code
  join notification_private.policies p on p.type_code = n.type_code
  where r.notification_id = p_notification_id and r.user_id = v_actor.id;
  if not coalesce(v_ok, false) then return jsonb_build_object('status', 'not_found'); end if;
  return jsonb_build_object('status', 'ok', 'href', v_href);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Sender RPCs (server-internal; no browser route reaches them)
-- ---------------------------------------------------------------------------------------------

-- Claims due deliveries (one event, or any event when p_notification_id is null = recovery),
-- re-validating the send gate for each. Refused rows are closed as skipped/expired/failed here.
create function public.notification_push_claim_v1(p_notification_id bigint, p_limit integer, p_lease_seconds integer)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_lease interval; v_items jsonb := '[]'::jsonb; v_skipped integer := 0; r record; g record; a record;
  v_reason text; v_token uuid; v_unread integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_lease_seconds is null or p_lease_seconds < 30
    or p_lease_seconds > 600 or (p_notification_id is not null and p_notification_id < 1) then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  v_lease := make_interval(secs => p_lease_seconds);
  for r in
    select d.* from notification_private.push_deliveries d
    where (p_notification_id is null or d.notification_id = p_notification_id)
      and ((d.status = 'pending' and d.next_attempt_at <= now())
        or (d.status = 'sending' and d.claimed_at < now() - v_lease))
    order by d.id
    limit p_limit
    for update of d skip locked
  loop
    select n.status n_status, n.type_code, n.severity, t.access_roles, p.enabled, p.push_enabled, p.rules,
      s.status s_status, s.user_id s_user, s.expires_at s_expires, s.endpoint, s.p256dh, s.auth, s.lang
    into g
    from notification_private.notifications n
    join notification_private.types t on t.code = n.type_code
    join notification_private.policies p on p.type_code = n.type_code
    join notification_private.push_subscriptions s on s.id = r.subscription_id
    where n.id = r.notification_id;
    select * into a from notification_private.actor(r.user_id);
    v_reason := case
      when r.status = 'sending' and r.attempt_count >= 3 then 'result_unknown'
      when r.expires_at <= now() then 'ttl_expired'
      when g.n_status is distinct from 'open' then 'resolved'
      when g.s_status is distinct from 'active' or g.s_user is distinct from r.user_id then 'subscription_inactive'
      when g.s_expires <= now() then 'subscription_expired'
      when a.id is null then 'recipient_inactive'
      when not notification_private.can_push(g.access_roles, g.enabled, g.push_enabled, g.rules, a.id, a.role, a.part)
        then 'not_allowed'
    end;
    if v_reason is not null then
      if v_reason = 'subscription_expired' then
        perform notification_private.revoke_subscription(r.subscription_id, 'expired');
      end if;
      update notification_private.push_deliveries set
        status = case v_reason when 'ttl_expired' then 'expired' when 'result_unknown' then 'failed' else 'skipped' end,
        last_error = v_reason, finished_at = now(), claim_token = null, claimed_at = null
      where id = r.id;
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_token := gen_random_uuid();
    update notification_private.push_deliveries set status = 'sending', attempt_count = attempt_count + 1,
      claimed_at = now(), claim_token = v_token
    where id = r.id;
    select count(*) into v_unread from (
      select 1 from notification_private.recipients rr
      join notification_private.notifications nn on nn.id = rr.notification_id
      join notification_private.types tt on tt.code = nn.type_code
      join notification_private.policies pp on pp.type_code = nn.type_code
      where rr.user_id = a.id and rr.read_at is null
        and notification_private.can_see(tt.access_roles, pp.enabled, pp.in_app_enabled, pp.rules, a.id, a.role, a.part)
      limit 100) s;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'deliveryId', r.id, 'claimToken', v_token, 'notificationId', r.notification_id, 'typeCode', g.type_code,
      'severity', g.severity, 'lang', g.lang, 'attempt', r.attempt_count + 1,
      'ttlSeconds', greatest(1, floor(extract(epoch from (r.expires_at - now())))::integer),
      'unreadCount', v_unread,
      'endpoint', g.endpoint, 'p256dh', g.p256dh, 'auth', g.auth));
  end loop;
  return jsonb_build_object('status', 'ok', 'items', v_items, 'skipped', v_skipped);
end $$;

-- Records one attempt. Only the current claim (token) may report; anything else is stale.
-- p_outcome: accepted | retry | gone | failed.
create function public.notification_push_report_v1(
  p_delivery_id bigint, p_claim_token uuid, p_outcome text, p_http_status integer,
  p_retry_after_seconds integer, p_error_code text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r notification_private.push_deliveries; v_next timestamptz; v_http integer; v_error text;
begin
  if p_delivery_id is null or p_claim_token is null or p_outcome is null
    or p_outcome not in ('accepted', 'retry', 'gone', 'failed')
    or (p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{0,59}$')
    or (p_retry_after_seconds is not null and p_retry_after_seconds < 0) then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  v_http := case when p_http_status between 100 and 599 then p_http_status end;
  select * into r from notification_private.push_deliveries
  where id = p_delivery_id and status = 'sending' and claim_token = p_claim_token for update;
  if not found then return jsonb_build_object('status', 'stale'); end if;
  if p_outcome = 'accepted' then
    update notification_private.push_deliveries set status = 'accepted', accepted_at = now(), finished_at = now(),
      last_http_status = v_http, last_error = null, claim_token = null, claimed_at = null where id = r.id;
    return jsonb_build_object('status', 'ok', 'delivery', 'accepted');
  end if;
  if p_outcome = 'gone' then
    perform notification_private.revoke_subscription(r.subscription_id, 'gone');
    update notification_private.push_deliveries set status = 'failed', finished_at = now(), last_http_status = v_http,
      last_error = 'subscription_gone', claim_token = null, claimed_at = null where id = r.id;
    return jsonb_build_object('status', 'ok', 'delivery', 'failed');
  end if;
  v_error := coalesce(p_error_code, case p_outcome when 'retry' then 'transient_error' else 'permanent_error' end);
  if p_outcome = 'retry' then
    v_next := now() + make_interval(secs => greatest(
      case r.attempt_count when 1 then 60 when 2 then 300 else 0 end,
      least(coalesce(p_retry_after_seconds, 0), 3600)));
    if r.attempt_count < 3 and v_next < r.expires_at then
      update notification_private.push_deliveries set status = 'pending', next_attempt_at = v_next,
        last_http_status = v_http, last_error = v_error, claim_token = null, claimed_at = null where id = r.id;
      return jsonb_build_object('status', 'ok', 'delivery', 'pending', 'nextAttemptAt', v_next);
    end if;
    update notification_private.push_deliveries set
      status = case when v_next >= r.expires_at and r.attempt_count < 3 then 'expired' else 'failed' end,
      finished_at = now(), last_http_status = v_http,
      last_error = case when v_next >= r.expires_at and r.attempt_count < 3 then 'ttl_expired' else 'retry_exhausted' end,
      claim_token = null, claimed_at = null where id = r.id;
    return jsonb_build_object('status', 'ok', 'delivery', 'failed');
  end if;
  update notification_private.push_deliveries set status = 'failed', finished_at = now(), last_http_status = v_http,
    last_error = v_error, claim_token = null, claimed_at = null where id = r.id;
  return jsonb_build_object('status', 'ok', 'delivery', 'failed');
end $$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: private schema stays closed; new RPCs callable by service_role only.
-- ---------------------------------------------------------------------------------------------

revoke all on all tables in schema notification_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema notification_private from public, anon, authenticated, service_role;
revoke all on all functions in schema notification_private from public, anon, authenticated, service_role;

revoke all on function public.notification_policy_list_v1(bigint) from public, anon, authenticated;
revoke all on function public.notification_policy_update_v1(bigint, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.notification_push_subscribe_v1(bigint, bigint, timestamptz, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.notification_push_unsubscribe_v1(bigint, text) from public, anon, authenticated;
revoke all on function public.notification_push_sync_v1(bigint, bigint, timestamptz, text) from public, anon, authenticated;
revoke all on function public.notification_push_session_revoke_v1(bigint, bigint) from public, anon, authenticated;
revoke all on function public.notification_push_session_touch_v1(bigint, bigint, timestamptz) from public, anon, authenticated;
revoke all on function public.notification_push_open_v1(bigint, bigint) from public, anon, authenticated;
revoke all on function public.notification_push_status_v1(bigint) from public, anon, authenticated;
revoke all on function public.notification_push_claim_v1(bigint, integer, integer) from public, anon, authenticated;
revoke all on function public.notification_push_report_v1(bigint, uuid, text, integer, integer, text) from public, anon, authenticated;

grant execute on function public.notification_policy_list_v1(bigint) to service_role;
grant execute on function public.notification_policy_update_v1(bigint, text, integer, jsonb) to service_role;
grant execute on function public.notification_push_subscribe_v1(bigint, bigint, timestamptz, text, text, text, text, text) to service_role;
grant execute on function public.notification_push_unsubscribe_v1(bigint, text) to service_role;
grant execute on function public.notification_push_sync_v1(bigint, bigint, timestamptz, text) to service_role;
grant execute on function public.notification_push_session_revoke_v1(bigint, bigint) to service_role;
grant execute on function public.notification_push_session_touch_v1(bigint, bigint, timestamptz) to service_role;
grant execute on function public.notification_push_open_v1(bigint, bigint) to service_role;
grant execute on function public.notification_push_status_v1(bigint) to service_role;
grant execute on function public.notification_push_claim_v1(bigint, integer, integer) to service_role;
grant execute on function public.notification_push_report_v1(bigint, uuid, text, integer, integer, text) to service_role;
