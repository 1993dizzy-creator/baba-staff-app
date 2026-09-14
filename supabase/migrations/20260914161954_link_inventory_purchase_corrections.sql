-- Explicit purchase corrections. No legacy data backfill; apply separately after review.
begin;
alter table public.inventory_logs add column correction_of_inventory_log_id bigint
  references public.inventory_logs(id) on delete restrict;
alter table public.inventory_logs add constraint inventory_purchase_correction_not_self
  check (correction_of_inventory_log_id is null or correction_of_inventory_log_id <> id);
create index inventory_logs_purchase_correction_idx on public.inventory_logs(correction_of_inventory_log_id,id)
  where correction_of_inventory_log_id is not null;

create function public.inventory_purchase_correction_guard_v1() returns trigger
language plpgsql set search_path=pg_catalog,public as $guard$
declare v_root public.inventory_logs%rowtype; v_total numeric;
begin
  if TG_OP='UPDATE' and OLD.correction_of_inventory_log_id is distinct from NEW.correction_of_inventory_log_id then
    if OLD.correction_of_inventory_log_id is not null or current_user <> 'postgres' then
      raise exception 'PURCHASE_CORRECTION_LINK_IMMUTABLE';
    end if;
  end if;
  if NEW.correction_of_inventory_log_id is null then return NEW; end if;
  perform pg_advisory_xact_lock(hashtext('ledger_inventory_candidate:inventory-log:' || NEW.correction_of_inventory_log_id));
  select * into v_root from public.inventory_logs where id=NEW.correction_of_inventory_log_id for update;
  if v_root.id is null or v_root.correction_of_inventory_log_id is not null
     or v_root.reason is distinct from 'purchase' or v_root.change_quantity <= 0
     or NEW.source is distinct from 'edit_form' or NEW.reason is distinct from 'purchase'
     or NEW.item_id is distinct from v_root.item_id or NEW.unit is distinct from v_root.unit
     or (v_root.purchase_supplier_partner_id is not null and NEW.purchase_supplier_partner_id is not null and NEW.purchase_supplier_partner_id is distinct from v_root.purchase_supplier_partner_id)
     or ((v_root.purchase_supplier_partner_id is null or NEW.purchase_supplier_partner_id is null) and lower(btrim(coalesce(NEW.new_supplier,''))) is distinct from lower(btrim(coalesce(v_root.new_supplier,''))))
     or NEW.change_quantity is null or NEW.change_quantity::text in ('NaN','Infinity','-Infinity')
     or NEW.new_purchase_price is null or NEW.new_purchase_price <= 0 or NEW.new_purchase_price::text in ('NaN','Infinity','-Infinity') then
    raise exception 'INVALID_PURCHASE_CORRECTION_REFERENCE';
  end if;
  select v_root.change_quantity::numeric+coalesce(sum(change_quantity::numeric),0)+NEW.change_quantity::numeric into v_total
    from public.inventory_logs where correction_of_inventory_log_id=v_root.id and id<>NEW.id;
  if v_total < 0 then raise exception 'PURCHASE_CORRECTION_EXCEEDS_PURCHASE'; end if;
  return NEW;
end;
$guard$;
revoke all on function public.inventory_purchase_correction_guard_v1() from public,anon,authenticated,service_role;
create trigger inventory_purchase_correction_guard before insert or update on public.inventory_logs
  for each row execute function public.inventory_purchase_correction_guard_v1();

do $contract$
declare v_definition text;
begin
  v_definition := pg_get_functiondef('inventory_ledger_private.lock_sources(text[],date[])'::regprocedure);
  if position($anchor$  select coalesce(array_agg(k order by k collate "C"),'{}') into v_keys
    from (select distinct unnest(p_keys) k) s where k is not null;$anchor$ in v_definition)=0 then raise exception 'PURCHASE_CORRECTION_CONTRACT_MISMATCH: inventory_ledger_private.lock_sources(text[],date[])'; end if;
  v_definition := replace(v_definition,$anchor$  select coalesce(array_agg(k order by k collate "C"),'{}') into v_keys
    from (select distinct unnest(p_keys) k) s where k is not null;$anchor$,$replacement$  select coalesce(array_agg(k order by k collate "C"),'{}') into v_keys from (
    select distinct case when input_key ~ '^inventory-log:[0-9]+$' and length(substring(input_key from 15))<=19 and substring(input_key from 15)::numeric<=9223372036854775807
      then coalesce((select 'inventory-log:' || coalesce(correction_of_inventory_log_id,id)
        from public.inventory_logs where id=substring(input_key from 15)::bigint),input_key)
      else input_key end k from unnest(p_keys) input_key
  ) sources where k is not null;$replacement$);
  execute v_definition;
end;
$contract$;

do $contract$
declare v_definition text;
begin
  v_definition := pg_get_functiondef('inventory_ledger_private.rebook_source(bigint,text,bigint,bigint,date,numeric,text,text,bigint,jsonb,text,bigint,date)'::regprocedure);
  if position($anchor$p_amount is null or p_amount <= 0 or scale(p_amount) > 3$anchor$ in v_definition)=0 then raise exception 'PURCHASE_CORRECTION_CONTRACT_MISMATCH: inventory_ledger_private.rebook_source(bigint,text,bigint,bigint,date,numeric,text,text,bigint,jsonb,text,bigint,date)'; end if;
  v_definition := replace(v_definition,$anchor$p_amount is null or p_amount <= 0 or scale(p_amount) > 3$anchor$,$replacement$p_amount is null or p_amount < 0 or scale(p_amount) > 3$replacement$);
  if position($anchor$  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, recognition_month, amount,
    category_id, party_id, status, source_type, source_key, source_snapshot,
    source_fingerprint, source_synced_at, correction_of_id, memo,
    created_by, confirmed_by, economic_effect_sign
  ) values (
    v_operation, 'expense', (p_business_date + time '03:00')$anchor$ in v_definition)=0 then raise exception 'PURCHASE_CORRECTION_CONTRACT_MISMATCH: inventory_ledger_private.rebook_source(bigint,text,bigint,bigint,date,numeric,text,text,bigint,jsonb,text,bigint,date)'; end if;
  v_definition := replace(v_definition,$anchor$  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, recognition_month, amount,
    category_id, party_id, status, source_type, source_key, source_snapshot,
    source_fingerprint, source_synced_at, correction_of_id, memo,
    created_by, confirmed_by, economic_effect_sign
  ) values (
    v_operation, 'expense', (p_business_date + time '03:00')$anchor$,$replacement$  if p_amount=0 then
    -- Keep positive-amount invariants: reverse only; never insert a zero/negative purchase.
    update public.ledger_candidates set status='dismissed',resolved_transaction_id=null,
      resolved_by=p_actor_user_id,resolved_at=now(),dismissal_reason='Inventory purchase fully cancelled',
      source_snapshot=p_source_snapshot,source_fingerprint=p_source_fingerprint,
      source_drift_snapshot=null,source_drift_fingerprint=null,source_drift_detected_at=null,updated_at=now()
      where id=v_candidate.id;
    insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
      values(p_actor_user_id,'inventory_source_rebooked','transaction',v_reversal_id,v_before,
        jsonb_build_object('originalTransactionId',v_original.id,'reversalTransactionId',v_reversal_id,
          'rebookTransactionId',null,'newPayableId',null,'finalAmount',0,'sourceSnapshot',p_source_snapshot),p_reason);
    return jsonb_build_object('status','rebooked','originalTransactionId',v_original.id,
      'reversalTransactionId',v_reversal_id,'rebookTransactionId',null);
  end if;

  insert into public.ledger_transactions(
    operation_id, type, occurred_at, business_date, recognition_month, amount,
    category_id, party_id, status, source_type, source_key, source_snapshot,
    source_fingerprint, source_synced_at, correction_of_id, memo,
    created_by, confirmed_by, economic_effect_sign
  ) values (
    v_operation, 'expense', (p_business_date + time '03:00')$replacement$);
  execute v_definition;
end;
$contract$;

do $contract$
declare v_definition text;
begin
  v_definition := pg_get_functiondef('public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure);
  if position($anchor$  v_month date;
begin$anchor$ in v_definition)=0 then raise exception 'PURCHASE_CORRECTION_CONTRACT_MISMATCH: public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'; end if;
  v_definition := replace(v_definition,$anchor$  v_month date;
begin$anchor$,$replacement$  v_month date;
  v_root_id bigint;
  v_corrections bigint[];
begin$replacement$);
  if position($anchor$  perform inventory_ledger_private.lock_sources(array[v_key]);
  select * into v_log from public.inventory_logs where id = p_inventory_log_id for update;$anchor$ in v_definition)=0 then raise exception 'PURCHASE_CORRECTION_CONTRACT_MISMATCH: public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'; end if;
  v_definition := replace(v_definition,$anchor$  perform inventory_ledger_private.lock_sources(array[v_key]);
  select * into v_log from public.inventory_logs where id = p_inventory_log_id for update;$anchor$,$replacement$  select coalesce(correction_of_inventory_log_id,id) into v_root_id from public.inventory_logs where id=p_inventory_log_id;
  v_key := 'inventory-log:' || coalesce(v_root_id,p_inventory_log_id);
  perform inventory_ledger_private.lock_sources(array[v_key]);
  select * into v_log from public.inventory_logs where id = v_root_id for update;$replacement$);
  if position($anchor$    v_amount := round(v_log.change_quantity::numeric * v_log.new_purchase_price::numeric, 3);$anchor$ in v_definition)=0 then raise exception 'PURCHASE_CORRECTION_CONTRACT_MISMATCH: public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'; end if;
  v_definition := replace(v_definition,$anchor$    v_amount := round(v_log.change_quantity::numeric * v_log.new_purchase_price::numeric, 3);$anchor$,$replacement$    select array_agg(id order by id) into v_corrections from public.inventory_logs
      where correction_of_inventory_log_id=v_log.id;
    if v_corrections is not null then
      select v_log.change_quantity::numeric+coalesce(sum(change_quantity::numeric),0) into v_log.change_quantity
        from public.inventory_logs where correction_of_inventory_log_id=v_log.id;
      select new_purchase_price into v_log.new_purchase_price from public.inventory_logs
        where correction_of_inventory_log_id=v_log.id order by id desc limit 1;
    end if;
    v_amount := round(v_log.change_quantity::numeric * v_log.new_purchase_price::numeric, 3);$replacement$);
  if position($anchor$    if coalesce(v_log.reason,'') <> 'purchase' or coalesce(v_log.change_quantity,0) <= 0
       or v_log.business_date is null or v_amount is null or v_amount <= 0 then$anchor$ in v_definition)=0 then raise exception 'PURCHASE_CORRECTION_CONTRACT_MISMATCH: public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'; end if;
  v_definition := replace(v_definition,$anchor$    if coalesce(v_log.reason,'') <> 'purchase' or coalesce(v_log.change_quantity,0) <= 0
       or v_log.business_date is null or v_amount is null or v_amount <= 0 then$anchor$,$replacement$    if v_corrections is not null and v_amount=0 and
       (v_candidate.id is null or (v_candidate.status='dismissed' and v_candidate.dismissal_reason='Inventory purchase fully cancelled')) then
      v_code := 'PURCHASE_CANCELLED';
    elsif coalesce(v_log.reason,'') <> 'purchase' or coalesce(v_log.change_quantity,0) < 0
       or (coalesce(v_log.change_quantity,0)=0 and v_corrections is null)
       or v_log.business_date is null or v_amount is null or v_amount < 0
       or (v_amount=0 and v_corrections is null) then$replacement$);
  if position($anchor$        v_code := 'NOT_A_PURCHASE';$anchor$ in v_definition)=0 then raise exception 'PURCHASE_CORRECTION_CONTRACT_MISMATCH: public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'; end if;
  v_definition := replace(v_definition,$anchor$        v_code := 'NOT_A_PURCHASE';$anchor$,$replacement$        if v_log.reason='purchase' and v_log.source='edit_form' and v_log.change_quantity<0 then
          v_status := 'review_required'; v_code := 'PURCHASE_CORRECTION_REFERENCE_REQUIRED';
        else v_code := 'NOT_A_PURCHASE'; end if;$replacement$);
  if position($anchor$      -- PostgREST timestamp formatting varied historically.$anchor$ in v_definition)=0 then raise exception 'PURCHASE_CORRECTION_CONTRACT_MISMATCH: public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'; end if;
  v_definition := replace(v_definition,$anchor$      -- PostgREST timestamp formatting varied historically.$anchor$,$replacement$      if v_corrections is not null then
        v_snapshot := v_snapshot || jsonb_build_object('inventory_correction_log_ids',v_corrections);
      end if;
      -- PostgREST timestamp formatting varied historically.$replacement$);
  execute v_definition;
end;
$contract$;


-- Atomic Inventory mutation + explicit correction log. Projection is called AFTER commit by the API.
create function public.inventory_apply_purchase_correction_v1(
  p_item_id bigint,p_purchase_log_id bigint,p_expected_quantity numeric,p_payload jsonb,
  p_business_date date,p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $apply$
declare
  v_old public.inventory%rowtype; v_new public.inventory%rowtype;
  v_root public.inventory_logs%rowtype; v_log_id bigint; v_actor jsonb; v_columns text; v_values text; v_log jsonb; v_field text;
begin
  select to_jsonb(u) into v_actor from public.users u where id=p_actor_user_id and is_active and app_login_enabled;
  if v_actor is null then return jsonb_build_object('status','forbidden'); end if;
  if p_expected_quantity is null or p_business_date is null or jsonb_typeof(p_payload) is distinct from 'object'
     or not (p_payload ? 'quantity') then return jsonb_build_object('status','invalid_payload'); end if;
  if exists(select 1 from jsonb_object_keys(p_payload) k where k <> all(array[
    'quantity','purchase_price','item_name','item_name_vi','part','category','category_vi','note','unit','code',
    'supplier','supplier_partner_id','low_stock_threshold','low_stock_enabled','package_content_quantity',
    'package_content_unit','updated_at','updated_by_name','updated_by_username']::text[])) then
    return jsonb_build_object('status','invalid_payload');
  end if;
  perform inventory_ledger_private.lock_sources(array['inventory-log:' || p_purchase_log_id]);
  select * into v_root from public.inventory_logs where id=p_purchase_log_id;
  if v_root.id is null or v_root.item_id is distinct from p_item_id or v_root.reason is distinct from 'purchase'
     or v_root.change_quantity<=0 or v_root.correction_of_inventory_log_id is not null then
    return jsonb_build_object('status','invalid_purchase_reference');
  end if;
  select * into v_old from public.inventory where id=p_item_id for update;
  if v_old.id is null then return jsonb_build_object('status','not_found'); end if;
  if v_old.quantity is distinct from p_expected_quantity then return jsonb_build_object('status','quantity_conflict'); end if;
  p_payload := p_payload || jsonb_build_object('updated_at',now(),'updated_by_name',v_actor->>'name','updated_by_username',v_actor->>'username');
  select string_agg(format('%I=(jsonb_populate_record(null::public.inventory,$2)).%I',k,k),',') into v_columns
    from jsonb_object_keys(p_payload) k;
  execute format('update public.inventory set %s where id=$1 returning *',v_columns) into v_new using p_item_id,p_payload;
  v_log := jsonb_build_object(
    'item_id',p_item_id,'source_actor_user_id',p_actor_user_id,'purchase_supplier_partner_id',v_new.supplier_partner_id,
    'correction_of_inventory_log_id',p_purchase_log_id,'item_name',to_jsonb(v_new)->>'item_name',
    'item_name_vi',to_jsonb(v_new)->>'item_name_vi','action','update','part',to_jsonb(v_new)->>'part',
    'category',to_jsonb(v_new)->>'category','category_vi',to_jsonb(v_new)->>'category_vi',
    'unit',to_jsonb(v_new)->>'unit','code',to_jsonb(v_new)->>'code','source','edit_form','reason','purchase',
    'business_date',p_business_date,'actor_name',v_actor->>'name','actor_username',v_actor->>'username',
    'prev_quantity',v_old.quantity,'new_quantity',v_new.quantity,'change_quantity',round((v_new.quantity-v_old.quantity)::numeric,3),
    'prev_purchase_price',v_old.purchase_price,'new_purchase_price',v_new.purchase_price,
    'prev_supplier',to_jsonb(v_old)->>'supplier','new_supplier',to_jsonb(v_new)->>'supplier'
  );
  foreach v_field in array array['note','code','unit','category','category_vi','part','low_stock_threshold'] loop
    v_log := v_log || jsonb_build_object('prev_' || v_field,to_jsonb(v_old)->v_field,'new_' || v_field,to_jsonb(v_new)->v_field);
  end loop;
  -- Default identity/timestamps are supplied by the table, not jsonb_populate_record.
  select string_agg(format('%I',key),','),string_agg(format('(jsonb_populate_record(null::public.inventory_logs,$1)).%I',key),',')
    into v_columns,v_values from jsonb_object_keys(v_log) key
    where exists(select 1 from pg_attribute where attrelid='public.inventory_logs'::regclass and attname=key and not attisdropped);
  execute format('insert into public.inventory_logs(%s) select %s returning id',v_columns,v_values) into v_log_id using v_log;
  if v_old.purchase_price is distinct from v_new.purchase_price then
    insert into public.inventory_price_logs(item_id,item_name,item_code,old_price,new_price,diff,business_date,source,reason,actor_username,note)
      values(p_item_id,to_jsonb(v_new)->>'item_name',to_jsonb(v_new)->>'code',v_old.purchase_price,v_new.purchase_price,
        round((v_new.purchase_price-v_old.purchase_price)::numeric,3),p_business_date,'edit_form','manual_price_update',v_actor->>'username',null);
  end if;
  insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
    values(p_actor_user_id,'inventory_purchase_correction_linked','inventory_log',v_log_id,null,
      jsonb_build_object('purchaseLogId',p_purchase_log_id,'correctionLogId',v_log_id),'Explicit purchase correction');
  return jsonb_build_object('status','ok','inventory',to_jsonb(v_new),'inventoryLogId',v_log_id);
end;
$apply$;

alter function public.inventory_apply_purchase_correction_v1(bigint,bigint,numeric,jsonb,date,bigint) owner to postgres;
revoke all on function public.inventory_apply_purchase_correction_v1(bigint,bigint,numeric,jsonb,date,bigint) from public,anon,authenticated,service_role;
grant execute on function public.inventory_apply_purchase_correction_v1(bigint,bigint,numeric,jsonb,date,bigint) to service_role;

-- Explicit audited legacy link; never repeats an Inventory quantity adjustment.
create function public.inventory_link_purchase_correction_v1(
  p_correction_log_id bigint,p_purchase_log_id bigint,p_actor_user_id bigint,p_reason text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $link$
declare v_correction public.inventory_logs%rowtype;
begin
  if not exists(select 1 from public.users where id=p_actor_user_id and is_active and app_login_enabled and lower(role::text) in ('owner','master'))
    then return jsonb_build_object('status','forbidden'); end if;
  if nullif(btrim(p_reason),'') is null then return jsonb_build_object('status','reason_required'); end if;
  perform inventory_ledger_private.lock_sources(array['inventory-log:' || p_purchase_log_id]);
  select * into v_correction from public.inventory_logs where id=p_correction_log_id for update;
  if v_correction.id is null then return jsonb_build_object('status','not_found'); end if;
  if v_correction.correction_of_inventory_log_id is not null and v_correction.correction_of_inventory_log_id<>p_purchase_log_id
    then return jsonb_build_object('status','invalid_purchase_reference'); end if;
  if v_correction.correction_of_inventory_log_id is null then
    -- Owner explicitly verifies purchase intent; preserve its previous reason in the audit.
    update public.inventory_logs set correction_of_inventory_log_id=p_purchase_log_id,reason='purchase' where id=p_correction_log_id;
    insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
      values(p_actor_user_id,'inventory_purchase_correction_linked','inventory_log',p_correction_log_id,
        to_jsonb(v_correction),jsonb_build_object('purchaseLogId',p_purchase_log_id,'correctionLogId',p_correction_log_id,'reason','purchase'),p_reason);
  end if;
  return public.ledger_project_inventory_purchase_log_v1(p_correction_log_id,p_actor_user_id);
end;
$link$;
alter function public.inventory_link_purchase_correction_v1(bigint,bigint,bigint,text) owner to postgres;
revoke all on function public.inventory_link_purchase_correction_v1(bigint,bigint,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.inventory_link_purchase_correction_v1(bigint,bigint,bigint,text) to service_role;
commit;
