import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { calculateMonthCloseRevenue } from "../lib/ledger/month-close-revenue.ts";
import { allocateCardDifferenceBySaleMonth } from "../lib/ledger/card-difference-attribution.ts";
import { calculateMonthCloseOperatingSummary } from "../lib/ledger/month-close-operating.ts";

test("August close applies sale-month card attribution to expense and operating profit", () => {
  const recognized = [
    {type:"sales",source_type:"pos_sales_daily_payment",source_key:"pos:2026-08:card",amount:731129010,economic_effect_sign:1,category:null},
    {type:"sales",source_type:"ledger_correction",source_key:null,amount:3505800,economic_effect_sign:1,category:null},
    {type:"expense_recognition",source_type:"card_settlement_difference",source_key:"card-reconciliation:1:difference",amount:4338130,economic_effect_sign:1,category:{name:"카드 정산 차액"}},
    {type:"expense",source_type:"manual",source_key:null,amount:478260731,economic_effect_sign:1,category:{name:"기타 비용"}},
  ];
  const lines = [
    {reconciliationId:1,businessDate:"2026-07-31",allocatedGrossAmount:1000000,matchedGrossAmount:2000000,differenceAmount:8000000},
    {reconciliationId:1,businessDate:"2026-08-01",allocatedGrossAmount:1000000,matchedGrossAmount:2000000,differenceAmount:8000000},
    {reconciliationId:22,businessDate:"2026-08-31",allocatedGrossAmount:224925720,matchedGrossAmount:449851440,differenceAmount:"1721850.652"},
    {reconciliationId:22,businessDate:"2026-09-01",allocatedGrossAmount:224925720,matchedGrossAmount:449851440,differenceAmount:"1721850.652"},
  ];
  const snapshot = calculateMonthCloseOperatingSummary("2026-08", recognized, lines);
  assert.equal(snapshot.revenue.total,734634810);
  assert.equal(snapshot.expense.attributedCardDifference,4860925.326);
  assert.equal(snapshot.expense.depositMonthRecognizedDifference,4338130);
  assert.equal(snapshot.expense.cardAttributionAdjustment,522795.326);
  assert.equal(snapshot.expense.total,483121656.326);
  assert.equal(snapshot.operatingResult.operatingProfit,251513153.674);
});

test("August close includes confirmed sales corrections without altering POS payment buckets", () => {
  const revenue = calculateMonthCloseRevenue([
    {type:"sales",source_type:"pos_sales_daily_payment",source_key:"pos:2026-08:card",amount:731129010,economic_effect_sign:1},
    {type:"sales",source_type:"ledger_correction",source_key:null,amount:3505800,economic_effect_sign:1},
  ]);
  assert.equal(revenue.card,731129010);
  assert.equal(revenue.adjustment,3505800);
  assert.equal(revenue.total,734634810);
});

test("card difference follows sale month across July/August and August/September deposits", () => {
  const lines = [
    {reconciliationId:1,businessDate:"2026-07-31",allocatedGrossAmount:1000000,matchedGrossAmount:2000000,differenceAmount:8000000},
    {reconciliationId:1,businessDate:"2026-08-01",allocatedGrossAmount:1000000,matchedGrossAmount:2000000,differenceAmount:8000000},
    {reconciliationId:22,businessDate:"2026-08-31",allocatedGrossAmount:224925720,matchedGrossAmount:449851440,differenceAmount:"1721850.652"},
    {reconciliationId:22,businessDate:"2026-09-01",allocatedGrossAmount:224925720,matchedGrossAmount:449851440,differenceAmount:"1721850.652"},
  ];
  const byMonth = allocateCardDifferenceBySaleMonth(lines);
  assert.equal(lines.filter(line=>line.businessDate.startsWith("2026-08")).reduce((sum,line)=>sum+Number(line.allocatedGrossAmount),0),225925720);
  assert.equal(byMonth["2026-08"],4860925.326);
  assert.equal(Math.round((byMonth["2026-08"]-4338130)*1000)/1000,522795.326);
  assert.equal(Math.round(Object.values(byMonth).reduce((sum,value)=>sum+value,0)*1000),9721850652);
});

test("a 0.001 remainder is allocated deterministically to the earliest month", () => {
  const lines=["2026-07-01","2026-08-01","2026-09-01"].map(businessDate=>({reconciliationId:1,businessDate,allocatedGrossAmount:1,matchedGrossAmount:3,differenceAmount:"0.001"}));
  assert.deepEqual(allocateCardDifferenceBySaleMonth(lines),{"2026-07":0.001,"2026-08":0,"2026-09":0});
});

test("month-close excludes inactive recurring plans and retains card fund snapshot path", () => {
  const source=fs.readFileSync("lib/ledger/month-close.ts","utf8");
  assert.match(source,/from\("ledger_recurring_expense_plans"\).*\.eq\("is_active",true\)/);
  assert.match(source,/calculateMonthCloseCardSnapshot\(cards,cardLines,cardSales,endExclusive\)/);
  assert.match(source,/calculateMonthCloseOperatingSummary\(month, recognized, cardFeeLines\)/);
  assert.match(source,/return \{month,revenue,expense,operatingResult,funds:/);
  assert.match(source,/\.eq\("reconciliation.status","matched"\)/);
  assert.match(fs.readFileSync("lib/ledger/month-close-operating.ts","utf8"),/card_settlement_difference_reversal/);
});
