-- Local-only follow-up. No backfill; existing correction/rebook implementation is retained.
begin;

create function inventory_ledger_private.item_matches_expected_v1(p_current jsonb,p_expected jsonb)
-- timestamptz input depends on session TimeZone/DateStyle; it is not immutable.
returns boolean language sql stable set search_path=pg_catalog as $$
  select jsonb_typeof(p_expected) = 'object'
    and p_expected ?& array['quantity','is_active','updated_at']
    and (p_current->>'updated_at')::timestamptz is not distinct from (p_expected->>'updated_at')::timestamptz
    and p_current @> (p_expected - 'updated_at');
$$;
revoke all on function inventory_ledger_private.item_matches_expected_v1(jsonb,jsonb) from public,anon,authenticated,service_role;

create function public.inventory_update_with_audit_v1(
  p_item_id bigint,p_expected_item jsonb,p_payload jsonb,p_business_date date,
  p_actor_user_id bigint,p_reason text,p_source text,p_price_business_date date
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $save$
declare
  v_old public.inventory%rowtype; v_new public.inventory%rowtype;
  v_actor jsonb; v_columns text; v_values text; v_log jsonb; v_log_id bigint; v_field text;
begin
  select to_jsonb(u) into v_actor from public.users u where id=p_actor_user_id and is_active and app_login_enabled;
  if v_actor is null then return jsonb_build_object('status','forbidden'); end if;
  if p_business_date is null or p_price_business_date is null
    or jsonb_typeof(p_payload) is distinct from 'object'
    or p_reason is null or p_reason <> all(array['purchase','stock_check','service','other','sale_deduction','unclassified'])
    or p_source is null or p_source <> all(array['quick_save','edit_form']) then
    return jsonb_build_object('status','invalid_payload');
  end if;
  if exists(select 1 from jsonb_object_keys(p_payload) k where k <> all(array[
    'quantity','purchase_price','item_name','item_name_vi','part','category','category_vi','note','unit','code',
    'supplier','supplier_partner_id','low_stock_threshold','low_stock_enabled','package_content_quantity',
    'package_content_unit','image_path','updated_at','updated_by_name','updated_by_username']::text[])) then
    return jsonb_build_object('status','invalid_payload');
  end if;
  select * into v_old from public.inventory where id=p_item_id for update;
  if v_old.id is null then return jsonb_build_object('status','not_found'); end if;
  if to_jsonb(v_old)->>'is_active' = 'false' and lower(v_actor->>'role') <> all(array['leader','manager','owner','master']) then
    return jsonb_build_object('status','forbidden');
  end if;
  if inventory_ledger_private.item_matches_expected_v1(to_jsonb(v_old),p_expected_item) is not true then
    return jsonb_build_object('status','inventory_conflict');
  end if;
  -- Purchase reductions must retain the original-root correction/audit path.
  -- Other reasons (stock checks, sales, service) may legitimately reduce stock.
  if p_reason = 'purchase' and p_payload ? 'quantity'
    and coalesce((p_payload->>'quantity')::numeric,0) < coalesce(v_old.quantity,0) then
    return jsonb_build_object('status','purchase_correction_required');
  end if;
  p_payload := p_payload || jsonb_build_object(
    'updated_at',greatest(clock_timestamp(),v_old.updated_at + interval '1 millisecond'),
    'updated_by_name',v_actor->>'name','updated_by_username',v_actor->>'username');
  select string_agg(format('%I=(jsonb_populate_record(null::public.inventory,$2)).%I',k,k),',')
    into v_columns from jsonb_object_keys(p_payload) k;
  execute format('update public.inventory set %s where id=$1 returning *',v_columns) into v_new using p_item_id,p_payload;
  v_log := jsonb_build_object(
    'item_id',p_item_id,'source_actor_user_id',p_actor_user_id,'purchase_supplier_partner_id',v_new.supplier_partner_id,
    'item_name',to_jsonb(v_new)->>'item_name','item_name_vi',to_jsonb(v_new)->>'item_name_vi','action','update',
    'part',to_jsonb(v_new)->>'part','category',to_jsonb(v_new)->>'category','category_vi',to_jsonb(v_new)->>'category_vi',
    'unit',to_jsonb(v_new)->>'unit','code',to_jsonb(v_new)->>'code','source',p_source,'reason',p_reason,
    'business_date',p_business_date,'actor_name',v_actor->>'name','actor_username',v_actor->>'username',
    'prev_quantity',round(coalesce(v_old.quantity,0)::numeric,3),'new_quantity',round(coalesce(v_new.quantity,0)::numeric,3),
    'change_quantity',round(round(coalesce(v_new.quantity,0)::numeric,3)-round(coalesce(v_old.quantity,0)::numeric,3),3),
    'prev_purchase_price',v_old.purchase_price,'new_purchase_price',v_new.purchase_price);
  foreach v_field in array array['note','supplier','code','unit','category','category_vi','part','low_stock_threshold'] loop
    v_log := v_log || jsonb_build_object('prev_' || v_field,to_jsonb(v_old)->v_field,'new_' || v_field,to_jsonb(v_new)->v_field);
  end loop;
  -- Include only installed audit columns; preserve table identity/timestamp defaults.
  select string_agg(format('%I',key),','),string_agg(format('(jsonb_populate_record(null::public.inventory_logs,$1)).%I',key),',')
    into v_columns,v_values from jsonb_object_keys(v_log) key
    where exists(select 1 from pg_attribute where attrelid='public.inventory_logs'::regclass and attname=key and not attisdropped);
  execute format('insert into public.inventory_logs(%s) select %s returning id',v_columns,v_values) into v_log_id using v_log;
  if v_log_id is null then raise exception 'INVENTORY_REQUIRED_AUDIT_MISSING'; end if;
  if v_new.purchase_price is not null
    and (v_old.purchase_price is null or round(v_old.purchase_price::numeric,3) <> round(v_new.purchase_price::numeric,3))
    and ((p_source='quick_save' and p_reason='purchase') or (p_source='edit_form' and p_payload ? 'purchase_price')) then
    insert into public.inventory_price_logs(item_id,item_name,item_code,old_price,new_price,diff,business_date,source,reason,actor_username,note)
    values(p_item_id,to_jsonb(v_new)->>'item_name',to_jsonb(v_new)->>'code',v_old.purchase_price,v_new.purchase_price,
      round((v_new.purchase_price-v_old.purchase_price)::numeric,3),p_price_business_date,p_source,
      case when p_source='quick_save' then 'purchase' else 'manual_price_update' end,v_actor->>'username',null);
  end if;
  -- Deliberately do not catch write errors: PostgreSQL rolls back master and all required logs together.
  return jsonb_build_object('status','ok','inventoryLogId',v_log_id);
end;
$save$;
alter function public.inventory_update_with_audit_v1(bigint,jsonb,jsonb,date,bigint,text,text,date) owner to postgres;
revoke all on function public.inventory_update_with_audit_v1(bigint,jsonb,jsonb,date,bigint,text,text,date) from public,anon,authenticated,service_role;
grant execute on function public.inventory_update_with_audit_v1(bigint,jsonb,jsonb,date,bigint,text,text,date) to service_role;

create function public.inventory_apply_purchase_correction_v2(
  p_item_id bigint,p_purchase_log_id bigint,p_expected_quantity numeric,p_expected_item jsonb,
  p_payload jsonb,p_business_date date,p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $correct$
declare v_old public.inventory%rowtype; v_result jsonb; v_actor_role text;
begin
  select lower(role::text) into v_actor_role from public.users where id=p_actor_user_id and is_active and app_login_enabled;
  if v_actor_role is null then return jsonb_build_object('status','forbidden'); end if;
  -- Same source -> item lock ordering as the original implementation.
  perform inventory_ledger_private.lock_sources(array['inventory-log:' || p_purchase_log_id]);
  select * into v_old from public.inventory where id=p_item_id for update;
  if v_old.id is null then return jsonb_build_object('status','not_found'); end if;
  if to_jsonb(v_old)->>'is_active' = 'false' and v_actor_role <> all(array['leader','manager','owner','master']) then
    return jsonb_build_object('status','forbidden');
  end if;
  if v_old.quantity is distinct from p_expected_quantity then return jsonb_build_object('status','quantity_conflict'); end if;
  if inventory_ledger_private.item_matches_expected_v1(to_jsonb(v_old),p_expected_item) is not true then
    return jsonb_build_object('status','inventory_conflict');
  end if;
  -- Existing correction audit, family guard, price history and Ledger projection contract are reused.
  v_result := public.inventory_apply_purchase_correction_v1(p_item_id,p_purchase_log_id,p_expected_quantity,p_payload,p_business_date,p_actor_user_id);
  if v_result->>'status' = 'ok' then
    if nullif(v_result->>'inventoryLogId','') is null then raise exception 'INVENTORY_REQUIRED_AUDIT_MISSING'; end if;
    update public.inventory set updated_at=greatest(clock_timestamp(),v_old.updated_at + interval '1 millisecond') where id=p_item_id;
    v_result := jsonb_set(v_result,'{inventory}',(select to_jsonb(i) from public.inventory i where id=p_item_id));
  end if;
  return v_result;
end;
$correct$;
alter function public.inventory_apply_purchase_correction_v2(bigint,bigint,numeric,jsonb,jsonb,date,bigint) owner to postgres;
revoke all on function public.inventory_apply_purchase_correction_v2(bigint,bigint,numeric,jsonb,jsonb,date,bigint) from public,anon,authenticated,service_role;
grant execute on function public.inventory_apply_purchase_correction_v2(bigint,bigint,numeric,jsonb,jsonb,date,bigint) to service_role;
-- Keep legacy v1 service access during rollout. Retire it in a separate migration
-- only after the new application is deployed and verified in real use.
commit;
