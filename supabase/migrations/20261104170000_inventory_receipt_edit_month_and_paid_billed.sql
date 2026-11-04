-- /inventory/snapshots 입고 수정 — 현재 영업월 미마감 입고 + 지급완료 입고의 실청구금액 감액 정정.
--
-- 1. 미지급(확정) 입고의 자동 재기표 범위: 당일 → 현재 영업월(베트남 03:00 영업일 기준).
--    월마감·지급·배분·수기금액 보호는 그대로이고, 이전 달 입고는 기존처럼 관리자 검토(ledger_review).
-- 2. 지급완료 입고: 수량·단가·거래처는 그대로 두고 실청구금액만 줄이는 수정을 원자적으로 반영한다.
--    원 비용 전표·후불·배분·지급 전표·지급 이동은 보존하고, 감소액만
--      * 비용 정정 전표(type expense, economic_effect_sign -1, correction_of = 원 비용 전표,
--        source_type 'inventory_purchase_billed_correction', 지급일·지급계정)
--      * 같은 지급계정 +감소액 이동(과다 지급분 복원)
--      * 감사 로그
--    로 기록한다. 원천 후보 스냅샷은 새 실청구금액으로 갱신하고, 같은 트랜잭션에서 기존 프로젝터가
--    UNCHANGED/METADATA_SYNCED 로 확인해야만 커밋된다. 같은 요청 재시도는 RPC의 no_change, 정정 전표는
--    (source_type, source_key) 유일 인덱스로 중복 반영되지 않는다.
--    대상 조건(하나라도 아니면 기존 payment_completed 차단): 수량·단가·거래처 변경 없음, manual 감액(>0),
--    입고·지급이 현재 영업월이고 미마감, 후불 paid·원금액=비용 전표, 배분 1건=원금액, 지급 전표 확정·이동 1건(출금).
--
-- 배포 본문에 앵커 패치한다(20261030180000 과 같은 방식). 앵커가 정확히 1회씩 없으면 중단한다.
-- 운영 데이터는 바꾸지 않는다.
begin;

create or replace function inventory_ledger_private.paid_receipt_billed_correction_ready_v1(
  p_transaction_id bigint, p_previous_amount numeric, p_new_amount numeric, p_business_date date
) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
  v_tx public.ledger_transactions%rowtype; v_payable public.ledger_payables%rowtype;
  v_payment public.ledger_transactions%rowtype; v_alloc public.ledger_payable_allocations%rowtype;
  v_corrected numeric; v_month date;
begin
  if p_new_amount is null or p_previous_amount is null or p_new_amount<=0 or p_new_amount>=p_previous_amount then return false; end if;
  v_month:=date_trunc('month',public.store_business_date_for_timestamp_v1(clock_timestamp()))::date;
  if p_business_date is distinct from public.store_business_date_for_timestamp_v1(clock_timestamp()) then return false; end if;
  select * into v_tx from public.ledger_transactions where id=p_transaction_id;
  if v_tx.id is null or v_tx.status<>'confirmed' or v_tx.type<>'expense' or v_tx.correction_of_id is not null
     or v_tx.source_type not in ('inventory_purchase_candidate','inventory_purchase_rebook')
     or date_trunc('month',v_tx.business_date)::date<>v_month or v_tx.recognition_month is distinct from v_month then return false; end if;
  select * into v_payable from public.ledger_payables where expense_transaction_id=v_tx.id;
  if v_payable.id is null or v_payable.status<>'paid' or v_payable.original_amount<>v_tx.amount or v_payable.party_id is distinct from v_tx.party_id then return false; end if;
  if (select count(*) from public.ledger_payable_allocations where payable_id=v_payable.id)<>1 then return false; end if;
  select * into v_alloc from public.ledger_payable_allocations where payable_id=v_payable.id;
  if v_alloc.allocated_amount<>v_payable.original_amount then return false; end if;
  select * into v_payment from public.ledger_transactions where id=v_alloc.payment_transaction_id;
  if v_payment.id is null or v_payment.status<>'confirmed' or v_payment.type<>'payable_payment'
     or date_trunc('month',v_payment.business_date)::date<>v_month
     or (select count(*) from public.ledger_movements where transaction_id=v_payment.id)<>1
     or not exists(select 1 from public.ledger_movements m join public.ledger_fund_accounts a on a.id=m.fund_account_id
       where m.transaction_id=v_payment.id and m.amount<0 and a.type<>'card_clearing') then return false; end if;
  if public.ledger_month_is_closed_v1(v_month) then return false; end if;
  -- Earlier billed corrections of this receipt: the booked cost minus them is the previous amount.
  select coalesce(sum(amount),0) into v_corrected from public.ledger_transactions
    where correction_of_id=v_tx.id and status='confirmed' and source_type='inventory_purchase_billed_correction';
  if exists(select 1 from public.ledger_transactions where correction_of_id=v_tx.id and status='confirmed'
       and source_type<>'inventory_purchase_billed_correction') then return false; end if;
  return v_tx.amount-v_corrected=p_previous_amount;
end;
$$;

create or replace function inventory_ledger_private.correct_paid_receipt_billed_v1(
  p_root_log_id bigint, p_edit_log_id bigint, p_transaction_id bigint,
  p_previous_amount numeric, p_new_amount numeric, p_business_date date, p_actor_user_id bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_key text:='inventory-log:' || p_root_log_id;
  v_candidate public.ledger_candidates%rowtype; v_tx public.ledger_transactions%rowtype;
  v_payable public.ledger_payables%rowtype; v_alloc public.ledger_payable_allocations%rowtype;
  v_payment public.ledger_transactions%rowtype; v_movement public.ledger_movements%rowtype;
  v_root public.inventory_logs%rowtype; v_latest public.inventory_logs%rowtype;
  v_effective numeric; v_corrections bigint[]; v_snapshot jsonb; v_previous_snapshot jsonb; v_fingerprint text;
  v_diff numeric:=p_previous_amount-p_new_amount; v_correction_id bigint; v_check jsonb; v_audit_id bigint;
begin
  select * into v_tx from public.ledger_transactions where id=p_transaction_id for update;
  select * into v_payable from public.ledger_payables where expense_transaction_id=p_transaction_id for update;
  select * into v_alloc from public.ledger_payable_allocations where payable_id=v_payable.id for update;
  select * into v_payment from public.ledger_transactions where id=v_alloc.payment_transaction_id for update;
  perform pg_advisory_xact_lock(hashtext('ledger_month_close:' || to_char(v_payment.business_date,'YYYY-MM')));
  if not inventory_ledger_private.paid_receipt_billed_correction_ready_v1(p_transaction_id,p_previous_amount,p_new_amount,p_business_date) then
    raise exception 'PAID_BILLED_CORRECTION_NOT_READY';
  end if;
  select * into v_movement from public.ledger_movements where transaction_id=v_payment.id;
  select * into v_candidate from public.ledger_candidates where source_type='inventory_purchase_log' and source_key=v_key
    order by id desc limit 1 for update;
  if v_candidate.id is null or v_candidate.status<>'confirmed' or v_candidate.resolved_transaction_id<>v_tx.id
     or v_candidate.proposed_amount<>v_tx.amount then raise exception 'PAID_BILLED_CANDIDATE_STATE'; end if;

  -- Source snapshot = the projector's snapshot for the edited receipt (economics re-checked below).
  select * into v_root from public.inventory_logs where id=p_root_log_id;
  select array_agg(id order by id),v_root.change_quantity+coalesce(sum(change_quantity),0)
    into v_corrections,v_effective from public.inventory_logs where correction_of_inventory_log_id=v_root.id;
  select * into v_latest from public.inventory_logs where correction_of_inventory_log_id=v_root.id order by id desc limit 1;
  if v_latest.id is distinct from p_edit_log_id or v_latest.billed_amount_mode is distinct from 'manual'
     or v_latest.billed_amount is distinct from p_new_amount then raise exception 'PAID_BILLED_EDIT_LOG_MISMATCH'; end if;
  v_previous_snapshot:=v_candidate.source_snapshot;
  v_snapshot:=v_candidate.source_snapshot || jsonb_build_object('purchase_amount',p_new_amount,'billed_amount_mode','manual',
    'calculated_amount',round(v_effective*v_latest.new_purchase_price,3),'inventory_correction_log_ids',to_jsonb(v_corrections));
  v_fingerprint:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
  update public.ledger_candidates set source_snapshot=v_snapshot,source_fingerprint=v_fingerprint,updated_at=now()
    where id=v_candidate.id;

  insert into public.ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,
      status,source_type,source_key,source_snapshot,correction_of_id,memo,created_by,confirmed_by,source_fingerprint,source_synced_at,
      economic_effect_sign)
    values(gen_random_uuid(),'expense',v_payment.occurred_at,v_payment.business_date,v_tx.recognition_month,v_diff,v_tx.category_id,v_tx.party_id,
      'confirmed','inventory_purchase_billed_correction','inventory-log:' || p_edit_log_id || ':paid-billed',
      jsonb_build_object('inventoryLogId',p_root_log_id,'editInventoryLogId',p_edit_log_id,'originalTransactionId',v_tx.id,
        'payableId',v_payable.id,'allocationId',v_alloc.id,'paymentTransactionId',v_payment.id,'fundAccountId',v_movement.fund_account_id,
        'previousAmount',p_previous_amount,'billedAmount',p_new_amount,'difference',v_diff),
      v_tx.id,'실청구금액 정정(지급완료 입고): ' || p_previous_amount::text || ' → ' || p_new_amount::text,
      p_actor_user_id,p_actor_user_id,v_fingerprint,now(),-1)
    returning id into v_correction_id;
  insert into public.ledger_movements(transaction_id,fund_account_id,amount) values(v_correction_id,v_movement.fund_account_id,v_diff);

  -- The unchanged projector must now see this receipt as already booked (no drift, no rebook).
  v_check:=public.ledger_project_inventory_purchase_log_v1(p_edit_log_id,p_actor_user_id);
  if v_check->>'status' is distinct from 'synced' or v_check->>'code' not in ('UNCHANGED','METADATA_SYNCED') then
    raise exception 'PAID_BILLED_PROJECTION_MISMATCH';
  end if;

  insert into public.ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
    values(p_actor_user_id,'inventory_paid_receipt_billed_corrected','transaction',v_correction_id,
      jsonb_build_object('transaction',to_jsonb(v_tx),'payable',to_jsonb(v_payable),'allocation',to_jsonb(v_alloc),
        'paymentTransaction',to_jsonb(v_payment),'paymentMovement',to_jsonb(v_movement),'candidateSnapshot',v_previous_snapshot,
        'amount',p_previous_amount),
      jsonb_build_object('correctionTransactionId',v_correction_id,'inventoryLogId',p_root_log_id,'editInventoryLogId',p_edit_log_id,
        'fundAccountId',v_movement.fund_account_id,'fundDelta',v_diff,'expenseDelta',-v_diff,'amount',p_new_amount,
        'candidateSnapshot',v_snapshot,'projection',v_check),
      'Paid inventory receipt billed amount corrected; original payment and allocation preserved')
    returning id into v_audit_id;
  if v_audit_id is null then raise exception 'INVENTORY_REQUIRED_AUDIT_MISSING'; end if;

  return jsonb_build_object('status','synced','code','PAID_BILLED_CORRECTED','inventoryLogId',p_edit_log_id,
    'candidateId',v_candidate.id,'transactionId',v_tx.id,'correctionTransactionId',v_correction_id,
    'fundAccountId',v_movement.fund_account_id,'fundDelta',v_diff,'amount',p_new_amount);
end;
$$;

revoke all on function inventory_ledger_private.paid_receipt_billed_correction_ready_v1(bigint,numeric,numeric,date) from public,anon,authenticated,service_role;
revoke all on function inventory_ledger_private.correct_paid_receipt_billed_v1(bigint,bigint,bigint,numeric,numeric,date,bigint) from public,anon,authenticated,service_role;
alter function inventory_ledger_private.paid_receipt_billed_correction_ready_v1(bigint,numeric,numeric,date) owner to postgres;
alter function inventory_ledger_private.correct_paid_receipt_billed_v1(bigint,bigint,bigint,numeric,numeric,date,bigint) owner to postgres;

do $migration$
declare
  v_definition text;
  v_anchor text[];
  v_patch text[];
  i integer;
begin
  select replace(pg_get_functiondef('public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)'::regprocedure),E'\r\n',E'\n')
    into v_definition;
  if position('correct_paid_receipt_billed_v1' in v_definition)>0 then
    raise exception 'INVENTORY_RECEIPT_EDIT_PAID_BILLED_ALREADY_APPLIED';
  end if;
  v_anchor:=array[
    -- a. state flag
    E'v_prev_amount numeric; v_new_amount numeric; v_billed_changed boolean;',
    -- b. paid receipt, billed-only decrease: lift only the payment_completed block
    E'    if v_block is not null then\n      return jsonb_build_object(''status'',''purchase_correction_review_required'',''code'',''CONFIRMED_RECEIPT_PROTECTED'',''blockReason'',v_block);',
    -- c. paid path replaces the projector call (the projector is re-run inside as a check)
    E'    v_projection:=public.ledger_project_inventory_purchase_log_v1(v_log_id,p_actor_user_id);\n    if v_projection->>''status''=''failed''',
    -- d. automatic rebook: same business month instead of same day
    E'      v_same_day:=v_root.business_date=p_business_date\n',
    -- e. a paid billed correction is complete without a rebook
    E'    if v_candidate_status=''confirmed'' and v_completion=''complete'' and v_projection->>''code'' is distinct from ''REBOOKED''\n'
  ];
  v_patch:=array[
    E'v_prev_amount numeric; v_new_amount numeric; v_billed_changed boolean; v_paid_billed boolean:=false;',
    E'    if v_block=''payment_completed'' and v_payable.id is not null and v_delta=0 and v_price=v_prev_price and not v_supplier_changed\n'
    || E'       and v_billed_mode=''manual'' and date_trunc(''month'',v_root.business_date)=date_trunc(''month'',p_business_date)\n'
    || E'       and inventory_ledger_private.paid_receipt_billed_correction_ready_v1(v_tx.id,v_prev_amount,v_new_amount,p_business_date) then\n'
    || E'      v_block:=null; v_paid_billed:=true;\n'
    || E'    end if;\n'
    || E'    if v_block is not null then\n      return jsonb_build_object(''status'',''purchase_correction_review_required'',''code'',''CONFIRMED_RECEIPT_PROTECTED'',''blockReason'',v_block);',
    E'    v_projection:=case when v_paid_billed\n'
    || E'      then inventory_ledger_private.correct_paid_receipt_billed_v1(v_root.id,v_log_id,v_tx.id,v_prev_amount,v_new_amount,p_business_date,p_actor_user_id)\n'
    || E'      else public.ledger_project_inventory_purchase_log_v1(v_log_id,p_actor_user_id) end;\n    if v_projection->>''status''=''failed''',
    E'      v_same_day:=date_trunc(''month'',v_root.business_date)=date_trunc(''month'',p_business_date)\n',
    E'    if v_candidate_status=''confirmed'' and v_completion=''complete'' and v_projection->>''code'' is distinct from ''REBOOKED'' and not v_paid_billed\n'
  ];
  for i in 1..array_length(v_anchor,1) loop
    if (length(v_definition)-length(replace(v_definition,v_anchor[i],'')))<>length(v_anchor[i]) then
      raise exception 'INVENTORY_RECEIPT_EDIT_PAID_BILLED_CONTRACT_MISMATCH (anchor %)',i;
    end if;
    v_definition:=replace(v_definition,v_anchor[i],v_patch[i]);
  end loop;
  execute v_definition;
end;
$migration$;

revoke all on function public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)
  to service_role;

commit;
