-- LOCAL REVIEW ONLY. Not applied to Production. No table change, no backfill.
-- Requires 20261030150000_inventory_purchase_billed_amount.sql (billed columns).
--
-- New inventory item + its first log (+ first price history, + Ledger projection for a
-- purchase) in ONE transaction for POST /api/inventory/items. Before this, the route wrote
-- the item, the log and the price history as separate requests, so a failed log left an
-- item with stock but no receipt, and nothing in the Ledger.
-- * Same rows as the route wrote: item columns from the request (allow-listed), one 'create'
--   log with source='create', one price log when the item has a purchase price.
-- * A purchase registration must increase stock after numeric(10,2) rounding; its billed
--   state follows the 실청구금액 rules (auto | manual with a positive amount and price).
-- * The projector records its own status (synced/pending/review_required/failed) in this
--   transaction; any other failure rolls back the item, log and price history together.
-- * Duplicate-name checks stay in the route (existing behavior).
begin;

do $contract$
begin
  if not exists(select 1 from pg_attribute where attrelid='public.inventory_logs'::regclass and attname='billed_amount_mode' and not attisdropped) then
    raise exception 'INVENTORY_CREATE_REQUIRES_BILLED_AMOUNT_MIGRATION';
  end if;
  if to_regprocedure('public.inventory_create_with_receipt_v1(jsonb,text,date,bigint)') is not null then
    raise exception 'INVENTORY_CREATE_WITH_RECEIPT_ALREADY_APPLIED';
  end if;
end;
$contract$;

create function public.inventory_create_with_receipt_v1(
  p_payload jsonb,p_reason text,p_business_date date,p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_actor jsonb; v_new public.inventory%rowtype; v_columns text; v_values text;
  v_log jsonb; v_log_id bigint; v_billed numeric; v_billed_mode text; v_quantity numeric; v_price numeric;
  v_projection jsonb;
begin
  select to_jsonb(u) into v_actor from public.users u where id=p_actor_user_id and is_active and app_login_enabled;
  if v_actor is null then return jsonb_build_object('status','forbidden'); end if;
  if p_business_date is null or jsonb_typeof(p_payload) is distinct from 'object'
     or p_reason is null or p_reason <> all(array['purchase','stock_check','service','other','sale_deduction','unclassified'])
     or exists(select 1 from jsonb_object_keys(p_payload) k where k <> all(array[
       'item_name','item_name_vi','part','category','category_vi','quantity','unit','note','code',
       'purchase_price','supplier','supplier_partner_id','low_stock_threshold','low_stock_enabled',
       'package_content_quantity','package_content_unit','image_path','updated_at','updated_by_name','updated_by_username',
       'billed_amount','billed_amount_mode']::text[])) then
    return jsonb_build_object('status','invalid_payload');
  end if;
  begin
    v_quantity:=coalesce((p_payload->>'quantity')::numeric,0);
    v_price:=nullif(p_payload->>'purchase_price','')::numeric;
    v_billed:=nullif(p_payload->>'billed_amount','')::numeric;
  exception when others then
    return jsonb_build_object('status','invalid_payload');
  end;
  v_billed_mode:=p_payload->>'billed_amount_mode';
  p_payload:=p_payload - array['billed_amount','billed_amount_mode']::text[];
  -- A purchase registration is a receipt: it must still increase stock as stored (numeric(10,2)).
  if p_reason='purchase' and not (v_quantity::text not in ('NaN','Infinity','-Infinity') and round(v_quantity,2)>0) then
    return jsonb_build_object('status','purchase_quantity_must_increase');
  end if;
  if (v_billed_mode is not null or v_billed is not null) and (
       v_billed_mode is null or v_billed_mode <> all(array['auto','manual'])
       or (v_billed_mode='auto' and v_billed is not null)
       or (v_billed_mode='manual' and (p_reason<>'purchase' or v_billed is null
         or v_billed::text in ('NaN','Infinity','-Infinity') or v_billed<=0 or v_billed<>round(v_billed,3)
         or v_billed>=10000000000000 or not coalesce(v_price>0,false)))) then
    return jsonb_build_object('status','invalid_billed_amount');
  end if;
  if p_reason<>'purchase' then v_billed_mode:=null; v_billed:=null; end if;

  -- All writes below commit together or not at all.
  p_payload:=p_payload || jsonb_build_object('updated_at',clock_timestamp(),
    'updated_by_name',v_actor->>'name','updated_by_username',v_actor->>'username');
  select string_agg(format('%I',k),','),string_agg(format('(jsonb_populate_record(null::public.inventory,$1)).%I',k),',')
    into v_columns,v_values from jsonb_object_keys(p_payload) k;
  execute format('insert into public.inventory(%s) select %s returning *',v_columns,v_values) into v_new using p_payload;

  -- The same first log the route wrote (action 'create', source 'create').
  v_log:=jsonb_build_object(
    'item_id',v_new.id,'source_actor_user_id',p_actor_user_id,'purchase_supplier_partner_id',v_new.supplier_partner_id,
    'item_name',v_new.item_name,'item_name_vi',v_new.item_name_vi,'action','create',
    'part',v_new.part,'category',v_new.category,'category_vi',v_new.category_vi,
    'prev_quantity',0,'new_quantity',coalesce(v_new.quantity,0),'change_quantity',coalesce(v_new.quantity,0),
    'prev_purchase_price',null,'new_purchase_price',v_new.purchase_price,
    'prev_note',null,'new_note',v_new.note,'prev_supplier',null,'new_supplier',v_new.supplier,
    'prev_code',null,'new_code',v_new.code,'prev_unit',null,'new_unit',v_new.unit,
    'prev_category',null,'new_category',v_new.category,'prev_category_vi',null,'new_category_vi',v_new.category_vi,
    'prev_part',null,'new_part',v_new.part,'unit',v_new.unit,'code',v_new.code,
    'actor_name',coalesce(v_actor->>'name',''),'actor_username',coalesce(v_actor->>'username',''),
    'prev_low_stock_threshold',null,'new_low_stock_threshold',coalesce(v_new.low_stock_threshold,1),
    'reason',p_reason,'source','create','business_date',p_business_date);
  if v_billed_mode is not null then
    v_log:=v_log || jsonb_build_object('billed_amount',v_billed,'billed_amount_mode',v_billed_mode);
  end if;
  select string_agg(format('%I',key),','),string_agg(format('(jsonb_populate_record(null::public.inventory_logs,$1)).%I',key),',')
    into v_columns,v_values from jsonb_object_keys(v_log) key
    where exists(select 1 from pg_attribute where attrelid='public.inventory_logs'::regclass and attname=key and not attisdropped);
  execute format('insert into public.inventory_logs(%s) select %s returning id',v_columns,v_values) into v_log_id using v_log;
  if v_log_id is null then raise exception 'INVENTORY_REQUIRED_AUDIT_MISSING'; end if;

  -- First price history (old price none), as insertInventoryPriceLog did for a create.
  if v_new.purchase_price is not null then
    insert into public.inventory_price_logs(item_id,item_name,item_code,old_price,new_price,diff,business_date,source,reason,actor_username,note)
    values(v_new.id,nullif(btrim(v_new.item_name),''),nullif(btrim(v_new.code),''),null,v_new.purchase_price,null,
      p_business_date,'create','create',nullif(btrim(v_actor->>'username'),''),null);
  end if;

  if p_reason='purchase' then
    v_projection:=public.ledger_project_inventory_purchase_log_v1(v_log_id,p_actor_user_id);
  end if;
  -- Deliberately do not catch write errors: PostgreSQL rolls back the item and all its logs together.
  return jsonb_build_object('status','ok','item',to_jsonb(v_new),'inventoryLogId',v_log_id,'ledgerSync',v_projection);
end;
$$;
alter function public.inventory_create_with_receipt_v1(jsonb,text,date,bigint) owner to postgres;
revoke all on function public.inventory_create_with_receipt_v1(jsonb,text,date,bigint) from public,anon,authenticated,service_role;
grant execute on function public.inventory_create_with_receipt_v1(jsonb,text,date,bigint) to service_role;
commit;
