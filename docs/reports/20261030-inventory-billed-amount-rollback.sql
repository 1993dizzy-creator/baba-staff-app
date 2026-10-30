-- ROLLBACK of 20261030170000 + 20261030150000 (실청구금액 v1). NOT a migration; run only with
-- explicit approval, in the SQL Editor, as one transaction. Generated from the original
-- migration files: restores the exact pre-migration function bodies.
-- Refuses when any manual 실청구금액 exists: those amounts are already booked in the Ledger,
-- and dropping them would make the Ledger disagree with inventory. Fix forward instead.
begin;

do $guard$
begin
  if not exists(select 1 from pg_attribute where attrelid='public.inventory_logs'::regclass and attname='billed_amount_mode' and not attisdropped) then
    raise exception 'BILLED_AMOUNT_ROLLBACK_NOT_APPLIED';
  end if;
  if exists(select 1 from public.inventory_logs where billed_amount_mode='manual') then
    raise exception 'BILLED_AMOUNT_ROLLBACK_BLOCKED_MANUAL_AMOUNTS_EXIST';
  end if;
  if position('baba.billed_amount_v1' in pg_get_functiondef('public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure))=0 then
    raise exception 'BILLED_AMOUNT_ROLLBACK_CONTRACT_MISMATCH: projector';
  end if;
end;
$guard$;

-- 20261030170000
drop function if exists public.inventory_create_with_receipt_v1(jsonb,text,date,bigint);
drop function if exists inventory_ledger_private.inventory_name_key_v1(text);

-- 20261030150000: projector additions removed at the same anchors (LF or CRLF).
do $projector$
declare
  v_def text; v_crlf boolean; v_anchor text; v_addition text; i integer;
  v_anchors text[]:=array[
    $a1$  v_corrections bigint[];
$a1$,
    $a2$    v_amount := round(v_log.change_quantity::numeric * v_log.new_purchase_price::numeric, 3);
$a2$,
    $a3$      if v_corrections is not null then
        v_snapshot := v_snapshot || jsonb_build_object('inventory_correction_log_ids',v_corrections);
$a3$];
  -- 1 and 2 append after their anchor; 3 inserts before it.
  v_additions text[]:=array[
    $b1$  v_billed jsonb; -- baba.billed_amount_v1
  v_calculated numeric;
$b1$,
    $b2$    -- 실청구금액: the latest family log with an explicit mode decides; auto keeps quantity x price.
    v_calculated := v_amount;
    v_billed := inventory_ledger_private.purchase_billed_amount_v1(v_log.id,null);
    if v_billed->>'mode' = 'manual' and v_calculated is not null and coalesce(v_log.change_quantity,0) > 0 then
      v_amount := (v_billed->>'amount')::numeric;
    end if;
$b2$,
    $b3$      if v_billed->>'mode' = 'manual' and v_calculated is not null and coalesce(v_log.change_quantity,0) > 0 then
        v_snapshot := v_snapshot || jsonb_build_object('billed_amount_mode','manual','calculated_amount',v_calculated);
      end if;
$b3$];
begin
  v_def:=pg_get_functiondef('public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure);
  v_crlf:=position(chr(13)||chr(10) in v_def)>0;
  for i in 1..3 loop
    v_anchor:=replace(v_anchors[i],chr(13)||chr(10),chr(10));
    v_addition:=replace(v_additions[i],chr(13)||chr(10),chr(10));
    if v_crlf then
      v_anchor:=replace(v_anchor,chr(10),chr(13)||chr(10));
      v_addition:=replace(v_addition,chr(10),chr(13)||chr(10));
    end if;
    v_addition:=case when i=3 then v_addition||v_anchor else v_anchor||v_addition end;
    if (length(v_def)-length(replace(v_def,v_addition,'')))/length(v_addition)<>1 then
      raise exception 'BILLED_AMOUNT_ROLLBACK_CONTRACT_MISMATCH: projector anchor %',i;
    end if;
    v_def:=replace(v_def,v_addition,v_anchor);
  end loop;
  execute v_def;
end;
$projector$;

do $inspect$
declare v_def text; v_anchor text:=$a$'oldAmount',t.amount,'newAmount',round(q*price,3),'delta',round(q*price,3)-t.amount,$a$; v_replacement text:=$r$'oldAmount',t.amount,
    'newAmount',case when q>0 and inventory_ledger_private.purchase_billed_amount_v1(r.id,i.id)->>'mode'='manual'
      then (inventory_ledger_private.purchase_billed_amount_v1(r.id,i.id)->>'amount')::numeric else round(q*price,3) end,
    'delta',case when q>0 and inventory_ledger_private.purchase_billed_amount_v1(r.id,i.id)->>'mode'='manual'
      then (inventory_ledger_private.purchase_billed_amount_v1(r.id,i.id)->>'amount')::numeric else round(q*price,3) end-t.amount,
    'calculatedAmount',round(q*price,3),'billedAmountMode',inventory_ledger_private.purchase_billed_amount_v1(r.id,i.id)->>'mode',$r$;
begin
  v_def:=pg_get_functiondef('inventory_ledger_private.inspect_purchase_repair(bigint,bigint)'::regprocedure);
  if (length(v_def)-length(replace(v_def,v_replacement,'')))/length(v_replacement)<>1 then
    raise exception 'BILLED_AMOUNT_ROLLBACK_CONTRACT_MISMATCH: inspect_purchase_repair';
  end if;
  execute replace(v_def,v_replacement,v_anchor);
end;
$inspect$;

create or replace function inventory_ledger_private.economics(p_snapshot jsonb)
returns jsonb language sql immutable set search_path=pg_catalog,public as $$
  select p_snapshot - array['item_name','item_name_vi','category','category_vi','unit','note','inventory_correction_log_ids']::text[];
$$;

create or replace function public.inventory_update_with_audit_v1(
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

create or replace function public.inventory_apply_purchase_receipt_edit_v1(
  p_item_id bigint,p_purchase_log_id bigint,p_expected_quantity numeric,p_expected_item jsonb,
  p_edit jsonb,p_business_date date,p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_actor jsonb; v_role text;
  v_old public.inventory%rowtype; v_new public.inventory%rowtype;
  v_root public.inventory_logs%rowtype; v_latest public.inventory_logs%rowtype;
  v_quantity numeric; v_price numeric; v_supplier text; v_partner bigint; v_reason text; v_note text;
  v_effective numeric; v_delta numeric; v_prev_price numeric; v_prev_supplier text; v_prev_partner bigint;
  v_supplier_changed boolean; v_same_day boolean; v_note_text text; v_candidate_status text; v_completion text:='complete';
  v_log jsonb; v_log_id bigint; v_columns text; v_values text; v_field text;
  v_projection jsonb; v_check jsonb; v_confirmation text; v_audit_id bigint;
  v_code text; v_block text; v_payable public.ledger_payables%rowtype;
  v_candidate public.ledger_candidates%rowtype; v_tx public.ledger_transactions%rowtype; v_month date;
begin
  -- Input contract. Unknown keys and non-finite numbers are rejected before any lock.
  if p_expected_quantity is null or p_business_date is null or jsonb_typeof(p_edit) is distinct from 'object'
     or exists(select 1 from jsonb_object_keys(p_edit) k
       where k <> all(array['quantity','purchase_price','supplier','supplier_partner_id','note','reason']::text[])) then
    return jsonb_build_object('status','invalid_payload');
  end if;
  begin
    v_quantity:=(p_edit->>'quantity')::numeric;
    v_price:=(p_edit->>'purchase_price')::numeric;
    v_partner:=nullif(p_edit->>'supplier_partner_id','')::bigint;
  exception when others then
    return jsonb_build_object('status','invalid_payload');
  end;
  v_supplier:=nullif(btrim(regexp_replace(coalesce(p_edit->>'supplier',''),'\s+',' ','g')),'');
  v_reason:=nullif(btrim(coalesce(p_edit->>'reason','')),'');
  v_note:=nullif(btrim(coalesce(p_edit->>'note','')),'');
  if v_quantity is null or v_quantity::text in ('NaN','Infinity','-Infinity') or v_quantity < 0
     or v_price is null or v_price::text in ('NaN','Infinity','-Infinity') or v_price <= 0
     or (v_supplier is null and v_partner is null) or v_reason is null
     or char_length(v_reason) > 200 or char_length(coalesce(v_note,'')) > 500 then
    return jsonb_build_object('status','invalid_payload');
  end if;

  select to_jsonb(u),lower(u.role::text) into v_actor,v_role from public.users u
    where id=p_actor_user_id and is_active and app_login_enabled;
  if v_actor is null then return jsonb_build_object('status','forbidden'); end if;

  -- Same source -> payable -> item lock order as inventory_apply_purchase_correction_v3.
  perform inventory_ledger_private.lock_sources(array['inventory-log:' || p_purchase_log_id],array[p_business_date]);
  perform 1 from public.ledger_payables where expense_transaction_id in (
    select resolved_transaction_id from public.ledger_candidates where source_type='inventory_purchase_log'
      and source_key='inventory-log:' || p_purchase_log_id
  ) order by id for update;
  select * into v_old from public.inventory where id=p_item_id for update;
  if v_old.id is null then return jsonb_build_object('status','not_found'); end if;
  if to_jsonb(v_old)->>'is_active' = 'false' and v_role <> all(array['leader','manager','owner','master']) then
    return jsonb_build_object('status','forbidden');
  end if;
  if v_old.quantity is distinct from p_expected_quantity then return jsonb_build_object('status','quantity_conflict'); end if;
  if inventory_ledger_private.item_matches_expected_v1(to_jsonb(v_old),p_expected_item) is not true then
    return jsonb_build_object('status','inventory_conflict');
  end if;

  select * into v_root from public.inventory_logs where id=p_purchase_log_id for update;
  if v_root.id is null or v_root.item_id is distinct from p_item_id or v_root.reason is distinct from 'purchase'
     or v_root.change_quantity is null or v_root.change_quantity<=0 or v_root.correction_of_inventory_log_id is not null then
    return jsonb_build_object('status','invalid_purchase_reference');
  end if;
  -- Stock is kept in the item's unit; a receipt in another unit is not editable here.
  if v_old.unit is distinct from v_root.unit then
    return jsonb_build_object('status','purchase_correction_review_required','blockReason','purchase_details_changed');
  end if;

  -- Current receipt state = original + linked corrections; latest linked log wins (projector rule).
  select v_root.change_quantity+coalesce(sum(change_quantity),0) into v_effective
    from public.inventory_logs where correction_of_inventory_log_id=v_root.id;
  select * into v_latest from public.inventory_logs where correction_of_inventory_log_id=v_root.id order by id desc limit 1;
  if v_latest.id is null then v_latest:=v_root; end if;
  if v_effective is null or v_effective < 0 then
    return jsonb_build_object('status','purchase_correction_review_required','blockReason','invalid_correction_history');
  end if;
  v_prev_price:=v_latest.new_purchase_price; v_prev_supplier:=nullif(btrim(v_latest.new_supplier),'');
  v_prev_partner:=v_latest.purchase_supplier_partner_id;
  v_delta:=v_quantity-v_effective;
  -- Supplier identity = partner id and name. Both ids present: the id decides, and a renamed
  -- partner keeps the recorded name. Otherwise any id change (null <-> id) or name change counts.
  if v_partner is not null and v_prev_partner is not null then
    v_supplier_changed:=v_partner<>v_prev_partner;
    if not v_supplier_changed then v_supplier:=coalesce(v_prev_supplier,v_supplier); end if;
  else
    v_supplier_changed:=v_partner is distinct from v_prev_partner
      or lower(coalesce(v_supplier,'')) <> lower(coalesce(v_prev_supplier,''));
    if not v_supplier_changed then v_supplier:=coalesce(v_prev_supplier,v_supplier); end if;
  end if;
  v_note_text:=v_reason || coalesce(' · ' || v_note,'');
  -- A memo/reason-only edit is saved as a zero-quantity edit log. The same request again
  -- (retry, double click) matches the latest log in every field and writes nothing.
  if v_delta=0 and v_price is not distinct from v_prev_price and not v_supplier_changed
     and v_note_text is not distinct from v_latest.new_note then
    return jsonb_build_object('status','no_change');
  end if;
  if v_supplier_changed and v_role <> all(array['owner','master']) then
    return jsonb_build_object('status','supplier_change_forbidden');
  end if;
  -- A later physical count already superseded receipt-derived stock.
  if v_delta<>0 and exists(select 1 from public.inventory_logs where item_id=p_item_id and reason='stock_check'
       and (created_at>v_root.created_at or (created_at=v_root.created_at and id>v_root.id))) then
    return jsonb_build_object('status','purchase_correction_later_stock_check');
  end if;
  if v_old.quantity+v_delta < 0 then return jsonb_build_object('status','inventory_quantity_negative'); end if;
  -- Ledger state before the edit decides which projector results are acceptable below.
  select status into v_candidate_status from public.ledger_candidates where source_type='inventory_purchase_log'
    and source_key='inventory-log:' || v_root.id order by id desc limit 1;
  -- A dismissed (excluded or fully cancelled) receipt would otherwise get a new pending candidate.
  if v_candidate_status='dismissed' then
    return jsonb_build_object('status','purchase_correction_review_required','code','DISMISSED_SOURCE','blockReason','purchase_dismissed');
  end if;
  -- One open Ledger review per receipt: an earlier-day edit (or any other projection issue)
  -- waits for the owner repair screen before the receipt can be edited again.
  if exists(select 1 from public.ledger_inventory_projection_status s join public.inventory_logs l on l.id=s.inventory_log_id
      where (l.id=v_root.id or l.correction_of_inventory_log_id=v_root.id) and s.status in ('review_required','failed')) then
    return jsonb_build_object('status','purchase_correction_review_required','code','LEDGER_REVIEW_PENDING','blockReason','ledger_review_pending');
  end if;
  -- A booked receipt is protected for every edit. A memo/reason-only edit keeps the economics,
  -- so the projector records it as metadata without its payment/close/manual-edit gates.
  -- Same checks as inspect_purchase_repair, under the payable row locks taken above and the
  -- month-close locks the projector uses (ascending month order).
  if v_candidate_status='confirmed' then
    select * into v_candidate from public.ledger_candidates where source_type='inventory_purchase_log'
      and source_key='inventory-log:' || v_root.id order by id desc limit 1;
    select * into v_tx from public.ledger_transactions where id=v_candidate.resolved_transaction_id;
    select * into v_payable from public.ledger_payables where expense_transaction_id=v_tx.id;
    for v_month in select distinct m from unnest(array[date_trunc('month',v_root.business_date)::date,
        v_candidate.proposed_recognition_month,date_trunc('month',v_tx.business_date)::date,v_tx.recognition_month,
        date_trunc('month',p_business_date)::date]) m where m is not null order by 1 loop
      perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(v_month,'YYYY-MM')));
      if public.ledger_month_is_closed_v1(v_month) then v_block:='month_closed'; end if;
    end loop;
    v_block:=coalesce(v_block,case
      when v_tx.id is null then 'ledger_transaction_missing'
      when v_tx.amount is distinct from v_candidate.proposed_amount then 'ledger_amount_changed'
      when v_tx.status is distinct from 'confirmed' or v_tx.type is distinct from 'expense'
        or v_tx.source_type not in ('inventory_purchase_candidate','inventory_purchase_rebook') then 'ledger_status_changed'
      when v_payable.id is null or v_payable.status='paid' then 'payment_completed'
      when exists(select 1 from public.ledger_payable_allocations where payable_id=v_payable.id) then 'payment_allocated'
      when v_payable.status is distinct from 'unpaid' then 'payment_state'
      when v_payable.original_amount is distinct from v_tx.amount or v_payable.party_id is distinct from v_tx.party_id
        then 'ledger_status_changed'
    end);
    if v_block is not null then
      return jsonb_build_object('status','purchase_correction_review_required','code','CONFIRMED_RECEIPT_PROTECTED','blockReason',v_block);
    end if;
  end if;

  -- All writes below commit together or not at all.
  begin
    update public.inventory set quantity=v_old.quantity+v_delta,
      updated_at=greatest(clock_timestamp(),v_old.updated_at + interval '1 millisecond'),
      updated_by_name=v_actor->>'name',updated_by_username=v_actor->>'username'
      where id=p_item_id returning * into v_new;
    v_log:=jsonb_build_object(
      'item_id',p_item_id,'source_actor_user_id',p_actor_user_id,'correction_of_inventory_log_id',v_root.id,
      'item_name',to_jsonb(v_new)->>'item_name','item_name_vi',to_jsonb(v_new)->>'item_name_vi',
      -- Marks a receipt-only edit; the daily sync must not copy it back onto the receipt row.
      'action','receipt_edit','source','edit_form','reason','purchase',
      'part',to_jsonb(v_new)->>'part','category',to_jsonb(v_new)->>'category','category_vi',to_jsonb(v_new)->>'category_vi',
      'unit',v_root.unit,'code',to_jsonb(v_new)->>'code',
      'business_date',p_business_date,'actor_name',v_actor->>'name','actor_username',v_actor->>'username',
      'prev_quantity',v_old.quantity,'new_quantity',v_new.quantity,'change_quantity',v_delta,
      'prev_purchase_price',v_prev_price,'new_purchase_price',v_price,
      'prev_supplier',v_prev_supplier,'new_supplier',v_supplier,'purchase_supplier_partner_id',v_partner,
      'prev_note',null,'new_note',v_note_text
    );
    foreach v_field in array array['code','unit','category','category_vi','part'] loop
      v_log:=v_log || jsonb_build_object('prev_' || v_field,to_jsonb(v_old)->v_field,'new_' || v_field,to_jsonb(v_new)->v_field);
    end loop;
    select string_agg(format('%I',key),','),string_agg(format('(jsonb_populate_record(null::public.inventory_logs,$1)).%I',key),',')
      into v_columns,v_values from jsonb_object_keys(v_log) key
      where exists(select 1 from pg_attribute where attrelid='public.inventory_logs'::regclass and attname=key and not attisdropped);
    execute format('insert into public.inventory_logs(%s) select %s returning id',v_columns,v_values) into v_log_id using v_log;
    if v_log_id is null then raise exception 'INVENTORY_REQUIRED_AUDIT_MISSING'; end if;

    v_confirmation:=current_setting('baba.purchase_confirmation',true);
    perform set_config('baba.purchase_confirmation','',true);
    v_projection:=public.ledger_project_inventory_purchase_log_v1(v_log_id,p_actor_user_id);
    if v_projection->>'status'='failed' then raise exception 'INVENTORY_LEDGER_ATOMIC_FAILED'; end if;
    -- pending = the receipt is not booked yet: its unconfirmed candidate (or a new one for an
    -- unmapped supplier) now carries the edited amount and still needs the owner's confirmation.
    -- That is a partial completion, never a success, and only valid if nothing was booked before.
    if v_projection->>'status'='pending' then
      if v_candidate_status is not null and v_candidate_status<>'pending' then raise exception 'LEDGER_PENDING_UNEXPECTED'; end if;
      v_completion:='ledger_pending';
    elsif v_projection->>'status' is distinct from 'synced' and v_projection->>'status' is distinct from 'review_required' then
      raise exception 'INVENTORY_LEDGER_ATOMIC_FAILED';
    end if;
    if v_projection->>'status'='review_required' then
      if v_projection->>'code' in ('MONTH_CLOSED','DISMISSED_SOURCE') then raise exception '%',v_projection->>'code'; end if;
      v_check:=inventory_ledger_private.inspect_purchase_repair(v_log_id,v_root.id);
      if not (v_check->>'code'='READY' or (v_check->>'code'='SUPPLIER_CHANGE_CONFIRMATION_REQUIRED' and v_supplier_changed
          and coalesce((v_check#>>'{supplierChange,valid}')::boolean,false))) then
        raise exception '%',coalesce(v_check->>'code','PURCHASE_CORRECTION_REVIEW_REQUIRED');
      end if;
      v_same_day:=v_root.business_date=p_business_date
        and p_business_date=public.store_business_date_for_timestamp_v1(clock_timestamp());
      if v_same_day then
        -- The receipt's supplier must resolve to exactly one mapped Ledger party; without a
        -- supplier change it must be the booked party (same check as v3).
        if not (select count(*)=1 and (v_supplier_changed or min(blp.ledger_party_id)=(
            select party_id from public.ledger_transactions where id=(v_check->>'transactionId')::bigint))
          from public.inventory_logs l join public.business_partners bp on bp.is_active and (
            (l.purchase_supplier_partner_id is not null and bp.id=l.purchase_supplier_partner_id)
            or (l.purchase_supplier_partner_id is null and (lower(btrim(bp.name))=lower(btrim(l.new_supplier))
              or exists(select 1 from public.business_partner_supplier_aliases a where a.business_partner_id=bp.id
                and a.status='linked' and a.normalized_name=lower(btrim(l.new_supplier))))))
          join public.business_partner_ledger_parties blp on blp.business_partner_id=bp.id
          where l.id=v_log_id) then
          raise exception 'SUPPLIER_PAYMENT_MAPPING_REQUIRED';
        end if;
        perform set_config('baba.purchase_confirmation',v_log_id::text,true);
        v_projection:=public.ledger_project_inventory_purchase_log_v1(v_log_id,p_actor_user_id);
        perform set_config('baba.purchase_confirmation',coalesce(v_confirmation,''),true);
        if v_projection->>'status' is distinct from 'synced' or v_projection->>'code' is distinct from 'REBOOKED' then
          raise exception '%',case when coalesce(v_projection->>'code','') ~ '^[A-Z0-9_]+$' then v_projection->>'code' else 'INVENTORY_LEDGER_ATOMIC_FAILED' end;
        end if;
        -- Same rebook evidence as v3: reversal, cancelled payable, rebook audit and new booking.
        if not exists(select 1 from public.ledger_transactions where correction_of_id=(v_check->>'transactionId')::bigint
            and source_type='inventory_purchase_reversal' and economic_effect_sign=-1 and amount=(v_check->>'oldAmount')::numeric)
          or not exists(select 1 from public.ledger_payables where expense_transaction_id=(v_check->>'transactionId')::bigint and status='cancelled')
          or not exists(select 1 from public.ledger_audit_logs where action='inventory_source_rebooked'
            and after_snapshot->>'originalTransactionId'=v_check->>'transactionId')
          or not exists(select 1 from public.ledger_candidates c where c.source_type='inventory_purchase_log'
            and c.source_key='inventory-log:' || v_root.id
            and (c.source_snapshot->>'purchase_amount')::numeric=(v_check->>'newAmount')::numeric
            and ((c.status='dismissed' and c.dismissal_reason='Inventory purchase fully cancelled' and (v_check->>'newAmount')::numeric=0)
              or (c.status='confirmed' and exists(select 1 from public.ledger_transactions t join public.ledger_payables p on p.expense_transaction_id=t.id
                where t.id=c.resolved_transaction_id and t.status='confirmed' and t.amount=(v_check->>'newAmount')::numeric
                  and p.status='unpaid' and p.original_amount=t.amount and p.party_id=t.party_id)))) then
          raise exception 'INVENTORY_LEDGER_ATOMIC_FAILED';
        end if;
      else
        -- An earlier day stays committed as review_required for the owner's repair screen.
        v_completion:='ledger_review';
      end if;
    end if;
    -- A booked receipt whose amount changed must have been rebooked (or be in review). A
    -- supplier-only change may also be the projector's same-party partner enrichment.
    if v_candidate_status='confirmed' and v_completion='complete' and v_projection->>'code' is distinct from 'REBOOKED'
       and (v_delta<>0 or v_price is distinct from v_prev_price
         or (v_supplier_changed and v_projection->>'code' is distinct from 'METADATA_SYNCED')) then
      raise exception 'INVENTORY_LEDGER_ATOMIC_FAILED';
    end if;
    perform set_config('baba.purchase_confirmation',coalesce(v_confirmation,''),true);

    insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
      values(p_actor_user_id,'inventory_purchase_receipt_edited','inventory_log',v_log_id,
        jsonb_build_object('purchaseLogId',v_root.id,'quantity',v_effective,'purchasePrice',v_prev_price,
          'supplier',v_prev_supplier,'supplierPartnerId',v_prev_partner,'itemQuantity',v_old.quantity,'preview',v_check),
        jsonb_build_object('purchaseLogId',v_root.id,'quantity',v_quantity,'purchasePrice',v_price,
          'supplier',v_supplier,'supplierPartnerId',v_partner,'itemQuantity',v_new.quantity,
          'editReason',v_reason,'note',v_note,'completion',v_completion,'projection',v_projection),
        'Inventory receipt edit') returning id into v_audit_id;
    if v_audit_id is null then raise exception 'INVENTORY_REQUIRED_AUDIT_MISSING'; end if;
  exception when others then
    get stacked diagnostics v_code=MESSAGE_TEXT;
    perform set_config('baba.purchase_confirmation',coalesce(v_confirmation,''),true);
    v_code:=case when v_code ~ '^[A-Z0-9_]+$' then v_code else 'RECEIPT_EDIT_FAILED' end;
    if v_code='PAYABLE_ALREADY_PAID' then
      select p.* into v_payable from public.ledger_payables p join public.ledger_candidates c on c.resolved_transaction_id=p.expense_transaction_id
        where c.source_type='inventory_purchase_log' and c.source_key='inventory-log:' || v_root.id order by c.id desc limit 1;
      v_block:=case when v_payable.status='paid' then 'payment_completed'
        when exists(select 1 from public.ledger_payable_allocations where payable_id=v_payable.id) then 'payment_allocated'
        else 'payment_state' end;
    else
      v_block:=case
        when v_code='MONTH_CLOSED' then 'month_closed'
        when v_code='MANUAL_LEDGER_OVERRIDE' then 'ledger_amount_changed'
        when v_code in ('INVALID_TRANSACTION_STATE','INVALID_PAYABLE_STATE','ALREADY_REBOOKED') then 'ledger_status_changed'
        when v_code in ('DISMISSED_SOURCE','INVALID_CANDIDATE_STATE') then 'purchase_dismissed'
        when v_code in ('SUPPLIER_PAYMENT_MAPPING_REQUIRED','SUPPLIER_MISMATCH','SUPPLIER_REFERENCE_REQUIRED',
          'SUPPLIER_CORRECTION_ORDER_REQUIRED','UNIT_MISMATCH','INVALID_PURCHASE_CORRECTION_REFERENCE') then 'supplier_mapping_required'
        when v_code in ('PURCHASE_CORRECTION_EXCEEDS_PURCHASE') then 'invalid_correction_history'
        when v_code='LEDGER_PENDING_UNEXPECTED' then 'ledger_status_changed'
        else 'receipt_edit_review' end;
    end if;
    return jsonb_build_object('status','purchase_correction_review_required','code',v_code,'blockReason',v_block);
  end;
  return jsonb_build_object('status','ok','inventoryLogId',v_log_id,'inventory',to_jsonb(v_new),
    'quantity',v_quantity,'quantityDelta',v_delta,'completion',v_completion,'ledgerSync',v_projection);
end;
$$;

drop trigger if exists inventory_purchase_correction_guard_billed_amount on public.inventory_logs;
drop function if exists public.inventory_purchase_billed_amount_guard_v1();
drop function if exists inventory_ledger_private.purchase_billed_amount_v1(bigint,bigint);
alter table public.inventory_logs
  drop constraint if exists inventory_logs_billed_amount_purchase_check,
  drop constraint if exists inventory_logs_billed_amount_mode_check,
  drop column if exists billed_amount_mode,
  drop column if exists billed_amount;

-- Privileges are unchanged by create or replace; restated for the replaced public functions.
revoke all on function public.inventory_update_with_audit_v1(bigint,jsonb,jsonb,date,bigint,text,text,date) from public,anon,authenticated,service_role;
grant execute on function public.inventory_update_with_audit_v1(bigint,jsonb,jsonb,date,bigint,text,text,date) to service_role;
revoke all on function public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint) from public,anon,authenticated,service_role;
grant execute on function public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint) to service_role;
revoke all on function public.ledger_project_inventory_purchase_log_v1(bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.ledger_project_inventory_purchase_log_v1(bigint,bigint) to service_role;
commit;
