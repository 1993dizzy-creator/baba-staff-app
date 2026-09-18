import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const page=readFileSync("app/(protected)/admin/ledger/entries/page.tsx","utf8");
const css=readFileSync("app/(protected)/admin/ledger/entries/entries.module.css","utf8");
const postcss=createRequire(import.meta.url)("postcss") as typeof import("postcss");
const {groupPayableRows}=createRequire(import.meta.url)("../lib/ledger/payable-date-groups.ts") as typeof import("../lib/ledger/payable-date-groups");
const stylesheet=postcss.parse(css);
const historical=page.slice(page.indexOf("function HistoricalPayablePartySheet"),page.indexOf("function PayablePartySheet"));
const current=page.slice(page.indexOf("function PayablePartySheet"),page.indexOf("function payableItemLabel"));

test("past and current payable sheets share dated expandable items",()=>{
  assert.match(historical,/<PayableDateGroups rows=\{rows\} lang=\{lang\}\/>/);
  assert.match(current,/<PayableDateGroups rows=\{detail\?\.payables\?\?\[\]\} lang=\{lang\}/);
  assert.match(page,/function PayableDateGroups[\s\S]*group\.rows\.length[\s\S]*payableItemLabel/);
  assert.match(historical,/<PayableMonthTotals summary=\{party\}/);
});

test("past sheet reads selected month response and has no payment controls",()=>{
  assert.match(page,/rows=\{payables\.historyPayables\.filter\(row => Number\(row\.party_id\) === payableParty\.partyId\)\}/);
  assert.doesNotMatch(historical,/\/api\/admin\/ledger\/payables\/\$\{|type="checkbox"|AccountField|onPaid|paymentForm|ledger\/payables\/pay/);
  assert.match(historical,/onClose=\{onClose\}/);
  assert.match(current,/\/api\/admin\/ledger\/payables\/\$\{party\.partyId\}/);
  assert.match(current,/\/api\/admin\/ledger\/payables\/pay/);
});

test("historical header uses the existing partner category badge without an icon",()=>{
  assert.match(historical,/<div className=\{styles\.payableDetailPartner\}><span className=\{styles\.partnerTypeBadge\}>\{partnerTypeLabel\(party\.partnerType,lang\)\}<\/span><strong>\{party\.partyName\}<\/strong><\/div>/);
  assert.doesNotMatch(historical,/🏷|🤝/);
  assert.match(page,/alcohol: "주류"/);
  assert.match(css,/\.payableDetailPartner>\.partnerTypeBadge\{[^}]*background:#f3f4f6/);
});

test("historical hint uses a short single-line app-font style",()=>{
  assert.match(historical,/className=\{styles\.payableReadOnlyHint\}/);
  assert.match(historical,/선택월 말 기준 잔액입니다\. 과거 내역은 결제할 수 없습니다\./);
  assert.match(historical,/Số dư cuối tháng đã chọn\. Không thể thanh toán giao dịch cũ\./);
  assert.match(css,/\.payableReadOnlyHint\{[^}]*font-family:inherit;font-size:11px;[^}]*white-space:nowrap/);
});

test("historical dated rows include fully paid entries and only paid dates get the badge",()=>{
  const rows=[
    {outstandingAmount:0,settlementStatus:"paid" as const,expense:{business_date:"2026-08-01"}},
    {outstandingAmount:3_170_000,settlementStatus:"partial" as const,expense:{business_date:"2026-08-22"}},
    {outstandingAmount:100,settlementStatus:"unpaid" as const,expense:{business_date:"2026-08-24"}},
  ];
  const historicalGroups=groupPayableRows(rows,true);
  assert.deepEqual(historicalGroups.map(group=>[group.businessDate,group.settlementStatus,group.total]),[
    ["2026-08-01","paid",0],["2026-08-22","partial",3_170_000],["2026-08-24","unpaid",100],
  ]);
  assert.deepEqual(groupPayableRows(rows).map(group=>group.businessDate),["2026-08-22","2026-08-24"]);
  assert.equal(groupPayableRows([
    {outstandingAmount:0,paidAmount:100,expense:{business_date:"2026-08-05"}},
    {outstandingAmount:50,paidAmount:0,expense:{business_date:"2026-08-05"}},
  ],true)[0].settlementStatus,"partial");
  assert.match(page,/groupPayableRows\(rows,!selectable\)/);
  assert.match(page,/const paidReadOnly=!selectable&&group\.settlementStatus==="paid"/);
  assert.match(page,/paidReadOnly\?<em className=\{styles\.payablePaidBadge\}>\{vi\?"Đã thanh toán":"결제완료"\}<\/em>:null/);
  assert.match(css,/\.payableDateRow \.payablePaidBadge\{[^}]*background:#e8f7ef/);
});

test("paid historical dates and expanded items hide zero amounts while other balances remain visible",()=>{
  assert.match(page,/paidReadOnly\?null:<strong>\{money\(group\.total\)\}<\/strong>/);
  assert.match(page,/paidReadOnly\?null:<b>\{money\(row\.outstandingAmount\)\}<\/b>/);
  assert.match(css,/\.payableDateRow>button>i\{grid-column:4\}/);
  const groups=groupPayableRows([
    {outstandingAmount:0,settlementStatus:"paid" as const,expense:{business_date:"2026-08-13"}},
    {outstandingAmount:3_170_000,settlementStatus:"partial" as const,expense:{business_date:"2026-08-22"}},
    {outstandingAmount:1_038_984,settlementStatus:"unpaid" as const,expense:{business_date:"2026-08-23"}},
  ],true);
  assert.deepEqual(groups.map(group=>[group.settlementStatus,group.total]),[["paid",0],["partial",3_170_000],["unpaid",1_038_984]]);
  assert.equal(groups.slice(1).reduce((sum,group)=>sum+group.total,0),4_208_984);
});

test("read-only rows use one full-width column while selectable rows keep the checkbox gutter",()=>{
  const declaration=(selector:string,property:string)=>{
    let result:string|undefined;
    stylesheet.walkRules(rule=>{
      if(rule.selectors.includes(selector))rule.walkDecls(property,decl=>{result=decl.value});
    });
    return result;
  };
  assert.equal(declaration(".payableDateRow","grid-template-columns"),"28px minmax(0,1fr)");
  assert.equal(declaration(".payableDateRowReadOnly","grid-template-columns"),"minmax(0,1fr)");
  assert.equal(declaration(".payableDateRowReadOnly>button","width"),"100%");
  assert.match(page,/const selectable=Boolean\(onSelectDate\)/);
  assert.match(page,/!selectable \? styles\.payableDateRowReadOnly : ""/);
  assert.match(page,/selectable&&onSelectDate\?<input type="checkbox"/);
  assert.match(page,/onClick=\{\(\)=>setExpanded\(/);
});

test("read-only items remove the checkbox indent without changing selectable ellipsis",()=>{
  assert.match(css,/\.payableItems\{display:grid;padding:0 0 6px 28px\}/);
  assert.match(css,/\.payableDatesReadOnly \.payableItems\{padding-left:8px\}/);
  assert.match(css,/\.payableItems em\{[^}]*text-overflow:ellipsis;white-space:nowrap/);
  assert.match(page,/!selectable \? styles\.payableDatesReadOnly : ""/);
});
