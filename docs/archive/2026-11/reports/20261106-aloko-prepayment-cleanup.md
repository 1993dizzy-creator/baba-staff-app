# Aloko 6,402,000₫ 선결제 중복 기장 정리 절차 (승인 전 실행 금지)

작성 2026-11-06 · 대상: #4126(수기비용), #4150(입고비용) · #1903(미지급) · #4159(지급) · 운영 DB 변경 없음(이 문서는 절차만 정의)

## 1. 현재 상태 (2026-11-05 읽기 전용 조회)

| 전표 | 내용 | 자금이동 |
|---|---|---|
| #4126 | 수기 expense 11/4, 6,402,000, `source_snapshot={}`, 연결 없음 | 법인계좌 −6,402,000 (#2157) |
| #4150 | 입고 expense 11/5 (입고 #14959), 미지급 #1903 생성 | 없음 |
| #4159 | payable_payment 11/4, #1903에 6,402,000 배분(#1997) | 법인계좌 −6,402,000 (#2209) |

중복: 비용 2회(#4126, #4150), 법인계좌 출금 2회(#2157, #2209). 실제 거래는 11/4 선지급 1회 + 11/5 입고 1회.

## 2. 목표 상태 = 새 선결제 기능의 결과와 동일

선결제 기능의 정상 결과는 "11/4 지급 전표 1건(출금 1회) → 11/5 입고 비용 1건 → 지급 전표가 입고 미지급에 배분"이다.
#4159(11/4, 법인계좌 −6,402,000, #1903에 전액 배분)와 #4150이 이미 정확히 그 구조이므로 **추가 생성·재배분 없이 #4126만 취소**하면 된다.

- #4159를 취소하고 새 선결제를 만들어 다시 연결하는 방식은 쓰지 않는다(쓰기 3배, #1903이 일시적으로 미지급이 됨, 결과는 동일).
- #4159의 `source_snapshot`에 `prepayment` 표시를 소급 추가하지 않는다(확정 전표 원천 변경 금지, 기능상 불필요).

## 3. 실행 절차 (사용자 승인 후, 앱 UI)

1. 사전 점검 SQL(아래 4-1)이 기대값과 정확히 일치하는지 확인한다. 하나라도 다르면 중단.
2. 앱 `/admin/ledger/entries` 11월 → #4126 수기 지출 → 기존 감사형 **삭제(취소)** 사용.
   사유: `Aloko 11/4 선지급 중복: 입고 #14959(#4150)·지급 #4159로 이미 기장됨`.
   - 기존 경로 `/api/admin/ledger/transactions/4126/cancel`(manual transaction cancel)만 사용. SQL 직접 실행 금지.
   - `ledger_manual_transaction_blocker_v1` 조건 충족: confirmed·manual·expense·snapshot `{}`·정정/미지급/배분/후보 연결 0건.
3. 사후 확인 SQL(4-2) 실행.

## 4. 점검 SQL (읽기 전용)

### 4-1. 사전 점검 (기대값)

```sql
select t.id, t.status, t.type, t.source_type, t.amount, t.business_date, t.source_snapshot,
  (select json_agg(json_build_object('acct',a.code,'amt',m.amount)) from ledger_movements m join ledger_fund_accounts a on a.id=m.fund_account_id where m.transaction_id=t.id) mv,
  (select count(*) from ledger_transactions c where c.correction_of_id=t.id) corrections,
  (select count(*) from ledger_payables p where p.expense_transaction_id=t.id) payables,
  (select count(*) from ledger_payable_allocations a where a.payment_transaction_id=t.id) allocations
from ledger_transactions t where t.id in (4126,4150,4159) order by t.id;
-- 기대: 4126 confirmed/expense/manual/6402000/2026-11-04/{}/[법인 -6402000]/0/0/0
--       4150 confirmed/expense/inventory_purchase_candidate/6402000/2026-11-05/mv null/0/1/0
--       4159 confirmed/payable_payment/manual/6402000/2026-11-04/[법인 -6402000]/0/0/1
select id,status,original_amount,(select sum(allocated_amount) from ledger_payable_allocations where payable_id=1903) allocated from ledger_payables where id=1903;
-- 기대: 1903 paid 6402000 6402000
select month,status from ledger_month_closures where month='2026-11-01';
-- 기대: 0행 (11월 열림)
```

### 4-2. 사후 확인

```sql
select id,status from ledger_transactions where id in (4126,4150,4159) order by id;
-- 기대: 4126 cancelled, 4150 confirmed, 4159 confirmed
select t.id, m.amount from ledger_movements m join ledger_fund_accounts a on a.id=m.fund_account_id join ledger_transactions t on t.id=m.transaction_id
where a.code='baba_corporate_bank' and t.status='confirmed' and t.business_date='2026-11-04' and m.amount=-6402000;
-- 기대: 1행 (#4159)
select sum(amount) from ledger_transactions where status='confirmed' and type='expense' and amount=6402000 and business_date between '2026-11-04' and '2026-11-05';
-- 기대: 6402000 (#4150 1건)
```

## 5. 영향과 보호

- 11월 비용 −6,402,000(중복 제거), 법인계좌 장부잔액 +6,402,000(중복 출금 제거). 미지급·재고·#1903·#4159 변화 없음.
- 비용 분류는 육류(#4126)→해산물(#4150), 인식일 11/4→11/5(같은 11월).
- 10월 마감(revision 1) 무관. 11월 마감 전 실행 필요(마감 후에는 재오픈 필요).
