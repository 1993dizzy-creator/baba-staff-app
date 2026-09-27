import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const sheet = page.slice(page.indexOf("function ManualEntrySheet"), page.indexOf("function AccountField"));
const api = readFileSync("app/api/admin/ledger/route.ts", "utf8");

function inOrder(source: string, markers: string[]) {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `expected ${marker} after index ${cursor}`);
    cursor = next;
  }
}

test("expense fields keep amount -> partner -> category -> account -> date -> time -> memo DOM order", () => {
  inOrder(sheet, [
    'data-manual-field="amount"',
    'data-manual-field="partner"',
    'data-manual-field="expense-category"',
    'fieldName="expense-account"',
    'data-manual-field="date"',
    'data-manual-field="time"',
    'data-manual-field="memo"',
  ]);
});

test("partner selection switches category between mapped readonly and the existing dropdown", () => {
  assert.match(sheet, /selectedPartner \? \(\s*<input[\s\S]*?readOnly[\s\S]*?manualExpenseCategoryName/);
  assert.match(sheet, /\) : \(\s*<select[^>]*data-manual-field="expense-category"/);
  assert.match(sheet, /data\.categories\s*\.filter\(isManualExpenseCategory\)/);
  assert.match(sheet, /setPartnerId\(event\.target\.value\)/);
  assert.doesNotMatch(sheet, /재고 입고·기존 미납금 지급은 해당 기능에서 처리하세요|Hãy xử lý nhập kho|manualHelp|manualFieldStack/);
});

test("partner select keeps none first and renders policy groups as optgroups", () => {
  const partnerSelect = sheet.slice(sheet.indexOf('data-manual-field="partner"'), sheet.indexOf("</select>", sheet.indexOf('data-manual-field="partner"')));
  inOrder(partnerSelect, ['<option value="">', "partnerGroups.map", "<optgroup", "group.partners.map"]);
  assert.match(sheet, /activePartners = data\.partners\.filter\(\(row\) => row\.isActive\)/);
  assert.match(sheet, /partnerGroups = groupManualEntryPartners\(activePartners, lang\)/);
  assert.match(sheet, /<optgroup key=\{group\.group\} label=\{group\.label\}>/);
});

test("manual income select uses only the fixed income policy and preserves categoryId POST", () => {
  assert.match(sheet, /type === "income"[\s\S]*?\.filter\(isManualIncomeCategory\)[\s\S]*?\.sort\(manualIncomeCategorySort\)/);
  assert.match(sheet, /data-manual-field="income-category"[\s\S]*?value=\{categoryId\}[\s\S]*?setCategoryId\(event\.target\.value\)/);
  assert.match(sheet, /categoryId:[\s\S]*?Number\(selectedPartner\?\.manualExpenseCategoryId \?\? categoryId\)/);
  assert.doesNotMatch(sheet, /POS 매출/);
});

test("general balance adjustments keep positive amount and route direction to one account", () => {
  assert.match(sheet, /parseLedgerAmount\(amount\)/);
  assert.match(sheet, /balanceDirection === "decrease"[\s\S]*?Number\(fromAccountId\)/);
  assert.match(sheet, /balanceDirection === "increase"[\s\S]*?Number\(toAccountId\)/);
  assert.match(sheet, /label=\{`⚖️ \$\{vi \? "Lý do điều chỉnh" : "조정 사유"\}`\}[\s\S]*?required/);
  assert.doesNotMatch(sheet, /Number\(amount\)\s*[<>]=?\s*0/);
});

test("investment adjustments use only the atomic investments endpoint and guard unconfigured months", () => {
  assert.match(sheet, /isInvestmentAdjustment \? "\/api\/admin\/ledger\/investments" : "\/api\/admin\/ledger"/);
  assert.match(sheet, /participantId: Number\(participantId\)/);
  assert.match(sheet, /action: investmentAction/);
  assert.match(sheet, /fundAccountId: Number\(investmentAction === "contribution" \? toAccountId : fromAccountId\)/);
  assert.match(sheet, /adjustmentType === "investment" && !investments\?\.configured/);
  assert.match(sheet, /<option value="investment" disabled=\{!investments\?\.configured\}/);
});

test("ledger API resolves partner party and active category authoritatively", () => {
  assert.match(api, /businessPartnerId/);
  assert.match(api, /business_partner_ledger_parties/);
  assert.match(api, /manualExpenseCategoryNameForPartner/);
  assert.match(api, /\.eq\("name", categoryName\)\.eq\("kind", "expense"\)\.eq\("is_active", true\)/);
  assert.match(api, /p_category_id: categoryId, p_party_id: partyId/);
  assert.match(api, /PARTNER_CATEGORY_MISSING/);
});
