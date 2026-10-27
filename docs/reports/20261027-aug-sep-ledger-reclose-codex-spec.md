# 2026-08·09 장부 재마감 — Codex 일회성 정정 작업 명세

- 작성: Claude Code (2026-10-27, 원본 `main` 직렬 모드), 운영 DB는 읽기 전용 조사만 함
- 담당: **Codex** (AGENTS.md: 로컬 SQL 작성·테스트·검증). 운영 적용은 사용자가 SQL Editor에서 직접 실행
- 현재 상태: 8월·9월 모두 `closed` / revision 3. 이 문서는 운영 변경을 승인하지 않는다.

## 1. 배경 (확정 정책)

- 현 임대차: 월 50,000,000₫ (2026-07 ~ 2027-06 잠정). 선납 300M(7/3, 장부 이전) + 300M(8/11, #1304 `prepaid_expense_payment`). 선납·준비금은 손익이 아니다.
- 다음 계약 준비금 #1(720M, 2026-09부터 월 60M)은 별도 정책이며 변경하지 않는다.
- 월 임대료 50M 인식은 **R1**(기존 정기비용 RPC)으로 한다. Claude Code가 UI/API를 구현했다(`/api/admin/ledger/recurring-expenses`, 장부설정 › 기본설정 › 정기비용, 마감 시트의 `RECURRING_NOT_SYNCED` 안내). 계획: 이름 `매장 임대료 (현 계약)`, 분류 임대료(id 3), 50,000,000, 인식일 1, 시작 2026-08, key `store-rent`.
- `#1304.source_snapshot.note`("8월 60M 적립 계획과 별개")와 `accountingTreatment: cash_outflow_only_no_monthly_expense`는 실제 정책과 다르다. 과거 기록이므로 수정하지 않는다.

## 2. 왜 Codex SQL이 필요한가

`ledger_create_correction_v1`은 원거래 월이 **마감 상태**여야 하고, 정정을 **다른 열린 월**에 귀속한다. 8월·9월 안에서 상쇄하는 정정은 앱 경로로 만들 수 없다.

## 3. 정정 대상 (모두 자금 이동 없음)

| ID | 월 | 내용 | 행 |
|---|---|---|---|
| C1 | 2026-08 | #1055 안의 임대료 60M 상쇄 | `type='expense'`, `source_type='ledger_correction'`, `source_key='legacy_sheet_expense_detail_offset:2026-08:rent'`, `correction_of_id=1055`, `category_id=4`(기타 비용), `amount=60000000`, `economic_effect_sign=-1`, `recognition_month='2026-08-01'`, `business_date='2026-08-31'`, movement 0건 |
| C2 | 2026-09 | #2191 보험 손익 상쇄 | 위와 같은 형식, `source_key='payroll_insurance_duplicate_offset:2026-09:2191'`, `correction_of_id=2191`, `category_id=75`(보험), `amount=9728000`, sign −1, `recognition_month='2026-09-01'`, `business_date='2026-09-30'` |
| C3 | 2026-09 | #2192 보험 손익 상쇄 | `source_key='payroll_insurance_duplicate_offset:2026-09:2192'`, `correction_of_id=2192`, `amount=2700000`, 나머지 C2와 같음 |

근거:
- C1: `#1055.source_snapshot`의 `sheetAccountingExpense = sheetCashOutflow 778,924,465 − 선납 300M + augustRentExpenseRecognition 60M`. 별도 임대료 거래 #1·#1062·#1065는 cancelled.
- C2·C3: 급여 배치 #2752의 `actual_company_cost_total = 실지급 151,448,409 + 직원보험 3,192,000 + 회사보험 6,536,000 + 대표보험 2,700,000 + 선지급 12,200,000 + PIT 109,385 = 176,185,794`로 사회보험 12,428,000을 이미 포함한다. 9월 급여 현금(10/10)은 실지급만이고, 9/29 은행 출금 #2191·#2192가 보험의 유일한 현금이다. 출금(movement)은 보존하고 손익만 상쇄한다.
- source_key 형식: C1은 기존 `#1055` 상쇄들과 같은 접두어라 대시보드 '기술적 보정·상쇄'로 분류된다. C2·C3는 일반 분류(인건비 › 보험)에 남는다.

## 4. 안전 조건 (함수 또는 가드가 있는 일회성 스크립트)

1. 실행 조건: 대상 월이 `reopened`(또는 열린 상태)일 것. `closed`면 `LEDGER_MONTH_CLOSED`로 실패해야 한다(기존 `ledger_transaction_month_guard_v1` 트리거에 맡기고 우회하지 않는다).
2. 중복 방지: 기존 유니크 인덱스 `ledger_transactions_source_key_unique (source_type, source_key) where source_key is not null`. 재실행 시 신규 행 0건(`on conflict do nothing` 또는 존재 확인 후 `already_applied` 반환).
3. 사전 검증(불일치 시 전체 중단): #1055 confirmed·196,211,473.5·cat 4·rm 2026-08; #2191/#2192 confirmed·9,728,000/2,700,000·cat 75·rm 2026-09·movement 존재; 배치 3 `insurance_remittance_total = 12,428,000`.
4. 감사 로그: 행마다 `ledger_audit_logs`에 `correction_created`(before = 원거래, after = 정정 id·economicDelta·사유).
5. 권한: 기존 정정 RPC와 같은 owner/master 검사, `security definer`, `search_path=pg_catalog,public`, PUBLIC·anon·authenticated revoke, service_role만 grant(함수로 만들 경우).
6. movement를 생성하지 않는다. 다른 거래·마감 테이블을 UPDATE하지 않는다.

## 5. 로컬 테스트 (PGlite 또는 native Postgres fixture)

- 마감 상태별: `closed` → 거부, `reopened` → 1회 생성, 재실행 → 0건, 다른 월 → 영향 없음.
- 8월 순감소 검증: C1(−60M) + R1 8월 인식(+50M, `recurring:<plan>:2026-08`) = **−10,000,000**.
- 9월: 임대료 +50M, C2·C3 −12,428,000.
- 자금 잔액(movement 합), 미납금, 카드 정산, 준비금 엔트리 불변.
- 감사 로그 3건, 원거래(#1055·#2191·#2192) 불변.
- 참고 fixture: `tests/ledger-recurring-rent-db.test.mjs`(운영 함수 본문 해시와 일치하는 정의를 설치함).

## 6. 재마감 예상 영업이익 (마감 기준 = 매출 − (원장 비용 + 카드 차액 매출월 귀속 보정))

| 월 | 현재 마감 | 예상 재마감 | 구성 |
|---|---|---|---|
| 8월 | 256,631,373.673 | **267,236,765.578** | 매출 734,634,810 − (477,480,641 − 10,000,000 − 82,596.578) |
| 9월 | 284,265,614.4 | **70,507,820.4** | 매출 691,165,200 − (583,085,379.6 + 50,000,000 − 12,428,000), 카드 귀속 0 |

8월 주의 — 카드 귀속 보정이 +522,795.327에서 −82,596.578로 바뀐다(차이 605,391.905):
- 8월 마감(rev 3, 2026-09-22) 당시 카드입금 #22(9/3)는 `matched`였다. 8월 매출 귀속 차액은 4,860,925.327이었다.
- 2026-09-29 `september_card_deposit_fifo_normalized`로 #22가 `auto_allocated`(차액 0)가 되었다. 그 차이는 9월 카드수수료 마감(#2384, 4,332,575, 9월 비용)에 이미 들어 있다.
- 지금 다시 계산하면 matched 기준 8월 매출 귀속은 4,255,533.422이다. 8월에 인식된 차액 4,338,130 중 82,596.578은 7월 매출분이다.
- 즉 현재 8·9월 마감본에 약 605,392₫이 중복되어 있다. 8월 재마감 때 자연 해소된다.
- 따라서 사용자가 제시한 266,631,373.673₫은 임대료만 반영한 값이고, 재마감 화면의 재계산 값은 267,236,765.578₫(±0.001₫ 반올림)이 맞다.

## 7. 정정하지 않는 항목

- 8월 BHXH #1446(8.1M)·#1447(22.528M): 귀속 기간 증빙 전 변경 금지
- 8/7 주류 지급계좌(#151~154), 8/27 주류 4,270,000(#1055 포함 가능성)
- 10월 VAT #3117(107,263,482): 별도 후속
- 10월 임대료: 미마감 월이므로 R1 동기화(`2026-10`)로 별도 반영
