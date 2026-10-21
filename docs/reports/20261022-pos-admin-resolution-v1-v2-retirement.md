# POS 관리자 복구 V1·V2 제거 보고서 (2026-10-22)

상태: 로컬 코드 제거·역방향 Migration 작성·격리 검증 완료. 운영 DB 적용, Git 반영, 배포는 하지 않았다.

## 1. 제거 이유

2026-10-21 CUKCUK 결제예정 영수증 누락·불일치에 대응하려고 관리자 복구 시스템을 개발했다.

- V1: 관리자 판정, POS 관측, 자동 재조회 큐
- V2: 판정 버전, 재고 검토·승인, 재무 정정 보류, 차감 이력 INSERT guard

이 시스템은 드문 예외에 대비한 것이지만 기존 동작을 여러 곳에서 바꿨다.
- 기존 재고 엔진 3개와 마감 원천 함수에 조건을 삽입했다.
- POS 영수증·품목·결제 테이블에 보호 트리거를 걸었다.
- 운영 테이블에 컬럼 4개를 추가했다.
- 기능 플래그 4개를 도입했다.

운영 필요에 비해 구조가 지나치게 복잡하다고 판단했다. 그래서 플래그만 OFF로 두지 않고 코드와 DB에서 제거해 기존 POS 운영 구조로 되돌린다. 운영 기록은 0건이었다(이전 읽기 전용 조회 기준이며, 이번 작업에서는 재조회하지 않았다).

후속 기능은 이번 작업에 포함하지 않고 별도로 다시 설계한다.
- 결제예정 30분 초과 배지
- 기존 영수증 화면에서 결제완료·취소 단순 정정
- 결제예정이 남은 영업일의 마감 차단

## 2. 코드 변경

비교 기준은 V1·V2 이전 `945cd789736f`와 이후 `9fc257c6b3bd`(GitHub 읽기 전용 비교, 80개 파일)이다. 파일 전체를 과거 버전으로 덮어쓰지 않고 hunk 단위로 분류했다.

### 보존한 변경 (V1·V2와 독립)
- 서버 세션 인증(`requireRole`)과 본문 `actorUsername` 신뢰 제거
  - today: Owner/Master/Manager
  - monthly: Owner/Master/Manager/Leader
  - receipts GET/POST, receipts/[id] GET/PATCH/POST, refresh-pos
  - sync(중단된 Codex 작업분)
- 일반 재고 경로의 55P03 처리
  - `inventory-deduction-lock.ts`, apply/reprocess API, batches/reprocess/unified-execute
- POS 상세 1건 조회 실패 격리(`sync-to-sales`). 실패 건은 기존 `failedDetails` 경로에서 partial로 처리되고 `source_complete=false`가 된다.
- 결제 스냅샷 테스트의 운영 Migration 파일명 정정(`20261016180852`)
- `.gitignore`, Keg·재고 UI 변경 전체

### 제거한 변경
- V1·V2 화면, API, 모듈, 플래그 4개, 그리고 이 기능용으로 공통 파일에 추가된 컬럼 조회·필터·배너·보호 분기
  - 플래그: `POS_ADMIN_RESOLUTION_SCHEMA_READY`, `POS_ADMIN_RESOLUTION_ENABLED`, `POS_ADMIN_RESOLUTION_V2_SCHEMA_READY`, `POS_PENDING_RECHECK_ENABLED`
- 중단된 Codex 작업 중 이번 범위 밖의 후속 기능
  - 최소 결제상태 정정 RPC와 Migration `20261021184020`, payment-correction API·정책
  - 결제예정 마감 차단(close/final/view/panel)
  - 이 기능을 전제로 한 Codex의 retire 초안 `20261021184037`
- V1 작업 중 커밋된 임시 산출물(`.local-pos-tsc*.txt`, `tests/pos-pending-write-check.tmp`)

제거한 미완료 작업은 모두 원본 그대로 보관했다. 위치는 `.tmp/codex-pos-rollback-wip-backup-20261022/`(Git 무시 대상)이며 SHA-256 목록이 함께 있다.

## 3. DB 역방향 Migration

파일: `supabase/migrations/20261021193000_retire_pos_admin_resolution_v1_v2.sql`. 하나의 트랜잭션으로 실행되며 lock_timeout 5s, statement_timeout 60s를 적용한다.

**제거 대상**
- 테이블 6개(public)와 private 테이블 2~3개
- 스키마 `pos_resolution_private`와 그 안의 함수 전체(`edit_paid_held` clone 포함)
- public RPC 8개와 재조회 RPC 2개(있는 경우)
- 보호 트리거 4개
- 인덱스 `pos_pending_resolution_candidates_idx`
- 컬럼 4개: `admin_resolution_version`, `admin_resolution_financial_review_required`, `admin_resolution_retired`, `admin_resolution_content_fingerprint`

**복원 대상**
- `apply_sales_inventory_deduction_batch`, `reprocess_modified_sales_inventory_deduction_receipt`, `rollback_canceled_sales_inventory_deduction_receipt`, `pos_sales_close_private.build_source`
- 운영 중인 정의에서 V2가 삽입한 문자열만 정확히 1회 제거한다. 저장소 원본으로 다시 만들지 않으므로 `processed_line_id`가 재도입되지 않는다.
- OID, owner, ACL, SECURITY DEFINER, SET 옵션이 COMMIT 전에 바뀌지 않았는지 검증한다.

**안전 조건**
- 데이터 DML 0건
- `CASCADE` 미사용(모든 DROP은 RESTRICT)
- 다음 중 하나라도 해당하면 전체 중단
  - V1·V2 테이블에 1행이라도 있음
  - 제거할 컬럼에 기본값이 아닌 값이 있음
  - V2 재고검토 보류 영수증이 있음
  - 정의가 예상 계약과 다름
  - 재실행

**점검 SQL** (모두 읽기 전용)
- 적용 전: `supabase/verification/20261021193000_retire_pos_admin_resolution_preflight.sql`
- 적용 후: `supabase/verification/20261021193000_retire_pos_admin_resolution_postflight.sql`

## 4. 자동 재조회 Migration `20261021174643`

- 운영 객체 기준으로는 이미 반영돼 있다(이전 읽기 전용 조회: 큐 테이블·RPC 없음). 그러나 history에는 없다.
- 이번 Migration은 이 파일을 다시 실행하지 않고 의존하지도 않는다. 적용 여부와 관계없이 동작하며 큐를 다시 만들지 않는다. 두 경우 모두 격리 검증했다.
- 파일은 수정하지 않았다. 객체 상태가 이미 반영돼 있으므로, history 등록 여부는 AGENTS.md 4단계 절차에 따라 사용자 승인 후 별도로 판단한다.

## 5. 검증 (격리 환경)

- **역방향 Migration (PostgreSQL 17, 6건 통과)**
  - V1 이전 상태와 카탈로그 전체가 일치한다: 스키마, 컬럼, 함수 본문, owner/ACL, 트리거, 인덱스, 제약.
  - 데이터 행이 전부 동일하고 마감 fingerprint도 같다.
  - 재고 엔진의 LF 해시가 사용자 확인 운영 해시와 일치한다.
  - 정상 마감과 initial apply(동시 2회 호출 시 1회만 반영)를 확인했다.
  - 실패 조건 6종에서 아무것도 변경되지 않는다.
  - 운영용 preflight·postflight SQL도 같은 스키마에서 실행해 확인했다.
- **결제 스냅샷 UNIQUE 수정 (10-16)**: PostgreSQL 47건과 Supabase CLI 적용 테스트가 통과했다.
- **재고·Keg PostgreSQL**: 18건 통과. inventory atomic edit와 safe correction도 통과했다.
- **Keg 브라우저 회귀**: production 빌드에서 KO/VI × PC/모바일 4개 조합이 통과했다.
- **세션 인증**: 라우트 8개에서 세션 누락·위조·비활성 401, 역할 밖 403, 허용 역할 통과를 확인했다.
- **전체 node 테스트**: 신규 실패 0건. 작업본 94건 실패는 모두 HEAD(106건)에서도 실패하는 기존 실패다.
- **TypeScript**: 오류 40건으로 HEAD와 동일하며, 전부 기존 테스트 파일이다.
- **ESLint**: 변경 파일 오류 0건.
- **Production Build**: 성공, 경고 0건. `/inventory`는 정적 페이지이며 제거한 라우트는 없다.

## 6. 운영 적용 순서

1. Vercel Production 환경변수에서 플래그 4개가 설정돼 있는지 확인한다. 이번 작업에서는 확인할 수 없었다.
2. 코드를 먼저 배포한다. 새 코드는 V1·V2 객체를 전혀 사용하지 않으므로 DB 변경 전에도 정상 동작한다. 반대로 플래그가 `"true"`인 상태에서 DB를 먼저 바꾸면 현재 코드의 POS 동기화가 실패할 수 있다.
3. preflight를 실행해 모든 expected 값이 일치하는지 확인한다.
4. 03:00~03:10과 수동 동기화 중을 피해 Migration을 SQL Editor에서 1회 실행한다.
5. postflight를 실행해 객체 제거, 함수 동일성·해시, 행 수 동일, 최근 마감 fingerprint 일치를 확인한다.
6. AGENTS.md 4단계에 따라 history를 등록한다.
7. 배포 후 다음을 확인한다: 5분 자동 동기화, 수동 동기화, refresh-pos, 결제완료 영수증 수정, 재고 차감 화면, 다음 날 03:05 자동 마감.

## 7. 복구 절차

- **Migration 실패**: 단일 트랜잭션이므로 아무것도 변경되지 않는다. 오류 코드를 확인하고 중단한다.
- **배포 후 코드 문제**: Vercel에서 이전 배포로 되돌린다. DB 적용 후에 되돌릴 경우 이전 코드는 플래그가 OFF인 상태에서만 안전하다.
- V1·V2를 다시 만드는 것은 권장하지 않는다. 기록이 0건이어서 잃는 데이터가 없다.

## 8. 남은 위험

- 운영 DB를 이번에 재조회하지 못했다. 0건 상태와 함수 정의 계약은 preflight로 확인해야 한다.
- `build_source`와 apply 엔진은 저장된 사전 해시가 없다. OID·ACL 동일성과 격리 재현으로만 검증했다.
- 일부 V1·V2 문서는 작성 당시 인코딩 손상으로 한글이 `?`로 남아 있다(폐기 표시만 추가했다).
