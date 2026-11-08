-- /inventory/snapshots 입고 수정 — 수량 변경 저장 실패(2026-11-08 #15182 Táo) 근본 원인 수정.
--
-- 원인
--   20261102120303(P1-2E)은 재고 수량을 바꾸는 RPC 본문을 inventory_writer_private.rpc_contracts.installed_body
--   로 등록하고, capture_change 트리거가 "현재 본문 = 등록 본문(pos_signed_private.current_rpc_body)"인
--   RPC의 수량 변경만 허용한다. 20261104170000은 inventory_apply_purchase_receipt_edit_v1 본문을 앵커
--   패치했지만 rpc_successors 에 후속 본문을 등록하지 않았다. 그 뒤 수량이 바뀌는 입고 수정은 모두
--   INVENTORY_WRITER_REGISTERED_REQUEST_REQUIRED 로 중단되고, RPC의 exception 처리기가 이를
--   receipt_edit_review(장부 상태 확인 불가)로 표시했다. 메모·사유만 바꾸는 수정은 수량이 그대로라 통과했다.
--
-- 변경(이 함수 하나만)
--   1. 현재 본문이 "등록 본문 + 20261104170000 의 다섯 앵커 패치"와 정확히 같을 때만 진행한다(줄바꿈 정규화).
--      다른 차이가 있으면 중단한다.
--   2. exception 처리기의 분류만 보강한다. 기존 코드 매핑·차단 규칙·쓰기 순서는 그대로다.
--        * INVENTORY_WRITER_* / INVENTORY_PHYSICAL_*         -> inventory_writer_contract
--        * SQLSTATE 40001/40P01/55P03(동시 작업·잠금)        -> inventory_busy_retry
--        * RPC가 직접 올린 코드가 아닌 DB 오류(SQLSTATE≠P0001) -> receipt_edit_unexpected
--        * 그 외(장부 검증 코드)                             -> receipt_edit_review (기존)
--      응답에 sqlState 를 추가한다(비밀정보 없는 진단값).
--   3. 결과 본문을 pos_signed_private.rpc_successors 에 후속 본문으로 등록한다(20261102142849 방식).
--   4. 등록된 모든 재고 writer RPC 의 현재 본문이 등록 본문과 일치하는지 확인한다.
-- 운영 데이터 행은 바꾸지 않는다(함수 정의와 후속 본문 등록 1행만).
begin;

do $migration$
declare
  v_oid oid:='public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)'::regprocedure;
  v_installed text; v_current text; v_expected text; v_definition text; v_new text;
  v_anchor text[]; v_patch text[]; i integer;
begin
  select installed_body into v_installed from inventory_writer_private.rpc_contracts where function_oid=v_oid;
  if v_installed is null then raise exception 'RECEIPT_EDIT_WRITER_CONTRACT_MISSING'; end if;
  if exists(select 1 from pos_signed_private.rpc_successors where function_oid=v_oid) then
    raise exception 'RECEIPT_EDIT_WRITER_SUCCESSOR_ALREADY_REGISTERED';
  end if;
  select prosrc into v_current from pg_proc where oid=v_oid;

  -- 1. The only reviewed drift is 20261104170000 (same anchors and patches, each exactly once).
  v_anchor:=array[
    E'v_prev_amount numeric; v_new_amount numeric; v_billed_changed boolean;',
    E'    if v_block is not null then\n      return jsonb_build_object(''status'',''purchase_correction_review_required'',''code'',''CONFIRMED_RECEIPT_PROTECTED'',''blockReason'',v_block);',
    E'    v_projection:=public.ledger_project_inventory_purchase_log_v1(v_log_id,p_actor_user_id);\n    if v_projection->>''status''=''failed''',
    E'      v_same_day:=v_root.business_date=p_business_date\n',
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
  v_expected:=replace(v_installed,E'\r\n',E'\n');
  for i in 1..array_length(v_anchor,1) loop
    if (length(v_expected)-length(replace(v_expected,v_anchor[i],'')))<>length(v_anchor[i]) then
      raise exception 'RECEIPT_EDIT_WRITER_DRIFT_UNREVIEWED (anchor %)',i;
    end if;
    v_expected:=replace(v_expected,v_anchor[i],v_patch[i]);
  end loop;
  if v_expected is distinct from replace(v_current,E'\r\n',E'\n') then
    raise exception 'RECEIPT_EDIT_WRITER_DRIFT_UNREVIEWED';
  end if;

  -- 2. Diagnostic classification in the exception handler only.
  v_definition:=replace(pg_get_functiondef(v_oid),E'\r\n',E'\n');
  v_anchor:=array[
    E'v_paid_billed boolean:=false;',
    E'get stacked diagnostics v_code=MESSAGE_TEXT;',
    E'        else ''receipt_edit_review'' end;',
    E'return jsonb_build_object(''status'',''purchase_correction_review_required'',''code'',v_code,''blockReason'',v_block);'
  ];
  v_patch:=array[
    E'v_paid_billed boolean:=false; v_sqlstate text;',
    E'get stacked diagnostics v_code=MESSAGE_TEXT, v_sqlstate=RETURNED_SQLSTATE;',
    E'        when v_sqlstate in (''40001'',''40P01'',''55P03'') then ''inventory_busy_retry''\n'
    || E'        when v_code like ''INVENTORY\\_WRITER\\_%'' or v_code like ''INVENTORY\\_PHYSICAL\\_%'' then ''inventory_writer_contract''\n'
    || E'        when v_sqlstate is distinct from ''P0001'' then ''receipt_edit_unexpected''\n'
    || E'        else ''receipt_edit_review'' end;',
    E'return jsonb_build_object(''status'',''purchase_correction_review_required'',''code'',v_code,''blockReason'',v_block,''sqlState'',v_sqlstate);'
  ];
  for i in 1..array_length(v_anchor,1) loop
    if (length(v_definition)-length(replace(v_definition,v_anchor[i],'')))<>length(v_anchor[i]) then
      raise exception 'RECEIPT_EDIT_DIAGNOSTIC_CONTRACT_MISMATCH (anchor %)',i;
    end if;
    v_definition:=replace(v_definition,v_anchor[i],v_patch[i]);
  end loop;
  execute v_definition;

  -- 3. Register the reviewed successor body (function OID, owner and ACL unchanged).
  select prosrc into v_new from pg_proc where oid=v_oid;
  if v_new=v_current or position('INVENTORY_WRITER_P1_2E' in v_new)=0 or position('inventory_writer_contract' in v_new)=0 then
    raise exception 'RECEIPT_EDIT_WRITER_SUCCESSOR_PATCH_MISSING';
  end if;
  insert into pos_signed_private.rpc_successors(function_oid,prior_body,installed_body) values(v_oid,v_current,v_new);

  -- 4. Every registered writer now runs its registered body.
  if exists(select 1 from inventory_writer_private.rpc_contracts c join pg_proc p on p.oid=c.function_oid
      where p.prosrc is distinct from pos_signed_private.current_rpc_body(c.function_oid)) then
    raise exception 'INVENTORY_WRITER_RPC_DRIFT_REMAINS';
  end if;
end;
$migration$;

revoke all on function public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.inventory_apply_purchase_receipt_edit_v1(bigint,bigint,numeric,jsonb,jsonb,date,bigint)
  to service_role;

commit;
