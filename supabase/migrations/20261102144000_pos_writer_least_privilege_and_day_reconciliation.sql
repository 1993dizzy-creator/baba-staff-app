-- P1-2F permission profile. Prepare locally; operating application requires a
-- separate approval and external service/cron owner inventory.
do $$ declare c record;cols text;begin
 if exists(select 1 from inventory_writer_private.rpc_contracts rc join pg_proc p on p.oid=rc.function_oid join pg_roles r on r.oid=p.proowner
  where not p.prosecdef or r.rolname<>'postgres' or p.prosrc is distinct from pos_signed_private.current_rpc_body(rc.function_oid)) then
  raise exception 'INVENTORY_PRIVILEGE_PROFILE_RPC_PREFLIGHT_FAILED';end if;
 -- Column privileges survive table REVOKE. Clear existing protected-column
 -- grants explicitly as well; table owners/superusers remain a trust boundary.
 revoke insert,update,delete,truncate on public.inventory from public,anon,authenticated,service_role;
 for c in select attname from pg_attribute where attrelid='public.inventory'::regclass and attnum>0 and not attisdropped loop
  execute format('revoke insert(%I),update(%I) on public.inventory from public,anon,authenticated,service_role',c.attname,c.attname);
 end loop;
 -- Known direct metadata writer: photo upload. Supplier alias functions retain
 -- their existing security-definer owner and ACL. No general metadata wildcard.
 select string_agg(quote_ident(attname),',') into cols from pg_attribute where attrelid='public.inventory'::regclass
  and attname in ('image_path','updated_at','updated_by_name','updated_by_username') and not attisdropped;
 if cols is not null then execute format('grant update(%s) on public.inventory to service_role',cols);end if;
 revoke update,delete,truncate on public.inventory_logs from public,anon,authenticated,service_role;
 for c in select attname from pg_attribute where attrelid='public.inventory_logs'::regclass and attnum>0 and not attisdropped loop
  execute format('revoke update(%I) on public.inventory_logs from public,anon,authenticated,service_role',c.attname);
  execute format('revoke insert(%I) on public.inventory_logs from public,anon,authenticated',c.attname);
 end loop;
 revoke insert on public.inventory_logs from public,anon,authenticated;
 for c in select function_oid from inventory_writer_private.rpc_contracts loop
  execute format('revoke execute on function %s from public,anon,authenticated',c.function_oid::regprocedure);
  execute format('grant execute on function %s to service_role',c.function_oid::regprocedure);
 end loop;
end $$;
-- Existing photo audit insert remains permitted, but cannot forge a count,
-- return, purchase or POS log without the registered postgres-owned RPC.
create function inventory_writer_private.guard_direct_audit() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if current_user in ('anon','authenticated','service_role','authenticator') then
  if new.source is distinct from 'photo' or new.reason is distinct from 'other' or new.action is distinct from 'update'
   or new.change_quantity is distinct from 0::numeric or new.prev_quantity is distinct from new.new_quantity
   or to_jsonb(new)->>'correction_of_inventory_log_id' is not null or to_jsonb(new)->>'related_deduction_id' is not null or to_jsonb(new)->>'related_receipt_id' is not null
  then raise exception 'INVENTORY_AUDIT_REGISTERED_RPC_REQUIRED' using errcode='42501';end if;
 end if;
 return new;
end $$;
create trigger inventory_writer_direct_audit before insert on public.inventory_logs for each row execute function inventory_writer_private.guard_direct_audit();
revoke all on function inventory_writer_private.guard_direct_audit() from public,anon,authenticated,service_role;

-- An independent daily closure is additional evidence, never an invented
-- provider revision/snapshot/deletion guarantee. No auto-confirmation flag is set.
create table pos_signed_private.day_reconciliations(
 id bigint generated always as identity primary key,request_id uuid not null unique,run_id uuid not null,
 external_evidence jsonb not null,internal_evidence jsonb not null,result jsonb not null,actor text not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table pos_signed_private.day_reconciliations enable row level security;
create trigger immutable before update or delete on pos_signed_private.day_reconciliations for each row execute function inventory_writer_private.immutable();
create trigger no_truncate before truncate on pos_signed_private.day_reconciliations for each statement execute function inventory_writer_private.immutable();
create function public.pos_signed_reconcile_day(p_run uuid,p_external jsonb,p_request uuid,p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r record;old pos_signed_private.day_reconciliations%rowtype;internal_entries jsonb;v_result jsonb;
 v_missing jsonb;v_extra jsonb;v_changed jsonb;v_pending integer;v_amount numeric;v_external_amount numeric;
begin
 perform pos_signed_private.authorize(p_actor);perform inventory_writer_private.enter(true);
 if p_request is null or jsonb_typeof(p_external) is distinct from 'object' or jsonb_typeof(p_external->'entries') is distinct from 'array'
  or coalesce(p_external->>'source','') not in ('fiscal_export','provider_signed_export','accounting_close')
  or coalesce(p_external->>'documentSha256','') !~ '^[a-f0-9]{64}$' or length(coalesce(p_external->>'proof',''))<10
  or p_external->'closed' is distinct from 'true'::jsonb or not pos_inventory_shadow.valid_time(p_external->>'cutoff')
  or not pos_inventory_shadow.valid_time(p_external->>'windowFrom') or not pos_inventory_shadow.valid_time(p_external->>'windowTo')
  or (p_external->>'cutoff')::timestamptz>clock_timestamp()
 then raise exception 'SIGNED_INDEPENDENT_CLOSURE_EVIDENCE_REQUIRED' using errcode='22023';end if;
 if jsonb_array_length(p_external->'entries')<>(select count(distinct lower(e->>'refId')) from jsonb_array_elements(p_external->'entries') e)
  or exists(select 1 from jsonb_array_elements(p_external->'entries') e where nullif(btrim(e->>'refId'),'') is null
   or coalesce(e->>'hash','') !~ '^[a-f0-9]{64}$' or coalesce(e->>'amount','') !~ '^-?[0-9]+([.][0-9]+)?$'
   or jsonb_typeof(e->'canceled') is distinct from 'boolean')
 then raise exception 'SIGNED_CLOSURE_ENTRIES_INVALID' using errcode='22023';end if;
 select * into old from pos_signed_private.day_reconciliations where request_id=p_request;
 if found then
  if old.run_id<>p_run or old.external_evidence<>p_external then raise exception 'SIGNED_IDEMPOTENCY_CONFLICT';end if;
  return old.result;
 end if;
 -- D ingestion acquires scope before run row: preserve that lock order.
 select * into strict r from pos_ingest_private.runs where id=p_run;
 perform pg_advisory_xact_lock(hashtextextended('pos_ingest:'||r.scope,0));
 select * into strict r from pos_ingest_private.runs where id=p_run for share;
 if r.status<>'committed' or r.manifest->'collectionComplete' is distinct from 'true'::jsonb
  or p_external->>'branchId' is distinct from r.branch_id or p_external->>'scope' is distinct from r.scope
  or p_external->>'businessDate' is distinct from r.business_date::text
  or (p_external->>'windowFrom')::timestamptz is distinct from r.window_from
  or (p_external->>'windowTo')::timestamptz is distinct from r.window_to
  or (p_external->>'cutoff')::timestamptz<r.window_to or r.started_at<(p_external->>'cutoff')::timestamptz
 then raise exception 'SIGNED_CLOSURE_SCOPE_OR_COLLECTION_UNPROVEN' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('refId',s.ref_id,'hash',s.content_hash,'amount',m->'amount',
  'canceled',s.payload->'receipt'->'is_canceled') order by s.ref_id),'[]'),count(*) filter(where o.outcome not in ('accepted','duplicate')
   or h.accepted_snapshot is distinct from s.id or h.canonical_hash is distinct from pos_ingest_private.canonical_hash(h.receipt_id))
 into internal_entries,v_pending
 from pos_ingest_private.observations o join pos_ingest_private.snapshots s on s.id=o.snapshot_id
 left join pos_ingest_private.heads h on h.scope=s.scope and h.ref_id=s.ref_id
 cross join lateral jsonb_array_elements(r.manifest->'entries') m where o.run_id=p_run and lower(m->>'refId')=s.ref_id;
 if jsonb_array_length(internal_entries) is distinct from (r.manifest->>'selectedCount')::integer then raise exception 'SIGNED_CLOSURE_OBSERVATIONS_INCOMPLETE';end if;
 select coalesce(jsonb_agg(e->>'refId' order by e->>'refId'),'[]') into v_missing from jsonb_array_elements(p_external->'entries') e
 where not exists(select 1 from jsonb_array_elements(internal_entries) i where i->>'refId'=lower(e->>'refId'));
 select coalesce(jsonb_agg(i->>'refId' order by i->>'refId'),'[]') into v_extra from jsonb_array_elements(internal_entries) i
 where not exists(select 1 from jsonb_array_elements(p_external->'entries') e where lower(e->>'refId')=i->>'refId');
 select coalesce(jsonb_agg(i->>'refId' order by i->>'refId'),'[]') into v_changed from jsonb_array_elements(internal_entries) i
 join jsonb_array_elements(p_external->'entries') e on lower(e->>'refId')=i->>'refId'
 where e->>'hash' is distinct from i->>'hash' or (e->>'amount')::numeric is distinct from (i->>'amount')::numeric or e->'canceled' is distinct from i->'canceled';
 select coalesce(sum((e->>'amount')::numeric),0) into v_amount from jsonb_array_elements(internal_entries) e;
 select coalesce(sum((e->>'amount')::numeric),0) into v_external_amount from jsonb_array_elements(p_external->'entries') e;
 v_result:=jsonb_build_object('status',case when v_missing='[]' and v_extra='[]' and v_changed='[]' and v_pending=0 and v_amount=v_external_amount then 'matched_provisional' else 'held' end,
  'missingRefIds',v_missing,'extraRefIds',v_extra,'changedRefIds',v_changed,'uncertainCount',v_pending,
  'internalCount',jsonb_array_length(internal_entries),'externalCount',jsonb_array_length(p_external->'entries'),
  'internalAmount',v_amount,'externalAmount',v_external_amount,'recoveryBusinessDate',r.business_date,
  'sourceComplete',false,'automaticConfirmation',false,'reason','provider_order_and_external_document_authenticity_require_verification');
 insert into pos_signed_private.day_reconciliations(request_id,run_id,external_evidence,internal_evidence,result,actor)
 values(p_request,p_run,p_external,internal_entries,v_result,p_actor);
 return v_result;
end $$;
revoke all on pos_signed_private.day_reconciliations from public,anon,authenticated,service_role;
revoke all on function public.pos_signed_reconcile_day(uuid,jsonb,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.pos_signed_reconcile_day(uuid,jsonb,uuid,text) to service_role;
