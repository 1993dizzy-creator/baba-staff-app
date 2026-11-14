-- BABA reservation management Phase 1: Zalo webhook inbox + reservation canon + history + planned table links.
--
-- * Everything lives in the private schema reservation_private. Tables have RLS enabled and NO
--   policies, and every privilege is revoked from public/anon/authenticated/service_role. The app
--   (service_role) reaches the data only through the security-definer public.reservation_*_v1 RPCs,
--   which check the acting staff member's role (users.role, active + app login enabled).
-- * The webhook never creates or confirms a reservation. It only stores the delivery in the inbox
--   (deduplicated on Zalo chat id + message id). A staff member turns an inbox row into a
--   'pending' reservation; confirmation is a separate, explicit transition.
-- * reservation_table_links is the PLANNED table assignment for a reservation time window only.
--   Actual table occupancy (POS orders / seating) is a different fact and is not stored here.
-- * Business day = Asia/Ho_Chi_Minh wall clock with a 03:00 cutoff (00:00–02:59 belongs to the
--   previous business date), same rule as lib/common/business-time.ts getBusinessDate().
-- * Personal data (customer name/contact, sender id/name, message text, raw payload) never goes
--   into reservation_events; events carry field names and non-personal values only.
-- * Writes no existing table. Does not touch any existing function, role or row.

create extension if not exists btree_gist with schema extensions;

create schema reservation_private;
revoke all on schema reservation_private from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

create function reservation_private.business_date(p_at timestamptz) returns date
language sql stable set search_path = pg_catalog as $$
  select ((p_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date
$$;

create function reservation_private.short_hash(p_value text) returns text
language sql immutable set search_path = pg_catalog as $$
  -- Same 16-hex fingerprint as lib/zalo/webhook-poc.ts fingerprint() (sha256, first 16 hex).
  select case when p_value is null or p_value = '' then null
    else left(encode(sha256(convert_to(p_value, 'UTF8')), 'hex'), 16) end
$$;

create function reservation_private.mask_contact(p_contact text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case
    when p_contact is null then null
    when length(regexp_replace(p_contact, '\D', '', 'g')) >= 4
      then '***' || right(regexp_replace(p_contact, '\D', '', 'g'), 3)
    else '***' end
$$;

-- Role of an active, login-enabled staff member; null otherwise.
create function reservation_private.actor_role(p_actor_user_id bigint) returns text
language sql stable security definer set search_path = pg_catalog, public as $$
  select lower(btrim(u.role)) from public.users u
  where u.id = p_actor_user_id and u.is_active is true and u.app_login_enabled is true
$$;

-- view   : reservation list/detail with masked contact (every active staff role)
-- manage : inbox review, raw message text, full contact, create/update/transition/table links
-- purge  : personal-data retention purge
create function reservation_private.can(p_role text, p_action text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select coalesce(case p_action
    when 'view' then p_role in ('staff', 'leader', 'manager', 'owner', 'master')
    when 'manage' then p_role in ('leader', 'manager', 'owner', 'master')
    when 'purge' then p_role in ('owner', 'master')
  end, false)
$$;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table reservation_private.inbox (
  id bigint generated always as identity primary key,
  source text not null default 'zalo_bot' constraint inbox_source_check check (source in ('zalo_bot')),
  -- 'msg:'||sha256(chat_id \n message_id) when both ids exist, else 'payload:'||payload_sha256.
  dedupe_key text not null,
  status text not null default 'received'
    constraint inbox_status_check check (status in ('received', 'quarantined', 'linked', 'dismissed')),
  quarantine_reason text constraint inbox_quarantine_reason_check check (quarantine_reason in
    ('invalid_json', 'unknown_event_shape', 'invalid_group_text', 'not_group', 'other_event')),
  event_name text constraint inbox_event_name_len check (char_length(event_name) <= 100),
  chat_type text constraint inbox_chat_type_len check (char_length(chat_type) <= 40),
  message_type text constraint inbox_message_type_len check (char_length(message_type) <= 40),
  group_fp text constraint inbox_group_fp_check check (group_fp ~ '^[0-9a-f]{16}$'),
  message_fp text constraint inbox_message_fp_check check (message_fp ~ '^[0-9a-f]{16}$'),
  -- Personal / raw data (nulled by the retention purge).
  chat_id text,
  message_id text,
  sender_id text,
  sender_name text,
  message_text text constraint inbox_message_text_len check (char_length(message_text) <= 20000),
  raw_payload jsonb,
  raw_body text constraint inbox_raw_body_len check (char_length(raw_body) <= 70000),
  payload_sha256 text not null constraint inbox_payload_sha_check check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  message_at timestamptz,
  received_at timestamptz not null default now(),
  business_date date not null,
  delivery_count integer not null default 1 constraint inbox_delivery_count_check check (delivery_count >= 1),
  last_delivery_at timestamptz not null default now(),
  payload_mismatch_count integer not null default 0 constraint inbox_mismatch_check check (payload_mismatch_count >= 0),
  reprocess_count integer not null default 0 constraint inbox_reprocess_check check (reprocess_count >= 0),
  reviewed_by bigint references public.users(id),
  reviewed_at timestamptz,
  review_note text constraint inbox_review_note_len check (char_length(review_note) <= 500),
  pii_purged_at timestamptz,
  constraint inbox_dedupe_unique unique (source, dedupe_key),
  constraint inbox_quarantine_reason_required check ((status = 'quarantined') = (quarantine_reason is not null)),
  constraint inbox_received_shape check (status not in ('received', 'linked') or
    (chat_type = 'GROUP' and event_name = 'message.text.received' and group_fp is not null and message_fp is not null)),
  constraint inbox_purge_shape check (pii_purged_at is null or (chat_id is null and message_id is null and
    sender_id is null and sender_name is null and message_text is null and raw_payload is null and raw_body is null))
);
create index inbox_status_business_date_idx on reservation_private.inbox (status, business_date desc, id desc);

create table reservation_private.reservations (
  id bigint generated always as identity primary key,
  source_inbox_id bigint references reservation_private.inbox(id),
  create_request_key uuid constraint reservations_create_request_key_unique unique,
  status text not null default 'pending' constraint reservations_status_check
    check (status in ('pending', 'confirmed', 'arrived', 'completed', 'cancelled', 'no_show')),
  customer_name text not null constraint reservations_customer_name_check
    check (char_length(btrim(customer_name)) between 1 and 120),
  customer_contact text constraint reservations_customer_contact_check
    check (customer_contact is null or char_length(customer_contact) between 1 and 120),
  party_size integer not null constraint reservations_party_size_check check (party_size between 1 and 200),
  reserved_at timestamptz not null,
  business_date date not null,
  duration_minutes integer not null default 120
    constraint reservations_duration_check check (duration_minutes between 15 and 720),
  note text constraint reservations_note_check check (char_length(note) <= 1000),
  cancel_reason text constraint reservations_cancel_reason_check check (char_length(cancel_reason) <= 500),
  version integer not null default 1 constraint reservations_version_check check (version >= 1),
  created_by bigint not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_by bigint not null references public.users(id),
  updated_at timestamptz not null default now(),
  pii_purged_at timestamptz,
  constraint reservations_cancel_reason_required check (status <> 'cancelled' or cancel_reason is not null)
);
create index reservations_business_date_idx on reservation_private.reservations (business_date, reserved_at, id);
create index reservations_source_inbox_idx on reservation_private.reservations (source_inbox_id) where source_inbox_id is not null;

create table reservation_private.reservation_table_links (
  id bigint generated always as identity primary key,
  reservation_id bigint not null references reservation_private.reservations(id),
  table_code text not null constraint reservation_table_links_code_check
    check (table_code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  -- Planned window copied from the reservation; kept in sync by the update RPC.
  planned_range tstzrange not null constraint reservation_table_links_range_check
    check (not isempty(planned_range) and lower_inc(planned_range) and not upper_inc(planned_range)),
  linked_by bigint not null references public.users(id),
  linked_at timestamptz not null default now(),
  released_at timestamptz,
  released_by bigint references public.users(id),
  release_reason text constraint reservation_table_links_release_reason_len check (char_length(release_reason) <= 200),
  constraint reservation_table_links_release_shape check ((released_at is null) = (released_by is null)),
  constraint reservation_table_links_no_overlap exclude using gist (
    table_code with =, planned_range with &&
  ) where (released_at is null)
);
create unique index reservation_table_links_active_unique
  on reservation_private.reservation_table_links (reservation_id, table_code) where released_at is null;

create table reservation_private.reservation_events (
  id bigint generated always as identity primary key,
  reservation_id bigint references reservation_private.reservations(id),
  inbox_id bigint references reservation_private.inbox(id),
  event_type text not null constraint reservation_events_type_check check (event_type in (
    'inbox_received', 'inbox_quarantined', 'inbox_duplicate', 'inbox_reprocessed', 'inbox_dismissed',
    'inbox_linked', 'reservation_created', 'reservation_updated', 'status_changed',
    'table_linked', 'table_released', 'contact_viewed', 'pii_purged')),
  from_status text,
  to_status text,
  changes jsonb not null default '{}'::jsonb,
  actor_user_id bigint references public.users(id),
  created_at timestamptz not null default now(),
  constraint reservation_events_target check (reservation_id is not null or inbox_id is not null)
);
create index reservation_events_reservation_idx on reservation_private.reservation_events (reservation_id, id) where reservation_id is not null;
create index reservation_events_inbox_idx on reservation_private.reservation_events (inbox_id, id) where inbox_id is not null;

create function reservation_private.reject_event_mutation() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'reservation_events is append-only' using errcode = '42501';
end $$;
create trigger reservation_events_append_only
  before update or delete on reservation_private.reservation_events
  for each row execute function reservation_private.reject_event_mutation();
create trigger reservation_events_no_truncate
  before truncate on reservation_private.reservation_events
  for each statement execute function reservation_private.reject_event_mutation();

create function reservation_private.set_reservation_derived() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.business_date := reservation_private.business_date(new.reserved_at);
  new.updated_at := now();
  return new;
end $$;
create trigger reservations_derived before insert or update on reservation_private.reservations
  for each row execute function reservation_private.set_reservation_derived();

alter table reservation_private.inbox enable row level security;
alter table reservation_private.reservations enable row level security;
alter table reservation_private.reservation_table_links enable row level security;
alter table reservation_private.reservation_events enable row level security;

create function reservation_private.log_event(
  p_reservation_id bigint, p_inbox_id bigint, p_event_type text, p_from text, p_to text,
  p_changes jsonb, p_actor bigint
) returns void language sql set search_path = pg_catalog as $$
  insert into reservation_private.reservation_events
    (reservation_id, inbox_id, event_type, from_status, to_status, changes, actor_user_id)
  values (p_reservation_id, p_inbox_id, p_event_type, p_from, p_to, coalesce(p_changes, '{}'::jsonb), p_actor)
$$;

create function reservation_private.reservation_json(p_id bigint, p_reveal_contact boolean) returns jsonb
language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object(
    'id', r.id, 'status', r.status, 'customerName', r.customer_name,
    'customerContact', case when p_reveal_contact then r.customer_contact
                            else reservation_private.mask_contact(r.customer_contact) end,
    'contactMasked', (not p_reveal_contact) and r.customer_contact is not null,
    'partySize', r.party_size, 'reservedAt', r.reserved_at, 'businessDate', r.business_date,
    'durationMinutes', r.duration_minutes, 'note', r.note, 'cancelReason', r.cancel_reason,
    'sourceInboxId', r.source_inbox_id, 'version', r.version,
    'createdAt', r.created_at, 'updatedAt', r.updated_at, 'piiPurged', r.pii_purged_at is not null,
    'tables', coalesce((select jsonb_agg(jsonb_build_object('linkId', l.id, 'tableCode', l.table_code) order by l.table_code)
      from reservation_private.reservation_table_links l where l.reservation_id = r.id and l.released_at is null), '[]'::jsonb))
  from reservation_private.reservations r where r.id = p_id
$$;

-- Parses an ISO-8601 instant that carries an explicit offset (or Z); null otherwise, so the server
-- session time zone can never silently decide the wall-clock time of a reservation.
create function reservation_private.parse_instant(p_value text) returns timestamptz
language plpgsql stable set search_path = pg_catalog as $$
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$' then
    return null;
  end if;
  return p_value::timestamptz;
exception when others then
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Webhook ingest (system; called by the webhook route with service_role)
-- ---------------------------------------------------------------------------------------------

create function public.reservation_inbox_ingest_v1(p_entry jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_status text := p_entry->>'status';
  v_reason text := nullif(p_entry->>'quarantine_reason', '');
  v_chat_id text := nullif(p_entry->>'chat_id', '');
  v_message_id text := nullif(p_entry->>'message_id', '');
  v_sha text := lower(coalesce(p_entry->>'payload_sha256', ''));
  v_message_at timestamptz := reservation_private.parse_instant(p_entry->>'message_at');
  v_key text;
  v_id bigint; v_inserted boolean; v_deliveries integer; v_mismatch boolean;
begin
  if jsonb_typeof(p_entry) is distinct from 'object'
     or v_status is null or v_status not in ('received', 'quarantined')
     or v_sha !~ '^[0-9a-f]{64}$'
     or (p_entry ? 'raw_payload') = (p_entry ? 'raw_body')
     or (v_status = 'quarantined' and v_reason is null)
     or (v_status = 'received' and (v_chat_id is null or v_message_id is null
         or p_entry->>'chat_type' is distinct from 'GROUP'
         or p_entry->>'event_name' is distinct from 'message.text.received'
         or jsonb_typeof(p_entry->'message_text') is distinct from 'string')) then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  v_key := case when v_chat_id is not null and v_message_id is not null
    then 'msg:' || encode(sha256(convert_to(v_chat_id || chr(10) || v_message_id, 'UTF8')), 'hex')
    else 'payload:' || v_sha end;

  insert into reservation_private.inbox as i (
    source, dedupe_key, status, quarantine_reason, event_name, chat_type, message_type,
    group_fp, message_fp, chat_id, message_id, sender_id, sender_name, message_text,
    raw_payload, raw_body, payload_sha256, message_at, business_date
  ) values (
    'zalo_bot', v_key, v_status, case when v_status = 'quarantined' then v_reason end,
    left(p_entry->>'event_name', 100), left(p_entry->>'chat_type', 40), left(p_entry->>'message_type', 40),
    reservation_private.short_hash(v_chat_id), reservation_private.short_hash(v_message_id),
    v_chat_id, v_message_id, nullif(p_entry->>'sender_id', ''), nullif(p_entry->>'sender_name', ''),
    p_entry->>'message_text',
    case when p_entry ? 'raw_payload' then p_entry->'raw_payload' end,
    p_entry->>'raw_body', v_sha, v_message_at,
    reservation_private.business_date(coalesce(v_message_at, now()))
  )
  on conflict (source, dedupe_key) do update set
    delivery_count = i.delivery_count + 1,
    last_delivery_at = now(),
    payload_mismatch_count = i.payload_mismatch_count + (i.payload_sha256 <> excluded.payload_sha256)::int
  returning i.id, (i.xmax = 0), i.delivery_count, (i.payload_sha256 <> v_sha)
    into v_id, v_inserted, v_deliveries, v_mismatch;

  if v_inserted then
    perform reservation_private.log_event(null, v_id,
      case when v_status = 'received' then 'inbox_received' else 'inbox_quarantined' end,
      null, v_status, jsonb_strip_nulls(jsonb_build_object('reason', v_reason)), null);
  else
    perform reservation_private.log_event(null, v_id, 'inbox_duplicate', null, null,
      jsonb_build_object('deliveryCount', v_deliveries, 'payloadMismatch', v_mismatch,
        'payloadSha256', case when v_mismatch then v_sha end), null);
  end if;

  return jsonb_build_object('status', case when v_inserted then 'stored' else 'duplicate' end,
    'inboxId', v_id, 'deliveryCount', v_deliveries, 'payloadMismatch', v_mismatch);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Inbox review (manage)
-- ---------------------------------------------------------------------------------------------

create function reservation_private.inbox_json(p_id bigint, p_include_raw boolean) returns jsonb
language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object(
    'id', i.id, 'status', i.status, 'quarantineReason', i.quarantine_reason,
    'eventName', i.event_name, 'chatType', i.chat_type, 'messageType', i.message_type,
    'groupFp', i.group_fp, 'messageFp', i.message_fp, 'senderName', i.sender_name,
    'messageText', i.message_text, 'messageAt', i.message_at, 'receivedAt', i.received_at,
    'businessDate', i.business_date, 'deliveryCount', i.delivery_count,
    'payloadMismatchCount', i.payload_mismatch_count, 'reprocessCount', i.reprocess_count,
    'reviewNote', i.review_note, 'piiPurged', i.pii_purged_at is not null,
    'reservationIds', coalesce((select jsonb_agg(r.id order by r.id) from reservation_private.reservations r
      where r.source_inbox_id = i.id), '[]'::jsonb))
    || case when p_include_raw then jsonb_build_object('rawPayload', i.raw_payload, 'rawBody', i.raw_body,
         'payloadSha256', i.payload_sha256) else '{}'::jsonb end
  from reservation_private.inbox i where i.id = p_id
$$;

create function public.reservation_inbox_list_v1(
  p_actor_user_id bigint, p_statuses text[], p_business_date_from date, p_business_date_to date,
  p_limit integer default 100
) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if not reservation_private.can(reservation_private.actor_role(p_actor_user_id), 'manage') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_business_date_from is null or p_business_date_to is null or p_business_date_to < p_business_date_from
     or p_business_date_to - p_business_date_from > 92 then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  return jsonb_build_object('status', 'ok', 'items', coalesce((
    select jsonb_agg(reservation_private.inbox_json(x.id, false) order by x.business_date desc, x.id desc)
    from (select i.id, i.business_date from reservation_private.inbox i
          where i.business_date between p_business_date_from and p_business_date_to
            and (p_statuses is null or i.status = any(p_statuses))
          order by i.business_date desc, i.id desc
          limit least(greatest(coalesce(p_limit, 100), 1), 500)) x), '[]'::jsonb));
end $$;

create function public.reservation_inbox_get_v1(p_actor_user_id bigint, p_inbox_id bigint) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare v jsonb;
begin
  if not reservation_private.can(reservation_private.actor_role(p_actor_user_id), 'manage') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  v := reservation_private.inbox_json(p_inbox_id, true);
  if v is null then return jsonb_build_object('status', 'not_found'); end if;
  return jsonb_build_object('status', 'ok', 'item', v);
end $$;

create function public.reservation_inbox_dismiss_v1(p_actor_user_id bigint, p_inbox_id bigint, p_note text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_row reservation_private.inbox;
begin
  if not reservation_private.can(reservation_private.actor_role(p_actor_user_id), 'manage') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select * into v_row from reservation_private.inbox where id = p_inbox_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_row.status not in ('received', 'quarantined') then
    return jsonb_build_object('status', 'invalid_transition', 'current', v_row.status);
  end if;
  if char_length(p_note) > 500 then return jsonb_build_object('status', 'invalid_input'); end if;
  update reservation_private.inbox set status = 'dismissed', quarantine_reason = null,
    reviewed_by = p_actor_user_id, reviewed_at = now(), review_note = nullif(btrim(p_note), '')
  where id = p_inbox_id;
  perform reservation_private.log_event(null, p_inbox_id, 'inbox_dismissed', v_row.status, 'dismissed',
    jsonb_strip_nulls(jsonb_build_object('quarantineReason', v_row.quarantine_reason)), p_actor_user_id);
  return jsonb_build_object('status', 'ok', 'item', reservation_private.inbox_json(p_inbox_id, false));
end $$;

-- Re-classifies a quarantined row after the app re-parsed its stored raw payload with the current
-- parser (lib/zalo/webhook-poc.ts buildZaloInboxEntry). The re-parsed entry must hash to the same
-- stored payload, so only the classification can change, never the evidence.
create function public.reservation_inbox_reprocess_v1(p_actor_user_id bigint, p_inbox_id bigint, p_entry jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_row reservation_private.inbox;
  v_status text := p_entry->>'status';
  v_reason text := nullif(p_entry->>'quarantine_reason', '');
  v_chat_id text := nullif(p_entry->>'chat_id', '');
  v_message_id text := nullif(p_entry->>'message_id', '');
  v_message_at timestamptz := reservation_private.parse_instant(p_entry->>'message_at');
  v_key text; v_other bigint;
begin
  if not reservation_private.can(reservation_private.actor_role(p_actor_user_id), 'manage') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select * into v_row from reservation_private.inbox where id = p_inbox_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_row.status <> 'quarantined' or v_row.pii_purged_at is not null then
    return jsonb_build_object('status', 'invalid_transition', 'current', v_row.status);
  end if;
  if jsonb_typeof(p_entry) is distinct from 'object'
     or lower(coalesce(p_entry->>'payload_sha256', '')) <> v_row.payload_sha256
     or v_status is null or v_status not in ('received', 'quarantined')
     or (v_status = 'quarantined' and v_reason is null)
     or (v_status = 'received' and (v_chat_id is null or v_message_id is null
         or p_entry->>'chat_type' is distinct from 'GROUP'
         or p_entry->>'event_name' is distinct from 'message.text.received'
         or jsonb_typeof(p_entry->'message_text') is distinct from 'string')) then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  if v_status = 'quarantined' then
    update reservation_private.inbox set quarantine_reason = v_reason, reprocess_count = reprocess_count + 1
    where id = p_inbox_id;
    perform reservation_private.log_event(null, p_inbox_id, 'inbox_reprocessed', 'quarantined', 'quarantined',
      jsonb_build_object('fromReason', v_row.quarantine_reason, 'toReason', v_reason), p_actor_user_id);
    return jsonb_build_object('status', 'ok', 'item', reservation_private.inbox_json(p_inbox_id, false));
  end if;

  v_key := 'msg:' || encode(sha256(convert_to(v_chat_id || chr(10) || v_message_id, 'UTF8')), 'hex');
  select id into v_other from reservation_private.inbox
  where source = v_row.source and dedupe_key = v_key and id <> p_inbox_id;
  if v_other is not null then
    -- The same Zalo message is already in the inbox: never create a second live copy.
    update reservation_private.inbox set status = 'dismissed', quarantine_reason = null,
      reprocess_count = reprocess_count + 1, reviewed_by = p_actor_user_id, reviewed_at = now(),
      review_note = 'duplicate_of:' || v_other
    where id = p_inbox_id;
    perform reservation_private.log_event(null, p_inbox_id, 'inbox_reprocessed', 'quarantined', 'dismissed',
      jsonb_build_object('duplicateOf', v_other), p_actor_user_id);
    return jsonb_build_object('status', 'duplicate', 'duplicateOf', v_other,
      'item', reservation_private.inbox_json(p_inbox_id, false));
  end if;

  update reservation_private.inbox set
    status = 'received', quarantine_reason = null, dedupe_key = v_key,
    event_name = left(p_entry->>'event_name', 100), chat_type = left(p_entry->>'chat_type', 40),
    message_type = left(p_entry->>'message_type', 40),
    chat_id = v_chat_id, message_id = v_message_id,
    group_fp = reservation_private.short_hash(v_chat_id), message_fp = reservation_private.short_hash(v_message_id),
    sender_id = nullif(p_entry->>'sender_id', ''), sender_name = nullif(p_entry->>'sender_name', ''),
    message_text = p_entry->>'message_text', message_at = v_message_at,
    business_date = reservation_private.business_date(coalesce(v_message_at, received_at)),
    reprocess_count = reprocess_count + 1
  where id = p_inbox_id;
  perform reservation_private.log_event(null, p_inbox_id, 'inbox_reprocessed', 'quarantined', 'received',
    jsonb_build_object('fromReason', v_row.quarantine_reason), p_actor_user_id);
  return jsonb_build_object('status', 'ok', 'item', reservation_private.inbox_json(p_inbox_id, false));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Reservations (manage for writes, view for reads)
-- ---------------------------------------------------------------------------------------------

create function public.reservation_create_v1(p_actor_user_id bigint, p_input jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_reserved_at timestamptz := reservation_private.parse_instant(p_input->>'reservedAt');
  v_inbox_id bigint;
  v_inbox reservation_private.inbox;
  v_request_key uuid;
  v_existing bigint;
  v_id bigint;
begin
  if not reservation_private.can(reservation_private.actor_role(p_actor_user_id), 'manage') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if jsonb_typeof(p_input) is distinct from 'object' or v_reserved_at is null
     or jsonb_typeof(p_input->'partySize') is distinct from 'number'
     or jsonb_typeof(p_input->'customerName') is distinct from 'string' then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  begin
    v_inbox_id := nullif(p_input->>'sourceInboxId', '')::bigint;
    v_request_key := nullif(p_input->>'requestKey', '')::uuid;
  exception when others then
    return jsonb_build_object('status', 'invalid_input');
  end;

  if v_request_key is not null then
    select id into v_existing from reservation_private.reservations where create_request_key = v_request_key;
    if v_existing is not null then
      return jsonb_build_object('status', 'ok', 'duplicateRequest', true,
        'reservation', reservation_private.reservation_json(v_existing, true));
    end if;
  end if;

  if v_inbox_id is not null then
    select * into v_inbox from reservation_private.inbox where id = v_inbox_id for update;
    if not found then return jsonb_build_object('status', 'invalid_source'); end if;
    if v_inbox.status not in ('received', 'linked') then
      return jsonb_build_object('status', 'invalid_source', 'inboxStatus', v_inbox.status);
    end if;
  end if;

  begin
    insert into reservation_private.reservations (
      source_inbox_id, create_request_key, customer_name, customer_contact, party_size, reserved_at,
      business_date, duration_minutes, note, created_by, updated_by
    ) values (
      v_inbox_id, v_request_key, btrim(p_input->>'customerName'),
      nullif(btrim(p_input->>'customerContact'), ''), (p_input->>'partySize')::integer, v_reserved_at,
      reservation_private.business_date(v_reserved_at),
      coalesce((p_input->>'durationMinutes')::integer, 120), nullif(btrim(p_input->>'note'), ''),
      p_actor_user_id, p_actor_user_id
    ) returning id into v_id;
  exception
    when unique_violation then
      -- Concurrent submit with the same request key.
      select id into v_existing from reservation_private.reservations where create_request_key = v_request_key;
      if v_existing is null then raise; end if;
      return jsonb_build_object('status', 'ok', 'duplicateRequest', true,
        'reservation', reservation_private.reservation_json(v_existing, true));
    when check_violation or invalid_text_representation or numeric_value_out_of_range then
      return jsonb_build_object('status', 'invalid_input');
  end;

  if v_inbox_id is not null and v_inbox.status = 'received' then
    update reservation_private.inbox set status = 'linked', reviewed_by = p_actor_user_id, reviewed_at = now()
    where id = v_inbox_id;
    perform reservation_private.log_event(null, v_inbox_id, 'inbox_linked', 'received', 'linked',
      jsonb_build_object('reservationId', v_id), p_actor_user_id);
  end if;

  perform reservation_private.log_event(v_id, v_inbox_id, 'reservation_created', null, 'pending',
    (select jsonb_build_object('partySize', r.party_size, 'reservedAt', r.reserved_at, 'businessDate', r.business_date,
       'durationMinutes', r.duration_minutes, 'hasContact', r.customer_contact is not null,
       'sourceInboxId', r.source_inbox_id) from reservation_private.reservations r where r.id = v_id),
    p_actor_user_id);
  return jsonb_build_object('status', 'ok', 'duplicateRequest', false,
    'reservation', reservation_private.reservation_json(v_id, true));
end $$;

create function public.reservation_update_v1(
  p_actor_user_id bigint, p_reservation_id bigint, p_expected_version integer, p_input jsonb
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_old reservation_private.reservations;
  v_new reservation_private.reservations;
  v_reserved_at timestamptz;
  v_fields text[] := '{}';
  v_before jsonb := '{}'; v_after jsonb := '{}';
begin
  if not reservation_private.can(reservation_private.actor_role(p_actor_user_id), 'manage') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if jsonb_typeof(p_input) is distinct from 'object' then return jsonb_build_object('status', 'invalid_input'); end if;
  select * into v_old from reservation_private.reservations where id = p_reservation_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_old.version <> p_expected_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', v_old.version);
  end if;
  if v_old.status not in ('pending', 'confirmed') or v_old.pii_purged_at is not null then
    return jsonb_build_object('status', 'invalid_transition', 'current', v_old.status);
  end if;

  v_new := v_old;
  if p_input ? 'reservedAt' then
    v_reserved_at := reservation_private.parse_instant(p_input->>'reservedAt');
    if v_reserved_at is null then return jsonb_build_object('status', 'invalid_input'); end if;
    v_new.reserved_at := v_reserved_at;
  end if;
  begin
    if p_input ? 'customerName' then v_new.customer_name := btrim(p_input->>'customerName'); end if;
    if p_input ? 'customerContact' then v_new.customer_contact := nullif(btrim(p_input->>'customerContact'), ''); end if;
    if p_input ? 'partySize' then v_new.party_size := (p_input->>'partySize')::integer; end if;
    if p_input ? 'durationMinutes' then v_new.duration_minutes := (p_input->>'durationMinutes')::integer; end if;
    if p_input ? 'note' then v_new.note := nullif(btrim(p_input->>'note'), ''); end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    return jsonb_build_object('status', 'invalid_input');
  end;

  -- Personal fields are recorded by name only.
  if v_new.customer_name is distinct from v_old.customer_name then v_fields := array_append(v_fields, 'customerName'); end if;
  if v_new.customer_contact is distinct from v_old.customer_contact then v_fields := array_append(v_fields, 'customerContact'); end if;
  if v_new.note is distinct from v_old.note then v_fields := array_append(v_fields, 'note'); end if;
  if v_new.party_size is distinct from v_old.party_size then
    v_fields := array_append(v_fields, 'partySize');
    v_before := v_before || jsonb_build_object('partySize', v_old.party_size);
    v_after := v_after || jsonb_build_object('partySize', v_new.party_size);
  end if;
  if v_new.reserved_at is distinct from v_old.reserved_at then
    v_fields := array_append(v_fields, 'reservedAt');
    v_before := v_before || jsonb_build_object('reservedAt', v_old.reserved_at, 'businessDate', v_old.business_date);
    v_after := v_after || jsonb_build_object('reservedAt', v_new.reserved_at,
      'businessDate', reservation_private.business_date(v_new.reserved_at));
  end if;
  if v_new.duration_minutes is distinct from v_old.duration_minutes then
    v_fields := array_append(v_fields, 'durationMinutes');
    v_before := v_before || jsonb_build_object('durationMinutes', v_old.duration_minutes);
    v_after := v_after || jsonb_build_object('durationMinutes', v_new.duration_minutes);
  end if;
  if cardinality(v_fields) = 0 then
    return jsonb_build_object('status', 'ok', 'unchanged', true,
      'reservation', reservation_private.reservation_json(p_reservation_id, true));
  end if;

  begin
    update reservation_private.reservations set
      customer_name = v_new.customer_name, customer_contact = v_new.customer_contact,
      party_size = v_new.party_size, reserved_at = v_new.reserved_at,
      duration_minutes = v_new.duration_minutes, note = v_new.note,
      version = version + 1, updated_by = p_actor_user_id
    where id = p_reservation_id;
    update reservation_private.reservation_table_links set
      planned_range = tstzrange(v_new.reserved_at, v_new.reserved_at + make_interval(mins => v_new.duration_minutes), '[)')
    where reservation_id = p_reservation_id and released_at is null;
  exception
    when exclusion_violation then
      return jsonb_build_object('status', 'table_conflict');
    when check_violation then
      return jsonb_build_object('status', 'invalid_input');
  end;

  perform reservation_private.log_event(p_reservation_id, null, 'reservation_updated', v_old.status, v_old.status,
    jsonb_build_object('fields', to_jsonb(v_fields), 'before', v_before, 'after', v_after), p_actor_user_id);
  return jsonb_build_object('status', 'ok', 'unchanged', false,
    'reservation', reservation_private.reservation_json(p_reservation_id, true));
end $$;

create function public.reservation_transition_v1(
  p_actor_user_id bigint, p_reservation_id bigint, p_expected_version integer, p_to_status text, p_reason text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_old reservation_private.reservations;
  v_reason text := nullif(btrim(p_reason), '');
  v_released integer := 0;
begin
  if not reservation_private.can(reservation_private.actor_role(p_actor_user_id), 'manage') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select * into v_old from reservation_private.reservations where id = p_reservation_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_old.version <> p_expected_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', v_old.version);
  end if;
  if not ((v_old.status, p_to_status) in (
      ('pending', 'confirmed'), ('pending', 'cancelled'),
      ('confirmed', 'arrived'), ('confirmed', 'cancelled'), ('confirmed', 'no_show'), ('confirmed', 'pending'),
      ('arrived', 'completed'))) then
    return jsonb_build_object('status', 'invalid_transition', 'current', v_old.status);
  end if;
  if p_to_status = 'cancelled' and v_reason is null then
    return jsonb_build_object('status', 'reason_required');
  end if;
  if char_length(v_reason) > 500 then return jsonb_build_object('status', 'invalid_input'); end if;

  update reservation_private.reservations set
    status = p_to_status, cancel_reason = case when p_to_status = 'cancelled' then v_reason else cancel_reason end,
    version = version + 1, updated_by = p_actor_user_id
  where id = p_reservation_id;

  -- A finished/cancelled/no-show reservation no longer holds its planned tables.
  if p_to_status in ('cancelled', 'no_show', 'completed') then
    with released as (
      update reservation_private.reservation_table_links set
        released_at = now(), released_by = p_actor_user_id, release_reason = 'status:' || p_to_status
      where reservation_id = p_reservation_id and released_at is null
      returning table_code)
    select count(*) into v_released from released;
  end if;

  perform reservation_private.log_event(p_reservation_id, null, 'status_changed', v_old.status, p_to_status,
    jsonb_strip_nulls(jsonb_build_object('reason', v_reason, 'releasedTables', nullif(v_released, 0))), p_actor_user_id);
  return jsonb_build_object('status', 'ok', 'reservation', reservation_private.reservation_json(p_reservation_id, true));
end $$;

create function public.reservation_link_table_v1(
  p_actor_user_id bigint, p_reservation_id bigint, p_expected_version integer, p_table_code text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_res reservation_private.reservations;
  v_code text := upper(btrim(p_table_code));
  v_range tstzrange;
  v_link_id bigint;
  v_conflict bigint;
begin
  if not reservation_private.can(reservation_private.actor_role(p_actor_user_id), 'manage') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9_-]{0,19}$' then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  select * into v_res from reservation_private.reservations where id = p_reservation_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_res.version <> p_expected_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', v_res.version);
  end if;
  if v_res.status not in ('pending', 'confirmed', 'arrived') then
    return jsonb_build_object('status', 'invalid_transition', 'current', v_res.status);
  end if;
  if exists (select 1 from reservation_private.reservation_table_links
             where reservation_id = p_reservation_id and table_code = v_code and released_at is null) then
    return jsonb_build_object('status', 'ok', 'unchanged', true,
      'reservation', reservation_private.reservation_json(p_reservation_id, true));
  end if;

  v_range := tstzrange(v_res.reserved_at, v_res.reserved_at + make_interval(mins => v_res.duration_minutes), '[)');
  begin
    insert into reservation_private.reservation_table_links (reservation_id, table_code, planned_range, linked_by)
    values (p_reservation_id, v_code, v_range, p_actor_user_id) returning id into v_link_id;
  exception when exclusion_violation then
    select l.reservation_id into v_conflict from reservation_private.reservation_table_links l
    where l.table_code = v_code and l.released_at is null and l.planned_range && v_range
    order by l.id limit 1;
    return jsonb_build_object('status', 'table_conflict', 'conflictReservationId', v_conflict);
  end;

  update reservation_private.reservations set version = version + 1, updated_by = p_actor_user_id
  where id = p_reservation_id;
  perform reservation_private.log_event(p_reservation_id, null, 'table_linked', v_res.status, v_res.status,
    jsonb_build_object('linkId', v_link_id, 'tableCode', v_code,
      'plannedFrom', lower(v_range), 'plannedTo', upper(v_range)), p_actor_user_id);
  return jsonb_build_object('status', 'ok', 'unchanged', false,
    'reservation', reservation_private.reservation_json(p_reservation_id, true));
end $$;

create function public.reservation_release_table_v1(
  p_actor_user_id bigint, p_reservation_id bigint, p_expected_version integer, p_link_id bigint, p_reason text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_res reservation_private.reservations;
  v_link reservation_private.reservation_table_links;
begin
  if not reservation_private.can(reservation_private.actor_role(p_actor_user_id), 'manage') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if char_length(p_reason) > 200 then return jsonb_build_object('status', 'invalid_input'); end if;
  select * into v_res from reservation_private.reservations where id = p_reservation_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_res.version <> p_expected_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', v_res.version);
  end if;
  select * into v_link from reservation_private.reservation_table_links
  where id = p_link_id and reservation_id = p_reservation_id for update;
  if not found or v_link.released_at is not null then return jsonb_build_object('status', 'not_found'); end if;

  update reservation_private.reservation_table_links set
    released_at = now(), released_by = p_actor_user_id, release_reason = coalesce(nullif(btrim(p_reason), ''), 'manual')
  where id = p_link_id;
  update reservation_private.reservations set version = version + 1, updated_by = p_actor_user_id
  where id = p_reservation_id;
  perform reservation_private.log_event(p_reservation_id, null, 'table_released', v_res.status, v_res.status,
    jsonb_build_object('linkId', p_link_id, 'tableCode', v_link.table_code,
      'reason', coalesce(nullif(btrim(p_reason), ''), 'manual')), p_actor_user_id);
  return jsonb_build_object('status', 'ok', 'reservation', reservation_private.reservation_json(p_reservation_id, true));
end $$;

create function public.reservation_list_v1(
  p_actor_user_id bigint, p_business_date_from date, p_business_date_to date, p_statuses text[]
) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if not reservation_private.can(reservation_private.actor_role(p_actor_user_id), 'view') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if p_business_date_from is null or p_business_date_to is null or p_business_date_to < p_business_date_from
     or p_business_date_to - p_business_date_from > 92 then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  -- Lists always mask the contact; the full contact is revealed one reservation at a time
  -- through reservation_get_v1 so every reveal is audited.
  return jsonb_build_object('status', 'ok', 'items', coalesce((
    select jsonb_agg(reservation_private.reservation_json(x.id, false) order by x.reserved_at, x.id)
    from (select r.id, r.reserved_at from reservation_private.reservations r
          where r.business_date between p_business_date_from and p_business_date_to
            and (p_statuses is null or r.status = any(p_statuses))
          order by r.reserved_at, r.id limit 1000) x), '[]'::jsonb));
end $$;

create function public.reservation_get_v1(p_actor_user_id bigint, p_reservation_id bigint, p_reveal_contact boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_role text := reservation_private.actor_role(p_actor_user_id);
  v_reveal boolean := coalesce(p_reveal_contact, false);
  v_contact text;
begin
  if not reservation_private.can(v_role, 'view') then return jsonb_build_object('status', 'forbidden'); end if;
  if v_reveal and not reservation_private.can(v_role, 'manage') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select customer_contact into v_contact from reservation_private.reservations where id = p_reservation_id;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if v_reveal and v_contact is not null then
    perform reservation_private.log_event(p_reservation_id, null, 'contact_viewed', null, null, '{}'::jsonb, p_actor_user_id);
  end if;
  return jsonb_build_object('status', 'ok',
    'reservation', reservation_private.reservation_json(p_reservation_id, v_reveal),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'type', e.event_type,
        'fromStatus', e.from_status, 'toStatus', e.to_status, 'changes', e.changes,
        'actorUserId', e.actor_user_id, 'createdAt', e.created_at) order by e.id)
      from reservation_private.reservation_events e where e.reservation_id = p_reservation_id), '[]'::jsonb),
    'tableHistory', coalesce((select jsonb_agg(jsonb_build_object('linkId', l.id, 'tableCode', l.table_code,
        'plannedFrom', lower(l.planned_range), 'plannedTo', upper(l.planned_range), 'linkedAt', l.linked_at,
        'releasedAt', l.released_at, 'releaseReason', l.release_reason) order by l.id)
      from reservation_private.reservation_table_links l where l.reservation_id = p_reservation_id), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Personal-data retention (proposal values; owner runs it manually, dry run first)
--   inbox linked/dismissed : 90 days after receipt
--   inbox received/quarantined (never reviewed) : 180 days after receipt
--   reservations completed/cancelled/no_show : 365 days after the business date
-- Metadata (status, fingerprints, hashes, counts, dates) and the event history are kept.
-- ---------------------------------------------------------------------------------------------

create function public.reservation_purge_expired_pii_v1(p_actor_user_id bigint, p_now timestamptz, p_dry_run boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_inbox bigint[]; v_res bigint[]; v_id bigint;
begin
  if not reservation_private.can(reservation_private.actor_role(p_actor_user_id), 'purge') then
    return jsonb_build_object('status', 'forbidden');
  end if;
  if v_now > now() + interval '1 day' then return jsonb_build_object('status', 'invalid_input'); end if;

  select coalesce(array_agg(i.id order by i.id), '{}') into v_inbox from reservation_private.inbox i
  where i.pii_purged_at is null and (
    (i.status in ('linked', 'dismissed') and i.received_at < v_now - interval '90 days') or
    (i.status in ('received', 'quarantined') and i.received_at < v_now - interval '180 days'));
  select coalesce(array_agg(r.id order by r.id), '{}') into v_res from reservation_private.reservations r
  where r.pii_purged_at is null and r.status in ('completed', 'cancelled', 'no_show')
    and r.business_date < reservation_private.business_date(v_now) - 365;

  if not coalesce(p_dry_run, true) then
    update reservation_private.inbox set chat_id = null, message_id = null, sender_id = null, sender_name = null,
      message_text = null, raw_payload = null, raw_body = null, pii_purged_at = now()
    where id = any(v_inbox);
    update reservation_private.reservations set customer_name = '-', customer_contact = null, note = null,
      cancel_reason = case when cancel_reason is null then null else '-' end, pii_purged_at = now()
    where id = any(v_res);
    foreach v_id in array v_inbox loop
      perform reservation_private.log_event(null, v_id, 'pii_purged', null, null, '{}'::jsonb, p_actor_user_id);
    end loop;
    foreach v_id in array v_res loop
      perform reservation_private.log_event(v_id, null, 'pii_purged', null, null, '{}'::jsonb, p_actor_user_id);
    end loop;
  end if;
  return jsonb_build_object('status', 'ok', 'dryRun', coalesce(p_dry_run, true),
    'inboxCount', cardinality(v_inbox), 'reservationCount', cardinality(v_res));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: private schema closed to every API role; RPCs callable by service_role only.
-- ---------------------------------------------------------------------------------------------

revoke all on all tables in schema reservation_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema reservation_private from public, anon, authenticated, service_role;
revoke all on all functions in schema reservation_private from public, anon, authenticated, service_role;

revoke all on function public.reservation_inbox_ingest_v1(jsonb) from public, anon, authenticated;
revoke all on function public.reservation_inbox_list_v1(bigint, text[], date, date, integer) from public, anon, authenticated;
revoke all on function public.reservation_inbox_get_v1(bigint, bigint) from public, anon, authenticated;
revoke all on function public.reservation_inbox_dismiss_v1(bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.reservation_inbox_reprocess_v1(bigint, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.reservation_create_v1(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.reservation_update_v1(bigint, bigint, integer, jsonb) from public, anon, authenticated;
revoke all on function public.reservation_transition_v1(bigint, bigint, integer, text, text) from public, anon, authenticated;
revoke all on function public.reservation_link_table_v1(bigint, bigint, integer, text) from public, anon, authenticated;
revoke all on function public.reservation_release_table_v1(bigint, bigint, integer, bigint, text) from public, anon, authenticated;
revoke all on function public.reservation_list_v1(bigint, date, date, text[]) from public, anon, authenticated;
revoke all on function public.reservation_get_v1(bigint, bigint, boolean) from public, anon, authenticated;
revoke all on function public.reservation_purge_expired_pii_v1(bigint, timestamptz, boolean) from public, anon, authenticated;

grant execute on function public.reservation_inbox_ingest_v1(jsonb) to service_role;
grant execute on function public.reservation_inbox_list_v1(bigint, text[], date, date, integer) to service_role;
grant execute on function public.reservation_inbox_get_v1(bigint, bigint) to service_role;
grant execute on function public.reservation_inbox_dismiss_v1(bigint, bigint, text) to service_role;
grant execute on function public.reservation_inbox_reprocess_v1(bigint, bigint, jsonb) to service_role;
grant execute on function public.reservation_create_v1(bigint, jsonb) to service_role;
grant execute on function public.reservation_update_v1(bigint, bigint, integer, jsonb) to service_role;
grant execute on function public.reservation_transition_v1(bigint, bigint, integer, text, text) to service_role;
grant execute on function public.reservation_link_table_v1(bigint, bigint, integer, text) to service_role;
grant execute on function public.reservation_release_table_v1(bigint, bigint, integer, bigint, text) to service_role;
grant execute on function public.reservation_list_v1(bigint, date, date, text[]) to service_role;
grant execute on function public.reservation_get_v1(bigint, bigint, boolean) to service_role;
grant execute on function public.reservation_purge_expired_pii_v1(bigint, timestamptz, boolean) to service_role;
