import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node strip-types requires the extension.
import { buildLedgerEntries, entryDisplaySubtotal } from "../lib/ledger/entries.ts";
// @ts-expect-error Node strip-types requires the extension.
import { entryDisplayBadgeKind, entryDisplayBadgeLabel } from "../lib/ledger/entry-display-badge.ts";
// @ts-expect-error Node strip-types requires the extension.
import { entryCategoryEmoji } from "../lib/ledger/entry-display-emoji.ts";
// @ts-expect-error Node strip-types requires the extension.
import { accountTransferBadgeLabel } from "../lib/ledger/entry-display-account.ts";

const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const manualDisplayEditor = readFileSync("app/(protected)/admin/ledger/entries/ManualDisplayEditor.tsx", "utf8");
const route = readFileSync("app/api/admin/ledger/route.ts", "utf8");

const build = (rows: Parameters<typeof buildLedgerEntries>[0]) => buildLedgerEntries(rows, [], new Map());

test("historical and new advances omit the amount from the title", () => {
  const advances = build([
    { id: 1, type: "payroll_payment", status: "confirmed", business_date: "2026-09-03", amount: 2_000_000, source_type: "manual", source_key: "payroll-advance-payment:2026-09-03:user:4", memo: "9/3 Quan 급여 가불 2,000,000₫" },
    { id: 2, type: "payroll_payment", status: "confirmed", business_date: "2026-09-29", amount: 2_000_000, source_type: "manual", source_snapshot: { paymentKind: "advance", employee: "Triem" }, memo: "Triem 급여 가불 2,000,000₫" },
  ]);
  const historical = advances.find(entry => entry.transactionId === 1)!;
  const current = advances.find(entry => entry.transactionId === 2)!;
  assert.deepEqual([historical.title, current.title], ["Quan 급여 가불", "Triem 급여 가불"]);
  assert.deepEqual([historical.amount, current.amount], [2_000_000, 2_000_000]);
});

test("card settlement display keeps accounting direction and separates legacy from new fees", () => {
  const cardEntries = build([
    { id: 1, type: "card_settlement_deposit", status: "confirmed", business_date: "2026-09-03", amount: 42_879_074, source_type: "card_settlement_deposit" },
    { id: 2, type: "expense", status: "confirmed", business_date: "2026-09-03", amount: 949_886, source_type: "card_settlement_difference", source_snapshot: { matchedGrossAmount: 43_828_960, depositAmount: 42_879_074, differenceAmount: 949_886 } },
    { id: 3, type: "expense", status: "confirmed", business_date: "2026-09-29", amount: 100_000, source_type: "card_fee_month_close" },
    { id: 4, type: "sales", status: "confirmed", business_date: "2026-09-29", amount: 500_000, source_type: "pos_sales_daily_payment", source_key: "pos:2026-09-29:card", category: { name: "카드매출" } },
  ]);
  const byId = (id: number) => cardEntries.find(entry => entry.transactionId === id)!;
  const [deposit, legacy, fee, pos] = [1, 2, 3, 4].map(byId);
  assert.equal(deposit.direction, "transfer");
  assert.deepEqual(entryDisplaySubtotal(deposit), { income: 0, expense: 0 });
  // Card settlement rows use the dedicated [카드] badge; accounting direction is unchanged.
  assert.equal(entryDisplayBadgeLabel(entryDisplayBadgeKind(deposit), "ko"), "카드");
  assert.equal(entryCategoryEmoji(deposit), "💳");
  assert.equal(legacy.direction, "expense");
  assert.equal(entryDisplayBadgeKind(legacy), "card");
  assert.equal(entryDisplayBadgeKind(fee), "card");
  assert.equal(entryDisplayBadgeKind(pos), "income");
  assert.equal(entryCategoryEmoji(legacy), "💳");
  assert.equal(legacy.systemDisplay?.kind, "cardSettlementDifference");
  if (legacy.systemDisplay?.kind !== "cardSettlementDifference") throw new Error("Missing legacy identity");
  assert.deepEqual([legacy.systemDisplay.matchedGrossAmount, legacy.systemDisplay.depositAmount, legacy.systemDisplay.differenceAmount], [43_828_960, 42_879_074, 949_886]);
  assert.equal((legacy.systemDisplay.differenceAmount! / legacy.systemDisplay.matchedGrossAmount! * 100).toFixed(2), "2.17");
  assert.equal(fee.systemDisplay?.kind, "cardFeeMonthClose");
  assert.equal(entryCategoryEmoji(fee), "💳");
  assert.equal(entryCategoryEmoji(pos), "🧾");
  for (const text of ["카드 실제 입금", "기존 카드 정산차액", "카드 수수료", "카드정산", "과거 카드정산 방식에서 카드매출 매칭금액과 실제 입금액의 차액으로 확정된 기록입니다.", "정산 대상 카드매출", "실제 입금", "정산차액", "차이율"]) assert.ok(page.includes(text), text);
});

test("title override flows through shared list, detail and search display", () => {
  const [edited, automatic, payroll, card, sourced] = build([
    { id: 1, type: "expense", status: "confirmed", business_date: "2026-09-29", amount: 10_000, source_type: "manual", memo: "새 메모", display_snapshot: { titleOverride: "새 제목" } },
    { id: 2, type: "expense", status: "confirmed", business_date: "2026-09-29", amount: 10_000, source_type: "automatic" },
    { id: 3, type: "payroll_payment", status: "confirmed", business_date: "2026-09-29", amount: 10_000, source_type: "manual" },
    { id: 4, type: "card_settlement_deposit", status: "confirmed", business_date: "2026-09-29", amount: 10_000, source_type: "card_settlement_deposit" },
    { id: 5, type: "income", status: "confirmed", business_date: "2026-09-29", amount: 10_000, source_type: "manual", source_key: "generated" },
  ]);
  assert.equal(edited.title, "새 제목");
  assert.equal(edited.memo, "새 메모");
  assert.equal(edited.editableManualDisplay, true);
  for (const entry of [automatic, payroll, card]) assert.equal(entry.editableManualDisplay, false);
  assert.equal(sourced.editableManualDisplay, true);
  assert.match(route, /source_snapshot,display_snapshot,/);
  assert.match(page, /entryDisplayTitle\(entry, lang\)/);
  assert.match(page, /!`\$\{entryDisplayTitle\(entry, lang\)\}/);
  assert.match(page, /<ManualDisplayEditor/);
  assert.match(manualDisplayEditor, /amountEditable \? "\/manual-edit" : "\/display"/);
});

test("production-shaped #1661 is editable and reaches the detail edit controls", () => {
  const [entry] = build([{
    id: 1661, type: "expense", source_type: "manual", status: "confirmed",
    correction_of_id: null, source_key: "sheet-manual-expense:2026-09:row-120",
    business_date: "2026-09-12", amount: 4_500_000,
    memo: "diet con trun thang 678 · 해충방제",
    movements: [{ amount: -4_500_000, fund_account: { display_name: "BABA 법인계좌" } }],
  }]);
  assert.equal(entry.editableManualDisplay, true);
  assert.equal(entry.drilldown, "generic");
  assert.equal(entry.title, "diet con trun thang 678 · 해충방제");
  assert.match(page, /entry\.editableManualDisplay \? <button type="button"[\s\S]*?"수정"/);
  assert.match(page, /manualDisplayOpen && entry\.editableManualDisplay && entry\.transactionId != null/);
  assert.match(page, /<ManualDisplayEditor[\s\S]*?transactionId=\{entry\.transactionId\}/);
});

test("manual payable payment #1675 can edit its title and memo without changing payment identity", () => {
  const [entry] = build([{
    id: 1675, type: "payable_payment", source_type: "manual", status: "confirmed",
    correction_of_id: null, source_key: "delayed-purchase-payment:inventory-log:10017:2026-09-04",
    business_date: "2026-09-04", amount: 1_900_000,
    memo: "8/29 켄트 담배 50개 매입분 실제 지연결제 · 9/4 Cho 계좌 1,900,000₫",
    source_snapshot: { paymentKind: "delayed_purchase_payment", originalBusinessDate: "2026-08-29", originalTransactionId: 794, originalInventoryLogId: 10017, itemName: "켄트 담배", quantity: 50, purchasePrice: 38000 },
    movements: [{ amount: -1_900_000, fund_account: { display_name: "개인(Cho)" } }],
    display_snapshot: { titleOverride: "켄트 담배 지연결제" },
  }]);
  assert.equal(entry.editableManualDisplay, true);
  assert.equal(entry.title, "켄트 담배 지연결제");
  assert.equal(entry.memo, "8/29 켄트 담배 50개 매입분 실제 지연결제 · 9/4 Cho 계좌 1,900,000₫");
  assert.equal(entry.amount, 1_900_000);
  assert.equal(entry.accountName, "개인(Cho)");
  assert.equal(entry.systemDisplay?.kind, "payablePayment");
  assert.match(page, /if \(display\?\.kind === "payablePayment"\) \{\s*if \(entry\.title\.trim\(\)\) return entry\.title/);
});

test("manual edit whitelist includes generic transfer and payable but excludes payroll, auto and corrections", () => {
  const entries = build([
    { id: 1, type: "income", source_type: "manual", status: "confirmed", business_date: "2026-09-12", amount: 10 },
    { id: 2, type: "expense", source_type: "manual", status: "confirmed", business_date: "2026-09-12", amount: 10 },
    { id: 3, type: "transfer", source_type: "manual", status: "confirmed", business_date: "2026-09-12", amount: 10 },
    { id: 4, type: "payable_payment", source_type: "manual", status: "confirmed", business_date: "2026-09-12", amount: 10 },
    { id: 5, type: "payroll_payment", source_type: "manual", status: "confirmed", business_date: "2026-09-12", amount: 10 },
    { id: 6, type: "payable_payment", source_type: "automatic", status: "confirmed", business_date: "2026-09-12", amount: 10 },
    { id: 7, type: "expense", source_type: "manual", status: "confirmed", correction_of_id: 1, business_date: "2026-09-12", amount: 10 },
  ]);
  const byId = (id: number) => entries.find(entry => entry.transactionId === id)!;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(id => byId(id).editableManualDisplay),
    [true, true, true, true, false, false, false]);
});

test("movement-confirmed #1724 transfer displays Cho to cash and strips only its duplicate route clause", () => {
  const input = {
    id: 1724, type: "transfer", source_type: "manual", status: "confirmed",
    business_date: "2026-09-12", amount: 1_500_000,
    memo: "9월 시트 row122 · doi tien mat · Cho → 현금 1,500,000₫",
    movements: [
      { amount: -1_500_000, fund_account: { display_name: "Cho 개인계좌 (BABA 소유분)" } },
      { amount: 1_500_000, fund_account: { display_name: "매장 현금" } },
    ],
  };
  const [entry] = build([input]);
  assert.equal(entry.title, "doi tien mat");
  assert.deepEqual(entry.systemDisplay, {
    kind: "accountTransfer", fromAccountName: "Cho 개인계좌 (BABA 소유분)", toAccountName: "매장 현금",
  });
  assert.equal(entry.memo, input.memo);
  if (entry.systemDisplay?.kind !== "accountTransfer") throw new Error("Missing transfer route");
  assert.equal(accountTransferBadgeLabel(entry.systemDisplay, "ko"), "Cho → 현금");
  assert.equal(accountTransferBadgeLabel(entry.systemDisplay, "vi"), "Cho → Tiền mặt");
  assert.equal(entry.accountName, "Cho 개인계좌 (BABA 소유분)");
  assert.match(page, /accountBadgeLabel\(entry\.accountName, lang, entry\)/);
});

test("account transfer route follows movement signs, and ambiguous movements retain fallback", () => {
  const movement = (amount: number, display_name: string) => ({ amount, fund_account: { display_name } });
  const base = { type: "transfer", source_type: "manual", status: "confirmed", business_date: "2026-09-12", amount: 100 };
  const entries = build([
    { ...base, id: 1, movements: [movement(100, "매장 현금"), movement(-100, "개인(Cho)")] },
    { ...base, id: 2, movements: [movement(-100, "개인(Cho)"), movement(100, "매장 현금"), movement(10, "법인")] },
    { ...base, id: 3, movements: [movement(-100, "개인(Cho)"), movement(90, "매장 현금")] },
  ]);
  const byId = (id: number) => entries.find(entry => entry.transactionId === id)!;
  assert.deepEqual(byId(1).systemDisplay, { kind: "accountTransfer", fromAccountName: "개인(Cho)", toAccountName: "매장 현금" });
  assert.equal(byId(2).systemDisplay, undefined);
  assert.equal(byId(3).systemDisplay, undefined);
  assert.equal(byId(2).accountName, "개인(Cho)");
});

test("manual metadata is shown once beside generic and payable rows", () => {
  assert.match(page, /subtitle === "수동 입력" && entry\.origin === "manual" \? "" : subtitle/);
});
