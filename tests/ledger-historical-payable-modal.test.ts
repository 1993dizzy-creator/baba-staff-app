import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page=readFileSync("app/(protected)/admin/ledger/entries/page.tsx","utf8");
const historical=page.slice(page.indexOf("function HistoricalPayablePartySheet"),page.indexOf("function PayablePartySheet"));
const current=page.slice(page.indexOf("function PayablePartySheet"),page.indexOf("function payableItemLabel"));

test("past and current payable sheets share dated expandable items",()=>{
  assert.match(historical,/<PayableDateGroups rows=\{rows\} lang=\{lang\}\/>/);
  assert.match(current,/<PayableDateGroups rows=\{detail\?\.payables\?\?\[\]\} lang=\{lang\}/);
  assert.match(page,/function PayableDateGroups[\s\S]*group\.rows\.length[\s\S]*payableItemLabel/);
  assert.match(historical,/<PayableMonthTotals summary=\{party\}/);
});

test("past sheet reads selected month response and has no payment controls",()=>{
  assert.match(page,/rows=\{payables\.payables\.filter\(row => Number\(row\.party_id\) === payableParty\.partyId\)\}/);
  assert.doesNotMatch(historical,/\/api\/admin\/ledger\/payables\/\$\{|type="checkbox"|AccountField|onPaid|paymentForm|ledger\/payables\/pay/);
  assert.match(historical,/onClose=\{onClose\}/);
  assert.match(current,/\/api\/admin\/ledger\/payables\/\$\{party\.partyId\}/);
  assert.match(current,/\/api\/admin\/ledger\/payables\/pay/);
});
