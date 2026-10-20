# Keg P0 정식 Migration 등록 및 배포 전 점검 — 2026-10-21

후속 상태: 아래는 구 해시의 차단 이력이다. 최상위 두 줄 제거와 실제 CLI 2.81.3 원자성 검증 후의 최신 판단은 [Migration 실행기 원자성 최종 검증](20261021-keg-safety-p0-runner-atomicity.md)을 따른다.

**로컬 등록·기능 검증 완료, 운영 적용은 실행기 호환성 문제로 보류한다.** 승인 SQL은 변경하지 않았다. CLI의 db push/migration up, 운영 DB 조회·변경, Migration 적용, Git 명령, Push·배포는 실행하지 않았다. 아래 SQL 실행은 모두 소유한 격리 PostgreSQL/PGlite 테스트 fixture다.

## 정식 Migration 파일 및 원본 보존

- 등록 파일: `supabase/migrations/20261020120000_keg_safety_p0.sql` (208행).
- 보존한 원본: `supabase/drafts/keg_safety_p0.sql`.
- 두 파일은 바이트 단위로 동일하다. SHA-256은 둘 다 `39b13e6911a83782e0e207f0ab8cee00efd8073fbf517d82aec5c5e3d67cbc31`.
- migrations 폴더의 같은 버전 파일은 1개, 같은 SHA-256 파일도 1개다. 두 신규 함수 이름을 정의하는 다른 Migration도 없다. 기존 Migration·제품 코드·초안 SQL은 수정하지 않았다.
- 여기서 등록은 로컬 migrations 디렉터리에 파일을 둔 것을 뜻한다. 원격 `schema_migrations`에 이력을 등록한 것이 아니다. 사용자 지정 파일명과 정확한 복사 지시를 따라 CLI로 별도 타임스탬프 파일을 생성하지 않았다.

## 실행 방식 조사 및 적용 차단 사유

저장소에는 `supabase/config.toml`, `.github` CI Migration workflow, package.json의 Supabase CLI dependency/버전 고정 또는 Migration 적용 script가 없다. PATH에서도 Supabase 실행 파일을 확인하지 못했다. `supabase/.temp/cli-latest`의 `v2.121.0`은 최신 버전 캐시이며 실제 설치/운영 실행 버전의 증거가 아니다. 따라서 현재 운영에서 선택할 바이너리·호출 경로는 저장소만으로 확정할 수 없다.

프로젝트의 기존 실제 실행 검증 경로는 **Supabase CLI 2.81.3 `db push --db-url`**이다. 로컬 문서 `20261017-pos-payment-migration-runner-verification.md`, 실제 CLI 테스트 `tests/pos-payment-migration-cli.test.mjs`, 당시 로그 `.tmp/pos-payment-cli-runner.log`에 근거가 있다. 이 경로는 Migration 문장 뒤에 history INSERT를 같은 암묵적 트랜잭션 배치로 보낸다. 기존 검증에는 내부 BEGIN/COMMIT이 있는 대조군에서 DDL/history 분리가 실제 CLI로 재현된 기록이 있다. 해당 버전의 `migration up`도 같은 ApplyMigrations 경로라는 기존 조사 근거가 있다. 이번에는 금지된 Migration 명령을 재실행하지 않았다.

**승인 SQL의 208행 `COMMIT`이 실행기의 후속 history INSERT보다 먼저 DDL·ACL을 확정한다. 후속 history 기록이 실패하면 새 테이블·RPC는 남고 해당 Migration 이력은 누락될 수 있다.** 직접 SQL 파일 실행의 DDL 원자성 통과가 history까지 포함한 Migration 실행기 원자성을 보장하지는 않는다. 따라서 현재 해시의 파일을 이 CLI 경로로 운영 적용하는 것은 승인 권고 대상이 아니다.

이번에는 실제 PostgreSQL 18.4의 격리 SQL protocol fixture로 같은 경계를 추가 확인했다. 실제 CLI 재검증으로 표현하지 않는다.

| 격리 SQL 배치 실험 | history INSERT 실패 뒤 결과 |
| --- | --- |
| 승인 파일 바이트 그대로 + 후속 history INSERT 강제 실패 | 새 audit 테이블/RPC 2개 유지, history 0행; 위험 재현 |
| 메모리 대조군에서 최상위 BEGIN/COMMIT만 제거 + 같은 실패 | 새 객체 없음, history 0행; 전체 롤백 |

두 실험 모두 기존 RPC 정의/ACL과 기존 재고·세션 데이터는 불변이었다. 메모리 대조군은 제안 검증일 뿐 파일에 저장하지 않았고, 원본·Migration 해시는 그대로다. 증거: `.qa-review/keg-p0/registration-runner-evidence.json` (`actualCliInvoked: false`). 기존 실제 CLI 기록과 이번 PostgreSQL 경계 실험을 구분해야 한다.

### 운영 적용 전에 필요한 최소 수정안 — 미실행

1. 운영 실행기를 검증된 버전·경로로 고정한다.
2. **별도 검토·승인 후** 최상위 `BEGIN;`/`COMMIT;`만 제거해 실행기가 DDL·RLS·ACL·history INSERT 전체의 트랜잭션을 소유하도록 한다. PL/pgSQL 함수 본문 BEGIN/END와 로직은 유지한다. 이 변경은 현재 승인 해시를 바꾸므로 새 SQL 전문·SHA-256 재승인이 필요하다.
3. 새 바이트를 대상으로 격리된 실제 실행기의 성공·중간 오류·history INSERT 오류·재실행 skip 검증을 거친다. 이번 제한에 따라 CLI 적용 테스트는 실행하지 않았다.

SQL Editor 수동 적용 후 별도 history INSERT/repair로 분리 상태를 덮는 방법은 제안하지 않는다. 다른 실행기를 선택한다면 승인 파일과 history를 함께 원자 처리하는 방식부터 별도 검증해야 한다. Postflight를 통과해도 이 트랜잭션 설계 문제를 해소한 것으로 간주하면 안 된다.

## PATCH·교체 API와 등록 SQL 계약

`app/api/inventory/keg-sessions/[id]/route.ts` PATCH는 인증 세션의 username과 session ID를 전달하고, `replace/route.ts` POST는 item ID를 전달한다. 두 경로는 `lib/inventory/keg-safety-server.ts`를 사용한다.

| 단계 | 함수와 정확한 인자 |
| --- | --- |
| dryRun | `inventory_preview_keg_change(p_action text, p_item_id bigint, p_session_id bigint, p_at timestamptz, p_business_date date, p_actor_username text, p_expected_quantity numeric)` |
| 저장 | `inventory_apply_keg_change`에 위 7개와 `p_preview_token text, p_request_id uuid, p_reason text, p_confirm boolean` 추가 |

등록 파일로 설치한 로컬 fixture에서 실제 API의 전달 key를 대조하고, 그 key를 PostgreSQL named notation으로 호출했다. 함수명·인자명·순서와 선택적 기본값, 타입 해석에 문제가 없다. PATCH는 `p_action=edit-start`, `p_item_id=null`, `p_session_id=<id>`이며 POST는 `p_action=replace`, `p_item_id=<itemId>`, `p_session_id=null`이다. actor는 요청 body가 아닌 인증 세션에서 얻는다. 영업일은 서버 공통 함수를 거쳐 SQL의 베트남 03:00 검증을 다시 받는다.

반환형은 모두 jsonb다. preview의 `ok/dryRun/writesPerformed/action/previewToken`과 수량·판매 요약, 최초 세션 null 요약을 확인했다. 저장 PATCH의 `ok/session(id,startedAt,startedBusinessDate)`, 교체의 기존 `ok/itemId/quantity/logId/closedSession/newSession` 구조를 유지한다. 명명된 저장 재호출도 동일 UUID의 `replayed=true`와 기존 결과를 반환하고 추가 차감이 없다. 실제 기능 회귀에서 snapshot mismatch·stale·영업일 mismatch 등의 오류 계약도 다시 확인했다.

## 기존 객체 보존 및 읽기 전용 Postflight

- 기존 `replace_inventory_keg` 및 `calculate_inventory_keg_sales`의 본문·owner/ACL·설정, 기존 트리거와 기존 테이블 ACL/RLS는 native 회귀에서 설치 전후 동일하다.
- SQL은 새 audit 테이블과 새 함수 2개만 CREATE/권한 설정한다. 기존 RPC는 호출만 한다. 기존 재고 -1 잠금·차감·로그·세션 교체 경로와 그 권한 정책은 유지한다.
- 설치 DDL 자체는 기존 Keg 데이터를 변경하거나 신규 함수 본문을 실행하지 않는다. 기존 139개 세션 백필, 지연 POS 수정, 장부 수정은 없다.
- 읽기 전용 파일: `supabase/verification/20261020120000_keg_safety_p0_postflight.sql`. `REPEATABLE READ READ ONLY` 트랜잭션으로 catalog/history/ACL/RLS/기존 RPC·트리거·Keg 데이터 fingerprint만 SELECT하고 ROLLBACK한다. 저장/교체/POS 계산 RPC를 호출하지 않는다.
- Postflight 전체를 격리 PostgreSQL에서 실행해 문법·read-only 실행과 기존 데이터 불변을 확인했다. 운영에서는 아직 실행하지 않았다. history 누락은 즉시 중단 조건이다.
- 적용 전 유지보수 창에서 기존 객체·데이터 조회 부분의 baseline을 저장하고, Keg 쓰기를 멈춘 상태에서 적용 후 결과와 비교해야 한다. 이번에 운영 baseline을 새로 조회한 것은 아니다. 감사 테이블은 쓰기 재개 전 0행, 새 RPC는 브라우저 역할 실행 불가/service_role 실행 허용, audit는 RLS 및 service_role 직접 SELECT만 허용이 기대값이다. owner 고유 권한은 별도다.

## 이번 재검증 결과

| 실행 | 통과 / 실패 / 생략 |
| --- | --- |
| 기능·SQL·API·I/O + native 동시성·롤백 + 새 등록/명명 인자/실행기 위험 재현 회귀 | 98 / 0 / 0 |
| P0 및 품목로그 KO/VI × PC/모바일 브라우저 | 3 / 0 / 0 |
| 중복 없는 전체 합계 | **101 / 0 / 0** |

위 테스트 통과 수에는 알려진 실행기 위험이 재현돼야 통과하는 검사도 포함된다. **테스트 101개 통과와 운영 적용 호환성 합격은 별개이며, 실행기 적합성은 불합격/보류다.**

- 루트 Production Build: exit 0. 브라우저용 Production 테스트 앱 Build도 exit 0.
- 신규 테스트 ESLint: exit 0. 제품 TS/TSX 변경이 없어 이번에는 전체 tsc를 반복하지 않았다. 앞선 전체 tsc의 기존 오류 40건은 해소했다고 주장하지 않는다.
- 일반 `/inventory` 브라우저 진입은 PC·모바일 각 버전 10회에서 **API 3 / DB 읽기 16 / 그중 POS 읽기 4 / telemetry 제외 11,909B**로 전 표본 동일했다. 신규 API/DB/POS 조회 0건. 실제 GET 코드를 로컬 read fixture에 연결한 I/O 수 검증으로, 운영 DB 읽기 실측이나 신규 latency benchmark가 아니다. 원시 응답의 처리시간 telemetry 길이는 달라질 수 있다.
- API 세 경로는 bootstrap-stream, logs/recent, snapshot/latest이며 신규 safety RPC는 일반 진입에서 호출되지 않는다. 제품 코드와 초기 진입 함수는 이번에 수정하지 않았다.
- 로그: `.qa-review/keg-p0/registration-regression.txt`, `registration-browser.txt`, `registration-contract-runner.txt`, `registration-root-build.txt`, `registration-harness-build.txt`, `registration-eslint.txt`, `registration-io-smoke.json`.

## 운영 적용 전 남은 위험

가장 먼저 내부 COMMIT/history 원자성 문제를 해결하고 새 바이트·해시를 승인받아야 한다. 실제 운영 적용 실행기/버전과 원격 pending/history도 아직 확정·조회하지 않았다. 다른 pending이나 버전 누락이 있으면 중단하고 include-all/repair로 우회하면 안 된다. 구버전 PATCH가 혼재해 안전 경로를 우회하지 않도록 Keg 쓰기를 잠시 멈추고 SQL 및 API/UI를 일관되게 전환해야 한다. 새 RPC 없이 앱만 전환하면 저장은 503으로 차단된다. 이미 불일치하는 과거 데이터와 저장 뒤 지연 POS의 자동 보정은 여전히 범위 밖이다.

참고: [프로젝트 기존 실행기 검증](20261017-pos-payment-migration-runner-verification.md), [Supabase CLI reference](https://supabase.com/docs/reference/cli/supabase-db-push), [PostgreSQL protocol transaction boundaries](https://www.postgresql.org/docs/current/protocol-flow.html).
