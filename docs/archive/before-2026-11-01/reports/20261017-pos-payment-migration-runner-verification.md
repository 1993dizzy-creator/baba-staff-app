# POS 결제 Migration 실행기·잠금 순서 최종 검증 — 2026-10-17

로컬 검증 완료. Production 접속·적용·동기화·복구·마감·배포·commit/push는 수행하지 않았다. 기존 결제 교체 알고리즘, MD5 고정값, 함수 권한 및 관리자 보호 정책은 변경하지 않았다.

## 실행 방식과 수정 이유

저장소에는 고정된 CI Migration 실행 설정이나 루트 `supabase/config.toml`이 없으므로 과거 운영 적용 경로를 코드만으로 단정하지 않는다. 이번 운영 적용 검증 기준은 프로젝트에서 확인한 **Supabase CLI 2.81.3의 `db push --db-url`** 경로로 고정했다. 실제 검증에서도 그 바이너리를 실행했으며 실행기를 JavaScript로 모사하지 않았다.

해당 버전은 Migration 문장들과 `supabase_migrations.schema_migrations`의 이력 INSERT를 동일한 암묵적 트랜잭션 배치에 넣는다. `migration up`도 같은 ApplyMigrations 경로를 사용한다. 파일 내부 COMMIT은 실행기가 뒤에 붙이는 이력 기록보다 먼저 함수 변경을 확정할 수 있다. 따라서 신규 Migration의 최상위 BEGIN/COMMIT을 제거했다. 함수 내부 PL/pgSQL의 BEGIN/END는 그대로다.

근거: [CLI v2.81.3 Migration ExecBatch](https://github.com/supabase/cli/blob/v2.81.3/pkg/migration/file.go#L69), [db push 실행 경로](https://github.com/supabase/cli/blob/v2.81.3/internal/db/push/push.go#L79), [migration up 실행 경로](https://github.com/supabase/cli/blob/v2.81.3/internal/migration/up/up.go#L15).

최종 SQL은 MD5 사전검증 → 함수 교체 → owner/권한 설정을 포함하며, 그 전체와 이력 INSERT의 원자성은 위 실행기가 보장한다. SQL Editor에 문장별로 복사하거나 다른 실행기를 사용하는 방법은 이번에 검증한 적용 방법이 아니다. 다른 실행 방법을 선택하면 그 실행기의 트랜잭션/이력 관리부터 별도 검증해야 한다.

## 실제 CLI와 PostgreSQL 검증

전용 새 PostgreSQL 17.6 클러스터, 임의 포트, 127.0.0.1, 새 `qa_case_*` DB에서 실행했다. CLI도 별도 `.tmp/pos-payment-cli-*` 작업 디렉터리에서 실행하며, 기존 이력 1건이 있는 상황과 신규 pending Migration 1건을 구성했다. root 프로젝트 연결 설정이나 운영 자격증명을 사용하지 않는다.

테스트의 CLI 호출:

```text
<검증된 Supabase CLI 2.81.3 바이너리> db push --db-url <소유한 loopback qa_case_* URL> --workdir <격리 작업 디렉터리> --yes
```

테스트 코드가 호스트=127.0.0.1, DB명=qa_case_* 및 임의 포트를 검사한다. 전송용 `PGSSLMODE=disable`은 TLS가 없는 이 소유한 로컬 클러스터의 CLI 자식 프로세스에만 지정한다. 운영 연결 보안을 변경하는 설정이 아니다.

| 실제 실행기 시나리오 | 검증 결과 |
|---|---|
| 기준 해시 일치 | 함수/권한 정상 적용, 기존 데이터·인덱스 불변, 정확히 1건의 이력 추가 |
| 성공 후 CLI 재실행 | 이력을 보고 건너뜀. 함수·권한·데이터·이력 모두 불변 |
| 운영용 파일의 MD5 불일치 | SQLSTATE 55000으로 실패. 함수 전체 정의·owner·ACL·search_path·인덱스·데이터·전체 이력 보존 |
| 함수 교체/권한 설정 후 SQL 오류 주입 | 전체 정의·권한·데이터·이력이 원상 복구됨 |
| 마지막 이력 INSERT 오류 주입 | 앞서 성공한 함수·권한 변경도 롤백됨. 기존 이력 내용/행 수 불변 |
| 비교용 구버전 내부 BEGIN/COMMIT + 같은 이력 오류 | 함수 변경은 남고 이력은 추가되지 않는 분리 상태가 실제로 재현됨. 최종 Migration에는 이 내부 명령이 없음 |

권한 롤백 검사에서는 격리 DB의 기존 authenticated 권한을 의도적으로 다르게 만들어, 실패 후 ACL까지 원래 값으로 돌아오는지 관찰했다. 이는 테스트 전용 설정이며 운영 권한 변경이 아니다.

해시 검증의 한계는 이전 보고서와 같다. 운영 고정값 `e6f024dfeda8366453100e60bb023670`은 그대로다. 로컬 과거 함수의 바이트 정의는 다른 MD5이므로 운영용 파일 그대로의 **불일치 차단**을 검증했다. 성공 경로는 fixture에서만 로컬 초기 기준 해시를 대입한 SQL로 수행했다. 실제 운영 함수의 일치는 사용자가 제공한 교차검증 결과를 근거로 하며, 이번에 Production에서 시험 적용한 것은 아니다.

## 공백 RefID의 일관된 잠금 순서

ORDER BY를 `btrim(value->>'receiptRefId')`로 변경했다. 중복 검사와 실제 조회에 사용되는 공백 정규화와 같은 ID 순서로 receipt lock을 획득한다. 그 외 결제 계획/선택적 DELETE/UPDATE/INSERT와 보호 조건은 유지했다.

3개 영수증 a/m/z에 서로 다른 앞뒤 공백과 입력 순서를 가진 스냅샷을 두 세션에서 동시에 전달했다.

1. 첫 세션이 정규화된 a 영수증만 먼저 잠근다.
2. 둘째 세션은 원문 정렬이라면 z를 먼저 잠그는 입력을 받는다. 최종 SQL에서는 정규화 순서 때문에 a에서 먼저 기다린다.
3. `pg_blocking_pids`로 실제 대기를 확인하고, 별도 세션의 `FOR UPDATE NOWAIT`로 m/z가 아직 잠기지 않았음을 확인했다.
4. 첫 세션의 일괄 RPC가 완료된 뒤 둘째 세션은 그대로 성공한다. 둘째 결과는 변경 없음 3건, 결제 행 수 3건, deadlock 0이다.

단순히 첫 RPC가 모든 행을 잠근 뒤 두 번째 RPC를 시작하는 시험만으로 끝내지 않고, 첫 잠금과 후속 잠금 사이의 경합을 검증했다. 공백만 다른 동일 RefID의 중복 차단 검사도 그대로 통과했다.

## 최종 결과와 변경 파일

- 전체 관련 회귀 **207/207 통과**, 실패·skip 0.
- 네이티브 PostgreSQL 결제 검사 **47건**(상위 1개 포함).
- 실제 Supabase CLI 실행기 검사 **6건**(5개 시나리오 + 상위 1개).
- 스냅샷 계약 26건, 동기화/진단/마감 계약 28건, 기존 매출·수정·장부·마감 회귀 100건.
- 변경 TS/MJS 파일 ESLint 및 git diff --check 통과.
- 앱 TS 코드는 바뀌지 않았다. Production build 및 전체 tsc의 기존 오류 40개/신규 0개 비교는 이전 검증 결과를 유지하며 이번에는 반복하지 않았다.

이번 변경:

- `supabase/migrations/20261016170140_fix_pos_payment_snapshot_replacement.sql`: 최상위 트랜잭션 명령 제거, 정규화 ORDER BY.
- `tests/pos-payment-migration-cli.test.mjs`: 실제 CLI 적용·이력 실패/성공 및 과거 COMMIT 위험 재현.
- `tests/pos-payment-reconciliation-postgres.test.mjs`: 공백 포함 다중 영수증의 실제 잠금 경합 검사, 외부 트랜잭션 검사 조정.
- `tests/sales-payment-snapshot-reconciliation.test.ts`: 실행기 소유 트랜잭션·정규화 정렬 계약.
- 검증 보고서 갱신. 기존 적용 Migration과 앱 결제 알고리즘은 수정하지 않았다.

최종 로그: `.tmp/pos-payment-runner-final.log`; 단독 실제 CLI 로그: `.tmp/pos-payment-cli-runner.log`.

## 운영 적용 시 지킬 실행 계약 — 실행하지 않음

1. 실제 대상 함수의 MD5, 기존 전체 Migration 이력 및 현재 파일 목록을 대조한다. pending이 이번 검토 파일 1개인지 확인한다. 다른 pending/누락 버전이 있으면 중단하며 임의 repair 또는 `--include-all`로 우회하지 않는다.
2. 별도 운영 승인 후에만 검증한 CLI 2.81.3과 `db push --db-url` 경로를 사용한다. 실제 대상/자격증명은 접근 제한 설정으로 관리하고 코드·로그·Git에 넣지 않는다. include-seed/include-roles는 사용하지 않는다.
3. 파일에 BEGIN/COMMIT을 다시 넣지 않는다. 사전검증 또는 이력 기록까지 어느 단계든 실패하면 이 Migration의 함수/권한/이력 변경은 함께 롤백된다.
4. 성공 후 함수 정의·권한과 해당 버전 이력 1건을 확인한다. 실패 시 기존 정의·권한·이력이 보존됐는지 확인하고 원인을 검토한다. history 누락을 임의 수동 INSERT로 보정하지 않는다.
5. 이 검증은 운영 Migration/배포/복구/마감 승인이 아니다. 실제 10월 15일 복구·마감에는 이전 보고서의 별도 승인 및 최신 원본 대조 절차를 따른다.
