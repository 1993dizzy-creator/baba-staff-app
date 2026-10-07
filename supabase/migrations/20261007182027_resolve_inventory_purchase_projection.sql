-- Local implementation only. No backfill; every repair requires an explicit owner selection.
begin;

-- Shared read-only preview/revalidation. Repair takes canonical source/month locks first.
create function inventory_ledger_private.inspect_purchase_repair(p_issue_id bigint,p_root_id bigint)
returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare
  i public.inventory_logs%rowtype; r public.inventory_logs%rowtype;
  c public.ledger_candidates%rowtype; t public.ledger_transactions%rowtype;
  p public.ledger_payables%rowtype; s public.ledger_inventory_projection_status%rowtype;
  q numeric; price numeric; code text; m date;
begin
  select * into i from public.inventory_logs where id=p_issue_id;
  select * into s from public.ledger_inventory_projection_status where inventory_log_id=p_issue_id;
  select * into r from public.inventory_logs where id=p_root_id;
  if i.id is null then code:='ISSUE_NOT_FOUND';
  elsif i.correction_of_inventory_log_id is not null then code:='ISSUE_ALREADY_LINKED';
  elsif s.status is distinct from 'review_required' or s.code is distinct from 'PURCHASE_CORRECTION_REFERENCE_REQUIRED'
    then code:='ISSUE_NOT_RESOLVABLE';
  elsif i.reason is distinct from 'purchase' or i.source is distinct from 'edit_form' or i.change_quantity is null
    or i.change_quantity>=0 or i.change_quantity::text in ('NaN','Infinity','-Infinity') then code:='INVALID_ISSUE';
  elsif r.id is null or r.reason is distinct from 'purchase' or r.change_quantity is null or r.change_quantity<=0
    or r.change_quantity::text in ('NaN','Infinity','-Infinity') or r.correction_of_inventory_log_id is not null
    or r.created_at>i.created_at or r.business_date>i.business_date then code:='INVALID_PURCHASE_ROOT';
  elsif r.item_id is distinct from i.item_id then code:='ITEM_MISMATCH';
  elsif r.unit is distinct from i.unit then code:='UNIT_MISMATCH';
  elsif (r.purchase_supplier_partner_id is not null and i.purchase_supplier_partner_id is not null
    and r.purchase_supplier_partner_id<>i.purchase_supplier_partner_id)
    or ((r.purchase_supplier_partner_id is null or i.purchase_supplier_partner_id is null)
      and lower(btrim(coalesce(r.new_supplier,'')))<>lower(btrim(coalesce(i.new_supplier,'')))) then code:='SUPPLIER_MISMATCH';
  elsif i.new_purchase_price is null or i.new_purchase_price<=0 or i.new_purchase_price::text in ('NaN','Infinity','-Infinity')
    then code:='INVALID_PURCHASE_PRICE';
  end if;
  if code is not null then return jsonb_build_object('safe',false,'code',code); end if;
  -- Price changes follow the existing correction identity policy; latest log ID wins.
  select r.change_quantity+coalesce(sum(change_quantity),0)+i.change_quantity into q
    from public.inventory_logs where correction_of_inventory_log_id=r.id;
  select new_purchase_price into price from (
    select id,new_purchase_price from public.inventory_logs where correction_of_inventory_log_id=r.id
    union all select i.id,i.new_purchase_price
  ) prices order by id desc limit 1;
  select * into c from public.ledger_candidates where source_type='inventory_purchase_log'
    and source_key='inventory-log:' || r.id order by id desc limit 1;
  select * into t from public.ledger_transactions where id=c.resolved_transaction_id;
  select * into p from public.ledger_payables where expense_transaction_id=t.id;
  if q<0 then code:='PURCHASE_CORRECTION_EXCEEDS_PURCHASE';
  elsif c.id is null or c.status is distinct from 'confirmed' or t.id is null then code:='INVALID_CANDIDATE_STATE';
  elsif exists(select 1 from public.ledger_candidates where source_type='inventory_purchase_log'
    and source_key='inventory-log:' || i.id) then code:='ISSUE_ALREADY_BOOKED';
  elsif t.status is distinct from 'confirmed' or t.type is distinct from 'expense'
    or t.source_type not in ('inventory_purchase_candidate','inventory_purchase_rebook') then code:='INVALID_TRANSACTION_STATE';
  elsif t.amount is distinct from c.proposed_amount then code:='MANUAL_LEDGER_OVERRIDE';
  elsif not exists(select 1 from public.ledger_categories where id=t.category_id and kind='expense' and is_active)
    then code:='INVALID_CATEGORY';
  elsif p.id is not null and not exists(select 1 from public.ledger_parties where id=t.party_id and is_active)
    then code:='INVALID_PAYABLE_STATE';
  elsif exists(select 1 from public.ledger_transactions where correction_of_id=t.id
    and source_type in ('inventory_purchase_reversal','inventory_purchase_rebook')) then code:='ALREADY_REBOOKED';
  elsif p.id is not null and (p.status is distinct from 'unpaid' or exists(
    select 1 from public.ledger_payable_allocations where payable_id=p.id)) then code:='PAYABLE_ALREADY_PAID';
  elsif p.id is not null and (p.original_amount is distinct from t.amount or p.party_id is distinct from t.party_id
    or exists(select 1 from public.ledger_movements where transaction_id=t.id)) then code:='INVALID_PAYABLE_STATE';
  elsif p.id is null and ((select count(*) from public.ledger_movements where transaction_id=t.id)<>1
    or (select count(*) from public.ledger_movements where transaction_id=t.id and amount=-t.amount)<>1)
    then code:='INVALID_PAYMENT_STATE';
  elsif p.id is null and not exists(select 1 from public.ledger_movements movement
    join public.ledger_fund_accounts account on account.id=movement.fund_account_id
    where movement.transaction_id=t.id and account.is_active and account.is_business_fund and account.type<>'card_clearing'
      and account.active_from<=r.business_date and (account.active_to is null or account.active_to>=r.business_date))
    then code:='INVALID_ACCOUNT';
  end if;
  for m in select distinct date_trunc('month',d)::date from unnest(array[
    i.business_date,r.business_date,c.business_date,c.proposed_recognition_month,t.business_date,t.recognition_month]) d
  loop
    if m is null then code:=coalesce(code,'INVALID_BUSINESS_DATE');
    elsif public.ledger_month_is_closed_v1(m) then code:=coalesce(code,'MONTH_CLOSED'); end if;
  end loop;
  return jsonb_build_object('safe',code is null,'code',coalesce(code,'READY'),
    'inventoryLogId',r.id,'businessDate',r.business_date,'quantity',r.change_quantity,'effectiveQuantity',q-i.change_quantity,
    'unit',r.unit,'price',price,'supplier',r.new_supplier,'candidateId',c.id,'transactionId',t.id,
    'oldAmount',t.amount,'newAmount',round(q*price,3),'delta',round(q*price,3)-t.amount);
end;
$$;
revoke all on function inventory_ledger_private.inspect_purchase_repair(bigint,bigint) from public,anon,authenticated,service_role;
alter function inventory_ledger_private.inspect_purchase_repair(bigint,bigint) owner to postgres;

create function public.ledger_inventory_purchase_repair_preview_v1(p_inventory_log_id bigint,p_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare i public.inventory_logs%rowtype; r bigint; candidate jsonb; candidates jsonb:='[]'::jsonb;
begin
  if not exists(select 1 from public.users where id=p_actor_user_id and is_active and app_login_enabled
    and lower(role::text) in ('owner','master')) then return jsonb_build_object('status','forbidden','code','FORBIDDEN'); end if;
  select * into i from public.inventory_logs where id=p_inventory_log_id;
  if i.id is null then return jsonb_build_object('status','not_found','code','ISSUE_NOT_FOUND'); end if;
  if i.correction_of_inventory_log_id is not null then return jsonb_build_object('status','blocked','code','ISSUE_ALREADY_LINKED'); end if;
  if not exists(select 1 from public.ledger_inventory_projection_status where inventory_log_id=i.id
    and status='review_required' and code='PURCHASE_CORRECTION_REFERENCE_REQUIRED')
    or i.reason is distinct from 'purchase' or i.source is distinct from 'edit_form' or i.change_quantity>=0 then
    return jsonb_build_object('status','blocked','code','ISSUE_NOT_RESOLVABLE');
  end if;
  for r in select id from public.inventory_logs where item_id=i.item_id and reason='purchase'
    and change_quantity>0 and correction_of_inventory_log_id is null and created_at<=i.created_at
    and business_date<=i.business_date and unit is not distinct from i.unit
    and ((purchase_supplier_partner_id is not null and i.purchase_supplier_partner_id is not null
      and purchase_supplier_partner_id=i.purchase_supplier_partner_id)
      or ((purchase_supplier_partner_id is null or i.purchase_supplier_partner_id is null)
        and lower(btrim(coalesce(new_supplier,'')))=lower(btrim(coalesce(i.new_supplier,'')))))
    order by business_date desc,created_at desc,id desc
  loop
    candidate:=inventory_ledger_private.inspect_purchase_repair(i.id,r);
    candidates:=candidates || jsonb_build_array(candidate);
  end loop;
  return jsonb_build_object('status','ok','candidates',candidates,
    'recommended',jsonb_array_length(candidates)=1 and coalesce((candidates->0->>'safe')::boolean,false));
end;
$$;

create function public.ledger_resolve_inventory_purchase_correction_v1(
  p_inventory_log_id bigint,p_purchase_log_id bigint,p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_check jsonb; v_result jsonb; v_before jsonb; v_date date; v_code text;
begin
  if not exists(select 1 from public.users where id=p_actor_user_id and is_active and app_login_enabled
    and lower(role::text) in ('owner','master')) then return jsonb_build_object('status','forbidden','code','FORBIDDEN'); end if;
  select business_date into v_date from public.inventory_logs where id=p_inventory_log_id;
  perform inventory_ledger_private.lock_sources(array['inventory-log:' || p_purchase_log_id,'inventory-log:' || p_inventory_log_id],array[v_date]);
  perform 1 from public.ledger_inventory_projection_status where inventory_log_id=p_inventory_log_id for update;
  -- Payable lock serializes payment allocation against validation and canonical rebook.
  perform 1 from public.ledger_payables where expense_transaction_id in
    (select resolved_transaction_id from public.ledger_candidates where source_type='inventory_purchase_log'
      and source_key='inventory-log:' || p_purchase_log_id) order by id for update;
  v_check:=inventory_ledger_private.inspect_purchase_repair(p_inventory_log_id,p_purchase_log_id);
  if not coalesce((v_check->>'safe')::boolean,false) then return jsonb_build_object('status','blocked','code',v_check->>'code'); end if;
  select to_jsonb(l) into v_before from public.inventory_logs l where id=p_inventory_log_id;
  -- Any returned non-success must rollback the link, rebook, payable and audits together.
  begin
    update public.inventory_logs set correction_of_inventory_log_id=p_purchase_log_id where id=p_inventory_log_id;
    v_result:=public.ledger_project_inventory_purchase_log_v1(p_inventory_log_id,p_actor_user_id);
    if v_result->>'status' is distinct from 'synced' then
      raise exception using errcode='P0001',message=coalesce(v_result->>'code','PROJECTION_FAILED');
    end if;
    insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
      values(p_actor_user_id,'inventory_purchase_correction_linked','inventory_log',p_inventory_log_id,v_before,
        jsonb_build_object('purchaseLogId',p_purchase_log_id,'projection',v_result,'preview',v_check),'Owner confirmed original purchase repair');
    return v_result || jsonb_build_object('purchaseLogId',p_purchase_log_id);
  exception when others then
    get stacked diagnostics v_code=MESSAGE_TEXT;
    return jsonb_build_object('status','blocked','code',case when v_code ~ '^[A-Z0-9_]+$' then v_code else 'REPAIR_FAILED' end);
  end;
end;
$$;
alter function public.ledger_inventory_purchase_repair_preview_v1(bigint,bigint) owner to postgres;
alter function public.ledger_resolve_inventory_purchase_correction_v1(bigint,bigint,bigint) owner to postgres;
revoke all on function public.ledger_inventory_purchase_repair_preview_v1(bigint,bigint) from public,anon,authenticated,service_role;
revoke all on function public.ledger_resolve_inventory_purchase_correction_v1(bigint,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.ledger_inventory_purchase_repair_preview_v1(bigint,bigint) to service_role;
grant execute on function public.ledger_resolve_inventory_purchase_correction_v1(bigint,bigint,bigint) to service_role;
commit;
