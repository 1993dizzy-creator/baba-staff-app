# 8·9월 C1~C3 정정 구현 및 운영 적용 검토

작성: Codex, 2026-10-27. 운영 DB는 읽기 전용으로만 조사했다. 운영 DDL/DML, 재개방·재마감, 통합·push·배포는 실행하지 않았다.

## 작업 환경과 구현 파일

- Worktree: `C:/workspace/baba-wt-codex`
- 작업 ID: `20261027-aug-sep-ledger-corrections-01`
- 브랜치: `codex/20261027-aug-sep-ledger-corrections-01`
- 기준: 로컬 main `8576e3a02e2bc1458adcc85ec2a2643e5db953bd` (대시보드 `24b4282`, R1 `8576e3a` 포함)
- `baba-start` STARTED, 재실행 Preflight 조건부 가능/HIGH: 신규 Migration의 운영 영향. 다른 Worktree 미커밋 변경·수정 파일 충돌 없음. 원격 main은 조회했으며 로컬 main보다 뒤였다. main을 이동하거나 두 커밋을 다시 병합하지 않았다.
- `supabase/migrations/20261027112354_aug_sep_reclose_corrections.sql`: 함수 설치만 하는 신규 Migration. 기존 Migration 수정 없음. CLI `migration new`로 생성했다.
- `scripts/ledger/aug-sep-reclose-snapshot.sql`: repeatable-read/read-only 변경 전·후 스냅샷, 잔액·원거래·보호 테이블 해시·이력 조회.
- `scripts/ledger/aug-sep-reclose-evidence.json`: 읽기 전용으로 수집한 계산 근거. 거래 배열의 열 순서는 `[id,type,recognition_month,business_date,amount,economic_effect_sign,source_type,source_key]`. 확정 Google Sheet 자체를 수정하거나 재조회하지 않았으며 #1055에 보존된 확정 금액을 검증했다.
- `scripts/ledger/aug-sep-reclose-calculate.mjs`: 원천 거래와 정산 라인으로 독립 손익 계산. 앱 계산 함수를 사용하지 않는다.
- `tests/ledger-aug-sep-reclose-db.test.mjs`: PGlite의 실제 PL/pgSQL 실행과 독립 계산 검증.

## 정정 함수 계약

`ledger_aug_sep_reclose_corrections_v1(p_month date,p_rent_plan_id bigint,p_actor_user_id bigint)`

입력 월은 정확히 2026-08-01 또는 2026-09-01이다. 활성 owner/master만 허용하며 함수는 postgres 소유 SECURITY DEFINER, 고정 search_path, PUBLIC/anon/authenticated 실행권한 제거, service_role만 실행권한을 갖는다. 호출자는 신뢰되는 서버/SQL Editor이며 브라우저에 직접 노출하지 않는다. 이 권한 구성은 [Supabase 함수 보안 문서](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker)의 권한 제한 원칙을 따른다.

기존 close/reopen과 같은 전체 마감 advisory lock → 월 advisory lock → closure 행 잠금 순서를 사용한다. 마감 월은 기존 `ledger_assert_month_open_v1` 및 INSERT trigger가 `LEDGER_MONTH_CLOSED`로 거부한다. 마감 trigger를 변경·해제하지 않는다. 재실행도 닫힌 월에서는 거부한다.

정정 중 source와 movement가 바뀌지 않도록 transactions의 SHARE ROW EXCLUSIVE, movements/payroll/recurring plan의 SHARE table lock을 취한다. 해당 세션의 lock_timeout은 함수 범위 5초다. 광범위한 장부 writer를 막는 일회성 유지보수 잠금이므로 쓰기 중지 시간을 확보해야 한다. 잠금 timeout/deadlock을 성공으로 처리하지 않는다.

모든 원거래 #1055/#2191/#2192, #1055의 확정 시트 snapshot, 두 보험 출금의 법인계좌·금액·행 수, 급여 배치 #3 및 비용 인식 #2752를 검증한 다음 정정한다. 임대료 계획은 cat 3, 월 50M, 1일, 2026-08 시작, 종료일 없음, `store-rent`이며 해당 월의 활성 monthly 계획이 하나여야 한다. 추가 활성 계획은 자동으로 처리하지 않고 중단한다.

8월은 C1 한 건과 R1 50M, 9월은 C2·C3 두 건과 R1 50M을 같은 함수 호출 안에서 처리한다. 호출이 실패하면 해당 호출의 정정·감사·R1이 모두 롤백된다. 정정은 spec의 source key, expense/sign -1, 원거래 링크, 월말 business_date, recognition_month를 사용한다. movement는 생성하지 않는다. source fingerprint 및 synced_at도 채워 실제 테이블의 source metadata 제약을 지킨다.

재실행 시 기존 key의 금액·월·분류·sign·원거래·party·snapshot·fingerprint·감사 한 건·movement 0건을 검사한다. 정확히 일치하면 새 정정 0건이고, 다른 내용·취소 상태·감사 누락이면 중단한다. 유니크 인덱스는 최후의 중복 방지 장치로 유지된다. R1은 기존 RPC이며 재실행 시 인식 행 수는 늘지 않지만 `source_synced_at`/`updated_at`은 갱신할 수 있다.

함수는 원거래, 기존 지급, 선납 #1304의 300M, 준비금, 미납금, 카드 정산, 마감 행을 UPDATE하지 않는다. 기존 월의 모든 정정과 R1을 취소하는 역방향 SQL은 만들지 않았다. 커밋 후 취소는 별도의 회계 정정 승인과 증빙이 필요하다.

## 원천에서 독립 계산한 손익

거래 1,987건을 확정 상태와 인식 월로 읽어 정수 milli-동으로 합산했다. 매출은 sales의 signed amount, 비용은 expense/expense_recognition의 signed amount다. 월별 기대 손익을 계산 입력으로 사용하지 않았다. 카드 귀속은 reconciliation별 실제 line의 gross 비율로 나누고, 0.001동 나머지는 가장 큰 나머지/월 순서로 배분해 총액을 보존했다. 결과를 기존 앱 귀속 함수와도 교차 검증한다.

| 항목 | 8월 | 9월 |
|---|---:|---:|
| 원천 거래 수 | 967 | 1,020 |
| 매출 | 734,634,810 | 691,165,200 |
| 현재 원장 비용 | 477,480,641 | 583,085,379.6 |
| 인식된 legacy 카드 차액 | 4,338,130 | 0 |
| 현재 matched 매출월 귀속 카드 차액 | 4,255,533.422 | 0 |
| 카드 귀속 추가 보정 | -82,596.578 | 0 |
| C1 / C2·C3 | -60,000,000 | -12,428,000 |
| R1 임대료 | +50,000,000 | +50,000,000 |
| 정정 후 총비용 | 467,398,044.422 | 620,657,379.6 |
| **예상 영업이익** | **267,236,765.578** | **70,507,820.4** |

9월 rev3 비용 406,899,585.6과 현재 비용의 차이 176,185,794는 #2752 급여 배치 비용이다. rev3 마감 이후 10/17에 인식됐으므로 과거 마감 손익 284,265,614.4에서 C2·C3와 R1만 더해 현재 손익을 추정하면 안 된다.

급여 비용 재검산: 실지급 151,448,409 + 보험 12,428,000 + 선지급 12,200,000 + PIT 109,385 = 176,185,794. PIT는 company_pit_total 107,750과 employee_pit_total 1,635의 합계다. 명세의 PIT 합계와 원천 필드의 차이도 확인했다.

## 카드 차이 605,391.905의 원인과 보존 한계

`ledger_card_reconciliations.id=22`의 deposit_transaction_id는 **1233**이다. `ledger_transactions.id=22`를 조회해 판단하지 않았다.

9/29 `september_card_deposit_fifo_normalized` 감사 로그의 before 라인에서 재계산하면, 당시 matched 6건의 차액 총 2,103,353 중 8월 귀속은 605,391.905, 9월 귀속은 1,497,961.095다. 15개 정산의 현재 상태는 auto_allocated이고 차액 0이다. 과거 차액 거래 6건은 cancelled이며 합계가 동일하게 2,103,353이다. 따라서 취소된 비용을 현재 confirmed 비용 합산에 다시 넣지 않는다.

현재 matched 정산들이 남기는 8월 귀속 4,255,533.422 + 위 605,391.905 = 과거 귀속 4,860,925.327. 여기서 8월 인식 4,338,130을 빼면 과거 보정 +522,795.327, 현재 보정 -82,596.578이 된다. 보정 차이 -605,391.905로 비용이 줄고 이익은 같은 만큼 증가한다. 임대료만 반영한 266,631,373.673 + 605,391.905 = 267,236,765.578이다.

9월 수수료 #2384는 `card_fee_month_close`, 금액 4,332,575, 인식 월 9월, 실제 clearing movement business_date 10/8이다. fee allocation은 9/28 997,775 + 9/29 685,800 + 9/30 2,649,000 = 4,332,575다. 과거 취소 차액 2,103,353 + 나머지 월말 수수료 2,229,222와 수수료 총액이 맞는다. 이는 정규화 후 FIFO 원금과 잔여 수수료 모델의 총액 대사이며, 옛 비용 한 건과 새 fee line 한 건이 일대일로 대응한다는 뜻은 아니다. 원금·정산 라인·수수료 #2384는 이번 정정 대상이 아니다.

수수료 자체도 독립 검산했다. 9월 카드매출 27건의 총액 181,045,460에서 현재 유효 입금 배분 라인 43건의 원금 176,712,885를 빼면 4,332,575다. 각 매출 ID마다 입금 배분 원금 + fee 배분 = 매출 gross가 정확히 성립한다. 따라서 9월 수수료는 원천 매출·원금에서 산출되며 #2384 금액을 정답으로 역산한 값이 아니다.

**운영 전 해소할 잔여 사항:** 남아 있는 matched 정산 #1은 7/31 카드매출 #1190(3,694,200)을 포함한다. 총 차액 306,427 중 7월 귀속이 82,596.578이다. 전체 귀속은 7월 82,596.578 + 8월 4,255,533.422 = 4,338,130으로 보존된다. 그러나 운영 DB에는 7월 closure가 없고 7월 인식 거래도 이 sales 한 건만 확인된다. 즉 8·9월 손익에서 7월분을 제외하는 계산은 맞지만, **모든 월의 공식 마감 손익에서 비용 누락이 없다고 확정할 수 없다.** 이 문제는 과거 rev3 보정에도 이미 포함돼 있던 경계 문제이며 C1~C3가 새로 만든 것은 아니다. 7월/장부 시작 이전 비용을 어떤 보고서·기초 회계에 보존하는지 확인하거나 별도 정책 승인이 필요하다. 82,596.578을 8월에 임의로 더하거나 7월 거래/마감을 자동 생성하지 않았다.

## 제안한 운영 순서의 안전성

순서 자체는 역순 재개방 → 정순 재마감 정책과 일치한다. 다만 아래 조건을 충족하기 전에는 운영 실행하지 않는다. 현재 Migration 버전 20261027112354와 동일 이름 함수는 운영에 없음을 해당 버전 범위만 조회했다. 과거 이력 전수 조사·repair는 하지 않았다.

0. 별도 승인 후 신규 함수 설치 SQL을 사용자가 SQL Editor에서 실행한다. 이 Migration은 DDL/권한만 변경하고 회계 행을 만들지 않는다. 설치 결과·권한·본문을 검증한 후에만 데이터 변경 단계로 간다. 운영의 적용 완료 통지 후 해당 버전 이력만 검증·등록한다.
1. 유지보수 시간을 확보해 장부 입력·동기화·카드 정산 writer를 중지하고 snapshot SQL 결과를 외부에 저장한다. SQL Editor가 마지막 result만 표시하면 SELECT별로 저장한다. 현재 시점과 8/31·9/30 as-of 자금 잔액을 모두 보존한다. 이 조사에서 수집한 증거는 여러 SELECT에 걸친 과거 캡처이므로 운영 직전 일관된 snapshot을 다시 확보해야 한다.
2. 9월을 기존 reopen RPC로 재개방한다. 이후 월이 이미 closed면 먼저 중단한다. 반환 status가 `reopened` 또는 확인된 재시도의 `already_reopened`인지 검사한다.
3. 8월을 재개방한다. 9월 closed 상태에서는 `later_month_closed`가 나와야 한다. 2~3을 한 세션에서 묶으면 두 번째 실패 시 첫 재개방도 롤백할 수 있지만, status 반환은 SQL 예외가 아니므로 명시적으로 검사하고 실패를 raise 해야 한다.
4. R1 계획을 기존 create RPC로 생성한다. 현재 운영 계획은 0건으로 조회됐다. 이름·cat 3·50M·1일·8월 시작·`store-rent`를 확인하고 반환 planId를 저장한다. 재시도는 새 계획 생성 대신 기존 계획의 전체 속성을 비교한다. 최신 버전 생성 RPC는 기존 version을 종료시킬 수 있으므로 create를 무조건 재실행하지 않는다.
5. 8월 정정 함수를 호출한다. 함수 안에서 C1과 R1을 원자적으로 처리하므로 별도 R1 호출은 필요 없다. 첫 호출 correctionsCreated=1, R1 createdCount=1, 총 인식 50M 및 비용 순변동 -10M을 확인한다. 재시도는 정정 0·R1 신규 0을 확인한다.
6. **새** 앱 preflight와 summary snapshot을 만들고 예상 손익·보호 잔액을 비교한 후 기존 close 경로로 8월 재마감한다. stale hash는 재조회한다. 8월 revision 3은 history에 보존되고 새 revision 4가 된다. 오래된 rev3 JSON이나 예제용 `{}`를 마감 snapshot으로 쓰면 안 된다.
7. 9월 정정 함수로 C2·C3와 R1을 원자적으로 처리한다. 첫 호출 정정 2·R1 1, 정정 -12,428,000, 순비용 +37,572,000을 확인한다. 원거래 출금과 #2752는 그대로여야 한다.
8. 9월도 fresh preflight/summary로 재마감한다. 8월 reopened 상태라면 `EARLIER_MONTH_REOPENED`로 차단된다. 동일하게 history rev3와 새 rev4를 검증한다.
9. 10월 R1은 기존 sync RPC로 별도 수행한다. 호출 전 월이 열렸는지 확인한다. 현재 함수는 10월을 허용하지 않는다. 월 50M 행 1건, movement 0건, source key `recurring:<planId>:2026-10`, 감사 1건을 검증한다. 재시도에서 신규 0을 확인한다.
10. snapshot SQL을 다시 실행한다. 모든 자금 잔액·movement 행 수와 해시·선납 #1304·원거래·미납금·준비금·카드 테이블 해시는 전과 같아야 한다. 신규 정정 3·R1 3, correction_created 감사 3, recurring_expense_created 감사 3, 두 month_reopen·month_reclose, history의 원본 snapshot 보존, 새 손익을 검사한다. 운영 Migration history·함수 인자/본문·PUBLIC/anon/authenticated/service_role 권한과 보안/성능 Advisor는 적용 완료 뒤 연결 도구로 검증한다.

호출 형태(현재는 실행 승인 없음, ID는 실제 반환값으로 대체):

```sql
begin;
set local statement_timeout='30s';
select public.ledger_aug_sep_reclose_corrections_v1(
  date '2026-08-01', :verified_rent_plan_id, :active_owner_or_master_id
);
-- status/계수/보호 잔액 확인 후 COMMIT. 오류면 전체 ROLLBACK.
```

위 `:...`는 설명용 placeholder이며 SQL Editor에 그대로 붙여 실행하는 완성된 배치가 아니다. 운영 승인 시 실제 계획·actor ID 및 결과 판정이 포함된 실행본을 확정해야 한다.

## 경합·중간 실패·롤백

- 같은 함수의 동시 호출과 close/reopen은 같은 전체 advisory lock으로 직렬화된다. 다른 writer는 table lock에 막히지만 R1의 prefix lock을 먼저 가진 writer와 잠금 순서가 뒤집힐 수 있다. writer 중지와 5초 lock timeout이 필요하고 timeout/deadlock은 트랜잭션 전체를 rollback한 뒤 상태를 다시 읽어 재시도한다. 네이티브 다중 세션 경합 실험은 수행하지 않았다.
- source key 유니크 인덱스와 내용 검사가 중복을 막는다. RPC 응답이 유실되면 조회 후 같은 월 함수로 재시도하며, 이미 닫힌 월은 성공 여부를 원거래 key·감사·마감 이력으로 확인한다. 성공 여부가 불명확하다는 이유로 다시 재개방하지 않는다.
- C1만 커밋되거나 C2만 커밋되는 경로는 함수 안에 없다. R1 또는 감사 실패도 해당 호출 전 상태로 복구된다. sequence 번호는 PostgreSQL 특성상 rollback 후 건너뛸 수 있으며 회계 행 유실을 뜻하지 않는다.
- 함수 커밋 후 재마감이 실패하면 정정이 있는 열린 월로 남는다. snapshot/preflight를 재계산해 재마감을 재시도한다. 과거 마감 JSON을 직접 덮어쓰거나 정정·감사 행을 DELETE해 복구하지 않는다.
- 8월 재마감 후 9월이 실패하면 8월 rev4와 9월 reopened 상태를 보존한 채 9월을 이어간다. 전체를 되돌리려면 새로운 승인과 보상 정정 계획이 필요하다. 10월 R1 실패는 두 재마감과 독립적으로 재시도한다.
- 기존 close RPC는 caller가 제공한 summary와 snapshot hash를 받는다. advisory lock이 모든 장부 writer를 자동 직렬화하지는 않으므로 summary 생성부터 close까지 writer 중지 상태를 유지해야 한다. 실제 앱 전체 preflight의 blockers가 0인지 이번 로컬 fixture만으로 보장하지 않는다.

## 로컬 검증과 한계

PGlite에서 신규 함수와 저장소의 실제 recurring·month guard·reopen·close 함수 본문을 실행했다. close/reopen body의 운영 whitespace 제거 MD5는 각각 `ebe29af93ca03e8ac44c7b20af43f917`, `352c07cb4208308bf1022cdc7f32446e`로 읽기 전용 확인했다. 기존 R1 fixture는 운영 함수 해시 일치도 별도로 검증한다.

신규 테스트는 독립 계산, card 총액 보존, closed 거부, reopen/reclose 순서, revision/history, 재실행, owner/master 권한과 비활성 사용자 거부, source/payment/payroll/plan drift, 감사 실패·R1 실패·C3 실패의 원자적 rollback, 잘못된 기존 key·감사 누락·movement 추가·R1 실제 금액 변조를 검사한다. 원거래와 movement는 실제 캡처 금액을 사용한다. 미납금·준비금·카드 보호 테이블은 최소 sentinel fixture이므로 전체 운영 스키마 회귀를 대체하지 않는다. close preflight는 로컬 stub이므로 실제 앱 blockers, snapshot 전체 생성, UI 동작은 미검증이다.

재현:

```text
node scripts/ledger/aug-sep-reclose-calculate.mjs
node --experimental-strip-types --import ./scripts/agent/lib/offline-guard.mjs --test tests/ledger-aug-sep-reclose-db.test.mjs
node scripts/agent/baba-verify.mjs --base main --tests "tests/ledger-aug-sep-reclose-db.test.mjs,tests/ledger-recurring-rent-db.test.mjs,tests/ledger-september-card-normalization-db.test.mjs,tests/ledger-month-reopen.test.mjs,tests/ledger-month-close-revenue-card.test.mjs" --json
```

최종 실제 실행 결과는 같은 작업 ID의 `docs/handoffs/` 인계서에 기록한다. 앱 코드·설정·화면은 변경하지 않아 Production build는 필요하지 않다. 운영 직접 적용·Advisor·재마감은 검증 대상으로 실행하지 않았다.

## 실제 운영 적용 전 필요한 승인

1. 7월 귀속 카드 비용 82,596.578의 공식 보존 위치 확인 또는 별도 회계 정책 결정. 모든 월의 비용 누락 없음 확인 전에는 운영 재마감 준비 완료로 보지 않는다.
2. 신규 Migration의 함수/권한 DDL 설치를 사용자가 SQL Editor에서 실행하는 승인. C1~C3·R1 데이터 변경 실행 승인은 별도다.
3. 유지보수 writer 중지, 9월→8월 재개방, 계획 생성, 월별 정정+R1, 8월→9월 재마감 및 10월 R1 각각의 운영 실행 승인. 실제 plan/actor, fresh snapshot과 전체 blockers를 적용 직전에 확정한다.
4. 적용 완료 통지 이후 해당 신규 Migration만 운영 검증·이력 등록하고 Advisor를 확인한다. Git 통합·push·Production 배포는 추가 명시적 승인 없이는 진행하지 않는다.
