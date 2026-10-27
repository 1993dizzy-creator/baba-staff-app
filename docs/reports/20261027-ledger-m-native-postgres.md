# BABA M단계 — 실제 PostgreSQL 경합 및 설치 검증

## 결론

**대상 Migration의 독립 PostgreSQL 설치·권한 검증은 PASS. 무중단 동시 writer 허용은 FAIL/실행 보류다.** 같은 월 중복 호출, close/reopen 직렬화, 5초 timeout 및 부분 실패의 원자적 rollback은 검증됐다. 그러나 기존 R1 writer와 정정 함수 사이의 advisory/table lock 순서 역전으로 실제 교착 `40P01`이 재현됐다. PostgreSQL은 피해 호출을 중단하고 부분 쓰기를 rollback했으며, 재실행에도 중복은 없었다.

테스트 러너 **15 PASS / 0 FAIL / 0 SKIP**는 상위 테스트 1개와 세부 시나리오 14개가 예상 결과를 검증했다는 뜻이다. 교착 시나리오는 **교착을 실제 재현하고 rollback을 검사하도록 만든 테스트가 PASS**한 것이며, 운영에서 교착이 없다는 PASS가 아니다. 운영 실행의 안전 판정은 아래 조건표로 구분한다.

운영 Supabase에는 접속하거나 SQL을 실행하지 않았다. 운영 함수 설치·이력 등록·데이터 변경·재개방·재마감·push·배포 모두 미실행이다. 운영 미설치 상태는 사용자 제공 사실이다.

## 환경과 대상 동일성

- 실제 PostgreSQL **17.6 / x86_64-windows / 64-bit**. PGlite 아님.
- 기존 바이너리: `C:/workspace/baba-staff-app/.tmp/production-preflight/node_modules/@embedded-postgres/windows-x64/native/bin`. 바이너리는 읽기/실행만 했다. Docker·Windows 서비스·사용자 시스템 설정은 변경하지 않았다.
- 저장소의 기존 `nativeInventoryPostgres` 도우미로 자기 Worktree `.qa-review/`에 새 UUID 클러스터를 생성했다. 고정된 외부 DB URL이나 환경 자격 증명을 받지 않고, 도우미가 만든 `127.0.0.1` 임의 포트·cluster_name·data_directory를 대조한다.
- 시나리오마다 독립 DB `qa_case_1`~`qa_case_14`, 서로 다른 backend PID의 실행 세션 A/B와 observer 세션을 사용했다. `pg_stat_activity`, `pg_blocking_pids`, server log로 실제 대기를 관찰했다.
- 검증 대상: `supabase/migrations/20261027112354_aug_sep_reclose_corrections.sql`, 수정 없음. 현재 로컬 main/GitHub 기준 `823af4e`와 파일 diff 0. 작업 브랜치는 기존 `codex/20261027-aug-sep-ledger-corrections-01`을 `baba-start --resume`으로 재개했다.
- 테스트에 사용한 파일의 SHA-256: `1afa18682ea2b407691ff9190e65b3aeaeace98ccfd8ab752e900d1fe1ed9b63`.
- `823af4e`는 기존 구현 뒤에 7월 정리 문서만 추가한 커밋이다. 이 문서를 `git show`로 확인했으며 승인 없는 Git 통합은 하지 않았다.
- 신규 파일: `tests/ledger-aug-sep-reclose-postgres.test.mjs`, `tests/helpers/ledger-aug-sep-reclose-native-fixture.mjs`, 본 보고서, M단계 인계서. 기존 PGlite 테스트·Migration·앱 코드는 수정하지 않았다.

## 요청 조건별 결과

| 조건 | 결과 | 실제 관찰 |
|---|---|---|
| 1. 같은 월 동시 호출 | PASS | 8월 및 9월 각각 advisory wait 관찰. 첫 호출 C1 1건/C2·C3 2건 및 R1 1건, 대기 호출 정정 신규 0/R1 신규 0. 감사도 중복 없음 |
| 2. 정정 vs close/reopen | PASS, fixture 범위 | 정정 선행 시 close 대기 후 성공. close 선행 시 정정 대기 후 `LEDGER_MONTH_CLOSED`, 신규 행 0. reopen 선행 시 대기 정정이 committed reopened 상태를 읽음. closed 정정 실패 후 rollback 경계와 대기 reopen도 검증. 해당 DB들의 교착 0 |
| 3. 일반 writer 충돌 | PASS; R1 동시 writer는 FAIL | 일반 INSERT가 relation lock에 대기한 뒤 실행되고, 테스트 지급 rollback 후 원거래·movement 완전 동일. source writer가 먼저 금액을 바꾸면 대기 정정은 `RECLOSE_SOURCE_DRIFT: 2191`, 정정/R1/감사 0. writer 결과를 덮지 않음. 별도 R1 역순 잠금은 `40P01` 재현 |
| 4. lock_timeout=5s | PASS | 쓰기 전 relation lock 만료 5,017ms, R1 감사 단계까지 진행한 뒤 만료 5,014ms. 둘 다 `55P03`, 정정·R1·각 감사 신규 0, 보호 자료 동일 |
| 5. 실패 후 재실행 | PASS | 두 timeout 후 재실행 1세트, 추가 재실행 신규 0. C3 실패로 C2와 감사가 rollback된 후 대기 호출이 1세트만 commit. deadlock 후 재시도도 중복 0·movement/원거래 보존 |
| 6. 설치·보안 | PASS | SECURITY DEFINER=true, owner=postgres, search_path=`pg_catalog, public`, lock_timeout=`5s`, PUBLIC EXECUTE 없음, anon/authenticated 실제 호출 `42501`, service_role 실제 호출 성공 |
| 7. 이력 등록 | 절차 확정, 로컬 모델 PASS | 같은 신규 버전의 두 등록 세션을 version advisory lock으로 직렬화, 이력 1행만 생성. 같은 버전 다른 SQL은 mismatch 판정 및 rollback. 운영 history에는 미접속 |

5초 후반부 검증은 **테스트 전용** AFTER INSERT audit trigger를 사용한다. R1 `recurring_expense_created` 감사 INSERT 다음에 별도의 테스트 gate 테이블에 쓰게 하고, A가 해당 gate의 SHARE lock을 유지한다. B는 C2·C3, 정정 감사, R1 행과 R1 감사까지 쓴 뒤 이 gate에서 실제 5초 만료를 받는다. 관찰 세션과 실패 후 조회 모두 해당 호출의 커밋된 행은 0이며, gate 해제 후 재시도는 정확히 1세트다. 이 trigger/table은 독립 테스트 DB에만 존재한다.

## 재현된 교착과 실행 제한

실제 기존 R1 함수의 prefix lock 이름을 사용해 다음 스케줄을 결정적으로 만들었다.

1. A가 트랜잭션을 시작하고 `hashtext('ledger_recurring:store-rent:2026-09')`의 xact advisory lock을 선점한다. 이는 기존 R1 sync가 거래 INSERT 전 획득하는 잠금과 같다.
2. B가 원본 정정 함수를 실행한다. B는 전체/month 마감 잠금과 `ledger_transactions`의 SHARE ROW EXCLUSIVE table lock을 얻고, C2·C3와 감사를 진행한다. R1에 진입한 뒤 A의 prefix lock에 대기한다.
3. A가 기존 `ledger_sync_recurring_expenses_v2`를 실행한다. 이미 가진 prefix lock은 재진입하지만 INSERT에 필요한 RowExclusiveLock이 B의 table lock과 충돌한다.
4. **B→A advisory 대기 / A→B table 대기** 순환이 생겨 PostgreSQL이 `40P01 deadlock detected`를 낸다. 최초 실행에서 피해자는 정정 B였다. server log에는 양쪽 SQL, backend PID 및 잠금 종류가 남았다. 통계 강제 flush 후 해당 DB의 deadlocks=1도 확인했다.
5. 피해 트랜잭션을 rollback하고 잔여 세션을 정리한 뒤 정정을 재실행했다. 최종 C2·C3 2건, R1 1건, correction_created 2건, recurring_expense_created 1건이며 원거래·movement는 기준선과 동일했다.

따라서 `lock_timeout=5s`가 교착을 예방한다는 주장은 성립하지 않는다. deadlock detector는 그보다 먼저 `40P01`을 낼 수 있다. **R1 sync를 포함한 장부 writer를 중지하고 이미 진행 중인 트랜잭션까지 배출한 유지보수 구간에서만 현 함수 실행을 검토한다.** writer 중지를 보장할 수 없다면 Migration 실행은 보류하고, 별도 후속 변경에서 실제 writer와의 잠금 순서를 통일한 뒤 다시 다중 세션 검증해야 한다. 이번 요청은 검증이므로 원본 Migration이나 기존 R1 RPC를 수정하지 않았다.

## SQL Editor 수동 설치와 단일 버전 이력 등록 절차

대상은 **20261027112354 / aug_sep_reclose_corrections 한 건만**이다. 과거 수동 적용분 전수 조사·재실행·일괄 이력 등록·CLI repair/db push는 하지 않는다.

1. 실행 전 승인본 SQL 및 파일 해시, 함수 인자, 설치만 수행한다는 점(회계 DML 호출 없음), owner·search_path·revoke/grant를 확정한다. 설치 직전 이 버전의 history 및 해당 함수 존재 여부만 확인한다.
2. **함수 없음 + 이력 없음:** 승인 후 사용자가 SQL Editor에서 원본 Migration 전체를 한 트랜잭션으로 실행한다. 함수 설치와 owner/revoke/grant를 부분 성공으로 남기지 않는다. 마지막 SELECT/RPC로 정정을 호출하지 않는다.
3. **함수 있음 + 이력 없음:** 재설치하지 않는다. 사용자의 실제 실행 SQL 증거와 승인본, `pg_get_functiondef`, 인자·소유자·ACL·proconfig를 비교해 설치 완료인지 확인한다. 누락·불일치는 이 함수 범위만 조사하고 중단한다. 원본은 `CREATE FUNCTION`이므로 재실행 시 `42723`이며 로컬에서 기존 함수·회계 행 보존을 검증했다.
4. **이력 있음:** 동일 버전의 name/statements와 실제 설치 객체를 대조한다. 동일하면 설치와 등록 모두 건너뛴다. 내용이 다르거나 객체가 없으면 해당 버전 충돌로 중단한다. 기록을 덮거나 `CREATE OR REPLACE`로 맞추지 않는다.
5. 사용자가 설치 완료를 통지한 후에만 연결 도구로 결과를 검증한다. 운영 history의 실제 컬럼/기존 row 형식을 해당 버전 범위에서 먼저 확인한다. 이번 로컬 테스트는 표준 `version text PRIMARY KEY, statements text[], name text` 모델이며 운영 테이블 구조를 새로 조회한 것은 아니다.
6. 검증 통과 후 이력이 없다면, **한 트랜잭션**에서 `pg_advisory_xact_lock(hashtext('baba_migration_history:20261027112354'))`를 잡고 다시 조회한다. 승인·실행된 SQL을 statements에 보존해 `INSERT ... ON CONFLICT(version) DO NOTHING`으로 해당 1행만 등록한다. 이후 존재 row의 name과 승인 SQL을 다시 비교하며, 불일치면 예외/전체 ROLLBACK, 일치하면 COMMIT한다. 새 설치 SQL을 재실행하지 않는다. SQL 문자열의 단순 포맷 차이는 설치 객체·실행 증거와 함께 검토하고 기존 이력을 임의 수정하지 않는다.
7. 커밋 후 같은 버전 1행, 함수 정의/인자/소유자, PUBLIC·anon·authenticated·service_role 권한을 다시 검증한다. 함수 설치만으로 신규 회계 거래·movement·정정 감사가 생성되지 않았는지도 확인한다. Advisor는 운영 설치 승인·완료 후 별도 검증한다. 정정 실행·재개방·재마감 승인은 설치/이력 승인과 별개다.

로컬 등록 실험은 두 세션이 각각 BEGIN → 같은 version advisory lock → 단일 버전 INSERT ON CONFLICT → name/statements 비교 → COMMIT하는 방식으로 1행을 확인했다. 불일치 요청은 ROLLBACK했고 기존 statements는 바뀌지 않았다. 이 실험이 운영 이력 등록 권한이나 원격 실행을 뜻하지 않는다.

## 재현 및 증거

```powershell
$env:QA_POSTGRES_BIN = 'C:/workspace/baba-staff-app/.tmp/production-preflight/node_modules/@embedded-postgres/windows-x64/native/bin'
node --import ./scripts/agent/lib/offline-guard.mjs --test --test-concurrency=1 tests/ledger-aug-sep-reclose-postgres.test.mjs
```

결과를 환경 변수 누락에 의한 SKIP로 오인하지 않도록 실제 출력의 PostgreSQL 버전과 skip=0을 확인한다. 테스트 도우미는 PG*/.env/운영 URL을 로드하지 않고 고정된 local-only 설정을 사용한다. 전체 `baba-verify`에서도 같은 바이너리 변수와 오프라인 가드를 사용한다.

직접 검증은 2회, 각 15 PASS/0 FAIL/0 SKIP다. 두 번째는 offline guard를 적용했다. 두 번 모두 자체 클러스터 정상 종료·소유권 검증·생성한 데이터 디렉터리 정리를 완료했고 기존 클러스터/로그는 삭제하지 않았다. 최종 baba-verify 재실행의 버전·테스트 수·기준선 오류 및 인계서 검사는 M단계 인계서에 기록한다.

두 번째 실행 증거:

- UUID `3733bbcb-93bf-4943-b7c3-2848f91278f4`.
- `.qa-review/pg-native-logs/pg-native-test-3733bbcb-93bf-4943-b7c3-2848f91278f4-k080s8/`의 server.log, commands.json, diagnostics.json, result.json.
- server.log SHA-256 `1869a6803f0dba52765245d48876964fc91323c478a08179f3d31f1bbaee9f29`.
- `.tmp-baba/m-native-postgres/results.json`: 실행 시 갱신되는 로컬 요약. 각 시나리오 DB명·세션 PID·wait_event/blocking PID·SQLSTATE·timeout 측정값·cleanup 상태를 기록한다. 위 UUID의 원본 서버 증거는 후속 실행과 별도로 보존된다.

## 한계 및 최종 승인 상태

- 실제 PostgreSQL의 잠금·트랜잭션·권한·원본 함수 실행을 검증했지만 운영 전체 스키마를 복제하지는 않았다. 실제 close/reopen/recurring/month guard 본문을 설치했고, close preflight는 로컬 stub이다. 전체 앱 blockers와 summary snapshot 생성, 사용자 UI는 검증 범위 밖이다. 미납금·준비금·카드 보호 테이블도 sentinel fixture이며 원거래·movement는 기존 캡처 값을 사용한다.
- 운영의 실제 PostgreSQL 버전·환경·현재 이력·Advisor는 조회하지 않았다. 사용자가 알려준 미설치 상태와 Git `823af4e`의 대상 파일을 기준으로 조사했다.
- 7월 카드 비용 82,596.578₫은 `823af4e:docs/reports/20261027-july-ledger-cleanup-items.md`에 **7월 후속 정리 대상이며 8·9월에 가산하지 않는 원칙**으로 기록된 것을 확인했다. 이전 인계의 미확정 상태를 그대로 반복 차단하지 않는다. 7월 공식 반영 방법/시점은 해당 별도 작업의 잔여 사항이다.
- **설치만:** 독립 PostgreSQL에서 기술적 설치 PASS. 운영 설치는 여전히 별도 사용자 SQL Editor 승인·실행 및 사후 검증이 필요하다.
- **정정 실행/재마감:** R1 writer와 교착 가능성이 확인됐으므로 무중단 실행은 불가. writer 중지·진행 중 트랜잭션 배출, fresh snapshot 및 실제 preflight 확인, 별도 운영 승인이 남았다. 필요하면 잠금 순서를 개선하는 별도 후속 작업을 수행한다.
- 이번 작업은 로컬 검증 결과만 보존한다. main 통합·push·Production 배포와 운영 SQL 실행 승인은 없으며 모두 미실시다.
