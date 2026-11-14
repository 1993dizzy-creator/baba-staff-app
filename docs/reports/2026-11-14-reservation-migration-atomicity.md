# 예약 Migration 2 원자성 수정 및 PostgreSQL 17.6 검증

## 완료 범위와 운영 경계

Codex `codex/reservation-phase1-hardening-20261114`에서 정식 Migration 2를 수정했다. PostgreSQL 17.6 격리 DB와 실제 Supabase CLI 3.1.0으로 후보를 먼저 검증한 뒤 정식 파일에 동일 바이트를 반영하고 다시 검증했다. Main·Claude 소스, Migration 1, 운영 DB 구조·데이터·이력은 변경하지 않았다. Main 병합, Push, 배포 및 Webhook 변경은 수행하지 않았다.

운영 이력 분석은 `db query --read-only`의 메타데이터 SELECT와 `db push --dry-run --skip-vault`만 사용했다. 격리 테스트의 `migration up --yes`는 새로 만든 127.0.0.1 PostgreSQL 클러스터만 대상으로 하며 호스트를 assert한다. 운영 자격 증명·환경변수는 테스트 자식 프로세스에 전달하지 않는다. 테스트 데이터는 모두 합성 데이터다.

## 결함과 정확한 수정

수정 파일: `C:\workspace\baba-wt-codex\supabase\migrations\20261114120001_reservation_phase1_hardening.sql`

CLI 3.1.0은 최상위 BEGIN/COMMIT이 있는 파일을 순차 실행하고, SQL 실행 완료 후 Migration 이력을 INSERT한다. 원본은 COMMIT이 먼저 완료되므로 이력 INSERT 실패 시 실제 변경만 남았다. PostgreSQL 17.6에서도 원본을 사용해 이 상태를 재현했다.

수정은 아래 경계만 바꾼다. 예약 RPC·권한·데이터 guard의 본문은 바꾸지 않는다.

```diff
-begin;
+do $reservation_hardening$ begin
+set local lock_timeout = '5s';
 lock table reservation_private.inbox, reservation_private.reservations,
   reservation_private.reservation_table_links, reservation_private.reservation_events in access exclusive mode;
 ...
-commit;
+end $reservation_hardening$;
```

단일 DO 문과 CLI의 이력 INSERT가 같은 트랜잭션 배치에 포함된다. 이력 INSERT 실패 시 DO 문이 수행한 DDL·함수·권한 변경도 롤백된다. 5초 timeout은 각각의 잠금 획득 대기에 적용되며 Migration 전체 실행시간 상한이 아니다. `SET LOCAL`은 배치가 끝나면 해제된다. BEGIN/COMMIT 단순 제거는 LOCK TABLE 실행 계약을 만족시키지 않아 채택하지 않았다.

## SQL 해시 이력

| 대상 | SHA-256 |
|---|---|
| Migration 1, 변경 없음 | `617978a504765da97008d711265575b09d9d0a5d43b2a5c3967d8ebfcaa77f68` |
| Migration 2, 변경 전 | `a684d07d46e22e5f2d709cef4deb0aa404d70da5c9e345b39152f1f569f63eb9` |
| Migration 2, 변경 후 | `da08303cf2f233c74fecdd11dcc747cf62d8e61b6d779ef3c28ce262eba4ed39` |

변경 후 파일은 이전 감사의 `candidate-hardening.sql` 및 CLI가 정상 시나리오에서 실제 읽은 SQL과 바이트 단위로 같다. 이전 `.local/migration-final-safety/` 증거는 보존했다. 이번 변경 전 SQL·해시·diff는 별도 `.local/reservation-migration-atomicity/`에 보관한다.

## 실제 검증 결과

격리 환경은 PostgreSQL **17.6 x86_64 Windows**, CLI **3.1.0**이다. 운영은 17.6 aarch64 Supabase이므로 OS·아키텍처와 hosted 역할 환경까지 같다는 주장은 하지 않는다. 바이너리는 고정 버전 `@embedded-postgres/windows-x64@17.6.0-beta.15`를 사용했다.

`tests/reservation-migration-atomicity-postgres.test.mjs`: 후보 8/8, 정식 파일 8/8 PASS. 아래 7개 시나리오와 부모 테스트를 Node가 8개로 집계한다.

| 시나리오 | 실제 결과 |
|---|---|
| Migration 1 → 수정 Migration 2 | 성공, 이력 2건, 테이블 5개, public RPC 13개, UUID 27개 |
| Migration 2 중간 SQL 실패 | 전체 M2 객체 계약 롤백, 이력은 M1만 유지 |
| Migration 2 마지막 SQL 실패 | 마지막 권한 변경 뒤 주입한 오류까지 전체 롤백 |
| 이력 INSERT 실패 | CHECK 위반 `23514`; 새 catalog·컬럼·함수·ACL·인덱스·트리거 모두 M1 상태와 동일 |
| 잠금 경합 | 실제 `pg_stat_activity` Lock 대기 관찰, 약 5.069초 뒤 `55P03`, M2 전체 롤백 및 잠금 해제 |
| 기존 Inbox 1건 | `55000`으로 중단, 행 전체 JSON과 객체 계약 보존 |
| 원본의 결함 대조 | 동일 이력 오류에서도 catalog가 남고 M2 이력이 없는 상태 재현 |

성공 DB와 원본 M1+M2를 적용한 대조 DB의 다음 정보를 전체 비교했다: private schema ACL, 테이블·시퀀스 ACL/RLS, 정책, public/private 함수 정의와 ACL, 제약, 인덱스, 사용자 트리거, 컬럼. 동일했다. UUID는 앱의 `BABA_TABLES` 27개와 정확히 비교했다. 각 실패 시나리오도 M1 스냅샷과 비교하므로 catalog 존재 여부 하나만으로 롤백을 판단하지 않는다.

기존 회귀 검사 **69/69 PASS**:

```powershell
$env:BABA_RESERVATION_PG_BIN='.local/pg17-tools/node_modules/@embedded-postgres/windows-x64/native/bin'
node --experimental-strip-types --test --test-concurrency=1 tests/zalo-webhook-poc.test.ts tests/zalo-webhook-persist.test.ts tests/reservation-inbox-db.test.mjs tests/reservation-hardening-db.test.mjs tests/reservation-confirm-api.test.mjs tests/reservation-inbox-concurrency.test.mjs tests/reservation-phase2-api.test.mjs tests/reservation-phase2-client.test.mjs
```

포함 범위: 5개 역할 확정과 권한 비확대, 활성 로그인 인증, Staff 개인정보 제한, NULL·오래된 버전, 확정자·확정 시각·이력, 개인정보 purge, 실제 테이블 UUID·충돌 롤백, Inbox 중복 생성, Zalo 중복 수신·저장 실패 ACK, 03:00 영업일, 기존 API DTO·RPC 인자 계약.

실제 동시성 테스트도 17.6에서 실행했다. 기존 concurrency 테스트에 로컬 바이너리 경로 선택을 추가하고 PostgreSQL 프로세스 환경을 whitelist로 제한했다. 동일 버전 확정·수정·배정·해제, 시간대별 배정 충돌, Inbox/request key 경쟁을 검증했다.

변경된 테스트 파일의 ESLint와 `git diff --check`도 PASS. 앱 소스·의존성·RPC 계약·화면은 변경되지 않아 기존 TypeScript·Build·반응형 브라우저 검증 범위는 재사용한다. 이번에 UI/Production Build를 재실행했다고 보고하지 않는다.

## 운영 이력 차이 분석 — 변경하지 않음

읽기 전용 확인 시 운영 이력 165건, 원격 전용 3건, Codex 이력 미등록 SQL 75개, Main 추가 급여 SQL 2개로 Main은 77개다. Codex의 75개 중 45개는 추출한 CREATE 선언의 객체명이 모두 현재 존재한다. 17개는 일부 이름을 찾지 못했고, 13개는 분석 대상 CREATE 선언이 없다. 이 분류는 객체명 확인에 한정된다. ALTER·데이터 변경·동적 SQL·후속 대체 함수까지 적용됐다는 뜻이 아니며, 이를 근거로 repair나 재실행을 허용하지 않는다.

| 운영 전용 버전 | 이력 원문/대상 | 현재 확인 |
|---|---|---|
| 20260917094840 | `count_all_linked_meal_corrections`, 실제 statements 1개 | `ledger_adjust_open_meal_transaction_v1(bigint,numeric,text,bigint)` 존재. 로컬 20260917092710 SQL과 주석·공백 정규화 후 일치. 버전은 변경하지 않음 |
| 20260924135025 | `fix_employee_schedule_time_compare`, 실제 statements 1개 | `employee_update_profile_and_level_v9(bigint,jsonb,boolean,date,text,date,text,bigint,text)` 존재. 일치하는 로컬 원본/커밋 미확인 |
| 20260928142712 | `replace_sales_receipt_split_payment_rpc`, 실제 statements 1개 | `admin_update_paid_sales_receipt(bigint,bigint,uuid,text,text,text,numeric,text,numeric,jsonb,numeric)` 존재. 로컬 split-payment Migration과 동일하다고 단정하지 않음 |

세 건 모두 운영 `schema_migrations.statements`에서 원문 출처를 확인했다. 적용 실행자·도구·Git 커밋과 현재 함수 본문이 당시 SQL 그대로인지까지 확인한 것은 아니다. 2026-10-09·10 이력 감사 문서에도 이미 같은 세 버전이 기록돼 있다. 전체 이력 중 69건은 statements가 없지만 해당 버전의 실제 로컬 SQL 파일은 존재한다. 따라서 `migration fetch`만 일괄 사용하면 빈 원문 문제가 생기며, 빈 Migration으로 맞추는 방식을 사용하지 않는다.

## 예약 2개만 적용하는 방식의 검토 결과

CLI 3.1.0 `migration up`도 `db push`와 같은 이력 대조를 수행한다. `--file`로 특정 Migration만 선택하는 기능은 확인되지 않았다. 두 파일만 넣은 폴더로 바꾸는 것만으로 기존 이력 누락 검사를 통과하지 못한다. `db query --file`은 정상 Migration 이력 기록을 대체하지 않는다.

이번에는 **실행 방식 제안의 검증용**으로 다음 입력 스냅샷을 `.local/`에 구성했다. 새 Worktree나 정식 Migration 대체물이 아니다. 운영 실행 방식의 채택은 Owner의 별도 승인 대상이다.

1. 운영에 이미 기록된 165개 버전을 모두 포함한다. 162개는 같은 버전의 실제 로컬 원본 SQL을 복사하고, 원격 전용 3개는 실제 이력 statements에서 복원했다.
2. 이력 미등록 과거 SQL과 급여 SQL은 넣지 않는다. 검증된 정식 예약 Migration 2개만 추가한다.
3. 총 167개 파일의 출처와 SHA-256을 manifest에 기록한다. 빈 파일·가짜 버전·repair·이력 직접 INSERT는 사용하지 않는다.
4. 공식 `--workdir`로 이 입력을 지정하고 `db push --dry-run --skip-vault`를 실행했다. 환경파일·Vault·seed·roles 변경은 입력에 없다.

```powershell
npx.cmd --cache .local/npm-cache supabase@3.1.0 db push --dry-run --skip-vault --remote=yfjqwsdqhvnfqxywsqcz --workdir .local/reservation-migration-atomicity/proposed-execution-input
```

실제 exit 0 결과:

```json
{"dryRun":true,"migrations":["20261114120000_create_reservation_inbox_foundation.sql","20261114120001_reservation_phase1_hardening.sql"],"seeds":[],"roles":[]}
```

이 방식은 기존 운영 이력을 고치거나 과거 SQL을 실행하지 않고 예약 2개만 계획하는 것을 확인했다. 실제 적용은 하지 않았다. 실행 시 기존 적용 버전은 CLI가 건너뛰고 예약 SQL과 이력을 정상 runner가 처리한다. M1/M2는 파일별 트랜잭션이므로 M2가 실패하면 M1은 남는다. 이 상태에서 앱·Persist를 활성화하지 않는다.

향후 실행 전에는 입력 전체 manifest와 정식 파일 해시, 운영 165건 이력의 변경 여부, 예약 객체 부재/기존 데이터, Dry Run의 정확한 2개 계획을 다시 확인해야 한다. 하나라도 달라지면 중단한다. 특정 파일을 빼서 CLI 검사를 숨기는 방식으로 다른 작업에 일반화하지 않는다.

## 운영 적용 전 차단 조건

로컬 수정·격리 검증은 완료했지만 운영 적용은 **NO-GO 유지**다.

- 검증된 커밋의 Main 통합 및 운영 실행에 대한 별도 Owner 승인이 필요하다.
- 앞선 감사의 백업 목록은 비어 있고 PITR은 비활성 상태였다. 실제 백업 시점·복구 범위·격리 복구 증거를 이번에 확보한 것은 아니다.
- 예약 테이블 4개 ACCESS EXCLUSIVE 외에 FK 때문에 `public.users` SHARE ROW EXCLUSIVE 잠금도 필요하다. 직원 생성·수정 및 예약 유입을 조율해야 한다. 5초는 각 잠금 대기 제한이므로 전체 작업시간 기준도 별도 확정한다.
- 현재 배포 소스·필수 환경변수·Zalo Secret/Allowlist와 Observe/Persist 설정을 배포 전에 다시 확인한다. Push 자동 배포와 Migration 적용 순서가 뒤바뀌면 안 된다.
- 실패·연결 유실 후에는 이력과 객체 상태를 조회해 일치 여부부터 확인한다. 불일치나 기존 데이터가 있으면 재실행·repair·파괴적 롤백을 중단하고 Owner 판단을 받는다.
- 운영 전체 복구는 예약 외 급여·POS·회계의 이후 변경을 되돌릴 수 있다. 빈 예약 스키마 전용 롤백과 전체 복구를 구분한다. 롤백 SQL은 이력을 자동 정리하지 않는다.

## 보존한 증거

루트: `C:\workspace\baba-wt-codex\.local\reservation-migration-atomicity\`

- `candidate-pg17.log`: 정식 반영 전 후보 검증 8/8.
- `formal-pg17.log`, `pg17-MCxJqV\evidence.json`, `pg17-MCxJqV\postgres.log`: 정식 파일 8/8 및 SQL·이력·잠금 증거.
- `pg17-MCxJqV\contracts.json`: 객체·권한 계약 스냅샷.
- `regression-pg17.log`: 기존 회귀 69/69 및 동시성 PostgreSQL 버전.
- `sql-hashes.json`, `verified-artifacts.json`, `migration-2-before.sql`, `formal-migration-2.diff`: 변경 전후 해시와 실행 SQL 동일성.
- `history-analysis.json`: 75개 이력 미등록 파일의 객체명 대조와 원격 3건 원문 해시.
- `proposed-execution-input-manifest.json`, `proposed-two-only-dry-run.log`: 167개 입력의 출처·해시와 예약 2개만 제시한 읽기 전용 계획.
- 이전 감사의 실패한 후보·원본 결함·PostgreSQL 18.6 증거는 덮어쓰지 않았다.

참고: [CLI 3.1.0 migration runner](https://github.com/supabase/cli/blob/d4fc0e5bbd65b3ade802e956d6df1cddab2e65a3/apps/cli/src/command-internal/migration-apply.ts), [migration up 이력 검사](https://github.com/supabase/cli/blob/d4fc0e5bbd65b3ade802e956d6df1cddab2e65a3/apps/cli/src/commands/migration/up/up.handler.ts), [공식 CLI 문서](https://supabase.com/docs/reference/cli/supabase-db-push).
