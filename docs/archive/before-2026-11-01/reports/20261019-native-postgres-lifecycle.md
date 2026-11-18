# PostgreSQL 테스트 클러스터 수명주기 개선 검증 — 2026-10-19

이번 변경은 로컬 테스트 도우미와 호출부, 안전성 테스트, 읽기 전용 잔여 조회에 한정한다. 운영 DB·Supabase·Vercel 작업, Migration 생성/수정, 비즈니스 로직 변경, commit/push/배포는 하지 않았다.

## 기존 구조와 누적 원인

`inventory-native-postgres.mjs`는 `.qa-review/pg-native-test-*`를 `mkdtemp`로 생성하고 `initdb`와 PostgreSQL을 실행한다. 정상 종료 시 클라이언트 연결과 PostgreSQL은 닫지만 데이터 디렉터리를 삭제하지 않는다. `Database`는 같은 클러스터 안에 `qa_case_N` DB를 계속 생성하므로, 여러 시나리오를 실행하면 base와 WAL이 커진다.

직접 호출부는 재고 원자적 수정, 재고 안전 정정, 시간제 추가근무 동시성, POS 결제 조정, POS Migration CLI 테스트의 5개 파일이다. 각 최상위 테스트가 클러스터 하나를 만들고 하위 시나리오에서 재사용한다. 호출부는 순차 하위 테스트를 사용하며 클러스터 종료 뒤 DB를 다시 읽지 않는다. 서로 다른 테스트 파일은 별도 프로세스로 병렬 실행할 수 있다.

기존에는 initdb·포트 예약이 try 바깥에 있고, 일부 호출부의 초기 fixture 생성도 finally 바깥에 있었다. 테스트 타임아웃 전용 훅이 없으며, 종료 실패 시 server.kill() 예외가 원래 실패를 가릴 가능성도 있었다. 직접 호출한 pg_ctl 이외의 CLI 자식 프로세스도 도우미에서 추적하지 않았다.

변경 전 도우미의 별도 기준 실행은 1/1 통과했지만 데이터 디렉터리가 남았다. 그 기준 자료는 소유권 표식이 없는 과거 형식이므로 자동 정리 대상으로 재분류하지 않고 보존했다.

## 변경 범위와 핵심 로직

- `tests/helpers/inventory-native-postgres.mjs`: 기존 공개 import 경로를 유지하는 재노출 모듈.
- `tests/helpers/native-postgres-lifecycle.mjs`: 소유권·연결·프로세스·증거·정리 상태 관리.
- 기존 호출부 5개: `{testContext:t}` 전달. POS CLI 호출부는 `trackChild`로 자체 CLI 자식도 등록한다.
- `tests/native-postgres-lifecycle.test.mjs`, `tests/helpers/native-postgres-lifecycle-child.mjs`: 실 PostgreSQL 및 격리된 Node 테스트 작업자로 안전성과 원래 종료 코드를 검증.
- `scripts/report-native-postgres-leftovers.mjs`: 읽기 전용 잔여 자료 조회. 삭제·프로세스 종료 기능 없음.

공개 `Database`, `connect`, `version`, `dir`, `stop` 사용 방식은 유지한다. 매 실행에 UUID와 고유 디렉터리를 부여하고 서버 cluster_name에도 UUID를 지정한다. 연결은 명시적인 127.0.0.1·동적 포트·고정된 테스트 전용 비밀번호·SSL 비활성 설정만 사용한다. .env 파일이나 DB URL을 읽지 않고 PostgreSQL 자식 환경에 PG* 설정과 운영 자격 증명을 전달하지 않는다.

정리는 원래 생성한 디렉터리의 절대 경로, realpath, 정확한 inode, 메모리에 보관한 UUID 소유권과 데이터/로그 폴더의 동일한 표식을 모두 확인한다. 연결을 닫고, 살아 있는 자신 소유 ChildProcess와 postmaster.pid가 일치할 때만 그 디렉터리의 pg_ctl fast stop을 실행한다. PG PID 숫자만으로 다른 프로세스를 종료하지 않는다. 서버의 close 이벤트·정상 종료 코드·정상 종료 로그·PID 파일 제거·클라이언트 및 등록 자식 종료를 함께 확인한다.

삭제 직전에는 링크·정리 잠금·실행 중 프로세스/자식·PID 파일·로그 해시를 다시 검사한다. 정리 Promise와 배타 생성 잠금 파일로 중복 정리를 막는다. 검사 실패, 종료 실패, 증거 보존 실패 시 디렉터리를 남기고 진단 결과를 반환한다. 다른 클러스터를 강제로 종료하는 fallback은 없다.

## 종료 상황별 동작과 증거 정책

| 상황 | 동작 |
|---|---|
| 정상 종료 | 기존 finally의 stop에서 연결·서버를 닫고, after에서 최종 결과 보존 후 데이터 삭제 |
| 테스트 실패 | afterEach/after에서 원래 오류·스택·하위 테스트 오류 기록, 로그 보존·검증 후 정상 종료된 데이터 삭제; 원래 예외/종료 코드를 바꾸지 않음 |
| 테스트 타임아웃 | signal로 종료를 시작하고 별도 after 훅에서 기다림; 진행 중 쿼리는 fast stop으로 해제; 타임아웃 실패 상태 유지 |
| 서버/연결/자식 종료 실패 | 증거를 남기고 데이터 보존, 실패 원인을 별도로 보고; 임의 서버 kill 없음 |
| 강제 종료 등으로 훅 미실행 | 남은 디렉터리는 조회 명령이 보고만 함; 다른 실행이 자동 삭제하거나 서버를 종료하지 않음 |
| 소유권·종료 상태 불확실 | 소유권 불명 또는 active-or-uncertain으로 표시하고 보존 |

정상·실패 모두 `.qa-review/pg-native-logs/<클러스터 디렉터리명>/`에 owner.json, server.log, commands.json, diagnostics.json, result.json을 보존한다. 서버 로그·명령 출력·원래 테스트 오류/스택·종료 상태·SHA-256을 남긴다. 필요한 증거 파일은 쓰기 후 다시 읽어 해시를 확인한 뒤에만 데이터 삭제를 허용한다. 초기화/강제 종료로 result.json이 없는 자료도 있을 수 있으며 이때 데이터는 자동 삭제하지 않는다. 보존 기한에 따른 자동 로그 삭제는 추가하지 않았다.

Node의 after/error/signal은 [Node 테스트 문서](https://nodejs.org/docs/latest-v24.x/api/test.html), fast/wait 종료 의미는 [PostgreSQL 17 pg_ctl 문서](https://www.postgresql.org/docs/17/app-pg-ctl.html)를 확인했다. pg_ctl 성공이나 PID 파일 하나에만 의존하지 않고 추가 종료 증거를 요구한다.

## 검증과 기존 오류

- 실제 PostgreSQL 17.6의 수명주기 안전성 17개와 기존 재고 원자적 수정 10개: 최종 27/27 통과, 실패·취소·스킵 0. 정상·실패·타임아웃, 종료 명령 실패, 소유권 변조, PID 불일치, 로그 보존 실패, 외부 링크, 중복 정리, 실행 중 자식, 병렬 격리, 잔여 보고, 반복 실행을 검증한다.
- 기존 장부 동시성: 새로 소유한 로컬 클러스터에서 5라운드로 세부 시나리오 총 90회 수행. deadlock 및 중복 후보/거래/이동/미지급금 0, 권한·함수 속성·트랜잭션 rollback 검사 PASS, 종료 후 해당 데이터 삭제.
- 장부 회귀: 변경 전 기록과 동일하게 357개 중 355 통과, 2 실패, 스킵 0. 기존 실패는 `Ledger review card hides raw projection codes and log IDs in operator text`, `opening balance and payable selection UI preserve one-request allocation payment`다.
- 변경된 모든 JS 테스트/스크립트의 ESLint 통과.
- 안전 정정·추가근무·POS 결제 네이티브 테스트는 아래 기존 파일명 불일치로 제한됨. 원본 테스트/사전 보존 목록에서도 동일한 참조와 파일명을 확인했으며 이 작업에서 수정하지 않았다. 이 3종은 최종 동시성 전체 통과로 주장하지 않는다.

| 테스트가 요구하는 파일 | 현재 실제 파일 |
|---|---|
| 20261011161314_safe_same_day_inventory_correction.sql | 20261011165833_safe_same_day_inventory_correction.sql |
| 20261017072217_part_time_early_extra_work_october.sql | 20261017082432_part_time_early_extra_work_october.sql.sql |
| 20261016170140_fix_pos_payment_snapshot_replacement.sql | 20261016180852_fix_pos_payment_snapshot_replacement.sql |

POS Migration CLI 통합 테스트는 Migration 작업 및 임시 Migration 파일 생성을 피하기 위해 실행하지 않았다. 호출부 변경은 정적 검사하고, 일반 등록 자식 프로세스의 종료 전 데이터 보존 동작을 별도 실 프로세스로 검증했다. Next 앱 소스 변경이 없어 이번 작업에서 빌드/개발 서버 재시작은 하지 않았다.

초기 검증 중 Windows Node 작업자가 3221226505로 두 차례 비정상 종료했다. 해당 데이터에는 종료 확인 증거가 없어 보존했다. 타임아웃에서 임시 상태 로그가 최종 결과를 덮을 수 있는 경합도 발견해, 최종 증거 쓰기를 after 훅 한 곳으로 모았다. 이후 기본 프로세스 격리 방식의 정상/실패/타임아웃 검증이 통과했다. 초기 Windows 작업자 종료의 원인까지 규명했다고 주장하지 않는다.

## 잔여 자료와 추가 누적 위험

정상 반복 3회에서 실행별 새 데이터 디렉터리 잔여는 0개이며 작은 로그만 보존한다. 이미 불확실하게 남아 있던 자료의 수는 증가하지 않았다. 최종 잔여 조회와 용량 수치는 아래 로컬 검증 JSON에 기록한다.

- 기존 소유권 불명 스모크 자료 2개: 보존.
- 초기 작업자 비정상 종료로 남은 이번 검증의 자료 2개: active-or-uncertain으로 보존.
- 변경 전 원본 도우미 기준 실행 자료 1개: 소유권 불명으로 보존.
- 초기 잠금/늦은 자식 경합 실험에서 보존된 새 자료 1개: owned-review-candidate로 보존. 이후 자신의 잠금만 해제하도록 수정하고 같은 검증이 통과했다.
- 정상 종료한 새 도우미 실행의 데이터: 잔여 0개.

따라서 총 잔여는 6개이며, 이 중 자동 정리 성공 후 새로 누적된 정상 실행 데이터는 없다. 기존 자료를 삭제하거나 새 표식을 붙여 자동 정리 대상으로 승격하지 않았다.

추가 위험: standalone `inventory-ledger-concurrency.mjs`는 호출자가 제공한 로컬 클러스터에 inventory_lock_test_* DB를 만들고 DROP하지 않는다. 이번에는 새 도우미가 소유한 클러스터에 넣어 실행하여 전체 데이터가 정리됐지만 기존 외부 실행 방식은 별도 관리가 필요하다. POS CLI의 `.tmp/pos-payment-cli-*` 작업공간, 수동 `.qa-review/october-settlement/pg-data`, 기존 `.tmp/production-preflight` 및 브라우저 검증 자료는 이번 자동 정리 대상이 아니다. 새 로그도 자동 만료하지 않으므로 장기 보존 정책은 별도 판단이 필요하다.

과거 26개 클러스터 데이터 약 6.41GiB가 남던 실행 패턴은 정상 정리가 완료되면 같은 데이터 잔존을 피한다. 실제 기본 반복 검증에서는 실행당 약 4~5KiB의 로그·메타데이터만 남았으며, 실패 사례나 SQL 진단이 많은 테스트는 더 커질 수 있다. 종료를 증명하지 못한 자료는 용량 절감보다 보존을 우선한다.

## 실행과 근거

```powershell
$env:QA_POSTGRES_BIN = (Resolve-Path '.tmp/production-preflight/node_modules/@embedded-postgres/windows-x64/native/bin').Path
node --test --test-concurrency=1 tests/native-postgres-lifecycle.test.mjs tests/inventory-atomic-edit-postgres.test.mjs
node scripts/report-native-postgres-leftovers.mjs
```

로컬 검증 자료: `.tmp/native-postgres-lifecycle-20261019/` 아래 `final-safety-and-inventory.log`, `ledger-concurrency.log/json`, `ledger-regressions.log`, `native-regressions.log`, `baseline-worker.log`, `lifecycle*.log`, `verification-summary.json`, `leftovers.json`. 새 서버별 증거는 `.qa-review/pg-native-logs/`에 있다. 이전 용량 정리의 보존 로그·감사 자료는 변경하지 않았다.

최종 보호 검증: 이전 보존 스냅샷과 기존 파일 40,291개를 SHA-256 대조했으며, 승인된 기존 테스트 6개 외 예상 밖 변경·삭제는 0개다. 기존 Migration, 환경변수, 운영/비즈니스 소스, Git 이력, 기존 보고서와 회계 스냅샷을 포함한다. 신규 파일은 테스트/보고 도구와 이 보고서뿐이다.

최종 UUID 디렉터리 형식으로 생성해 삭제를 완료한 126개 기록의 서버 로그/diagnostics/result 해시는 모두 일치했다. 초기 타임아웃 경합 실험의 이전 형식 자료 pg-native-test-5bTcnp 1개에는 로그와 result 해시 불일치가 남아 있으며 그 자료도 보존했다. 최종 코드에서는 임시 stop에서 증거를 덮어쓰지 않고 after에서 한 번 기록하며, 동일 타임아웃 회귀가 통과했다.
환경 분리 검증에는 실제 자격 증명이 아닌 가짜 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD/PGOPTIONS/PGSSLMODE를 자식 테스트 환경에 넣었다. 연결 대상은 여전히 소유한 127.0.0.1 클러스터이며, 테스트 전용 비밀번호와 옵션으로 환경값 대체를 막는다. 운영 환경변수 파일이나 운영 설정은 변경하지 않았다.

기존 실패가 있는 경우 정리 실패는 진단으로 추가해 원래 실패를 덮지 않는다. 반대로 테스트 본문이 성공했는데 정리가 불완전하면 after 훅은 정리 오류를 명시적으로 실패 처리해 누적을 숨기지 않는다. 등록된 늦은 자식과 잠금 해제 회귀에서도 이 경로를 검증했다.

최종 측정 시각: 2026-10-19T08:48:16.483Z. 보존한 6개 데이터 디렉터리는 총 236.59 MiB, 이번 검증에서 생성한 서버별 로그/메타데이터 전체는 1120.74 KiB다. 정상 성공 실행의 새 데이터 잔여는 0개다. PostgreSQL 프로세스는 발견되지 않았으며, PID 파일이 남은 불확실 자료는 이 관측만으로 종료를 단정하지 않았다. 기존 개발 서버 PID 18556은 유지했다.
