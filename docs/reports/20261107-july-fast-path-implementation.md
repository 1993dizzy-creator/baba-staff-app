# FAST PATH 최소 구현 — 구조와 241행 데이터 배치 분리

기준 `06d48077e8ae80106b663d60c37b09e160b689d2`, 지정 Worktree 전용 구현이다. 기존 시뮬레이션과 적용 완료1~4차 근거를 재사용했다. **격리 PostgreSQL(PGlite)에서 구조 Migration과 신규241행 배치를 실행해124/124칸·기말300,353,642₫를 확인했다. 운영 DB 호출/쓰기·기존1~4차 SQL 실행은0회다.**

## 제출 파일과 적용 단위

| 단위 | 파일 | 상태 |
|---|---|---|
| 최초 구조 Migration | `supabase/migrations/20261107150007_ledger_historical_cash_import_v1.sql` | 새 Migration, 운영 미적용, 별도 구조 승인 필요 |
| 241행 데이터 SQL | `.local/july-restore/fast-path-final-20261107-v2/cash-241-REQUIRES-SEPARATE-OWNER-APPROVAL.sql` | 구조 DDL 미포함, 별도 데이터 승인 필요 |
| 사전/사후 읽기 | 같은 폴더 `preflight-READONLY.sql`, `postflight-READONLY.sql` | READ ONLY + ROLLBACK, actor 실제 ID만 지정 |
| Manifest/무결성 | 같은 폴더 `manifest.json`, `verification.json` | 395원본·154기존연결·241신규수용·124목표 및14개 엔진 계약 |
| 공통 렌더러 | `scripts/ledger/cash-import-batch.mjs` | 파일 생성만 수행, DB/네트워크 실행기 없음 |

Migration은 Supabase CLI `migration new`로 생성했다. 기존 Migration·기존 운영 함수의 본문을 수정하지 않았다. 구조 파일은 역할/원본 형식을 포함한 계약 원문 그대로 검토·적용하며 함수 본문을 임의 재포맷/생략하지 않는다. CRLF/LF 차이는 계약 검증에서 정규화한다.

## 실제 격리 DB 처리 결과

| 처리 | 원본행 수 | 신규 전표 | movement |
|---|---:|---:|---:|
| 기존153복원행 + #395/#1190 | **154** | **0** | **0** |
| 역사적 비손익 자금 기록 | **211** | **211** | **278** |
| 카드매출 참조만 | **30** | **0** | **0** |
| 이번 신규 수용 | **241** | **211** | **278** |

Registry는 전체395행을 저장하지만, 앞의154행은 기존 전표/감사 고유키를 연결하는 메타데이터일 뿐 재기표가 아니다. 이미 인식된2~3차 입고196개(33+163, 정정2개 포함)는 기존 anchor 소유 Claim으로 예약한다. 입고 로그·재고 수량·기존 후보·지급배분은 수정하지 않는다. 새211행에는 비용·매출·투자·후불·급여 adjustment를 자동 생성하지 않는다. 카드30행은 참조 증감만 보존하고 card_clearing movement를 생성하지 않는다.

자금211행 거래 규모1,598,469,992₫, 카드30행 참조219,868,620₫. 합계는 신규 매출/비용이 아니다. 신규4계정 순이동은 **+84,991,822₫**다.

| 계정 | 신규 자금 증감 | 7월 말 | 목표 차이 |
|---|---:|---:|---:|
| 매장현금 | −53,664,400 | 95,464,986 | **0** |
| Vượng | −1,731,700 | 5,231,310 | **0** |
| Cho | +93,201,900 | 95,470,741 | **0** |
| 법인계좌 | +47,186,022 | 104,186,605 | **0** |
| 합계 | **+84,991,822** | **300,353,642** | **0** |

## 구현한 최소 구조와 경계

- `ledger_import_rows`: 문서/탭/행 고유키, 원본 CSV 모든 열과 기존 매핑 snapshot, 날짜·실제 증감·참조 증감, canonical/SHA, 기존 전표 배열/신규 cash 전표, cash/economic 상태, batch digest. 원본키 PK와 `(profile_key, source_row)` UNIQUE. 원본 행번호와 고유키 suffix도 검증한다. seal 후 원본·금액·날짜·링크는 불변이다.
- `ledger_import_source_claims`: `(source_kind, source_id)` UNIQUE, 소유 anchor·member 행·경제 전표 링크. 같은 결제를 여러 그룹이 소유할 수 없고, #364/#369처럼 같은 그룹을 공유하는 정상 다대일은 허용한다. 이미 처리된 입고를 새 행이 재사용하려 하면 차단한다.
- `historical_cash_event`: 기존 ledger/movement를 사용하는 비손익 신규 type. category/recognition_month NULL. **신규 일반 수입·비용·투자금·잔액조정이 아니다.** source snapshot과 실제 이동은 원본에서만 생성한다.
- RLS 활성화, anon/authenticated 쓰기/RPC 실행 차단. service_role도 Registry/Claim 직접 쓰기는 허용하지 않고, Owner/Master·활성 로그인 확인을 통과한 SECURITY DEFINER RPC로만 처리한다. private helper schema는 공개 실행 권한을 주지 않는다.
- 입력·코드 계약·승인 해시, 원본 중복·기처리154연결·행/leg 건수, 4계정 실제 증감, 31일×4계정124칸을 검증한다. **모든 Postflight를 COMMIT 전에 통과해야 한다.** 실패 시 전체 롤백, 동일 manifest 재실행은 신규 행/전표/movement/감사 모두0이다. 다른 원문/승인 digest 재사용은 거부한다.
- cutoff는 임의 날짜가 아니라 각4계정의 **실제 기초 전표가 존재하는 날짜**여야 한다. 8/1 실제 기초·기존8~10월 마감 hash/revision·기존 원장/지급배분/카드/임대/급여/투자 자료를 전후 보호한다. inventory/POS 테이블 전체를 해시하거나710건을 재조사하지 않는다. 입고196개는 기존 확정 소유권을 위해 ID 존재만 확인한다.
- 공통 lock 순서를 사용하고 lock_timeout5초/statement_timeout90초를 유지한다. 기존 ledger/protection 객체의 compact MD5 비교는 공통 helper에 한 번 구현했다. 매 데이터 배치마다 새 보호 SQL이나 여러 업무 RPC 조합을 작성하지 않는다.

## 후속 원거래 연결과 경제 인식

`ledger_link_import_source_v1`은 POS payment/receipt, 입고, 후불, 가불 adjustment, 투자 또는 문서 증거를 Claim 그룹에 연결한다. existing/cash 전표 및 movement ID를 반환하며 **새 자금 이동0**이다. 원거래 ID 존재를 확인하고 다른 소유 그룹의 Claim은 거부한다. 동일 연결은 무쓰기 duplicate다. 이미 현금이 발생한 다른 전표를 새 현금처럼 연결하는 것도 거부한다. 그룹 연결만으로 비용·매출 확정 또는 마감 완료로 표시하지 않는다.

seal 이후 일반/Native RPC의 과거 기표와 movement INSERT/UPDATE/DELETE는 table guard가 차단한다. 기존 자금 전표 취소/날짜 변경 등도 차단된다. 정상 후속 경제 처리를 전부 막지 않도록 **별도 승인된 비현금 경로** `ledger_recognize_import_group_v1`을 제공했다. 식별된 Claim 그룹에만 `APPROVED_ECONOMICS:<canonical SHA>`와 실제 경제 발생일·귀속 월·금액·카테고리·근거를 주어 단일 income/sales/expense_recognition 전표를 만든다. 고유 그룹키로 재실행/다중 Claim 중복 인식을 차단하며 자금 movement·후불·가불·투자금은 생성하지 않는다. 이미 처리된 그룹·기존 채무/급여/투자 원천·카드 참조/카드입금은 이 신규 인식 경로에서 거부한다. 이 함수는241행 배치에서 **호출하지 않으며 현재 경제 유형을 자동 확정하지 않는다.**

직원 식대·급여·선지급·투자·세금 등은 기존 근거/전월 채무와의 연결을 별도로 확정한다. 기존 계정 active_from을 변경하지 않는다. 후불/급여/투자의 이미 존재하는 경제 거래는 새 비용/원금을 만들지 않고 링크한다. 경제 분류 확인 전에는 해당 상태를 대기로 남긴다. 카드 차이 **−6,102,347₫** 및 기존 차액/미연결은 해소했다고 판정하지 않는다.

`ledger_cash_import_status_v1`은 최초 수용 후 **cashReconciled=true / economicClosed=false / economicPending=241**을 반환한다. 경제 확인이 남은 기간을 `ledger_month_closures`에 closed로 저장하면 DB trigger가 차단한다. 따라서 cash 검산 완료를 회계 마감으로 오인하지 않는다. 현재 카드 정산69건·현재 카드 잔액은 그대로다.

## UI/API 및1~6월 경계

- `lib/ledger/fund-account-view.ts`: fund별 최신 opening business_date를 찾아 그 이전 이동을 다시 합산하지 않는다. card_clearing은 이 cutoff에서 제외한다. 현재8/1 경계는 typed opening 정보가 없는 호출의 fallback으로 유지한다. Jan~Jun 복원이7월 기초600,859,817₫ 또는8월 기초에 재합산되지 않는다. 월별 기초가 없으면 앞선 실제 기초에서 이어 계산한다.
- `app/api/admin/ledger/route.ts`: movement 조회에 type을 포함해 full/dashboard/accounts 계산이 같은 경계를 사용한다. 읽기 전용 cash 상태 RPC 결과를 전달한다. 구조 적용 전 PGRST202/42883은 null 상태로 처리하되 권한/데이터 오류는 숨기지 않는다.
- `dashboard-cash-report.ts`, `dashboard-report.ts`, 대시보드 page: 기존 기타조정 fallback과 분리한 **과거 자금·분류 대기** 항목과 cash/경제 상태를 표시한다. 새 비손익 type은 손익 whitelist에 포함하지 않는다. `entries.ts`/`fund-account-log.ts`도 별도 라벨을 제공한다.
- `summary.ts`와 API 현금 수입/상세 집계: 후속 비현금 경제 인식은 P&L에는 포함하지만 같은 입금을 현금 KPI/시재에 다시 추가하지 않는다. 기존3인자 cash 함수 호출은 그대로 호환된다.
- 공통 SQL 엔진·renderer는 기간/targets/기존 source anchors로 동작한다. 현재 원본 어댑터와 실제 데이터 검증은7월이며1~6월 원본을 새로 조사하지 않았다. 다른 월은 source manifest와 독립적인 기초/목표가 필요하다. 새 RPC/월별 SQL 로직을 복제하지 않는다.

## 영향 범위 검증

**24개 고유 검사 PASS**. 코드 변경이 영향을 준 패턴만 선택 재실행하고 유효한 나머지 PASS는 재사용했다.

| 범위 | PASS | 주요 확인 |
|---|---:|---|
| 격리 DB | 5 | 실제 구조/241배치, 124칸·기말,154기존 전표/감사와 stock/POS/지급배분/카드/마감 보존,211/278/30/196, 무쓰기 재실행, 잘못된 마지막 target/중복키/권한/승인/가짜 cutoff의 전체 롤백, READ ONLY CRLF hash preflight, Claim/비현금 승인/카드 차단/financial close guard |
| 신규 월간 경계·표시 | 2 | fund별 Jan~Aug opening, 카드 연속성, 비손익 라벨·waterfall, 후속 인식 입금 중복 제외 |
| 신규 API | 2 | 실제 route transpilation+readonly double, 현금/경제 상태 분리, 후속 P&L 증가해도 입금/시재 불변, 구조 미적용/권한 오류 구별 |
| 기존 영향 cashflow | 14 | 기존 투자/정산/비용/계정 범위/KPI 보존 |
| 기존 API multi-scope 경계 | 1 | July cash reconstruction의8~11월 full/dashboard/accounts 및 closed/provisional 보호 |

추가로 변경 TS/TSX8개 구문 검사0오류, 공유 계산 모듈4개 진입점의 scoped semantic check0오류. 전체 앱 TypeScript/Build/회귀·브라우저 E2E·운영 검증은 하지 않았다. 테스트에 운영 자격 증명을 제공하지 않았다.

Fixture는 기존 월마감 제약/trigger와 읽기 캡처의7월 header·movement·감사를 사용하고, 적용 완료4차9행은 **승인된 action을 데이터로만 적재**했다. 오너가 실제4차 전표 ID 범위를 제공하지 않았으므로 fixture ID7000대는 합성값이며 운영 ID라고 주장하지 않는다. 운영 batch는 감사/원본키/기존 actionHash로 실제 ID를 fresh resolution한다. 기존 header 캡처에 없던 source_snapshot은 fixture 기본값이고, stock/POS 및 일부 보조 테이블은 보호 계약용 축소 fixture다. 이전1~4차 실제 경제 검산 PASS를 대체하거나 재실행한 것이 아니다. 멀티세션 lock stress/운영 실행 시간을 검증했다고 주장하지 않는다.

## 승인·실행 경계와 상태

1. **구조 승인** 후 승인된 절차로 새 Migration 원문만 적용한다. 기존1~4차 SQL은 사용하지 않는다.
2. UI/API 코드 통합·배포 여부는 별도 오너 결정이다. 이번에 Main 수정·병합·Push·배포하지 않았다.
3. 운영 담당자가 `preflight-READONLY.sql`의 actor를 실제 Owner/Master ID로 지정해 실제 source/상태/계약을 확인한다. 새4차9행의 ID도 자동 조회하며 숫자를 추정하지 않는다.
4. **데이터 승인**은 정확한 manifest digest에 대해 별도로 받는다. actor/approval placeholder를 승인에 따라 지정한 뒤241행 SQL 한 번을 실행한다. 이 파일에는 구조 DDL이 없다.
5. `postflight-READONLY.sql`로 cash=true/economic=false·124칸을 확인한다. 과거 SQL이나 새 배치를 검증 목적으로 불필요하게 재실행하지 않는다.

현재 차단 사유는 운영 구조/코드 적용과 별도 데이터 승인이 아직 없다는 것이다. 원거래 경제 분류·카드 정산 미해결은 **회계 마감**을 차단하지만 이241행의 자금 수용 자체를 차단하지 않는다. 운영 Preflight에서 실제 데이터/마감/계약 drift가 나오면 임의 해시 교체·보정 없이 중단한다.

Manifest 승인 SHA-256: `112ba5f837811f3e1fef7b581390a4c9d6494016b594f27ba4206f67144a6907`.
구조 Migration SHA-256: `c6d47342c79835d45304e3b2b8a69a582e1aad4690d4b93cec21ec312083fe75`.
최종 데이터 SQL raw SHA는 같은 폴더 `verification.json`에 보존한다. 이전 r1/r2/r3/final 초안은 superseded이며 실행 대상으로 사용하지 않는다. `.local` 원본·증거·산출물은 Git 제외, 코드/테스트/보고서/새 Migration만 로컬 커밋한다. 최종 커밋 SHA는 완료 응답과 Git 이력으로 식별한다.
