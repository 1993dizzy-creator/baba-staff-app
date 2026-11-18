# GPT 검토용: BABA Keg P0 운영 적용 전 보완 SQL 전문 및 검증 보고

운영 미적용 로컬 초안이다. 기존 검토본의 192행 SQL을 대체하는 최신 원문 208행을 아래에 생략 없이 수록했다. Git 명령·운영 DB 조회/변경·Migration 적용·배포는 실행하지 않았다. 정식 Migration 후보명은 20261020120000_keg_safety_p0.sql이며 해당 migrations 파일은 아직 생성·등록하지 않았다.

## 이번 보완과 최신 검증 요약

- 새 audit 테이블과 RPC 2개, RLS, REVOKE, GRANT 전체를 BEGIN/COMMIT으로 감쌌다. 같은 연결에서 전체 파일을 실행해야 한다. 격리 PostgreSQL에서 중간 10지점 오류 및 별도 연결의 비가시성/전체 롤백과 최종 COMMIT 공개를 확인했다.
- preview의 p_business_date를 p_at의 Asia/Ho_Chi_Minh 현지 시각에서 3시간 뺀 날짜와 비교한다. 불일치는 KEG_BUSINESS_DATE_MISMATCH / SQLSTATE 22023 / HTTP 400, KO/VI 안내로 차단한다. apply도 같은 preview를 호출하므로 잘못된 저장이 차단된다. 현지 자정·03:00 경계·월말·연말을 검증했다.
- 종료 세션 없는 최초 20L 세션의 시각 수정은 관련 판매·미판매·차이·상세를 null로 반환한다. KO/VI × PC/모바일 모달에서 안내문만 보이고 20L 로스 표시는 없으며, 저장 후에도 최초 활성 세션의 loss_quantity는 NULL이다.
- 합성 L3 종료 #141/활성 #142에 늦게 도착한 330mL 6잔을 넣었다. 합성 저장 판매 330mL→현재 POS 2,310mL로 +1,980mL다. 기존 preview는 stale로 차단하고 새 preview도 저장 스냅샷 불일치로 차단한다. 시각·기존 합계는 합성이고 ID/+6잔 외 운영 원본 복제를 주장하지 않는다.
- 회귀: 86 기능/SQL/API/I-O + 7 native 동시성/설치 원자성/롤백 + 3 브라우저 = **96 통과 / 0 실패 / 0 생략**. 중복 재실행한 DB/API 23건은 합계에 다시 더하지 않았다.
- 변경 파일 ESLint 통과. 실제 루트 및 테스트 앱 Production Build exit 0. 전체 TypeScript는 기존 오류 40건과 같은 진단이며 신규 0건이다.
- 일반 진입 I/O 회귀 재실행: API 3 / DB 읽기 16 / 그중 POS 읽기 4 / telemetry 제외 11,909B로 동일. 신규 API/DB/POS 읽기 0건. 일반 GET 핸들러·판매량 계산 함수·기존 재고 차감 본문은 변경하지 않았다.
- 이전의 PC·모바일 버전당 40회 전용 교차 측정과 버전당 30회 React 프로파일은 아래 보고서에 이력으로 유지했다. +6ms는 재현되지 않았고 이번 작업에서 모달 구조 개편은 하지 않았다. 실제 운영 셸/네트워크/데이터 및 실제 모바일 하드웨어 성능을 보장하는 자료는 아니다.

## 기존 RPC·트리거·권한 불변 근거

- 6행의 CREATE TABLE, 18행의 RLS 및 해당 테이블 REVOKE/GRANT는 새 audit 객체만 대상으로 한다.
- 23행과 133행에서 새 RPC 2개만 CREATE FUNCTION 한다. 기존 함수 CREATE OR REPLACE/DROP은 없다. 기존 calculate_inventory_keg_sales 및 replace_inventory_keg는 호출만 한다.
- 마지막 REVOKE/GRANT는 새 RPC 2개만 대상으로 한다. 새 함수는 PUBLIC/anon/authenticated 실행을 철회하고 service_role에 실행을 허용한다. 새 audit는 RLS 활성화, 브라우저 역할 접근 철회, service_role 직접 SELECT만 허용한다.
- 트리거 CREATE/ALTER/DROP은 없고 기존 트리거 및 기존 테이블/RPC ACL 변경 문도 없다. 새 함수 실행 시 기존 UPDATE/교체 경로의 기존 트리거는 그대로 동작한다.
- 실제 격리 PostgreSQL에서 설치 전후 기존 두 RPC의 pg_get_functiondef/ACL, 기존 트리거 정의, 기존 테이블 ACL/RLS가 동일했다. 증거: native-evidence.json의 ddlTransaction={"failurePoints":10,"partialObjectsVisible":false,"existingRpcTriggerAclUnchanged":true}.
- 새 함수 본문의 UPDATE/INSERT는 CREATE 시 실행되지 않는다. 승인된 저장 요청에만 실행되며 기존 139개 세션 일괄 백필이나 지연 POS 자동 보정은 없다.

## 적용 전 남은 사항

사용자가 기존 운영 RPC 호환성 확인 완료를 공유했다. 이번에 운영 조회는 추가하지 않았다. 후보를 정식 Migration으로 등록하기 전 실행기가 전체 파일을 같은 연결에서 단일 트랜잭션으로 처리하는지 확인해야 한다. PostgreSQL은 중첩 BEGIN을 별도 트랜잭션으로 만들지 않으므로 외부 Migration runner의 트랜잭션 및 history 기록 방식과도 맞춰야 한다. 오류로 abort된 연결은 ROLLBACK/종료하고 파일 일부만 재실행하지 않는다. 운영 적용은 별도 승인을 받아야 한다. 구버전 PATCH가 섞여 안전성을 우회하지 않도록 Keg 변경을 잠시 중지한 뒤 SQL→API/UI를 일관되게 전환한다. 저장 후 새로 유입되는 POS 변화나 이미 불일치한 운영 기록 자동 보정은 이번 범위 밖이다.

## 원문 식별

- SQL 경로: supabase/drafts/keg_safety_p0.sql
- SQL 208행 SHA-256: 39b13e6911a83782e0e207f0ab8cee00efd8073fbf517d82aec5c5e3d67cbc31
- 정식 Migration 후보: supabase/migrations/20261020120000_keg_safety_p0.sql (미생성·미등록·미적용)
- 검증 보고: docs/reports/20261020-keg-safety-p0-local-validation.md
- 보고서 SHA-256: dceb5565af7e198d03f3a4c8a8955477d77859843a76c8bdbf5705e7754e6b49

## 전체 SQL (생략 없음)

```sql
-- LOCAL DRAFT ONLY. No backfill. Apply only after explicit production approval.
-- Prerequisite: 202607230003_unify_keg_sales_calculation.sql and existing Keg schema.
-- Execute this entire file on one connection; never apply individual statements.
begin;

create table public.inventory_keg_safety_audit (
  request_id uuid primary key,
  action text not null check (action in ('replace', 'edit-start')),
  inventory_item_id bigint not null references public.inventory(id),
  actor_username text not null,
  reason text not null,
  request_payload jsonb not null,
  before_state jsonb not null,
  after_state jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.inventory_keg_safety_audit enable row level security;
revoke all on public.inventory_keg_safety_audit from public, anon, authenticated, service_role;
grant select on public.inventory_keg_safety_audit to service_role;

-- Stable/read-only: evaluates only the selected item and its linked boundary.
create function public.inventory_preview_keg_change(
  p_action text, p_item_id bigint, p_session_id bigint, p_at timestamptz,
  p_business_date date, p_actor_username text, p_expected_quantity numeric default null
) returns jsonb language plpgsql stable security definer set search_path = public set timezone = 'UTC' as $$
declare
  v_item public.inventory%rowtype;
  v_active public.inventory_keg_sessions%rowtype;
  v_previous public.inventory_keg_sessions%rowtype;
  v_item_id bigint := p_item_id;
  v_before jsonb := '{}'::jsonb; v_after jsonb := '{}'::jsonb;
  v_old_sold numeric := 0; v_new_sold numeric := 0;
  v_old_loss numeric := 0; v_new_loss numeric := 0; v_capacity numeric;
  v_mismatch boolean := false; v_warnings jsonb := '[]'::jsonb;
  v_state jsonb; v_result jsonb; v_previous_count int;
begin
  if p_action is null or p_action not in ('replace','edit-start') or p_at is null or p_business_date is null then
    raise exception 'KEG_INVALID_REQUEST';
  end if;
  if not exists(select 1 from public.users where username=p_actor_username and is_active=true) then
    raise exception 'KEG_INVALID_ACTOR';
  end if;
  if p_at > statement_timestamp() then raise exception 'KEG_FUTURE_TIME'; end if;
  -- Vietnam business day starts at 03:00, independent of the connection timezone.
  if p_business_date is distinct from ((p_at at time zone 'Asia/Ho_Chi_Minh') - interval '3 hours')::date then
    raise exception 'KEG_BUSINESS_DATE_MISMATCH' using errcode = '22023';
  end if;
  if p_action='edit-start' then
    select inventory_item_id into v_item_id from public.inventory_keg_sessions
      where id=p_session_id and status='active';
    if not found then raise exception 'KEG_ACTIVE_SESSION_NOT_FOUND'; end if;
  end if;
  select * into v_item from public.inventory where id=v_item_id;
  if not found then raise exception 'KEG_ITEM_NOT_FOUND'; end if;
  if lower(coalesce(v_item.unit,'')) <> 'keg' or v_item.package_content_quantity is null
    or v_item.package_content_quantity <= 0 or lower(coalesce(v_item.package_content_unit,'')) <> 'ml' then
    raise exception 'KEG_INVALID_CAPACITY';
  end if;
  -- Missing mappings are unknown evidence, not zero POS sales.
    if not exists(select 1 from public.inventory_keg_tracking_mappings where inventory_item_id=v_item_id and is_active=true and target_type='product') then
      raise exception 'KEG_MAPPING_NOT_FOUND';
    end if;
  select * into v_active from public.inventory_keg_sessions
    where inventory_item_id=v_item_id and status='active' order by started_at desc limit 1;
  if p_action='edit-start' and v_active.id is distinct from p_session_id then
    raise exception 'KEG_STALE_PREVIEW';
  end if;
  if p_action='replace' then
    if p_expected_quantity is not null and round(p_expected_quantity,6) <> round(v_item.quantity,6) then
      raise exception 'KEG_QUANTITY_CONFLICT';
    end if;
    if coalesce(v_item.quantity,0)<1 then raise exception 'KEG_INSUFFICIENT_QUANTITY'; end if;
    if v_active.id is not null and p_at < v_active.started_at then raise exception 'KEG_TIME_CONFLICT'; end if;
    v_capacity := v_item.package_content_quantity;
    if v_active.id is not null then
      v_after := public.calculate_inventory_keg_sales(v_item_id,v_active.started_at,p_at);
      if p_at-v_active.started_at <= interval '5 minutes' then v_warnings := v_warnings || '"SHORT_INTERVAL"'::jsonb; end if;
    end if;
  else
    -- Existing (inventory_item_id, started_at) index restricts this to one item.
    select count(*) into v_previous_count from public.inventory_keg_sessions
      where inventory_item_id=v_item_id and status='closed' and ended_log_id=v_active.started_log_id;
    if v_previous_count>1 then raise exception 'KEG_BOUNDARY_CONFLICT'; end if;
    select * into v_previous from public.inventory_keg_sessions
      where inventory_item_id=v_item_id and status='closed' and ended_log_id=v_active.started_log_id;
    if v_previous.id is not null then
      if v_previous.ended_at is distinct from v_active.started_at then raise exception 'KEG_BOUNDARY_CONFLICT'; end if;
      if p_at<v_previous.started_at then raise exception 'KEG_TIME_CONFLICT'; end if;
      v_capacity := v_previous.capacity_quantity;
      v_before := public.calculate_inventory_keg_sales(v_item_id,v_previous.started_at,v_previous.ended_at);
      v_after := public.calculate_inventory_keg_sales(v_item_id,v_previous.started_at,p_at);
      v_old_sold := round((v_before->>'soldMl')::numeric,3);
      v_old_loss := greatest(v_capacity-v_old_sold,0);
      v_mismatch := v_previous.sold_quantity is null or v_previous.loss_quantity is null or v_previous.loss_rate is null
        or round(v_previous.sold_quantity,3)<>v_old_sold or round(v_previous.loss_quantity,3)<>round(v_old_loss,3)
        or v_previous.loss_rate<>round(v_old_loss/v_capacity,6);
    else
      -- A first session may have no predecessor; don't infer or invent a historical one.
      if exists(select 1 from public.inventory_keg_sessions where inventory_item_id=v_item_id and status='closed') then
        raise exception 'KEG_BOUNDARY_CONFLICT';
      end if;
      v_capacity := v_active.capacity_quantity;
    end if;
  end if;
  if p_action='edit-start' and v_previous.id is null then
    -- No closed Keg is affected: its sales/loss summary is not applicable, not a full-Keg loss.
    v_old_sold := null; v_old_loss := null; v_new_sold := null; v_new_loss := null;
    v_after := 'null'::jsonb;
  else
    v_after := v_after || jsonb_build_object('totalUnits',coalesce((v_after->>'regularUnits')::numeric,0)+coalesce((v_after->>'towerUnits')::numeric,0)+coalesce((v_after->>'otherUnits')::numeric,0));
    v_new_sold := round(coalesce((v_after->>'soldMl')::numeric,0),3);
    if p_action='replace' and v_new_sold=0 then v_warnings := v_warnings || '"ZERO_SALES"'::jsonb; end if;
    v_new_loss := greatest(v_capacity-v_new_sold,0);
  end if;
  v_state := jsonb_build_object('action',p_action,'at',p_at,'businessDate',p_business_date,'actor',p_actor_username,
    'item',jsonb_build_object('id',v_item.id,'quantity',v_item.quantity,'capacity',v_item.package_content_quantity,'unit',v_item.package_content_unit,'updatedAt',v_item.updated_at),
    'active',to_jsonb(v_active),'previous',to_jsonb(v_previous),'posBefore',v_before,'posAfter',v_after);
  v_result := jsonb_build_object('ok',true,'dryRun',true,'writesPerformed',false,'action',p_action,'itemId',v_item_id,
    'actorUsername',p_actor_username,'activeSessionId',v_active.id,'previousSessionId',v_previous.id,
    'oldAt',v_active.started_at,'replacementAt',p_at,'businessDate',p_business_date,
    'currentQuantity',v_item.quantity,'projectedQuantity',case when p_action='replace' then v_item.quantity-1 else v_item.quantity end,
    'capacityMl',v_capacity,'soldMl',v_new_sold,'lossMl',v_new_loss,'overageMl',case when v_new_sold is not null then greatest(v_new_sold-v_capacity,0) end,
    'usagePercent',round(v_new_sold/v_capacity*100,3),'salesBreakdown',v_after,
    'storedSoldMl',v_previous.sold_quantity,'storedLossMl',v_previous.loss_quantity,'posBeforeSoldMl',v_old_sold,'posBeforeLossMl',v_old_loss,
    'soldDeltaMl',v_new_sold-v_old_sold,'lossDeltaMl',v_new_loss-v_old_loss,
    'priorDriftMl',case when v_previous.sold_quantity is null then null else v_old_sold-v_previous.sold_quantity end,
    'snapshotMismatch',v_mismatch,'warnings',v_warnings,
    'previewToken',encode(sha256(convert_to(v_state::text,'UTF8')),'hex'));
  return v_result;
end $$;

create function public.inventory_apply_keg_change(
  p_action text, p_item_id bigint, p_session_id bigint, p_at timestamptz,
  p_business_date date, p_actor_username text, p_expected_quantity numeric,
  p_preview_token text, p_request_id uuid, p_reason text, p_confirm boolean default false
) returns jsonb language plpgsql security definer set search_path = public set timezone = 'UTC' as $$
declare
  v_item_id bigint := p_item_id; v_active_id bigint; v_previous_id bigint;
  v_preview jsonb; v_payload jsonb; v_existing public.inventory_keg_safety_audit%rowtype;
  v_before jsonb; v_after jsonb; v_result jsonb; v_sold numeric; v_loss numeric; v_capacity numeric;
begin
  if p_request_id is null or nullif(btrim(p_preview_token),'') is null or length(coalesce(p_reason,''))>500 then
    raise exception 'KEG_INVALID_REQUEST';
  end if;
  if not exists(select 1 from public.users where username=p_actor_username and is_active=true) then raise exception 'KEG_INVALID_ACTOR'; end if;
  v_payload := jsonb_build_object('action',p_action,'itemId',p_item_id,'sessionId',p_session_id,'at',p_at,'businessDate',p_business_date,
    'actor',p_actor_username,'expectedQuantity',p_expected_quantity,'previewToken',p_preview_token,'reason',btrim(coalesce(p_reason,'')),'confirm',p_confirm);
  -- Request lock precedes the item/active/previous row lock order used by all new saves.
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
  select * into v_existing from public.inventory_keg_safety_audit where request_id=p_request_id;
  if found then
    if v_existing.request_payload is distinct from v_payload then raise exception 'KEG_IDEMPOTENCY_CONFLICT'; end if;
    return v_existing.result || jsonb_build_object('replayed',true);
  end if;
  if p_action='edit-start' then
    select inventory_item_id into v_item_id from public.inventory_keg_sessions where id=p_session_id;
  end if;
  perform 1 from public.inventory where id=v_item_id for update;
  if not found then raise exception 'KEG_ITEM_NOT_FOUND'; end if;
  perform 1 from public.inventory_keg_sessions where inventory_item_id=v_item_id and status='active' for update;
  -- Lock the linked predecessor, never all Keg histories.
  perform 1 from public.inventory_keg_sessions previous where previous.inventory_item_id=v_item_id and previous.status='closed'
    and previous.ended_log_id=(select started_log_id from public.inventory_keg_sessions where inventory_item_id=v_item_id and status='active') for update;
  v_preview := public.inventory_preview_keg_change(p_action,v_item_id,p_session_id,p_at,p_business_date,p_actor_username,p_expected_quantity);
  if v_preview->>'previewToken' is distinct from p_preview_token then raise exception 'KEG_STALE_PREVIEW'; end if;
  if (v_preview->>'snapshotMismatch')::boolean then raise exception 'KEG_STORED_SNAPSHOT_MISMATCH'; end if;
  if (p_action='edit-start' or jsonb_array_length(v_preview->'warnings')>0) and nullif(regexp_replace(coalesce(p_reason,''),'[[:space:]]','','g'),'') is null then
    raise exception 'KEG_REASON_REQUIRED';
  end if;
  if jsonb_array_length(v_preview->'warnings')>0 and not coalesce(p_confirm,false) then raise exception 'KEG_CONFIRMATION_REQUIRED'; end if;
  v_active_id := (v_preview->>'activeSessionId')::bigint;
  v_previous_id := (v_preview->>'previousSessionId')::bigint;
  v_before := jsonb_build_object('preview',v_preview,'active',(select to_jsonb(s) from public.inventory_keg_sessions s where id=v_active_id),
    'previous',(select to_jsonb(s) from public.inventory_keg_sessions s where id=v_previous_id));
  if p_action='replace' then
    -- Keep the existing atomic stock lock, expectedQuantity check, -1 log and close/open semantics.
    v_result := public.replace_inventory_keg(v_item_id,p_actor_username,p_business_date,(v_preview->>'currentQuantity')::numeric,p_at);
    if v_result->>'ok'='false' then raise exception 'KEG_QUANTITY_CONFLICT'; end if;
    if v_active_id is not null and (v_result#>>'{closedSession,soldQuantity}')::numeric is distinct from (v_preview->>'soldMl')::numeric then raise exception 'KEG_STALE_PREVIEW'; end if;
  else
    update public.inventory_keg_sessions set started_at=p_at,started_business_date=p_business_date,updated_at=clock_timestamp()
      where id=v_active_id and status='active';
    if not found then raise exception 'KEG_STALE_PREVIEW'; end if;
    if v_previous_id is not null then
      v_sold := (v_preview->>'soldMl')::numeric; v_loss := (v_preview->>'lossMl')::numeric; v_capacity := (v_preview->>'capacityMl')::numeric;
      update public.inventory_keg_sessions set ended_at=p_at,ended_business_date=p_business_date,sold_quantity=v_sold,
        sold_unit='ml',loss_quantity=v_loss,loss_rate=round(v_loss/v_capacity,6),updated_at=clock_timestamp(),
        summary_note=format('Keg time corrected. POS sales %s ml / %s ml; unsold %s ml.',v_sold,v_capacity,v_loss)
        where id=v_previous_id and status='closed';
      if not found then raise exception 'KEG_STALE_PREVIEW'; end if;
    end if;
    v_result := jsonb_build_object('ok',true,'session',jsonb_build_object('id',v_active_id,'startedAt',p_at,'startedBusinessDate',p_business_date));
  end if;
  v_after := jsonb_build_object('active',(select to_jsonb(s) from public.inventory_keg_sessions s where inventory_item_id=v_item_id and status='active'),
    'previous',(select to_jsonb(s) from public.inventory_keg_sessions s where id=case when p_action='replace' then v_active_id else v_previous_id end));
  insert into public.inventory_keg_safety_audit(request_id,action,inventory_item_id,actor_username,reason,request_payload,before_state,after_state,result)
    values(p_request_id,p_action,v_item_id,p_actor_username,btrim(coalesce(p_reason,'')),v_payload,v_before,v_after,v_result);
  return v_result;
end $$;

revoke all on function public.inventory_preview_keg_change(text,bigint,bigint,timestamptz,date,text,numeric) from public, anon, authenticated;
revoke all on function public.inventory_apply_keg_change(text,bigint,bigint,timestamptz,date,text,numeric,text,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.inventory_preview_keg_change(text,bigint,bigint,timestamptz,date,text,numeric) to service_role;
grant execute on function public.inventory_apply_keg_change(text,bigint,bigint,timestamptz,date,text,numeric,text,uuid,text,boolean) to service_role;

-- DDL, RLS and final ACLs become visible together; any preceding error aborts everything.
commit;
```

## 로컬 검증 보고 원문

# BABA Keg P0 로컬 구현·검증 보고 (2026-10-20)

운영 적용 전 보완 후 관련 기능·동시성·권한·롤백·브라우저 회귀 **96건 통과 / 0건 실패 / 0건 생략**이다. SQL 전체의 단일 트랜잭션, 베트남 03:00 영업일 검증, 최초 세션의 해당 없음(null) 요약, 합성 L3 #141의 지연 POS +1,980mL 불일치 차단을 확인했다. 일반 진입의 신규 API/DB/POS 읽기는 0건이다. 앞선 40회 교차 성능 측정과 별도 30회 React 프로파일에서는 PC +6ms 증가가 재현되지 않았으며 추가 모달 구조 개편은 하지 않았다. 운영 전체 지연을 보장하는 결과는 아니다. 운영 DB/POS/재고/장부 조회·변경, 기존 139개 세션 백필, 운영 Migration 적용, Git 명령, Push·배포는 수행하지 않았다.

## 운영 Migration 적용 전 보완: 최신 검증

### SQL 원문과 후보

- 미적용 원문: `supabase/drafts/keg_safety_p0.sql`, **208행**.
- 정확한 파일 SHA-256: `39b13e6911a83782e0e207f0ab8cee00efd8073fbf517d82aec5c5e3d67cbc31`.
- 정식 Migration **후보 파일명**: `20261020120000_keg_safety_p0.sql` (예정 경로 `supabase/migrations/20261020120000_keg_safety_p0.sql`). 이번에는 해당 Migration 파일을 생성·등록·적용하지 않았고 기존 적용 Migration도 수정하지 않았다.
- 전체 SQL과 이 검증 보고를 `20261020-keg-safety-p0-gpt-review.md`에 재수록했다. 코드 블록에서 추출한 SQL이 원문과 정확히 일치하는지 문자열·SHA-256으로 확인했다.

### 보완 내용과 검증 근거

1. 파일의 모든 신규 CREATE TABLE / CREATE FUNCTION / RLS / REVOKE / GRANT를 명시적인 `BEGIN; ... COMMIT;` 안에 넣었다. 파일 전체를 **같은 연결에서 순서대로** 실행해야 하며 문장별 별도 연결 실행은 금지한다. 외부 커넥션에 미완성 객체·중간 ACL이 공개되지 않으며 오류가 나면 전체가 abort된다. 실행기가 오류 후 연결을 계속 사용할 경우 ROLLBACK으로 정리해야 한다. 기존 트랜잭션 안에서 또 BEGIN을 여는 것은 PostgreSQL의 중첩 트랜잭션이 아니므로, 정식 적용 실행기와 Migration history 처리도 사전 확인한다.
2. 실제 격리 PostgreSQL 18.4에서 파일을 top-level 문장으로 나눠 같은 연결에서 실행했다. 테이블 생성부터 마지막 GRANT까지 **중간 10지점 각각**에서 오류를 주입했고, 별도 연결에서 신규 테이블·함수가 하나도 보이지 않는 것과 ROLLBACK 뒤 전체 제거를 확인했다. 성공 경로에서도 COMMIT 직전까지 외부에 신규 객체가 보이지 않았고 COMMIT 뒤 함께 보였다. 기존 두 RPC의 `pg_get_functiondef`/ACL, 기존 트리거 정의, 기존 테이블 ACL/RLS는 전후 동일했다. 증거: `.qa-review/keg-p0/native-evidence.json`의 `ddlTransaction`.
3. `inventory_preview_keg_change`는 `((p_at AT TIME ZONE 'Asia/Ho_Chi_Minh') - interval '3 hours')::date`와 `p_business_date`를 비교한다. 다르면 SQLSTATE 22023 / `KEG_BUSINESS_DATE_MISMATCH`, API HTTP 400과 KO/VI 안내를 반환한다. 저장 RPC도 같은 preview를 호출하므로 오류 시 세션·재고·로그·감사 기록을 저장하지 못한다. UTC 날짜와 현지 자정 차이, 02:59:59.999/03:00:00, +07 offset, 월말·연말 경계, 잘못된 영업일로 미리보기/저장 모두 차단을 검증했다. API fixture도 실제 공통 영업일 함수로 교체했다.
4. 최초 활성 세션의 시각 수정은 영향받는 종료 세션이 없으므로 판매·미판매·초과량·판매율·기존 POS·차이·상세 구성을 `null`로 반환한다. 용량 메타데이터는 유지하지만 전체 20L를 로스로 만들지 않는다. 기존 UI의 `previousSessionId === null` 안내 분기를 유지했고, nullable API 타입을 반영하기 위해 교체 미리보기의 action 타입을 확인한다. KO/VI × PC/모바일 실제 모달에서 안내문만 표시하고 미판매/20L 로스 수치가 없으며 저장 후에도 최초 세션의 loss_quantity는 NULL임을 검증했다.
5. 합성 L3 종료 세션 **#141 / 활성 #142**에 지연 동기화된 330mL 잔 6개를 추가했다. 합성 저장 판매 330mL 대비 현재 POS 2,310mL, 차이 **+1,980mL**, 저장 미판매 29,670mL 대비 현재 POS 기준 27,690mL다. 기존 preview 저장은 `KEG_STALE_PREVIEW`, 새 preview 저장은 `KEG_STORED_SNAPSHOT_MISMATCH`로 차단되고 세션·재고·로그·감사는 불변이다. ID와 6잔이라는 제공 사실 외 시각·기존 합계는 합성 값이며 운영 원본 재현이라고 주장하지 않는다.
6. 기존 `replace_inventory_keg`, `calculate_inventory_keg_sales`, 트리거, 권한 및 재고 -1 처리 본문은 수정하지 않았다. 이번 SQL은 새 객체에만 ACL을 설정한다. 정상 교체·재시도·2인 경합·시각 수정 경합·감사 기록 후 실패의 롤백을 다시 통과했다.

### 실행 결과

| 실행 | 통과 / 실패 / 생략 |
| --- | --- |
| 관련 기능·실제 SQL·API·추가 I/O 회귀 | 86 / 0 / 0 |
| 격리 native PostgreSQL 동시성·DDL 원자성·권한 보존·롤백·기존 인덱스 | 7 / 0 / 0 (상위 테스트 포함) |
| P0 및 기존 품목로그 브라우저 회귀 | 3 / 0 / 0 |
| 중복 없는 전체 테스트 합계 | **96 / 0 / 0** |

- 변경한 TS/TSX·테스트 파일 ESLint 통과.
- 전체 TypeScript는 **기존 오류 40건으로 실패**. 보완 전 로그와 진단 문자열이 같으며 신규/해소 오류 모두 0건이다. `.qa-review/keg-p0/amendment-tsc-comparison.json`.
- 실제 루트 Production Build 및 브라우저용 Production 테스트 앱 Build 모두 exit 0.
- 일반 진입 브라우저 I/O 회귀도 다시 실행: PC·모바일 각 버전 10회에서 API 3 / DB 읽기 16 / 그중 POS 읽기 4, telemetry 제외 응답 11,909B로 동일. 신규 API/DB/POS 읽기 0. 이번 추가 실행은 I/O 회귀이며 아래의 전용 40회 성능 실험을 대체하는 latency benchmark로 사용하지 않는다. `.qa-review/keg-p0/performance-sql-amendment-smoke.json`.
- 실행 로그: `.qa-review/keg-p0/amendment-regression.txt`, `amendment-concurrency.txt`, `amendment-browser.txt`, `amendment-lint.txt`, `amendment-tsc.txt`, `amendment-build.txt`.
- 이번 변경 파일: SQL 초안, `lib/inventory/keg-safety.ts`, `lib/inventory/keg-safety-server.ts`, `components/inventory/InventoryPageContent.tsx`의 교체 preview 타입 조건 1곳, `tests/helpers/keg-safety-fixture.mjs`, P0 DB/API/동시성/브라우저 테스트 4개, 이 보고서와 GPT 검토본. 일반 GET 핸들러 및 판매량 계산 라이브러리는 변경하지 않았다.

사용자가 기존 운영 RPC 호환성 확인 완료를 공유했다. 이번 검증은 운영 조회를 추가하지 않고 로컬 원본 RPC·트리거·ACL 보존을 검증했다. 정식 Migration 등록·실행기의 전체 파일 트랜잭션 처리 확인·운영 적용 승인은 남아 있다. 기존 지연 POS의 운영 데이터 보정이나 백필은 수행하지 않았으며 저장 후 새 POS 변경으로 발생하는 미래 불일치를 자동 보정하는 범위도 아니다.

트랜잭션 및 날짜 연산의 기준 문서: [PostgreSQL BEGIN](https://www.postgresql.org/docs/current/sql-begin.html), [AT TIME ZONE와 날짜 연산](https://www.postgresql.org/docs/current/functions-datetime.html).

## 구현과 변경 파일

제품 코드:

- `app/api/inventory/keg-sessions/[id]/route.ts`: 기존 두 개의 직접 UPDATE를 제거. 인증된 담당자만 새 안전 RPC에 전달. `dryRun: true`는 읽기 전용 미리보기, 저장은 UUID·미리보기 토큰·변경 사유를 받아 단일 RPC로 실행.
- `app/api/inventory/keg-sessions/replace/route.ts`: 같은 인증 정책으로 새 안전 RPC에 위임. 원자적 재고 차감은 기존 `replace_inventory_keg`에 위임한다. 안전 RPC가 없으면 503으로 차단하며 이전의 위험한 경로로 우회하지 않는다.
- `lib/inventory/keg-safety-server.ts`: 날짜/미래 시각·UUID·토큰 검증, 기존 영업일 계산 재사용, RPC 바인딩, 충돌/미설치 오류의 명시적 응답.
- `lib/inventory/keg-safety.ts`: 미리보기 데이터 계약, KO/VI 안내·오류 문구, UTC+07·초 단위 시간 표시. 모달을 여는 이벤트에서만 동적으로 로드해 초기 진입 경로에서 제외.
- `components/inventory/InventoryPageContent.tsx`: 명시적으로 버튼을 눌러 미리보기 실행. 이전 시각/변경 시각, 저장 요약/현재 POS/변경 후 요약/차이를 구분. 미리보기 없거나 입력을 바꾸면 저장 차단. 과거 불일치는 관리자 확인 안내와 함께 저장 차단. 사유·단시간/0L 재확인, 즉시 중복 클릭 차단, 응답 유실 재시도 시 UUID/요청 보존. 타이핑은 미리보기만 무효화하고 네트워크를 호출하지 않는다.
- `supabase/drafts/keg_safety_p0.sql`: **미적용 로컬 Migration 초안**. 신규 감사/멱등성 테이블 1개와 RPC 2개만 정의. 기존 테이블 데이터·RPC·POS 매핑·2700/3000ml 설정은 변경하지 않음.

테스트 및 검증 코드:

- 신규: `tests/keg-safety-p0-db.test.mjs`, `tests/keg-safety-p0-api.test.mjs`, `tests/keg-safety-p0-concurrency.test.mjs`, `tests/keg-safety-p0-browser.test.mjs`.
- 신규 fixture: `tests/helpers/keg-safety-fixture.mjs`, `tests/helpers/inventory-keg-browser-fixture.mjs`.
- 기존 구조 검사 갱신: `tests/keg-replacement-shadow.test.ts`, `tests/sales-inventory-keg-security-policy.test.ts`. API가 계산/교체 RPC를 직접 호출하던 검사만 새 안전 경로에 맞추고, 기존 RPC 재사용 및 담당자 위조 방지 검사는 유지했다.

## 트랜잭션·정합성

읽기 전용 `inventory_preview_keg_change`는 선택 품목, 활성 세션, `ended_log_id = active.started_log_id`로 연결된 직전 종료 세션만 조사한다. POS는 기존 `calculate_inventory_keg_sales`로 기존 구간과 변경 구간을 계산한다. 저장된 판매·미판매·로스율이 현재 POS와 이미 다르면, 시간 변경으로 생기는 차이와 별도로 보여주고 저장을 차단한다. NULL 요약, 연결/경계 불일치, 활성 매핑 누락을 정상 0 판매로 간주하지 않는다. 최초 세션처럼 종료 세션이 없는 경우에는 존재하지 않는 이력을 만들어내지 않는다.

`inventory_apply_keg_change`는 요청 UUID advisory lock → 재고 행 → 활성 세션 → 연결 종료 세션 순서로 잠근다. 세션 상태/버전·재고·현재 POS 구성과 계산값을 포함한 SHA-256 미리보기 토큰을 다시 비교한다. RPC 내부 timezone은 UTC로 고정해 풀 연결의 시간대가 달라도 토큰이 안정적이다. 시각 수정은 활성 시작 및 종료 세션의 종료·판매·미판매·로스율·요약을 한 트랜잭션에서 갱신한다. 교체는 기존 재고 잠금·expectedQuantity·-1 로그·종료/신규 세션 생성 RPC를 그대로 호출한다. 기존 교체 결과와 미리보기 판매량이 다르면 롤백한다.

성공한 요청의 요청 본문, 변경 전후 전체 세션 상태·POS 요약, 담당자 username, 사유, 결과를 `inventory_keg_safety_audit`에 보존한다. 동일 UUID·동일 요청은 기존 결과만 반환한다. 동일 UUID의 다른 요청·담당자는 충돌 처리한다. 감사 INSERT 실패를 포함한 중간 오류는 모든 행 변경을 롤백한다. PostgreSQL 시퀀스 번호의 빈 값은 일반적인 비트랜잭션 시퀀스 특성이며 별도 레코드나 중복 차감이 생기는 것은 아니다.

단시간 기준은 **5분 이하**다. 짧은 구간 또는 0L 교체에는 명시적 재확인과 내용이 있는 사유가 필요하다. 정상적인 실제 단시간 교체는 허용한다. 활성 세션이 없는 최초 설치도 0L 확인을 요구한다. 일반적인 정상 교체는 사유를 선택적으로 남길 수 있다.

## Migration·권한·인덱스

초안의 대상:

- 신규 `inventory_keg_safety_audit`: UUID 기본 키, 요청·변경 전후·담당자·사유·결과 저장. RLS 활성화. PUBLIC/anon/authenticated 접근 불가. service_role은 직접 SELECT만 허용하고 기록은 보안 RPC에서 추가한다.
- 신규 `inventory_preview_keg_change(...)`: STABLE 읽기 전용 SECURITY DEFINER. PUBLIC/anon/authenticated 실행 불가, service_role 실행 허용.
- 신규 `inventory_apply_keg_change(...)`: 트랜잭션 SECURITY DEFINER. 동일한 실행 권한 제한.
- 기존 `calculate_inventory_keg_sales`, `replace_inventory_keg`, 기존 테이블의 권한·인덱스·트리거는 변경하지 않는다. 기존 앱의 인증된 직원 처리 정책도 유지한다.

기존 세션 인덱스 `inventory_keg_sessions_item_started_idx`, `inventory_keg_sessions_one_active_uidx`를 재사용한다. 이력/POS 테이블에 추가 인덱스를 만들지 않는다. 새 테이블 UUID 기본 키 인덱스는 요청의 정확한 단건 조회에 필요하다. 신규 테이블을 제외한 데이터 일괄 변경은 없다.

격리 PostgreSQL 18.4에서 관련 없는 활성 세션 10,000개를 넣고 `EXPLAIN (ANALYZE, BUFFERS)`를 실행했다. 종료 세션 조회는 기존 item_started 인덱스의 `inventory_item_id = 3` Index Scan으로 1행을 반환하고, 같은 품목의 다른 1행만 필터링했다. 활성 세션 조회는 기존 one_active 인덱스를 사용했다. 실행 계획 원문: `.qa-review/keg-p0/native-evidence.json`. 운영 실행 계획을 조회한 결과는 아니다.

## 성능 후속 검증: 40회 교차 측정 및 별도 React 프로파일 (SQL 보완 전 이력)

최종 판정은 **이번 로컬 조건에서 +6ms 회귀 미재현, 일반 진입 I/O 증가 없음**이다. 최초 10회 결과만으로 보류했던 로컬 시간 불확실성을 아래 추가 측정으로 해소했다. 유의한 속도 개선을 주장하거나 모든 장비에서 정확히 0ms 차이라고 주장하는 결과는 아니다.

### 조건과 방법

- 동일 장비: AMD Ryzen 7 260 / 논리 CPU 16개 / RAM 약 31.3GiB, Node 24.15.0, Chrome 155.0.8059.82, Next 16.2.1 Production 서버. 측정 시간은 2026-10-20 11:23~11:27 UTC 구간이다.
- 기존 기준은 P0 작업 시작 시 저장한 `InventoryPageBefore.txt`에서 만든 JSX이며, 변경 버전은 현재 실제 `InventoryPageContent.tsx`이다. 같은 테스트 앱, 같은 서버, 같은 브라우저 프로세스 및 화면별 같은 context에서 두 경로를 hard navigation으로 번갈아 실행했다.
- 일반 Production 빌드: KO, PC 1280×900 및 모바일 390×844, 각 버전 3회 예열 후 **각 40회**, AB/BA 순서 교대. 총 유효 160회. 표본 제외·이상치 제거·목표 결과를 위한 재측정은 하지 않았다.
- 별도 Production `next build --profile`: PC 각 3회 예열 후 **각 30회**, 총 유효 60회. 테스트 페이지의 동일한 React Profiler로 컴포넌트를 감싸 실제 `actualDuration`, `startTime`, `commitTime`을 수집했다. 프로파일 빌드의 부하는 일반 빌드 최초 표시 판정과 혼합하지 않았다. 테스트용 wrapper 소스는 측정 후 원복했다.
- 최초 표시는 navigation 시작부터 첫 L3 품목 DOM 생성 후 두 번의 requestAnimationFrame까지다. 픽셀 기반 FCP/LCP 측정은 아니다. DOM 생성 시점 및 DOM→RAF 구간도 따로 기록했다.
- 같은 로컬 읽기 fixture 및 실제 기존 GET 핸들러를 사용했다. API만 가로채 로컬 fixture 응답을 제공하며 외부 origin은 차단했다. Playwright routing으로 브라우저 HTTP 캐시는 비활성화되어 있다. 예열은 서버·번들·실행 경로 예열을 뜻하며 브라우저 디스크 캐시 적중 측정이 아니다. 빌드·다른 테스트를 동시에 실행하지 않았다. 외부 OS 부하나 전원 정책은 통제하지 않았다.
- 실제 운영 앱의 ProtectedLayout/auth polling을 포함하지 않은 동일 테스트 셸이다. 운영 네트워크·DB 지연, 실제 모바일 기기, 전체 운영 셸 성능의 대체 검증은 아니다.

### 일반 Production 결과

분산은 표본분산(n−1), p95는 nearest-rank이다. 수치는 기존 → 변경 순서다.

| 지표 | PC: 각 40회 | 모바일: 각 40회 |
| --- | --- | --- |
| 최초 표시 중앙값 | 339.00 → 338.50ms | 339.00 → 338.80ms |
| 최초 표시 p95 | 349.00 → 345.20ms | 347.30 → 345.70ms |
| 표본분산 | 36.20 → 25.96ms² | 26.53 → 25.68ms² |
| 표준편차 | 6.02 → 5.10ms | 5.15 → 5.07ms |
| 최초 품목 DOM 중앙값 | 318.75 → 318.15ms | 319.50 → 319.45ms |
| bootstrap 응답 완료→DOM 중앙값 | 6.90 → 6.85ms | 6.95 → 6.85ms |
| DOM→두 번째 RAF 중앙값 | 19.75 → 20.15ms | 21.15 → 20.50ms |

PC 쌍별 차이 평균은 -1.10ms, 95% paired bootstrap 구간은 -3.63~+1.51ms다. 두 버전 중앙값 차이 -0.50ms의 paired bootstrap 구간은 -4.60~+3.55ms다. 모바일 중앙값 차이 -0.20ms의 구간은 -4.35~+3.00ms다. 고정 seed 20261020, 쌍을 보존한 10,000회 재표집이며 독립적인 날짜·장비 반복의 신뢰구간은 아니다. PC를 순서대로 10쌍씩 나눈 중앙값 차이도 -3.65 / -5.05 / -0.15 / +4.20ms로 +6ms가 반복되지 않았다. p95의 작은 변화에는 별도 유의성 결론을 붙이지 않는다.

### 실제 React 렌더 구간: 별도 프로파일 각 30회

| PC 프로파일 지표 | 중앙값: 기존 → 변경 | p95: 기존 → 변경 |
| --- | --- | --- |
| 첫 품목을 포함한 commit의 React actualDuration | 3.60 → 3.35ms | 5.50 → 4.60ms |
| 첫 품목 commit까지의 React 렌더 시간 합 | 6.25 → 6.30ms | 8.50 → 7.40ms |
| 문서의 ScriptDuration | 23.22 → 23.29ms | 26.36 → 26.06ms |
| 문서의 LayoutDuration | 1.93 → 1.66ms | 2.77 → 2.48ms |
| 문서의 RecalcStyleDuration | 1.81 → 1.82ms | 2.45 → 2.28ms |

첫 품목 commit 렌더 중앙값 차이의 bootstrap 구간은 -0.65~+0.15ms, 첫 품목까지 렌더 합 중앙값 차이 구간은 -0.70~+0.50ms다. 실제 React 렌더·레이아웃에서 +6ms 증가를 뒷받침하는 구간이 없다. 프로파일 빌드 자체의 최초 표시도 중앙값 340.20 → 336.75ms, p95 349.00 → 348.10ms다. 이 결과로 일반 빌드 시간을 보정하지 않았다.

일반 빌드에서 시도한 CDP 이전 문서 대비 차감 값은 navigation 시 카운터가 초기화되어 무효였다. 해당 CPU 값은 결과·통계에서 전부 제외했고, 별도 프로파일에서 현재 문서 누적값으로 바로잡았다. 최초 표시·DOM·API·I/O 수치에는 영향이 없다. 제외 전 자료는 `performance-followup-cdp-invalid-raw.json`에 보존했다.

### 일반 진입 경로 I/O

일반 160회 및 프로파일 60회 모두 다음 조건을 assert했다. DB는 실제 운영 DB 읽기가 아니라 실제 GET 코드가 로컬 mock DB에 요청한 조회 수다.

| 지표 | 기존 | 변경 | 판정 |
| --- | --- | --- | --- |
| API 요청 | 3 | 3 | 전 표본 동일 |
| DB 읽기(기존 POS 포함) | 16 | 16 | 조회 순서·테이블·반환 행 수도 동일 |
| 그중 POS 읽기 | 4 | 4 | 신규 POS 읽기/안전 RPC 0 |
| API 응답 합계 중앙값 / p95 | 12,107 / 12,109B | 12,107 / 12,109B | PC·모바일 동일 |
| 처리시간 telemetry 제외 응답 크기 | 11,909B | 11,909B | 전 표본 동일 |
| 전체 HTTP 요청 수 | 29 | 27 | 테스트 셸의 asset 포함; 증가 없음 |

세 API는 `/api/inventory/bootstrap-stream`, `/api/inventory/logs/recent`, `/api/inventory/snapshot/latest`다. 원시 응답은 기존 처리시간 숫자 자릿수 때문에 양쪽 모두 12,105~12,109B 범위이며 매 요청의 원시 바이트가 일치한다는 뜻은 아니다. 일반 진입에서 신규 API·DB 읽기·POS 집계 요청은 없고, 모달 lazy-loading 추가 개편은 하지 않았다.

### 결과 보관·재현·남은 확인

- 실행 스크립트: `.qa-review/keg-p0/performance-followup.mjs`, 통계: `analyze-followup.mjs`.
- 표본/요청/읽기/렌더 commit 원문: `performance-followup.json`, `performance-followup-profile.json`; 통계 및 구간: `performance-followup-analysis.json`.
- 기존 91/91 기능 회귀 결과는 재실행하지 않고 유지했다. 이번 실행은 성능 220표본과 표본별 I/O 불변 assert이며, 기존 기능 테스트 통과 수에 합산하지 않는다. 프로파일용 테스트 앱 Production Build도 완료했다.
- 이번 수정은 측정 스크립트·결과·보고서뿐이다. 기능 TS/TSX, SQL 초안, 운영 RPC 정의·트리거·권한·데이터는 수정하지 않았다.
- **로컬 성능 후속 검증은 완료**한다. 실제 운영 셸/데이터/네트워크 및 실제 모바일 기기 성능, 운영 RPC·트리거·ACL 호환성과 승인된 Migration 적용은 아래 배포 전 확인사항으로 남는다. 운영 전체 성능 또는 배포 승인을 선언하지 않는다.

## 최초 성능 비교 (10회; 후속 검증 전 판단 기록)

실제 운영 DB·실제 단말 측정이 아니다. 동일 로컬 Production 테스트 앱에서 수정 전 컴포넌트 사본과 수정 후 컴포넌트를 비교했다. KO, PC 1280×900 / 모바일 390×844. 화면별·버전별 예열 1회 뒤 **각 10회**를 교차 순서로 측정했다. 문서 초기화부터 목록 DOM 생성 후 두 번의 requestAnimationFrame까지 브라우저 내부 performance.now를 기록했다. 중앙값 및 nearest-rank p95다.

GET은 변경하지 않은 실제 bootstrap/recent/snapshot 핸들러와 실제 목록·진행상태 계산 모듈을 실행했다. DB 클라이언트는 로컬 읽기 fixture로 대체하고 인증·영업일은 격리 설정을 사용했다. 데이터는 품목 20개, 활성 Keg·POS 판매 fixture를 포함한다. SQL 서버/운영 네트워크 지연을 측정한 것은 아니며, DB 읽기 횟수는 이 fixture의 실행된 쿼리 호출 수다.

| 지표 | PC 기존 → 개선 | 모바일 기존 → 개선 |
| --- | --- | --- |
| 최초 목록 표시 중앙값 | 342.6 → 348.7ms | 347.3 → 343.2ms |
| 최초 목록 표시 p95 | 349.4 → 355.2ms | 354.3 → 357.0ms |
| API 요청 수 중앙값/p95 | 3/3 → 3/3 | 3/3 → 3/3 |
| DB 읽기 중앙값/p95 | 16/16 → 16/16 | 16/16 → 16/16 |
| 기존 POS 읽기 중앙값/p95 | 4/4 → 4/4 | 4/4 → 4/4 |
| API 응답 합계 중앙값/p95 | 12,109/12,109 → 12,109/12,109B | 동일 |
| 타이밍 telemetry 제외 데이터 | 11,909 → 11,909B | 동일 |
| 전체 네트워크 요청 중앙값/p95 | 29/29 → 27/27 | 29/29 → 27/27 |

신규 초기 요청 0건, 신규 DB/POS 읽기·POS RPC 집계 0건. 최종 PC 중앙값은 +6.1ms/p95 +5.8ms, 모바일 중앙값은 -4.1ms/p95 +2.7ms다. 대응 샘플 차이는 PC -8.1~+19.6ms / 모바일 -14.3~+24.2ms였다. 안전성 안내·시간 표시는 모달을 열 때만 로드하도록 변경했지만 PC 중앙값 증가가 남았다. GET 작업 증가는 검출되지 않았으나 초기 렌더/프레임 스케줄링/측정 변동 중 원인을 확정하지 못했다. 따라서 전체 성능 무회귀를 통과로 단정하지 않는다.

원인 분리를 위한 다음 대안은 (1) 새 안전성 모달의 UI·상태·이벤트 처리까지 별도 지연 로드 컴포넌트로 분리해 초기 파싱/렌더 경로를 더 줄이는 것, (2) 대상 장비의 Production 빌드에서 React commit/프레임 타이밍을 계측하고 더 긴 교차 반복으로 비교하는 것이다. API/DB 읽기 및 응답 데이터 불변 검사는 통과했지만, 시간 기준 무회귀 확인 전에는 P0 전체 완료/배포 승인을 권하지 않는다.

초기 개발 모드 결과 및 Playwright 제어 시간 포함 측정도 삭제하지 않고 보관했다. 최종 표는 제어 시간 대신 브라우저 내부 시각을 사용한 Production 측정이다. 일반 목록·최신 스냅샷·품목로그 fetch 함수는 수정 전 사본과 문자열 단위로 동일함을 확인했다. 타이핑·폴링·Cron 신규 요청이 없으며 기존 품목로그 브라우저 회귀도 통과했다.

원시 샘플: `.qa-review/keg-p0/performance.json`; 비교 과정: `performance-development.json`, `performance-production-controller-timed.json`; GET 코드 비교: `unchanged-get-functions.json`.

## 초기 검증 결과 (91건, SQL 보완 전 이력)

**서로 다른 테스트 기준 91건 통과 / 0건 실패 / 0건 생략**:

- 관련 회귀·PGlite SQL·실제 API 바인딩 검사 82건.
- 별도 일회용 loopback PostgreSQL 18.4에서 실제 잠금 경합·동시 요청·롤백·실행 계획 6건(상위 테스트 포함).
- 신규 P0 브라우저 2건: GET 요청/읽기/데이터 불변 검사와 KO/VI × PC/모바일 시나리오. 이 통과 수는 표시시간 무회귀 입증과 구분한다.
- 기존 Keg 품목로그 브라우저 회귀 1건: KO/VI × PC/모바일.

정상 -1 차감, 시각 경계의 330mL 잔과 2700/3000mL 타워, 반개방 구간 [시작, 종료), 영수증/행 취소·제외·옵션·미결제, 지연 동기화로 인한 기존 불일치 및 stale 토큰, 미래·역전 시각, 매핑 누락, L3 0분·2분·정상 실제 단시간 교체, 동일 UUID·두 직원 동시 처리, 시각 수정끼리 및 시각 수정/교체 경합, 활성 행 수정 후 오류·교체 후 감사 기록 실패의 완전 롤백을 확인했다. 브라우저에서 사유·미리보기 필수 조건, 입력 중 요청 없음, 오래된 미리보기 폐기, 중복 클릭 1회 처리, 커밋 응답 유실 후 재시도 1회 차감도 확인했다.

7월 L2 #22/#32, L3 #25 및 10월 L3 #138은 **동일 ID와 이상 유형을 갖춘 합성 격리 fixture**다. 실제 운영 세션의 시간·판매 수치가 제공되지 않았고 운영 조회도 하지 않았으므로 원본 숫자를 정확히 재현한 fixture로 주장하지 않는다. 운영 139개 세션을 읽거나 백필하지 않았다.

- 변경 파일 ESLint: 통과.
- 전체 app/components/lib/tests ESLint: 기존 6개 오류·4개 경고로 실패. 변경 파일 오류·경고 없음.
- 전체 TypeScript: 기존 오류 40개로 실패. 수정 전후 진단 텍스트가 동일하고 신규 오류 없음.
- 실제 앱 Production Build: 컴파일·빌드 TypeScript 검사·정적 페이지 72개 생성 통과.
- 성능 비교용 별도 Production 테스트 앱 Build도 통과.

검증 로그는 `.qa-review/keg-p0/` 아래에 저장했다. 테스트는 운영 환경 변수/URL을 로드하지 않으며, native 테스트는 직접 생성한 임시 클러스터의 127.0.0.1 임의 포트에만 접속한다. 추가한 SQL은 PGlite 및 이 격리 DB에서만 실행했다.

## 운영 반영 전 작업과 남는 한계

1. 실제 운영의 RPC 정의·인자·트리거·권한·서버 버전·Migration history를 승인된 읽기 절차로 대조해야 한다. 로컬 최소 fixture가 운영의 모든 부수 트리거를 재현한 것은 아니다.
2. 초안을 검토한 뒤 정식 후속 Migration으로 등록하고 별도 승인을 받아 적용해야 한다. 이 파일은 아직 원격/로컬 Migration history에 등록된 적용 파일이 아니다. 수동 SQL Editor 실행은 history 등록을 대신하지 않는다.
3. 기존 PATCH가 남은 혼합 버전에서는 원자적 갱신 보장이 적용되지 않으므로 Keg 변경 작업을 잠시 차단한 상태에서 Migration과 API/UI를 순서대로 일관되게 반영해야 한다. 새 RPC 없이 새 앱만 배포하면 Keg 저장은 503으로 차단된다.
4. 적용 뒤 함수 정의/인자, PUBLIC·anon·authenticated·service_role 권한, Migration history, 세션·재고·로그 행 수, 감사 생성 및 보안/성능 Advisor를 다시 확인해야 한다.
5. 롤백 시 먼저 변경 작업을 차단한다. 새 RPC를 비활성화해 fail-closed 상태를 유지할 수 있지만, 감사 테이블을 삭제하거나 옛 비원자적 PATCH를 그대로 복구하는 것은 권하지 않는다. 성공한 변경의 역변경은 현재 상태를 확인한 별도의 승인된 트랜잭션이 필요하다.
6. 저장 이후 새로 유입되는 지연 POS/영수증 취소는 과거 요약과 현재 POS를 다시 달라지게 할 수 있다. 이번 처리는 저장 시점 스냅샷을 검증하고 기존/재발 불일치를 숨기지 않는다. 모든 미래 POS 변동을 과거 요약에 자동 반영하거나 전체 세션을 계속 보정하는 기능은 포함하지 않았다. 이미 불일치하는 실제 과거 세션의 별도 정정은 이 범위 밖이며 저장이 차단된다.
7. 실제 운영 수치를 가진 네 사례의 비식별 fixture 확보와 운영 장비에서의 성능 확인은 추가 검토 항목이다. 이번 로컬 비교는 신규 요청·DB 부담 증가를 검출하지만 운영 지연 자체를 보장하지 않는다.
