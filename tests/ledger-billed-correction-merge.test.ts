import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildLedgerEntries, entryDisplaySubtotal, withPaymentDifferenceAdjustments, type LedgerEntry, type TransactionRow } from "../lib/ledger/entries.ts";
import { entryMatchesListFilter, type LedgerEntryFilter } from "../lib/ledger/entry-list-filter.ts";

// Paid-receipt billed-amount corrections (inventory_purchase_billed_correction) are folded into
// the purchase they correct: one final amount per item, no separate expense row.
const nov2 = "2026-11-02", nov4 = "2026-11-04", month = "2026-11-01";
const account = (id: number, name: string) => (amount: number) => [{ amount, fund_account: { id, display_name: name } }];
const cash = account(1, "매장 현금"), bank = account(5, "BABA 법인계좌");

function purchase(id: number, date: string, partyId: number, party: string, item: string, amount: number, paymentId: number, pay: typeof cash): TransactionRow[] {
  const payment = { id: paymentId, type: "payable_payment", business_date: date, status: "confirmed", amount, movements: pay(-amount) };
  return [
    { id, type: "expense", status: "confirmed", business_date: date, recognition_month: month, occurred_at: `${date}T10:00:00+07:00`, amount,
      source_type: "inventory_purchase_candidate", party_id: partyId, party: { name: party }, category: { name: "재고매입" },
      source_snapshot: { item_name: item, inventory_log_id: id + 10_000, change_quantity: 1, purchase_price: amount },
      payable: { id: id + 50_000, original_amount: amount, status: "paid", allocations: [{ allocated_amount: amount, payment }] } },
    { id: paymentId, type: "payable_payment", status: "confirmed", business_date: date, occurred_at: `${date}T12:00:00+07:00`, amount,
      source_type: "inventory_purchase_payment", party_id: partyId, party: { name: party }, movements: pay(-amount) },
  ];
}
function correction(id: number, originalId: number, date: string, previous: number, billed: number, pay: typeof cash): TransactionRow {
  return { id, type: "expense", status: "confirmed", business_date: date, recognition_month: month, occurred_at: `${date}T12:00:00+07:00`,
    amount: previous - billed, economic_effect_sign: -1, correction_of_id: originalId, source_type: "inventory_purchase_billed_correction",
    source_key: `inventory-log:${id}:paid-billed`, memo: `실청구금액 정정(지급완료 입고): ${previous}.000 → ${billed}`,
    source_snapshot: { originalTransactionId: originalId, previousAmount: previous, billedAmount: billed, difference: previous - billed }, movements: pay(previous - billed) };
}

const rows: TransactionRow[] = [
  ...purchase(3673, nov2, 7, "Shopee", "MOSA 가스", 543_150, 3684, cash),
  ...purchase(3677, nov2, 8, "WinMart", "살라미", 339_200, 3683, cash),
  ...purchase(3678, nov2, 7, "Shopee", "철판", 332_100, 3685, bank),
  ...purchase(3936, nov4, 7, "Shopee", "볼펜", 84_240, 4066, bank),
  ...purchase(3937, nov4, 7, "Shopee", "방향제", 146_424, 4065, bank),
  correction(4110, 3673, nov2, 543_150, 543_000, cash),
  correction(4111, 3677, nov2, 339_200, 339_000, cash),
  correction(4112, 3678, nov2, 332_100, 332_000, bank),
  correction(4130, 3936, nov4, 84_240, 84_000, bank),
  // #4131: manual extra cost with no correction link — must stay its own row, never auto-linked.
  { id: 4131, type: "expense", status: "confirmed", business_date: nov4, recognition_month: month, occurred_at: `${nov4}T12:00:00+07:00`, amount: 576,
    source_type: "manual", party_id: 7, memo: "Shopee 방향제 실제 지급 147,000₫ 부족액 576₫", movements: bank(-576) },
];
const entries = withPaymentDifferenceAdjustments(buildLedgerEntries(rows, [], new Map(), [], "2026-11"));
const listed = (filter: LedgerEntryFilter = "all") => entries.filter(entry => entryMatchesListFilter(entry, filter));
const itemOf = (transactionId: number) => entries.flatMap(entry => entry.items).find(item => item.transactionId === transactionId)!;
const dayExpense = (date: string, filter: LedgerEntryFilter = "all") => listed(filter).filter(entry => entry.businessDate === date)
  .reduce((sum, entry) => sum + entryDisplaySubtotal(entry).expense, 0);

test("11/2 corrections #4110–#4112 show one final billed amount on the original item", () => {
  assert.equal(itemOf(3673).billedCorrection?.finalAmount, 543_000);
  assert.equal(itemOf(3677).billedCorrection?.finalAmount, 339_000);
  assert.equal(itemOf(3678).billedCorrection?.finalAmount, 332_000);
  assert.deepEqual(itemOf(3673).billedCorrection, {
    originalAmount: 543_150, finalAmount: 543_000, difference: -150,
    corrections: [{ transactionId: 4110, businessDate: nov2, previousAmount: 543_150, billedAmount: 543_000, difference: -150,
      reason: "실청구금액 정정(지급완료 입고): 543150.000 → 543000" }],
  });
  // The booked transaction amount (edit source) is unchanged.
  assert.equal(itemOf(3673).amount, 543_150);
});

test("11/4 pen correction #4130 shows 84,000₫; manual #4131 stays a separate unlinked row", () => {
  assert.equal(itemOf(3936).billedCorrection?.finalAmount, 84_000);
  assert.equal(itemOf(3937).billedCorrection, undefined);
  const manual = listed().find(entry => entry.transactionId === 4131);
  assert.equal(manual?.amount, 576);
  assert.equal(manual?.direction, "expense");
});

test("correction vouchers get no list row of their own in any filter", () => {
  for (const filter of ["all", "expense", "payment", "adjustment", "manual"] as LedgerEntryFilter[])
    for (const id of [4110, 4111, 4112, 4130]) assert.equal(listed(filter).some(entry => entry.transactionId === id), false, `${filter} #${id}`);
  assert.equal(entries.some(entry => [4110, 4111, 4112, 4130].includes(entry.transactionId ?? 0)), false);
});

test("group amounts, accounts, paid status and day subtotals carry the final amounts once", () => {
  const groups = entries.filter(entry => entry.drilldown === "inventory" && entry.businessDate === nov2);
  const byAccount = new Map(groups.map(group => [`${group.title}:${group.accountName}`, group]));
  assert.equal(byAccount.get("Shopee:매장 현금")?.amount, 543_000);
  assert.equal(byAccount.get("WinMart:매장 현금")?.amount, 339_000);
  assert.equal(byAccount.get("Shopee:BABA 법인계좌")?.amount, 332_000);
  for (const group of groups) assert.equal(group.settlementStatus, "paid");
  // Before: 1,214,450 booked − 450 corrections (as separate −rows). After: same net, in the purchase rows.
  assert.equal(dayExpense(nov2), 543_000 + 339_000 + 332_000);
  assert.equal(dayExpense(nov2, "expense"), 543_000 + 339_000 + 332_000);
  assert.equal(dayExpense(nov4), 84_000 + 146_424 + 576);
  // Payment rows stay read inside their purchases (no double count).
  assert.equal(listed().some(entry => entry.paymentTransaction), false);
});

test("multiple corrections of one item sum; out-of-view or unexpected corrections keep their own row", () => {
  const multi = buildLedgerEntries([
    ...purchase(1, nov2, 7, "Shopee", "가스", 10_000, 2, cash),
    correction(3, 1, nov2, 10_000, 9_800, cash),
    correction(4, 1, nov2, 9_800, 9_500, cash),
    correction(5, 999, nov2, 1_000, 900, cash), // original not in this view (e.g. another month)
    { ...correction(6, 1, nov2, 9_500, 9_400, cash), recognition_month: "2026-12-01" }, // different P&L month
  ], [], new Map(), [], "2026-11");
  const item = multi.flatMap(entry => entry.items).find(row => row.transactionId === 1)!;
  assert.equal(item.billedCorrection?.finalAmount, 9_500);
  assert.deepEqual(item.billedCorrection?.corrections.map(row => [row.transactionId, row.difference]), [[3, -200], [4, -300]]);
  for (const id of [5, 6]) {
    const kept = multi.find(entry => entry.transactionId === id);
    assert.ok(kept, `#${id} kept`);
    assert.equal(entryMatchesListFilter(kept!, "all"), true);
    assert.equal(entryDisplaySubtotal(kept!).expense, -100);
  }
  const total = multi.filter(entry => entryMatchesListFilter(entry, "all")).reduce((sum, entry) => sum + entryDisplaySubtotal(entry as LedgerEntry).expense, 0);
  assert.equal(total, 9_500 - 100 - 100);
});

test("detail shows a collapsed correction history and ?transactionId= of a correction opens its purchase", () => {
  const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
  assert.match(page, /item\.billedCorrection\?\.finalAmount \?\? item\.purchaseSettlement\?\.effectiveAmount \?\? item\.amount/);
  assert.match(page, /<details[^>]*data-testid="billed-correction-history"/);
  assert.match(page, /정정 전표"\} #\$\{row\.transactionId\}/);
  assert.match(page, /item\.billedCorrection\?\.corrections\.some\(correction => correction\.transactionId === focusTransactionId\)/);
});
