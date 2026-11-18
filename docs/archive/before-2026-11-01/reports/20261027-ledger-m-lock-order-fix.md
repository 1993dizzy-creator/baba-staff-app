# BABA M단계 — R1/정정 교착 수정

## 결론 및 변경 관리

기존 40P01 재현 스케줄을 수정 후 실제 PostgreSQL 17.6에서 그대로 실행해 **성공(00000), 교착 0건**을 확인했다. 원래 15개 검증은 모두 다시 실행했고, 추가 계획 변경·삼중 세션·prefix timeout·함수 drift 검증을 포함한 직접 실행은 **22 PASS / 0 FAIL / 0 SKIP**다. 모든 시나리오에서 통계 강제 flush 후 deadlocks=0을 확인했다. 40P01을 기대해 통과시키던 옛 테스트는 삭제하고, 발생하면 실패하도록 바꿨다.

원본 `20261027112354_aug_sep_reclose_corrections.sql`은 그대로 보존한다. 사용자 지시에 따라 미적용 Migration 수정 정책을 확인했으나 `baba-preflight`와 `baba-verify`는 운영 적용 여부와 무관하게 기준선에 있는 Migration 파일 수정을 금지한다. 정책·검증기를 우회하거나 Git 이력을 재작성하지 않고 **후속 Migration `20261027160650_fix_aug_sep_reclose_lock_order.sql`**을 추가했다. 기존에 적용된 SQL 파일, 기존 R1/close/reopen RPC는 수정하지 않았다.

최초 설치 시 원본 → 후속을 순서대로 한 트랜잭션에 설치하고, 후속의 검증 완료 전 정정 RPC를 호출하지 않는다. **원본 파일 단독 설치/실행은 여전히 보류**다. 두 파일 조합의 로컬 기술 검증은 PASS이며 운영 설치·재개방·재마감·Git 통합·push·배포는 실행하지 않았다. 운영 Supabase에는 접속하거나 SQL을 실행하지 않았다.

## 분석한 실제 잠금 순서

표의 순서는 사용자·입력 확인 이후의 주요 잠금이다. 일반 SELECT의 AccessShareLock도 R1 cursor와 계획 SHARE lock의 호환성 판단에 포함했다.

| 경로 | 주요 획득 순서 | 상대가 기다릴 수 있는 지점 |
|---|---|---|
| 기존 정정 | 전체 마감 advisory → 월 마감 advisory → closure 행 FOR UPDATE → 거래 SHARE ROW EXCLUSIVE → movements SHARE → payroll SHARE → plans SHARE → R1 prefix/month advisory → R1 거래/감사 | 거래 테이블을 가진 채 R1 prefix를 기다림 |
| 기존 R1 v2, 열린 월 → v1 | 월 상태 읽기 → plans cursor AccessShare, 활성 월계획 id 순회 → `ledger_recurring:<prefix>:YYYY-MM` advisory → 기존 거래 SELECT FOR UPDATE(RowShare + 행) → INSERT/UPDATE(RowExclusive) → 감사 INSERT | prefix를 가진 채 거래 RowExclusive를 기다림 |
| 기존 R1 v2, 닫힌 월 | 월 상태 읽기 → 활성 계획/기존 거래 읽기 → 필요 시 source drift 후보 기록 | 정정은 closed 가드에서 먼저 거부. 월 비용 동기화 행 생성 경로가 아님 |
| 계획 버전 생성 | `ledger_recurring_plan:<prefix>` advisory → 이전 계획 FOR UPDATE → plans RowExclusive로 종료/신규 버전 → 감사 INSERT | 기존 RPC는 거래 테이블이나 마감 advisory를 요청하지 않음 |
| close/reopen | `ledger_month_close_serial` advisory → 월 advisory → closure FOR UPDATE → preflight/이력/closure/감사 | 기존 정정과 동일 마감 순서. close가 선행하면 정정은 대기 후 closed 가드에서 거부 |
| month guard/assert | closure 상태 읽기(일반 SELECT) | 거래 writer에서 closure FOR UPDATE나 마감 advisory를 역으로 취하지 않음 |
| **수정 정정** | **전체/월 마감 advisory → closure FOR UPDATE → 계획 prefix advisory → plans SHARE → 계획 검증 → R1 prefix/month advisory → 거래 SHARE ROW EXCLUSIVE → movements SHARE → payroll SHARE → 정정/R1/감사** | 계획과 R1 prefix를 모두 선점한 후 거래 테이블을 잠금 |

검토 근거: 저장소의 `202608210007` 계획 생성, `20260916172211` 활성계획 R1 v1/v2, `202608210008` month guard/assert, `20260916161512` close/reopen 정의와 `app/api/admin/ledger/recurring-expenses/route.ts`의 독립 RPC 호출. 기존 R1 해시 일치 회귀도 함께 실행한다. 앱의 create_plan과 sync는 별도 RPC이며, 한 트랜잭션에서 임의로 조합하는 API가 아니다.

### 기존 교착과 수정 효과

기존 스케줄은 A가 R1 prefix advisory를 가진 뒤 B 정정을 시작하고, B가 거래 table lock을 얻어 A의 prefix에서 기다리는 동안 A가 R1 INSERT를 하는 것이다. **A는 B의 table lock 대기, B는 A의 prefix 대기**로 순환해 40P01이 발생했다.

수정 후 동일하게 A가 prefix를 선점해도 B는 거래 table lock을 얻기 **전** prefix에서 기다린다. 관찰 세션의 pg_locks에서 이때 B가 거래 SHARE ROW EXCLUSIVE를 갖지 않은 것을 확인했다. A의 실제 R1 함수가 INSERT·감사를 완료해 COMMIT하면 B가 이어서 정정하고, R1은 이미 존재하는 50M 한 건을 확인한다. 최종 C2·C3 2건/R1 1건, 정정 감사 2건/R1 감사 1건이다. 재실행 신규 0이며 원거래·movement는 그대로다.

### R1 잠금만 앞으로 옮기지 않은 이유

계획 테이블을 늦게 고정하면 계획 변경이나 여러 활성 계획 때문에 정정이 예상하지 못한 다른 prefix를 R1에서 뒤늦게 얻을 수 있다. 그래서 먼저 계획 생성 RPC와 같은 `ledger_recurring_plan:store-rent` advisory를 획득하고 전체 plans SHARE로 계획 집합을 고정한다. **기존의 동일한 R1 계획 조건과 해당 월 활성 monthly 계획 1개 조건을 거래 lock 전에 검증**한 다음 정확한 `store-rent` 월 prefix를 획득한다.

- 같은 prefix 계획 변경 선행: 정정은 plan advisory에서 대기한다. 계획 변경 RPC는 거래/마감 잠금을 요구하지 않아 완료 가능하고, 커밋 후 정정은 변경된 계획을 재검증해 `RECLOSE_RENT_PLAN_DRIFT`로 쓰기 없이 중단한다.
- 정정 선행: 같은 prefix의 계획 변경은 advisory에서, 다른 prefix의 변경은 plans SHARE에 대한 RowExclusive에서 대기한다. 정정은 상대 prefix를 필요로 하지 않아 완료 후 대기를 해제한다.
- 여러 활성 월계획: plans SHARE 아래에서 기존의 1개 조건이 실패하므로, 다른 R1 prefix나 거래 table lock을 기다리기 전에 중단한다. 이전에는 거래 lock 뒤에 있던 **검증 위치만 이동**했다.
- R1 cursor의 plans AccessShare와 정정의 plans SHARE는 호환된다. 정정이 R1 prefix를 기다려도 기존 R1 reader가 이 계획 table lock 때문에 멈추지 않는다.
- close/reopen은 기존 전체→월→closure 순서를 유지한다. 계획 버전 RPC는 이 마감 잠금을 요청하지 않는다. 실제 계획 변경 A + 정정 B + 마감 C가 겹치는 3개 실행 세션도 순환 없이 종료했다.

## 회계·권한·실패 정책 보존

후속 Migration은 `pg_get_functiondef`에서 잠금 블록과 **동일 내용의 계획 검증 블록 위치만** 교체한다. 기존 C1 60M 상쇄, C2 9,728,000/C3 2,700,000 상쇄, R1 50M, source key·sign·날짜·원거래·급여 검증·중복 방지·감사 INSERT·return은 변경하지 않는다. 선납 300M·준비금 60M·원거래와 movement에 대한 변경도 없다.

whitespace 제거 함수 본문 MD5 가드:

- 수정 전: `5429554141424f2fa75aa3492350eb2c`
- 수정 후: `beebd06ff35eb3eaf0a68dfde8494412`

대상 함수가 없으면 `RECLOSE_LOCK_ORDER_ORIGINAL_FUNCTION_MISSING`, 알려진 원본/수정본과 다른 본문이면 `RECLOSE_LOCK_ORDER_FUNCTION_DRIFT`로 중단한다. 정확한 수정본의 재적용은 no-op다. 전체 실행은 Migration 트랜잭션 안에서 수행하며 최종 본문 해시가 다르면 예외로 rollback한다. 기존 owner·SECURITY DEFINER·proconfig·ACL을 유지하는 CREATE OR REPLACE 정의를 사용한다.

기존 전체/월 마감 잠금과 closed 거부, 함수 범위 `lock_timeout=5s`, 원자적 롤백, 유니크 key와 기존 내용 대조, 감사 before/after 정책을 유지했다. 5초는 **각 lock 획득 대기**의 한도다. 여러 대기가 연속되면 호출 총시간은 5초를 넘을 수 있으므로 기존 운영 statement_timeout/짧은 트랜잭션 절차도 유지한다.

독립 계산 손익은 기존 회귀에서 그대로 비교한다: 8월 **267,236,765.578₫**, 9월 **70,507,820.4₫**. 원천 거래·카드 라인 evidence와 계산 코드는 수정하지 않았다.

## 실제 PostgreSQL 17.6 검증

기존 바이너리만 실행해 자기 Worktree의 새 UUID 클러스터를 생성했다. Docker·서비스·시스템 설정 변경 없음. 시나리오마다 독립 DB와 서로 다른 PID의 A/B/observer를 만들며, 삼중 경합은 추가 실행 C를 연결했다. 운영 URL·자격 증명은 로드하지 않고 offline guard와 고정 loopback 설정을 사용한다.

| 검증 | 결과 |
|---|---|
| 기존 15개 suite 재실행 | 15 PASS, 기존 교착 시나리오는 이제 성공/교착 0만 허용 |
| 추가 7개 포함 native suite | 22 PASS / 0 FAIL / 0 SKIP |
| 기존 40P01 스케줄 | 00000 성공, R1 writer 먼저 COMMIT 후 정정 성공, deadlocks=0 |
| 계획 변경 선행/후행, 다른 prefix | 기대대로 대기 또는 계획 drift 중단, deadlocks=0 |
| 계획 변경·정정·마감 3개 실행 세션 | 계획 변경 완료 → 정정 drift 거부 → 마감 완료, deadlocks=0 |
| 여러 활성 계획 | 거래 table lock 이전 drift 거부, 신규 회계 행 0 |
| 수정 Migration 재적용/본문 변조 | 재적용 no-op, 변조 본문은 drift 거부 |
| 권한 | postgres owner, SECURITY DEFINER, 고정 search_path/5s, PUBLIC·anon·authenticated 실행 금지, service_role 실제 호출 성공 |

직접 확장 실행의 timeout 측정은 table 경합 **5,011ms**, 정정/R1/감사 뒤 gate 경합 **5,013ms**, 새 R1 prefix 경합 **5,017ms**다. 모두 **55P03 lock timeout**, 부분 정정·R1·감사 rollback 및 재실행 중복 0을 검증했다. **40P01 deadlock은 한 건도 없으며 timeout과 다른 결과로 분류한다.** 테스트 결과에서 40P01 또는 통계 deadlocks>0이면 FAIL이다.

증거(직접 확장 실행):

- UUID `9aeffe2f-0064-463f-a34e-d1b9e4f2e56e`, `.qa-review/pg-native-logs/pg-native-test-9aeffe2f-0064-463f-a34e-d1b9e4f2e56e-gYGoRL/`.
- server.log SHA-256 `8c6dc61182648b92deff69a9d6129d649280c23e7634751975e4060abd6367d3`.
- 후속 SQL SHA-256 `185d0b8aec5757c7f569d426a9cdee2153e7f7362abc22fde758244adf05ce6e`.
- 기존 15개만 먼저 실행한 UUID `cd03790f-6042-4a8d-8406-cb44f28c8b56`도 15 PASS/교착 0이었다.
- 자기 클러스터 정상 종료와 소유권 검증 후 생성한 데이터만 정리했고 서버/명령/진단 로그는 보존했다. 이전 M단계 실패 증거도 보존했다.

최종 통합 검증은 기존 PGlite 5개와 R1 4개, 카드 정규화 3개, reopen 14개, 손익/카드 5개 및 native 22개를 실행한다. 실제 최종 결과·수정 SHA는 같은 작업의 lock-order-fix 인계서에 기록한다.

```powershell
$env:QA_POSTGRES_BIN = 'C:/workspace/baba-staff-app/.tmp/production-preflight/node_modules/@embedded-postgres/windows-x64/native/bin'
node scripts/agent/baba-verify.mjs --base main --tests "tests/ledger-aug-sep-reclose-postgres.test.mjs,tests/ledger-aug-sep-reclose-db.test.mjs,tests/ledger-recurring-rent-db.test.mjs,tests/ledger-september-card-normalization-db.test.mjs,tests/ledger-month-reopen.test.mjs,tests/ledger-month-close-revenue-card.test.mjs" --json
```

## 설치 가능 여부 및 남은 제한

**원본+후속의 조합은 독립 PostgreSQL에서 설치·실행 검증 PASS이며, 기존 R1 교착 차단 사유는 검증 범위에서 해소됐다.** 사용자 승인 전까지 운영 설치 보류는 유지한다. 원본만 설치한 상태의 정정 호출은 허용하지 않는다. 기존 원본 Migration과 모든 과거 적용 SQL은 수정하지 않았고 별도 로컬 수정 커밋으로 관리한다.

설치 승인 시 사용자가 두 SQL을 순서대로 **같은 SQL Editor 트랜잭션**에서 실행하고, 수정 후 본문 해시·owner·인자·ACL·5초 설정을 검증한다. 이력 등록은 실제 실행 증거와 각 SQL을 대조해 원본 `20261027112354`와 후속 `20261027160650` 각각만 확인한다. 이미 있는 동일 이력은 건너뛰고 충돌은 중단한다. 최종 함수는 후속 본문이므로 원본 이력을 등록하기 위해 함수를 옛 본문으로 되돌리지 않는다. 전체 과거 이력 재실행/repair/db push는 하지 않는다.

검증은 실제 PostgreSQL 잠금/권한/원자성을 다루지만 운영 전체 스키마·RLS·실제 앱 blockers/summary snapshot/UI를 대체하지 않는다. close preflight는 local stub이고 부속 보호 테이블은 sentinel fixture다. 단일 RPC들 및 명시한 경합 스케줄을 검증했으며, 외부에서 여러 RPC/임의 SQL을 역순으로 조합한 장기 트랜잭션까지 교착이 불가능하다고 주장하지 않는다. 기존의 짧은 유지보수 구간·fresh snapshot·writer 배출 절차는 계속 따른다.

Git 통합·push·배포·운영 DDL/DML·재개방·재마감은 별도 승인 대상이며 이번에 실행하지 않았다. 7월 귀속 비용은 기존 823af4e의 별도 7월 정리 원칙을 유지한다.
