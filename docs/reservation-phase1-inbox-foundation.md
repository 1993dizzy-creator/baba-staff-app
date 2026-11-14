# BABA 예약 관리 Phase 1 — 로컬 기반 및 RPC 계약

상태: Codex에서 인수·핵심 결함 보완. Phase 2 UI 미구현. Main 병합·Push·배포·운영 DB 조회/쓰기·Migration 적용 없음.

## 인수와 Migration 판단

- 기준 Main: `d1bdf18b13dd78e48c4c5e1a1c9115cccdc28e9c`.
- 신규 브랜치: `codex/reservation-phase1-hardening-20261114`.
- 지정 인수: `d51708b0e7fdaf011c0e49e84a969b8de178ef3e` → `bf68261ec64e798b92afa31a0f72d275f4c4f9c5`.
- 인수 후 커밋: `3d595368`, `013819bc`. 최초 PoC `676dedc1`은 Main 포함이므로 재인수하지 않았다. Claude 미추적 파일도 제외했다.
- 원본 정식 Migration `supabase/migrations/20261114120000_create_reservation_inbox_foundation.sql`은 변경하지 않았다.
- Claude 문서·커밋에는 미적용으로 기록돼 있지만 현재 운영 적용 상태를 확정할 로컬 Migration 이력 증거는 없었다. 운영 조회는 금지돼 있으므로 후속 정식 Migration을 선택했다.
- 후속: `supabase/migrations/20261114120001_reservation_phase1_hardening.sql`.
- Supabase CLI 3.1.0 `migration new reservation_phase1_hardening`으로 생성했다. CLI 생성 시각 `20261114111340`이 원본의 미래 시각 버전 `20261114120000`보다 빨라, 새 미적용 파일만 다음 버전 `20261114120001`로 조정했다. 원본 이력은 보존했다.
- 최종 스키마 검증은 원본 → 후속 두 정식 SQL 파일을 실행하는 격리 DB로 수행한다. 운영 적용 이력은 변경하지 않는다.

후속 Migration은 트랜잭션과 테이블 잠금 아래 기존 Inbox·예약·배정·이력이 하나라도 있으면 `reservation_phase1_data_requires_owner_review`로 중단한다. 과거 자유 입력을 담은 append-only 이력을 임의로 정리하거나 테이블 코드를 추정 변환하지 않는다. 기존 데이터가 있다면 보존·전환 범위를 Owner가 검토한 별도 데이터 Migration이 필요하다. 따라서 이 후속 파일은 빈 Phase 1 기반을 위한 정식 산출물이며, 운영에 무조건 실행할 수 있다는 의미가 아니다.

## PoC 근거 보존

최초 `676dedc1`, 보안 보완 `d51708b0`의 개발 이력은 보존한다. Claude가 남긴 수신 근거는 2026-11-14 08:08:25Z `TEST BABA 005`, 08:19:54Z `TEST BABA 006`, `message.text.received`, GROUP, HTTP 200이다. 감사 시 운영 수신을 재현하거나 검증하지 않았다. 해당 기록에서는 Owner가 Webhook을 해제하고 임시 터널·프록시·서버를 종료했다고 설명한다.

## 수신·저장 계약

- `/api/integrations/zalo-bot`은 Secret 헤더를 검증한다. Secret 설정 오류 503, 인증 오류 401, 64KiB 초과 413.
- 기본 `observe`는 저장하지 않는다. 알 수 없는 모드 문자열도 observe로 처리하므로 환경 설정을 정확히 확인해야 한다.
- `persist`는 비어 있지 않은 그룹 Allowlist가 필수다. 원본 그룹 ID 또는 SHA-256 앞 16자리 지문을 받는다.
- 저장 대상은 DB 결과 확인 뒤 200, 실패는 503. 다른 그룹·Bot 메시지·빈 본문에는 저장 없는 200 예외가 있다.
- 잘못된 JSON·미지원 형식·비텍스트·PRIVATE 메시지는 격리 저장한다. PRIVATE와 출처 불명 payload 저장 여부는 운영 정책 미확정이다.
- Inbox 상태: `received / quarantined / linked / dismissed`.
- `(chat_id, message_id)` 해시로 중복 제거하고, ID가 없으면 payload hash를 사용한다. 첫 원본을 보존하고 재수신·payload 불일치 횟수와 이력을 추가한다.
- Webhook은 예약을 생성하거나 확정하지 않는다. 재처리는 현재 파서와 저장된 hash를 사용한다.
- Zalo의 실패 후 재전송 여부·횟수·간격은 미확인이다. 내부 재시도 큐도 없으므로 503만으로 유실 방지를 보장하지 않는다.
- 원문·연락처·발신자·Secret·DB 오류 메시지는 로그에 쓰지 않는다. 원본 그룹 ID 출력 옵션은 운영에서 꺼야 한다.

## 인증·권한

직원 RPC는 service_role 전용이며 입력 actor의 `public.users` 실제 role, `is_active=true`, `app_login_enabled=true`를 검사한다. 앱 세션을 검증하는 책임은 HTTP 서버에 있다. 클라이언트 actor ID를 신뢰하면 안 된다.

| 동작 | Staff | Leader / Manager | Owner / Master |
|---|---|---|---|
| 최소 예약 목록·상세 | 허용 | 허용 | 허용 |
| pending → confirmed | 허용 | 허용 | 허용 |
| 기타 상태 변경·생성·수정·배정·해제 | 차단 | 기존 허용 유지 | 기존 허용 유지 |
| Inbox 원문·검토·재처리·무시 | 차단 | 기존 허용 유지 | 기존 허용 유지 |
| 연락처 원문 | 차단 | 기존 허용 유지 | 기존 허용 유지 |
| 개인정보 삭제 | 차단 | 차단 | 기존 허용 유지 |

Staff용 예약 JSON은 명시적 필드 허용 목록이다: 예약 ID·상태·인원·예약 시각·영업일·예상 이용 시간·버전·테이블 UUID·확정자 ID·확정 시각·삭제 여부. 고객명·연락처(부분 번호 포함)·메모·취소 사유·Inbox ID를 보내지 않는다. 이벤트 changes는 비우고, 테이블 해제 사유도 공개하지 않는다. 정규식 마스킹으로 자유 입력의 안전성을 추정하지 않는다.

Leader 이상 상세의 기존 연락처 원문 열람과 `contact_viewed` 감사는 유지한다. 기존 관리 권한은 확대하지 않았다. 이 역할들의 개인정보 접근 범위가 최종 운영 정책으로 승인됐다는 의미는 아니다.

실제 구현한 HTTP는 `POST /api/tables/reservations/[id]/confirm` 하나다. 매 요청 `getAuthenticatedActor()`로 서명 세션과 현재 직원 정보를 확인하고, 서버 actor ID로 `reservation_transition_v1`을 호출한다. 본문 `expectedVersion`은 양의 정수여야 한다. 고객 개인정보가 없는 확정 결과 5개 필드만 반환한다. 다른 조회·수정 HTTP API와 UI는 Phase 2 범위다.

## 상태·버전·확정 이력

```
pending   → confirmed / cancelled
confirmed → arrived / cancelled / no_show / pending
arrived   → completed
```

취소는 사유 필수다. Staff는 위 전이 중 pending → confirmed만 가능하다. 완료·취소·노쇼는 종료 상태다.

모든 수정·상태 변경·배정·해제 RPC는 expected version의 NULL·0·음수·증가 불가능한 최댓값을 거부한다. 누락은 함수 해석 단계에서, 정수로 변환할 수 없는 값은 PostgreSQL 인자 검사에서 거부한다. 행 잠금 후 현재 버전과 `IS DISTINCT FROM`으로 비교한다. HTTP는 문자열·소수·누락도 400으로 거부한다. 동시 동일 버전 변경은 한 건만 성공한다.

`confirmed_by / confirmed_at`은 마지막 성공 확정의 담당자와 실제 시각이다. 일반 수정·배정·확정 취소로 덮어쓰지 않는다. 재확정 시 현재 확정 정보만 갱신하고, 과거 확정별 actor·event 시각·정확한 confirmedAt을 append-only 이벤트로 유지한다.

## 실제 테이블 계약과 동시성

`lib/sales/baba-table-catalog.ts`의 27개 실제 UUID·이름을 private catalog에 고정한다. RLS와 접근 회수를 적용하고 테스트로 코드 카탈로그와 완전 일치하는지 검사한다. 추가 POS API 호출이나 자격 증명이 필요 없다.

- 배정은 `table_id uuid` FK를 사용한다. 임의 코드·미등록 UUID는 거부한다.
- `reservation_link_table_v1(bigint,bigint,integer,text)`는 제거한다.
- 새 계약은 `reservation_link_table_v1(p_actor_user_id bigint,p_reservation_id bigint,p_expected_version integer,p_table_id uuid)`다.
- JSON `tableCode`도 `tableId`로 바뀐다. 다른 public RPC 12개의 인자형은 원본과 같다.
- GiST exclusion은 `(table_id =, planned_range &&) WHERE released_at IS NULL`로 유지한다.
- 시간 범위는 `[시작, 종료)`이며 맞닿은 예약은 허용한다. 시간 수정은 모든 계획 범위를 함께 바꾸며 충돌하면 예약·범위·버전·이력 추가를 롤백한다.
- 예약 확정과 계획 배정은 POS 실제 점유를 변경하지 않는다.

PGlite의 순차 테스트와 별도로 로컬 PostgreSQL 독립 연결에서 실제 잠금 대기를 관측한다. 동시 확정·수정·동일 테이블 배정·배정 대 시간 수정·Inbox 생성·동일 requestKey 생성 경쟁을 검증한다.

## Inbox 중복 정책

복수 예약 정책 확정 전에는 Inbox 1건당 예약 1건으로 제한한다. source Inbox 행 잠금과 부분 UNIQUE 인덱스를 함께 사용한다.

- 같은 requestKey 재전송: 기존 예약을 반환하는 멱등 처리.
- 같은 Inbox와 다른/누락 requestKey: `source_conflict`와 기존 예약 ID 반환.
- 기존 예약이 취소돼도 같은 메시지에서 새 예약을 만들지 않는다.
- 개인정보가 삭제된 Inbox에서는 새 예약을 만들지 않는다.
- 향후 한 메시지의 복수 예약이 필요하면 명시적 Owner 정책과 별도 계약 변경이 필요하다.

## 개인정보 보존·삭제

기간은 기존 제안값을 유지한다. 검토 완료 Inbox 90일, 미검토 Inbox 180일, 종료 예약은 영업일 후 365일이다. 자동 실행은 없고 Owner/Master만 실행할 수 있다. 기간·실행 담당자·PRIVATE 저장 여부는 운영 전 결정해야 한다.

삭제는 NULL/true dry run을 기본으로 하고 미래 기준 시각을 거부한다. 실행 시 Inbox 원문·raw·ID·발신자·review_note, 예약 고객명·연락처·메모·취소 사유, 관련 배정 release_reason을 제거한다. 취소 상태의 필수 사유는 고정 대체값으로 남긴다. 삭제 후 Inbox 무시 동작으로 새 자유 입력을 덧붙이는 것도 차단한다.

자유 입력 사유는 새 이벤트에 저장하지 않는다. 이벤트에는 hasReason 등 구조화 값만 남겨 개인정보 삭제와 append-only 증거 보존을 양립시킨다. 과거 자유 입력 이벤트가 있는 운영 DB는 Migration 사전 조건에서 중단하므로 자동 변환·삭제되지 않는다.

## 검증 기록과 재실행

원본 회귀 테스트 40개는 인수 직후 실제 40/40 PASS를 확보했다. 로그는 `.local/reservation-phase1/baseline-40.log`다. 최종 검증은 아래 명령으로 수행하며 결과와 SQL SHA-256을 이 문서 말미에 기록한다.

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/zalo-webhook-poc.test.ts tests/zalo-webhook-persist.test.ts tests/reservation-inbox-db.test.mjs tests/reservation-hardening-db.test.mjs tests/reservation-confirm-api.test.mjs tests/reservation-inbox-concurrency.test.mjs
```

실제 동시성용 바이너리는 저장소 의존성을 바꾸지 않고 `.local/pg-tools`에 설치한다.

```powershell
npm.cmd --cache .local/npm-cache install --prefix .local/pg-tools --no-audit --no-fund embedded-postgres@18.6.0-beta.19
```

동시성 테스트는 매번 `.local/reservation-phase1/pg-*`에 새 클러스터를 만들고, 무작위 loopback 포트에만 연결하며 종료 시 서버를 정지한다. 운영 URL·환경 파일·고객정보를 사용하지 않는다. 테스트용 DB·서버 로그는 증거로 보존한다. 수동 롤백 SQL은 원본·후속 어느 빈 스키마에서도 동작하며 데이터가 있으면 중단한다. Migration 이력 정리는 수행하지 않는다.

## Phase 2 경계

예약 페이지는 `app/(protected)/tables/reservations/page.tsx` 하나이며 기존 테이블 / 예약 메뉴를 유지한다. 오늘 예약 / Zalo 수신함 / 전체 일정, 등록·상세 모달은 이번 작업에서 구현하지 않았다. 관리자 예약 페이지는 생성하지 않는다.

최소 예약 조회·확정 계약은 Phase 2 기반으로 사용할 수 있다. Phase 2 조회·수정 서버 API도 매 요청 실제 인증이 필요하다. 개인정보·수정·취소 권한을 전체 역할 확정 권한과 분리하고, VN 03:00 영업일 및 실제 카탈로그 UUID를 유지해야 한다.

## 운영 적용 경계

Main 병합·Push·배포와 운영 Migration 적용은 각각 필요한 승인 범위를 따른다. 현재 운영 적용 상태는 미확인이다. 빈 DB라면 두 정식 Migration이 순서대로 필요하며, 이미 원본만 적용한 빈 DB에는 후속만 필요하다. 데이터가 있는 경우 후속은 중단한다. 적용 전 운영 승인과 별도의 읽기 점검이 필요하며, 이번 작업은 그 승인을 포함하지 않는다.

persist는 필요한 DB 계약이 준비된 뒤에만 활성화한다. Zalo 재전송 미확인, 보존기간·개인정보 정책·장애 복구 정책은 잔여 운영 결정사항이다.

## 최종 검증 결과 (2026-11-14)

- Node `v24.15.0`, PGlite `0.3.14`, 실제 동시성 서버 PostgreSQL `18.6` (Windows x64).
- 인수 직후 원본 40개: **40/40 PASS** (`.local/reservation-phase1/baseline-40.log`).
- 원본 회귀 40 + 보완 DB 10 + 인증 API 2 + 초기 동시성 7: **59/59 PASS** (`.local/reservation-phase1/final-tests.log`, 21.17초).
- 이후 테스트에 배정·해제 경쟁과 4개 RPC의 누락·비정수 거부를 추가했다. 영향받은 DB 10 + 동시성 9를 직렬 재실행: **19/19 PASS** (`.local/reservation-phase1/final-db-concurrency.log`, 9.65초).
- 중복 집계를 제외한 현재 테스트는 **61개**, 모두 유효한 실행 PASS가 있다. 그중 실제 동시 경쟁 시나리오는 8개이며 부모 테스트까지 포함해 Node 집계 9개다. 기존 검증 40개와 변경 없는 API 2개는 유효한 PASS를 재사용했다.
- 변경 API와 새 테스트 파일의 ESLint PASS (`.local/reservation-phase1/lint.log`).
- 변경 API 및 그 실제 인증 의존성의 한정 TypeScript 검사 PASS (`.local/reservation-phase1/types.log`). 전체 프로젝트 TypeScript·Build는 실행하지 않았다.
- `git diff --check` PASS. 원본 Migration은 `bf68261e` 대비 변경 없음.
- 테스트한 Worktree 실제 파일 SHA-256:
  - 원본: `617978A504765DA97008D711265575B09D9D0A5D43B2A5C3967D8EBFCAA77F68`
  - 후속: `A684D07D46E22E5F2D709CEF4DEB0AA404D70DA5C9E345B39152F1F569F63EB9`

후속 보완 파일의 전체 경로:

```text
C:\workspace\baba-wt-codex\app\api\tables\reservations\[id]\confirm\route.ts
C:\workspace\baba-wt-codex\supabase\migrations\20261114120001_reservation_phase1_hardening.sql
C:\workspace\baba-wt-codex\supabase\reservation_inbox_foundation_rollback.sql
C:\workspace\baba-wt-codex\tests\helpers\reservation-hardening-fixture.mjs
C:\workspace\baba-wt-codex\tests\reservation-confirm-api.test.mjs
C:\workspace\baba-wt-codex\tests\reservation-hardening-db.test.mjs
C:\workspace\baba-wt-codex\tests\reservation-inbox-concurrency.test.mjs
C:\workspace\baba-wt-codex\docs\reservation-phase1-inbox-foundation.md
```

그 외 지정 커밋에서 인수한 파일(이 단계에서 추가 수정하지 않음):

```text
C:\workspace\baba-wt-codex\app\api\integrations\zalo-bot\route.ts
C:\workspace\baba-wt-codex\lib\zalo\webhook-poc.ts
C:\workspace\baba-wt-codex\lib\reservations\zalo-inbox-store.ts
C:\workspace\baba-wt-codex\supabase\migrations\20261114120000_create_reservation_inbox_foundation.sql
C:\workspace\baba-wt-codex\tests\zalo-webhook-poc.test.ts
C:\workspace\baba-wt-codex\tests\zalo-webhook-persist.test.ts
C:\workspace\baba-wt-codex\tests\reservation-inbox-db.test.mjs
```

판정: 필수 보완 A~F에 대해 로컬 검증 완료. **Phase 2 로컬 개발 착수 가능**. 운영 적용은 현재 DB 상태와 정책을 별도로 확인·승인해야 하며, 이번 결과는 운영 적용 PASS가 아니다.

종료 전 Worktree 확인에서 Main HEAD는 기준과 같았지만, 시작 시 없던 `C:\workspace\baba-staff-app\app\api\admin\users\create\route.ts` 수정과 `C:\workspace\baba-staff-app\lib\payroll\new-employee-setup.ts` 미추적 파일을 발견했다. 변경 주체는 확인하지 않았으며 이번 예약 파일과 경로가 겹치지 않는다. 해당 파일은 읽어 수정하거나 인수하지 않고 보존했다. Claude HEAD와 미추적 6개도 유지됐다.
