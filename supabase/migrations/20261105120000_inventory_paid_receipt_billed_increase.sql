-- 지급완료 입고 실청구금액: 당월 감액에 더해 증액도 같은 정정 체계로 반영한다.
--
-- 20261104170000 의 두 private 함수만 교체한다(서명·권한 동일). 입고 수정 RPC
-- public.inventory_apply_purchase_receipt_edit_v1 은 이미 이 함수들을 호출하므로 바꾸지 않는다.
--   * 차액 v_diff = 새 실청구액 - 직전 실청구액 (증액 +, 감액 -). 0 은 대상 아님.
--   * 정정 전표: type expense, correction_of = 원 비용 전표, source_type 'inventory_purchase_billed_correction',
--     amount |v_diff|, economic_effect_sign sign(v_diff)  → 비용 +v_diff
--   * 같은 지급계정 이동 -v_diff (증액 = 추가 출금, 감액 = 과다 지급분 복원)
--   * 직전 실청구액 = 원 비용 + Σ(이전 정정 amount × sign) — 증액·감액이 섞인 반복 수정도 누적이 정확하다.
-- 원 비용 전표·후불·배분·지급 전표·지급 이동은 그대로 보존한다. 대상 조건(현재 영업월·미마감·
-- 수량·단가·거래처 불변·manual·후불 paid·배분 1건·지급 이동 1건 출금·카드 정산계정 제외)과 재시도 보호
-- (RPC no_change, (source_type, source_key) 유일)는 20261104170000 과 같다.
-- 운영 데이터는 바꾸지 않는다(기존 감액 정정 전표는 sign -1 이므로 새 누적식과 그대로 일치).
begin;

do $guard$
begin
  if position('correct_paid_receipt_billed_v1' in pg_get_functiondef(
       'public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)'::regprocedure))=0
     or to_regprocedure('inventory_ledger_private.correct_paid_receipt_billed_v1(bigint,bigint,bigint,numeric,numeric,date,bigint)') is null then
    raise exception 'INVENTORY_PAID_BILLED_INCREASE_REQUIRES_20261104170000';
  end if;
end;
$guard$;

create or replace function inventory_ledger_private.paid_receipt_billed_correction_ready_v1(
  p_transaction_id bigint, p_previous_amount numeric, p_new_amount numeric, p_business_date date
) returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare
  v_tx public.ledger_transactions%rowtype; v_payable public.ledger_payables%rowtype;
  v_payment public.ledger_transactions%rowtype; v_alloc public.ledger_payable_allocations%rowtype;
  v_corrected numeric; v_month date;
begin
  if p_new_amount is null or p_previous_amount is null or p_new_amount<=0 or p_new_amount=p_previous_amount then return false; end if;
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
  -- Earlier billed corrections of this receipt, signed (increase +, decrease -): booked cost plus them is the previous amount.
  select coalesce(sum(amount*economic_effect_sign),0) into v_corrected from public.ledger_transactions
    where correction_of_id=v_tx.id and status='confirmed' and source_type='inventory_purchase_billed_correction';
  if exists(select 1 from public.ledger_transactions where correction_of_id=v_tx.id and status='confirmed'
       and source_type<>'inventory_purchase_billed_correction') then return false; end if;
  return v_tx.amount+v_corrected=p_previous_amount;
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
  -- Signed expense delta: + increase (extra cost, extra outflow), - decrease (cost back, refund to the account).
  v_diff numeric:=p_new_amount-p_previous_amount; v_correction_id bigint; v_check jsonb; v_audit_id bigint;
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
    values(gen_random_uuid(),'expense',v_payment.occurred_at,v_payment.business_date,v_tx.recognition_month,abs(v_diff),v_tx.category_id,v_tx.party_id,
      'confirmed','inventory_purchase_billed_correction','inventory-log:' || p_edit_log_id || ':paid-billed',
      -- difference keeps its 20261104170000 meaning (previous - billed, refund +); expenseDelta is the signed cost change.
      jsonb_build_object('inventoryLogId',p_root_log_id,'editInventoryLogId',p_edit_log_id,'originalTransactionId',v_tx.id,
        'payableId',v_payable.id,'allocationId',v_alloc.id,'paymentTransactionId',v_payment.id,'fundAccountId',v_movement.fund_account_id,
        'previousAmount',p_previous_amount,'billedAmount',p_new_amount,'difference',-v_diff,'expenseDelta',v_diff),
      v_tx.id,'실청구금액 정정(지급완료 입고): ' || p_previous_amount::text || ' → ' || p_new_amount::text,
      p_actor_user_id,p_actor_user_id,v_fingerprint,now(),sign(v_diff)::integer)
    returning id into v_correction_id;
  insert into public.ledger_movements(transaction_id,fund_account_id,amount) values(v_correction_id,v_movement.fund_account_id,-v_diff);

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
        'fundAccountId',v_movement.fund_account_id,'fundDelta',-v_diff,'expenseDelta',v_diff,'amount',p_new_amount,
        'candidateSnapshot',v_snapshot,'projection',v_check),
      'Paid inventory receipt billed amount corrected; original payment and allocation preserved')
    returning id into v_audit_id;
  if v_audit_id is null then raise exception 'INVENTORY_REQUIRED_AUDIT_MISSING'; end if;

  return jsonb_build_object('status','synced','code','PAID_BILLED_CORRECTED','inventoryLogId',p_edit_log_id,
    'candidateId',v_candidate.id,'transactionId',v_tx.id,'correctionTransactionId',v_correction_id,
    'fundAccountId',v_movement.fund_account_id,'fundDelta',-v_diff,'amount',p_new_amount);
end;
$$;

revoke all on function inventory_ledger_private.paid_receipt_billed_correction_ready_v1(bigint,numeric,numeric,date) from public,anon,authenticated,service_role;
revoke all on function inventory_ledger_private.correct_paid_receipt_billed_v1(bigint,bigint,bigint,numeric,numeric,date,bigint) from public,anon,authenticated,service_role;
alter function inventory_ledger_private.paid_receipt_billed_correction_ready_v1(bigint,numeric,numeric,date) owner to postgres;
alter function inventory_ledger_private.correct_paid_receipt_billed_v1(bigint,bigint,bigint,numeric,numeric,date,bigint) owner to postgres;

commit;
