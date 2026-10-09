-- Local/isolated validation only. No data backfill, month reopen, or automatic legacy linking.
begin;
create or replace function inventory_ledger_private.economics(p_snapshot jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
  select p_snapshot - array['item_name','item_name_vi','category','category_vi','unit','note','inventory_correction_log_ids']::text[];
$$;
revoke all on function inventory_ledger_private.economics(jsonb) from public,anon,authenticated,service_role;

-- Supplier identity and supplier-change intent are different checks. A changed supplier
-- must carry evidence of the previous supplier, then receive a separate owner confirmation.
create function inventory_ledger_private.purchase_supplier_matches(
  p_left_id text,p_left_name text,p_right_id text,p_right_name text
) returns boolean language sql stable set search_path=pg_catalog,public as $$
  select case
    when p_left_id is not null and p_right_id is not null then p_left_id=p_right_id
      and (nullif(btrim(p_left_name),'') is null or nullif(btrim(p_right_name),'') is null
        or lower(btrim(p_left_name))=lower(btrim(p_right_name)))
    else nullif(lower(btrim(p_left_name)),'') is not null
      and lower(btrim(p_left_name))=lower(btrim(p_right_name))
      and (
        select count(*) from public.business_partners bp where bp.is_active
          and (coalesce(p_left_id,p_right_id) is null or bp.id::text<>coalesce(p_left_id,p_right_id))
          and (lower(btrim(bp.name))=lower(btrim(p_left_name)) or exists (
            select 1 from public.business_partner_supplier_aliases a
            where a.business_partner_id=bp.id and a.status='linked'
              and a.normalized_name=lower(btrim(p_left_name))
          ))
      ) <= case when coalesce(p_left_id,p_right_id) is null then 1 else 0 end
    end;
$$;
create function inventory_ledger_private.compare_purchase_supplier(p_issue jsonb,p_before jsonb)
returns jsonb language plpgsql stable set search_path=pg_catalog,public as $$
declare
  before_id text:=p_before->>'purchase_supplier_partner_id';
  before_name text:=p_before->>'new_supplier';
  after_id text:=p_issue->>'purchase_supplier_partner_id';
  after_name text:=p_issue->>'new_supplier';
  prev_id text:=coalesce(p_issue->>'prev_purchase_supplier_partner_id',p_issue->>'prev_supplier_partner_id');
  prev_name text:=nullif(btrim(p_issue->>'prev_supplier'),'');
  changed boolean; code text; fingerprint text;
begin
  changed:=not coalesce(inventory_ledger_private.purchase_supplier_matches(before_id,before_name,after_id,after_name),false);
  if coalesce((p_issue->>'_direct_root')::boolean,false) then
    -- Direct source drift has the immutable booked snapshot as its previous-supplier evidence.
    if before_id is null and nullif(btrim(before_name),'') is null then code:='SUPPLIER_REFERENCE_REQUIRED'; end if;
  elsif prev_id is not null or prev_name is not null then
    if not coalesce(inventory_ledger_private.purchase_supplier_matches(before_id,before_name,prev_id,prev_name),false)
      then code:='SUPPLIER_MISMATCH'; end if;
  elsif changed then code:='SUPPLIER_REFERENCE_REQUIRED';
  end if;
  if nullif(btrim(after_name),'') is null and after_id is null then code:=coalesce(code,'SUPPLIER_REFERENCE_REQUIRED'); end if;
  fingerprint:=encode(sha256(convert_to(jsonb_build_object('issue',p_issue,'before',p_before)::text,'UTF8')),'hex');
  return jsonb_build_object('valid',code is null,'code',coalesce(code,'READY'),
    'requiresConfirmation',changed,'beforeSupplier',before_name,'beforePartnerId',before_id,
    'afterSupplier',after_name,'afterPartnerId',after_id,'confirmationFingerprint',fingerprint);
end;
$$;
alter function inventory_ledger_private.purchase_supplier_matches(text,text,text,text) owner to postgres;
alter function inventory_ledger_private.compare_purchase_supplier(jsonb,jsonb) owner to postgres;
revoke all on function inventory_ledger_private.purchase_supplier_matches(text,text,text,text) from public,anon,authenticated,service_role;
revoke all on function inventory_ledger_private.compare_purchase_supplier(jsonb,jsonb) from public,anon,authenticated,service_role;

create or replace function public.inventory_purchase_correction_guard_v1() returns trigger
language plpgsql set search_path=pg_catalog,public as $guard$
declare
  v_root public.inventory_logs%rowtype; v_total numeric; v_before jsonb;
  v_previous_matches boolean; v_current_matches boolean; v_has_previous boolean;
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
     or coalesce(NEW.source,'') not in ('edit_form','quick_save') or NEW.reason is distinct from 'purchase'
     or NEW.item_id is distinct from v_root.item_id or NEW.unit is distinct from v_root.unit
     or NEW.change_quantity is null or NEW.change_quantity::text in ('NaN','Infinity','-Infinity')
     or NEW.new_purchase_price is null or NEW.new_purchase_price <= 0 or NEW.new_purchase_price::text in ('NaN','Infinity','-Infinity') then
    raise exception 'INVALID_PURCHASE_CORRECTION_REFERENCE';
  end if;
  select to_jsonb(l) into v_before from public.inventory_logs l
    where correction_of_inventory_log_id=v_root.id and id<NEW.id order by id desc limit 1;
  v_before:=coalesce(v_before,to_jsonb(v_root));
  -- Keep this trigger SECURITY INVOKER and preserve its current_user link check.
  -- Source metadata updates run as service_role, which cannot execute private helpers.
  -- Compare the same identities inline rather than widening helper/schema permissions.
  with identities as (
    select 'previous' as side,
      coalesce(to_jsonb(NEW)->>'prev_purchase_supplier_partner_id',to_jsonb(NEW)->>'prev_supplier_partner_id') as partner_id,
      nullif(btrim(to_jsonb(NEW)->>'prev_supplier'),'') as supplier
    union all select 'current',NEW.purchase_supplier_partner_id::text,NEW.new_supplier
  ), comparisons as (
    select side,partner_id,supplier,case
      when partner_id is not null and v_before->>'purchase_supplier_partner_id' is not null then
        partner_id=v_before->>'purchase_supplier_partner_id'
        and (nullif(btrim(supplier),'') is null or nullif(btrim(v_before->>'new_supplier'),'') is null
          or lower(btrim(supplier))=lower(btrim(v_before->>'new_supplier')))
      else nullif(lower(btrim(supplier)),'') is not null
        and lower(btrim(supplier))=lower(btrim(v_before->>'new_supplier'))
        and (
          select count(*) from public.business_partners bp where bp.is_active
            and (coalesce(partner_id,v_before->>'purchase_supplier_partner_id') is null
              or bp.id::text<>coalesce(partner_id,v_before->>'purchase_supplier_partner_id'))
            and (lower(btrim(bp.name))=lower(btrim(supplier)) or exists (
              select 1 from public.business_partner_supplier_aliases a
              where a.business_partner_id=bp.id and a.status='linked'
                and a.normalized_name=lower(btrim(supplier))
            ))
        ) <= case when coalesce(partner_id,v_before->>'purchase_supplier_partner_id') is null then 1 else 0 end
      end as matches from identities
  ) select coalesce(bool_or(matches) filter(where side='previous'),false),
      coalesce(bool_or(matches) filter(where side='current'),false),
      bool_or(partner_id is not null or nullif(btrim(supplier),'') is not null) filter(where side='previous')
    into v_previous_matches,v_current_matches,v_has_previous from comparisons;
  if v_has_previous and not v_previous_matches then raise exception 'SUPPLIER_MISMATCH'; end if;
  if not v_current_matches and not v_has_previous then raise exception 'SUPPLIER_REFERENCE_REQUIRED'; end if;
  if NEW.purchase_supplier_partner_id is null and nullif(btrim(NEW.new_supplier),'') is null then
    raise exception 'SUPPLIER_REFERENCE_REQUIRED';
  end if;
  if not v_current_matches and exists(
    select 1 from public.inventory_logs where correction_of_inventory_log_id=v_root.id and id>NEW.id
  ) then raise exception 'SUPPLIER_CORRECTION_ORDER_REQUIRED'; end if;
  select v_root.change_quantity::numeric+coalesce(sum(change_quantity::numeric),0)+NEW.change_quantity::numeric into v_total
    from public.inventory_logs where correction_of_inventory_log_id=v_root.id and id<>NEW.id;
  if v_total < 0 then raise exception 'PURCHASE_CORRECTION_EXCEEDS_PURCHASE'; end if;
  return NEW;
end;
$guard$;
revoke all on function public.inventory_purchase_correction_guard_v1() from public,anon,authenticated,service_role;

do $contract$
declare d text;
begin
  d:=pg_get_functiondef('public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure);
  if position($anchor$v_log.source='edit_form' and v_log.change_quantity<0$anchor$ in d)=0 then raise exception 'PURCHASE_ECONOMIC_CONTRACT_MISMATCH'; end if;
  d:=replace(d,$anchor$v_log.source='edit_form' and v_log.change_quantity<0$anchor$,$replacement$v_log.source in ('edit_form','quick_save') and v_log.change_quantity<=0$replacement$);
  if position($anchor$      select new_purchase_price into v_log.new_purchase_price from public.inventory_logs
        where correction_of_inventory_log_id=v_log.id order by id desc limit 1;$anchor$ in d)=0 then raise exception 'PURCHASE_ECONOMIC_CONTRACT_MISMATCH'; end if;
  d:=replace(d,$anchor$      select new_purchase_price into v_log.new_purchase_price from public.inventory_logs
        where correction_of_inventory_log_id=v_log.id order by id desc limit 1;$anchor$,$replacement$      select new_purchase_price,new_supplier,purchase_supplier_partner_id,item_name,item_name_vi
        into v_log.new_purchase_price,v_log.new_supplier,v_log.purchase_supplier_partner_id,v_log.item_name,v_log.item_name_vi
        from public.inventory_logs where correction_of_inventory_log_id=v_log.id order by id desc limit 1;$replacement$);
  if position($anchor$          -- Never silently undo an owner's manual economic edit.$anchor$ in d)=0 then raise exception 'PURCHASE_ECONOMIC_CONTRACT_MISMATCH'; end if;
  d:=replace(d,$anchor$          -- Never silently undo an owner's manual economic edit.$anchor$,$replacement$          -- Economic drift always requires explicit owner confirmation through the repair RPC.
          if current_setting('baba.purchase_confirmation',true) is distinct from p_inventory_log_id::text then
            v_status := 'review_required';
            v_code := case when v_corrections is not null and v_amount=0 then 'PURCHASE_ORIGINAL_CANCELLED' else 'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED' end;
          elsif not exists(select 1 from public.ledger_payables where expense_transaction_id=v_tx.id)
            or exists(select 1 from public.ledger_payables p where p.expense_transaction_id=v_tx.id
              and (p.status<>'unpaid' or exists(select 1 from public.ledger_payable_allocations a where a.payable_id=p.id))) then
            v_status := 'review_required'; v_code := 'PAYABLE_ALREADY_PAID';
          else
          -- Never silently undo an owner's manual economic edit.$replacement$);
  if position($anchor$          if v_status = 'review_required' then$anchor$ in d)=0 then raise exception 'PURCHASE_ECONOMIC_CONTRACT_MISMATCH'; end if;
  d:=replace(d,$anchor$          if v_status = 'review_required' then$anchor$,$replacement$          end if; -- explicit confirmation/payment gate
          if v_status = 'review_required' then$replacement$);
  execute d;
end;
$contract$;

create or replace function inventory_ledger_private.inspect_purchase_repair(p_issue_id bigint,p_root_id bigint)
returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare
  i public.inventory_logs%rowtype; r public.inventory_logs%rowtype;
  c public.ledger_candidates%rowtype; t public.ledger_transactions%rowtype;
  p public.ledger_payables%rowtype; s public.ledger_inventory_projection_status%rowtype;
  q numeric; price numeric; code text; m date; supplier_check jsonb; supplier_before jsonb;
begin
  select * into i from public.inventory_logs where id=p_issue_id;
  select * into s from public.ledger_inventory_projection_status where inventory_log_id=p_issue_id;
  select * into r from public.inventory_logs where id=p_root_id;
  if i.id is null then code:='ISSUE_NOT_FOUND';
  elsif i.correction_of_inventory_log_id is not null and i.correction_of_inventory_log_id<>r.id then code:='ISSUE_ALREADY_LINKED';
  elsif not ((s.status='review_required' and s.code in ('PURCHASE_CORRECTION_REFERENCE_REQUIRED','PURCHASE_AMOUNT_CONFIRMATION_REQUIRED','PURCHASE_ORIGINAL_CANCELLED','MONTH_CLOSED','PAYABLE_ALREADY_PAID'))
    or (s.status='synced' and s.code='NOT_A_PURCHASE' and i.source='quick_save' and i.change_quantity<0))
    then code:='ISSUE_NOT_RESOLVABLE';
  elsif i.reason is distinct from 'purchase' or (i.id<>r.id and coalesce(i.source,'') not in ('edit_form','quick_save')) or i.change_quantity is null
    or (i.change_quantity>0 and i.id<>r.id and i.correction_of_inventory_log_id is null) or i.change_quantity::text in ('NaN','Infinity','-Infinity') then code:='INVALID_ISSUE';
  elsif r.id is null or r.reason is distinct from 'purchase' or r.change_quantity is null or r.change_quantity<=0
    or r.change_quantity::text in ('NaN','Infinity','-Infinity') or r.correction_of_inventory_log_id is not null
    or r.created_at>i.created_at or r.business_date>i.business_date then code:='INVALID_PURCHASE_ROOT';
  elsif r.item_id is distinct from i.item_id then code:='ITEM_MISMATCH';
  elsif r.unit is distinct from i.unit then code:='UNIT_MISMATCH';
  elsif i.new_purchase_price is null or i.new_purchase_price<=0 or i.new_purchase_price::text in ('NaN','Infinity','-Infinity')
    then code:='INVALID_PURCHASE_PRICE';
  end if;
  if code is not null then return jsonb_build_object('safe',false,'code',code); end if;
  -- Price changes follow the existing correction identity policy; latest log ID wins.
  select r.change_quantity+coalesce(sum(change_quantity),0)+case when i.id=r.id or i.correction_of_inventory_log_id=r.id then 0 else i.change_quantity end into q
    from public.inventory_logs where correction_of_inventory_log_id=r.id;
  select new_purchase_price into price from (
    select id,new_purchase_price from public.inventory_logs where correction_of_inventory_log_id=r.id
    union all select i.id,i.new_purchase_price
  ) prices order by id desc limit 1;
  select * into c from public.ledger_candidates where source_type='inventory_purchase_log'
    and source_key='inventory-log:' || r.id order by id desc limit 1;
  select * into t from public.ledger_transactions where id=c.resolved_transaction_id;
  select * into p from public.ledger_payables where expense_transaction_id=t.id;
  if i.id=r.id then
    supplier_before:=jsonb_build_object('id',r.id,'new_supplier',c.source_snapshot->>'supplier',
      'purchase_supplier_partner_id',c.source_snapshot->'purchase_supplier_partner_id');
    supplier_check:=inventory_ledger_private.compare_purchase_supplier(to_jsonb(i)||'{"_direct_root":true}'::jsonb,supplier_before);
  else
    select to_jsonb(l) into supplier_before from public.inventory_logs l
      where correction_of_inventory_log_id=r.id and id<i.id order by id desc limit 1;
    supplier_check:=inventory_ledger_private.compare_purchase_supplier(to_jsonb(i),coalesce(supplier_before,to_jsonb(r)));
  end if;
  if not (supplier_check->>'valid')::boolean then code:=supplier_check->>'code';
  elsif i.id<>r.id and (supplier_check->>'requiresConfirmation')::boolean and exists(
    select 1 from public.inventory_logs where correction_of_inventory_log_id=r.id and id>i.id
  ) then code:='SUPPLIER_CORRECTION_ORDER_REQUIRED';
  elsif q<0 then code:='PURCHASE_CORRECTION_EXCEEDS_PURCHASE';
  elsif c.id is null or c.status is distinct from 'confirmed' or t.id is null then code:='INVALID_CANDIDATE_STATE';
  elsif exists(select 1 from public.ledger_candidates where source_type='inventory_purchase_log'
    and source_key='inventory-log:' || i.id and i.id<>r.id) then code:='ISSUE_ALREADY_BOOKED';
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
  elsif p.id is null then code:='PAYABLE_ALREADY_PAID';
  end if;
  for m in select distinct date_trunc('month',d)::date from unnest(array[
    i.business_date,r.business_date,c.business_date,c.proposed_recognition_month,t.business_date,t.recognition_month]) d
  loop
    if m is null then code:=coalesce(code,'INVALID_BUSINESS_DATE');
    elsif public.ledger_month_is_closed_v1(m) then code:=coalesce(code,'MONTH_CLOSED'); end if;
  end loop;
  -- Bind the separate confirmation to the current purchase family and booked state,
  -- as well as the selected root and the supplier identities shown in preview.
  supplier_check:=jsonb_set(supplier_check,'{confirmationFingerprint}',to_jsonb(encode(sha256(convert_to(
    jsonb_build_object('supplierComparison',supplier_check,'quantity',q,'price',price,
      'candidateId',c.id,'candidateFingerprint',c.source_fingerprint,
      'transactionId',t.id,'amount',t.amount,'partyId',t.party_id,
      'corrections',(select jsonb_agg(to_jsonb(l) order by l.id) from public.inventory_logs l
        where l.correction_of_inventory_log_id=r.id))::text,'UTF8')),'hex')));
  if code is null and (supplier_check->>'requiresConfirmation')::boolean then code:='SUPPLIER_CHANGE_CONFIRMATION_REQUIRED'; end if;
  return jsonb_build_object('safe',code is null,'code',coalesce(code,'READY'),'supplierChange',supplier_check,
    'inventoryLogId',r.id,'businessDate',r.business_date,'quantity',r.change_quantity,'effectiveQuantity',case when i.id=r.id then (c.source_snapshot->>'change_quantity')::numeric else q-i.change_quantity end,'quantityDelta',case when i.id=r.id then q-(c.source_snapshot->>'change_quantity')::numeric else i.change_quantity end,
    'unit',r.unit,'price',price,'supplier',coalesce(c.source_snapshot->>'supplier',r.new_supplier),'newSupplier',i.new_supplier,'candidateId',c.id,'transactionId',t.id,
    'oldAmount',t.amount,'newAmount',round(q*price,3),'delta',round(q*price,3)-t.amount,'changeKind',case when q=0 then 'cancelled' else 'amount_changed' end);
end;
$$;
revoke all on function inventory_ledger_private.inspect_purchase_repair(bigint,bigint) from public,anon,authenticated,service_role;
alter function inventory_ledger_private.inspect_purchase_repair(bigint,bigint) owner to postgres;

create or replace function public.ledger_inventory_purchase_repair_preview_v1(p_inventory_log_id bigint,p_actor_user_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare i public.inventory_logs%rowtype; r bigint; candidate jsonb; candidates jsonb:='[]'::jsonb;
begin
  if not exists(select 1 from public.users where id=p_actor_user_id and is_active and app_login_enabled
    and lower(role::text) in ('owner','master')) then return jsonb_build_object('status','forbidden','code','FORBIDDEN'); end if;
  select * into i from public.inventory_logs where id=p_inventory_log_id;
  if i.id is null then return jsonb_build_object('status','not_found','code','ISSUE_NOT_FOUND'); end if;
  if i.correction_of_inventory_log_id is not null then
    candidate:=inventory_ledger_private.inspect_purchase_repair(i.id,i.correction_of_inventory_log_id);
    return jsonb_build_object('status','ok','candidates',jsonb_build_array(candidate),'recommended',false);
  end if;
  if not exists(select 1 from public.ledger_inventory_projection_status where inventory_log_id=i.id
    and ((status='review_required' and code in ('PURCHASE_CORRECTION_REFERENCE_REQUIRED','PURCHASE_AMOUNT_CONFIRMATION_REQUIRED','PURCHASE_ORIGINAL_CANCELLED','MONTH_CLOSED','PAYABLE_ALREADY_PAID'))
      or (status='synced' and code='NOT_A_PURCHASE' and i.source='quick_save' and i.change_quantity<0)))
    or i.reason is distinct from 'purchase' or (i.change_quantity<=0 and coalesce(i.source,'') not in ('edit_form','quick_save')) then
    return jsonb_build_object('status','blocked','code','ISSUE_NOT_RESOLVABLE');
  end if;
  if i.change_quantity>0 then
    candidate:=inventory_ledger_private.inspect_purchase_repair(i.id,i.id);
    return jsonb_build_object('status','ok','candidates',jsonb_build_array(candidate),'recommended',false);
  end if;
  for r in select id from public.inventory_logs where item_id=i.item_id and reason='purchase'
    and change_quantity>0 and correction_of_inventory_log_id is null and created_at<=i.created_at
    and business_date<=i.business_date and unit is not distinct from i.unit
    order by business_date desc,created_at desc,id desc
  loop
    candidate:=inventory_ledger_private.inspect_purchase_repair(i.id,r);
    candidates:=candidates || jsonb_build_array(candidate);
  end loop;
  return jsonb_build_object('status','ok','candidates',candidates,
    'recommended',jsonb_array_length(candidates)=1 and coalesce((candidates->0->>'safe')::boolean,false));
end;
$$;

create function public.ledger_resolve_inventory_purchase_correction_v2(
  p_inventory_log_id bigint,p_purchase_log_id bigint,p_actor_user_id bigint,p_supplier_confirmation jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_check jsonb; v_result jsonb; v_before jsonb; v_date date; v_code text; v_confirmation text; v_issue public.inventory_logs%rowtype; v_saved_confirmation jsonb;
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
  select * into v_issue from public.inventory_logs where id=p_inventory_log_id for update;
  if v_issue.correction_of_inventory_log_id is not null and v_issue.correction_of_inventory_log_id<>p_purchase_log_id then
    return jsonb_build_object('status','blocked','code','ISSUE_ALREADY_LINKED');
  end if;
  select after_snapshot->'projection',after_snapshot->'supplierConfirmation' into v_result,v_saved_confirmation from public.ledger_audit_logs
    where action='inventory_purchase_correction_linked' and entity_type='inventory_log' and entity_id=p_inventory_log_id
      and after_snapshot->>'purchaseLogId'=p_purchase_log_id::text
      and after_snapshot->'confirmedSource'=to_jsonb(v_issue)
    order by id desc limit 1;
  if v_result is not null then
    if v_saved_confirmation is not null and v_saved_confirmation<>'null'::jsonb
      and p_supplier_confirmation is distinct from v_saved_confirmation then
      return jsonb_build_object('status','blocked','code','SUPPLIER_CHANGE_CONFIRMATION_REQUIRED');
    end if;
    return v_result || jsonb_build_object('purchaseLogId',p_purchase_log_id);
  end if;
  v_check:=inventory_ledger_private.inspect_purchase_repair(p_inventory_log_id,p_purchase_log_id);
  if v_check->>'code'='SUPPLIER_CHANGE_CONFIRMATION_REQUIRED' then
    if jsonb_typeof(p_supplier_confirmation) is distinct from 'object'
      or p_supplier_confirmation->'confirmed' is distinct from 'true'::jsonb then
      return jsonb_build_object('status','blocked','code','SUPPLIER_CHANGE_CONFIRMATION_REQUIRED','supplierChange',v_check->'supplierChange');
    end if;
    if p_supplier_confirmation->>'fingerprint' is distinct from v_check#>>'{supplierChange,confirmationFingerprint}' then
      return jsonb_build_object('status','blocked','code','SUPPLIER_CHANGE_CONFIRMATION_STALE');
    end if;
  elsif not coalesce((v_check->>'safe')::boolean,false) then
    return jsonb_build_object('status','blocked','code',v_check->>'code');
  end if;
  select to_jsonb(l) into v_before from public.inventory_logs l where id=p_inventory_log_id;
  -- Any returned non-success must rollback the link, rebook, payable and audits together.
  begin
    if p_inventory_log_id<>p_purchase_log_id and v_issue.correction_of_inventory_log_id is null then
      update public.inventory_logs set correction_of_inventory_log_id=p_purchase_log_id where id=p_inventory_log_id;
    end if;
    v_confirmation:=current_setting('baba.purchase_confirmation',true);
    perform set_config('baba.purchase_confirmation',p_inventory_log_id::text,true);
    v_result:=public.ledger_project_inventory_purchase_log_v1(p_inventory_log_id,p_actor_user_id);
    perform set_config('baba.purchase_confirmation',coalesce(v_confirmation,''),true);
    if v_result->>'status' is distinct from 'synced' then
      raise exception using errcode='P0001',message=coalesce(v_result->>'code','PROJECTION_FAILED');
    end if;
    insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
      values(p_actor_user_id,'inventory_purchase_correction_linked','inventory_log',p_inventory_log_id,v_before,
        jsonb_build_object('purchaseLogId',p_purchase_log_id,'projection',v_result,'preview',v_check,'supplierConfirmation',case when v_check->>'code'='SUPPLIER_CHANGE_CONFIRMATION_REQUIRED' then p_supplier_confirmation else null end,'confirmedSource',(select to_jsonb(l) from public.inventory_logs l where id=p_inventory_log_id)),'Owner confirmed original purchase repair');
    return v_result || jsonb_build_object('purchaseLogId',p_purchase_log_id);
  exception when others then
    get stacked diagnostics v_code=MESSAGE_TEXT;
    return jsonb_build_object('status','blocked','code',case when v_code ~ '^[A-Z0-9_]+$' then v_code else 'REPAIR_FAILED' end);
  end;
end;
$$;
-- Existing callers remain compatible for same-supplier repairs; this RPC cannot
-- confirm a supplier change. v2 requires an explicit, fresh preview fingerprint.
-- v2 payload: {"confirmed":true,"fingerprint":preview.supplierChange.confirmationFingerprint}.
-- UI/API wiring of that separate confirmation is intentionally outside this SQL-only follow-up.
create or replace function public.ledger_resolve_inventory_purchase_correction_v1(
  p_inventory_log_id bigint,p_purchase_log_id bigint,p_actor_user_id bigint
) returns jsonb language sql security definer set search_path=pg_catalog,public as $$
  select public.ledger_resolve_inventory_purchase_correction_v2(p_inventory_log_id,p_purchase_log_id,p_actor_user_id,null);
$$;
alter function public.ledger_resolve_inventory_purchase_correction_v2(bigint,bigint,bigint,jsonb) owner to postgres;
revoke all on function public.ledger_resolve_inventory_purchase_correction_v2(bigint,bigint,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.ledger_resolve_inventory_purchase_correction_v2(bigint,bigint,bigint,jsonb) to service_role;
alter function public.ledger_inventory_purchase_repair_preview_v1(bigint,bigint) owner to postgres;
alter function public.ledger_resolve_inventory_purchase_correction_v1(bigint,bigint,bigint) owner to postgres;
revoke all on function public.ledger_inventory_purchase_repair_preview_v1(bigint,bigint) from public,anon,authenticated,service_role;
revoke all on function public.ledger_resolve_inventory_purchase_correction_v1(bigint,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.ledger_inventory_purchase_repair_preview_v1(bigint,bigint) to service_role;
grant execute on function public.ledger_resolve_inventory_purchase_correction_v1(bigint,bigint,bigint) to service_role;

commit;
