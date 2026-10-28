import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { buildLedgerEntries, entryDisplaySubtotal, type LedgerEntry, type TransactionRow } from "../lib/ledger/entries.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { entryMatchesListFilter } from "../lib/ledger/entry-list-filter.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { entryDisplayBadgeKind, entryDisplayBadgeLabel } from "../lib/ledger/entry-display-badge.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { entryDisplayAmount, entryDisplayAmountSign, entryDisplayAmountTone } from "../lib/ledger/entry-display-amount.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { inventoryPurchaseStatusSummary } from "../lib/ledger/inventory-purchase-status.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { ledgerHrefWithoutInventoryFocus, parseInventoryLedgerFocus } from "../lib/ledger/inventory-entry-focus.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { ledgerMonthHref } from "../lib/ledger/month-query.ts";

// Regression rows are the production shapes (read-only lookup, 2026-10-28):
// #1304 8/11 annual rent paid 300M from the corporate bank; #3305 (9/1) and
// #3306 (10/1) the current lease's monthly 50M recognition with no movement and
// no payable; #3307 10/22 flour 1,101,600₫ booked as an unpaid payable.
const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const sections = readFileSync("app/(protected)/admin/ledger/entries/EntryStatusSections.tsx", "utf8");
const BANK = { id: 2, code: "baba_corporate_bank", display_name: "BABA 법인계좌" };
const rentPlan = { amount: 50_000_000, planId: 3, planName: "매장 임대료 (현 계약)", frequency: "monthly", effectiveTo: null, effectiveFrom: "2026-08-01", recognitionDay: 1 };
const recognition = (id: number, month: string): TransactionRow => ({
  id, type: "expense_recognition", status: "confirmed", business_date: `${month}-01`, recognition_month: `${month}-01`, amount: "50000000.000",
  source_type: "recurring_expense", source_key: `recurring:3:${month}`, memo: "매장 임대료 (현 계약)", economic_effect_sign: 1,
  category: { id: 40, name: "임대료" }, source_snapshot: rentPlan,
});
const prepaid1304: TransactionRow = {
  id: 1304, type: "prepaid_expense_payment", status: "confirmed", business_date: "2026-08-11", amount: "300000000.000",
  source_type: "legacy_sheet_detail", source_key: "legacy-sheet-detail:2026-08:row:132:annual-rent-payment", economic_effect_sign: 1,
  memo: "8월 시트 row 132 · 1년치 임대료 실제 지급 300,000,000₫ · 손익/60M 적립과 분리",
  source_snapshot: { accountingTreatment: "cash_outflow_only_no_monthly_expense" },
  movements: [{ amount: -300_000_000, fund_account: BANK }],
};
const flour3307: TransactionRow = {
  id: 3307, type: "expense", status: "confirmed", business_date: "2026-10-22", recognition_month: "2026-10-01", amount: "1101600.000",
  source_type: "inventory_purchase_candidate", source_key: "candidate:1978", party_id: 29, party: { name: "khác" }, economic_effect_sign: 1,
  category: { id: 31, name: "식자재" }, occurred_at: "2026-10-22T09:15:35+00:00",
  source_snapshot: { unit: "Kg", reason: "purchase", item_id: 625, category: "식자재", item_name: "지구표 999 강력분 밀가루", item_name_vi: "Bột mì địa cầu 999",
    category_vi: "Nguyên liệu", business_date: "2026-10-22", purchase_price: 22032, change_quantity: 50, purchase_amount: 1101600, inventory_log_id: 13849, paymentVerification: "pending" },
  payable: { id: 1631, original_amount: 1101600, due_date: null, status: "unpaid", allocations: [] },
};
const byId = (entries: readonly LedgerEntry[], id: number) => entries.find(entry => entry.transactionId === id)!;
const badge = (entry: LedgerEntry, lang: "ko" | "vi" = "ko") => entryDisplayBadgeLabel(entryDisplayBadgeKind(entry), lang);

test("deep link: the focus parameters are one-shot and never follow a month switch", () => {
  const search = "month=2026-10&inventoryLogId=13849&sourceKey=inventory-log%3A13849";
  assert.deepEqual(parseInventoryLedgerFocus(new URLSearchParams(search)), { logId: 13849, sourceKey: "inventory-log:13849" });
  assert.equal(ledgerHrefWithoutInventoryFocus("/admin/ledger/entries", search), "/admin/ledger/entries?month=2026-10");
  assert.equal(ledgerHrefWithoutInventoryFocus("/admin/ledger/entries", "inventoryLogId=1"), "/admin/ledger/entries");
  assert.equal(ledgerMonthHref("/admin/ledger/entries", search, "2026-09"), "/admin/ledger/entries?month=2026-09");
  assert.equal(ledgerMonthHref("/admin/ledger/entries", "month=2026-10&view=x", "2026-09"), "/admin/ledger/entries?month=2026-09&view=x");
  // Used once, then replaced (not pushed) so back/forward and remounts don't reopen it.
  const effect = page.slice(page.indexOf("const focusHandledRef"), page.indexOf("function editCandidate"));
  assert.match(effect, /focusHandledRef\.current = handledKey;\s*router\.replace\(ledgerHrefWithoutInventoryFocus\(pathname, searchParams\.toString\(\)\), \{ scroll: false \}\);/);
  assert.doesNotMatch(effect, /router\.push/);
});

test("#3305/#3306 monthly rent: 선납배분, actual payment 0₫, outside the day's 지출 and never 미납/미지정", () => {
  const entries = buildLedgerEntries([recognition(3305, "2026-09"), recognition(3306, "2026-10")], [], new Map(), [], "2026-10");
  for (const id of [3305, 3306]) {
    const rent = byId(entries, id);
    // rent: true → hidden from the daily list since the A plan (shown in 임대료 관리); see tests/ledger-rent-a-integration.test.ts.
    assert.deepEqual(rent.prepaidAllocation, { planName: "매장 임대료 (현 계약)", monthlyAmount: 50_000_000, effectiveFrom: "2026-08-01", rent: true });
    assert.deepEqual(rent.systemDisplay, { kind: "rent" });
    // The accounting identity is unchanged: still a profit expense of 50M.
    assert.equal(rent.direction, "expense");
    assert.equal(rent.participatesInProfit, true);
    assert.equal(rent.amount, 50_000_000);
    assert.equal(rent.settlementStatus, undefined);
    assert.equal(rent.accountName, null);
    assert.equal(badge(rent), "선납배분");
    assert.equal(badge(rent, "vi"), "Phân bổ trả trước");
    assert.equal(entryDisplayAmount(rent), 50_000_000);
    assert.equal(entryDisplayAmountSign(rent), "");
    assert.equal(entryDisplayAmountTone(rent), "transfer");
    // Before: the day header read 지출 50,000,000₫. Now 0 — no money moved that day.
    assert.deepEqual(entryDisplaySubtotal(rent), { income: 0, expense: 0 });
    assert.equal(entryMatchesListFilter(rent, "all"), true);
    assert.equal(entryMatchesListFilter(rent, "expense"), true);
    for (const filter of ["unpaid", "partial", "payment"] as const) assert.equal(entryMatchesListFilter(rent, filter), false, filter);
  }
  assert.match(page, /if \(entry\?\.prepaidAllocation\) return lang === "vi" \? "Đã trả trước" : "선납";/);
  assert.match(page, /"월 손익 반영 · 실제 지급 0₫"/);
  // The day header names the allocation separately from 지출: P&L only.
  assert.match(page, /if \(entry\.prepaidAllocation\) group\.allocation \+= entry\.amount \* entry\.economicEffectSign;/);
  assert.match(page, /group\.filterAmount === null && group\.allocation > 0/);
  assert.match(page, /"선납배분"\} \{money\(group\.allocation\)\} \(\{vi \? "lãi lỗ" : "손익만"\}\)/);
  // At 360px the allocation note shrinks first, so the row count stays visible.
  const css = readFileSync("app/(protected)/admin/ledger/entries/entries.module.css", "utf8");
  assert.match(css, /\.dateHeader \.dateSummary>b\.dateAllocation\{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/);
  assert.match(sections, /`월 손익: 비용 \$\{money\(entry\.amount\)\}에 포함됩니다\.`/);
  assert.match(sections, /날짜별 지출 합계와 실제 지출에 넣지 않으며/);
  assert.match(sections, /"선납 비용배분 · 추가 결제 불필요"/);
  assert.match(sections, /\[vi \? "Thực trả" : "실제 지급", money\(0\)\]/);
});

test("#1304 annual rent paid in advance stays a real 300M cash outflow, read as 선납 지급", () => {
  const entries = buildLedgerEntries([prepaid1304], [], new Map(), [], "2026-08");
  const paid = byId(entries, 1304);
  assert.equal(paid.prepaidPayment, true);
  assert.equal(paid.prepaidAllocation, undefined);
  assert.equal(paid.participatesInProfit, false);
  assert.equal(paid.accountName, "BABA 법인계좌");
  assert.equal(badge(paid), "지출");
  assert.equal(entryDisplayAmountSign(paid), "−");
  assert.deepEqual(entryDisplaySubtotal(paid), { income: 0, expense: 300_000_000 });
  assert.match(page, /"선납 지급 · 손익은 월별 배분"/);
});

test("only a movement-free, payable-free recurring recognition is a prepaid allocation", () => {
  const withMovement = { ...recognition(9001, "2026-10"), movements: [{ amount: -50_000_000, fund_account: BANK }] };
  const withPayable = { ...recognition(9002, "2026-10"), payable: { id: 1, original_amount: 50_000_000, allocations: [] } };
  const cardFee: TransactionRow = { id: 2384, type: "expense_recognition", status: "confirmed", business_date: "2026-10-08", amount: 4_332_575,
    source_type: "card_fee_month_close", source_key: "card-fee-closure:1", movements: [{ amount: -4_332_575, fund_account: BANK }] };
  const entries = buildLedgerEntries([withMovement, withPayable, cardFee], [], new Map(), [], "2026-10");
  for (const id of [9001, 9002, 2384]) assert.equal(byId(entries, id).prepaidAllocation, undefined, String(id));
});

test("#3307 10/22 flour: 미납, purchase 1,101,600 · paid 0 · remaining 1,101,600, pay from 미납금", () => {
  const entries = buildLedgerEntries([flour3307], [], new Map(), [], "2026-10");
  const flour = entries.find(entry => entry.items.some(item => item.transactionId === 3307))!;
  assert.equal(badge(flour), "미납");
  assert.equal(flour.accountName, "미지급");
  assert.equal(flour.items[0].inventoryLogId, 13849);
  // Booked as 결제 미확인: paid from 미납금 현황 › 기타, not from a party's 미납금.
  assert.equal(flour.items[0].paymentVerificationPending, true);
  assert.match(sections, /"지급했다면 \[미납금 현황\] › \[기타 · 결제 미확인\]에서 \[개별 결제\]로 기록하세요\."/);
  assert.deepEqual(inventoryPurchaseStatusSummary(flour), { payable: true, original: 1_101_600, effective: 1_101_600, paid: 0, remaining: 1_101_600, adjustment: 0, state: "unpaid", verificationPending: true });
  // The unpaid purchase still counts in the day's 지출 (an obligation that will be paid).
  assert.deepEqual(entryDisplaySubtotal(flour), { income: 0, expense: 1_101_600 });
});

test("purchase status: partial, paid, a non-cash small difference and an immediate purchase", () => {
  const pay = (id: number, amount: number) => ({ allocated_amount: amount, payment: { id, type: "payable_payment", source_type: "manual", amount, business_date: "2026-10-23", status: "confirmed" } });
  const writeoff = { allocated_amount: 1_600, payable_id: 1631, payment: { id: 7001, type: "expense", source_type: "ledger_correction", economic_effect_sign: -1, amount: 1_600,
    business_date: "2026-10-24", status: "confirmed", source_key: "payable-small-diff:2026-10:1631", movements: [],
    source_snapshot: { adjustmentType: "payable_small_difference_writeoff", nonCash: true, cashMovementAmount: 0, payableId: 1631, originalTransactionId: 3307, originalAmount: 1_101_600, writeoffAmount: 1_600 } } };
  const variant = (allocations: unknown[]) => buildLedgerEntries([{ ...flour3307, payable: { ...flour3307.payable!, allocations } } as TransactionRow], [], new Map(), [], "2026-10")[0];
  assert.deepEqual(inventoryPurchaseStatusSummary(variant([pay(8001, 600_000)])), { payable: true, original: 1_101_600, effective: 1_101_600, paid: 600_000, remaining: 501_600, adjustment: 0, state: "partial", verificationPending: true });
  assert.deepEqual(inventoryPurchaseStatusSummary(variant([pay(8001, 1_101_600)])), { payable: true, original: 1_101_600, effective: 1_101_600, paid: 1_101_600, remaining: 0, adjustment: 0, state: "paid", verificationPending: false });
  // Paid 1,100,000 and wrote off 1,600 without cash: exact difference, nothing left to pay.
  assert.deepEqual(inventoryPurchaseStatusSummary(variant([pay(8001, 1_100_000), writeoff])), { payable: true, original: 1_101_600, effective: 1_100_000, paid: 1_100_000, remaining: 0, adjustment: 1_600, state: "paid", verificationPending: false });
  const immediate = buildLedgerEntries([{ ...flour3307, payable: null, movements: [{ amount: -1_101_600, fund_account: BANK }] }], [], new Map(), [], "2026-10")[0];
  assert.deepEqual(inventoryPurchaseStatusSummary(immediate), { payable: false, original: 1_101_600, effective: 1_101_600, paid: 1_101_600, remaining: 0, adjustment: 0, state: "paid", verificationPending: false });
});

test("purchase detail: compact status first; settlement, audit and JSON only under 고급 상세", () => {
  // Per-state rendering is covered in ledger-inventory-purchase-status.test.mjs.
  for (const label of ["매입금액", "실제 지급액", "미지급 잔액"]) assert.match(sections, new RegExp(`"${label}"`));
  assert.match(sections, /"미납금 현황 열기"/);
  assert.match(sections, /const openPayables = payable && remaining > 0 \? onOpenPayableParty \?\? onShowPayables : undefined;/);
  assert.match(sections, /display\.changes\.map\(change =>/);
  const sheet = page.slice(page.indexOf("function EntryDetailSheet("), page.indexOf("function editRefreshFailureMessage"));
  assert.match(sections, /if \(entry\.drilldown !== "inventory"\) return null;/);
  const status = sheet.indexOf("<InventoryPurchaseStatus "), items = sheet.indexOf('entry.drilldown === "inventory" ? (\n        <div className={styles.itemList}>'), advanced = sheet.indexOf("<InventoryAdvancedDetails ");
  assert.ok(status > 0 && status < items && items < advanced, `${status} ${items} ${advanced}`);
  // The item rows no longer open 원입고 정산 inline; it moved, unchanged, into the advanced section.
  assert.doesNotMatch(sheet, /<PurchaseSettlementDetails /);
  const advancedFn = page.slice(page.indexOf("function InventoryAdvancedDetails("), page.indexOf("function PayablePaymentHistorySection("));
  assert.match(advancedFn, /<details className=\{styles\.advancedDetails\}/);
  assert.match(advancedFn, /<PurchaseSettlementDetails settlement=\{item\.purchaseSettlement!\} vi=\{vi\} \/>/);
  assert.match(advancedFn, /<InventoryPurchaseCaseDetails key=\{issue\.inventoryLogId\} issue=\{issue\} vi=\{vi\} \/>/);
  const settlement = readFileSync("components/ledger/PurchaseSettlementDetails.tsx", "utf8");
  for (const kept of ["비현금 소액조정", "지급·조정 감사 내역", "JSON.stringify(a.sourceSnapshot,null,2)"]) assert.ok(settlement.includes(kept), kept);
});
