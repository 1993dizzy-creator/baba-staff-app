import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildLedgerEntries, entryDisplaySubtotal, type LedgerEntry, type TransactionRow } from "../lib/ledger/entries.ts";
import { entryMatchesListFilter, LEDGER_ENTRY_FILTERS, type LedgerEntryFilter } from "../lib/ledger/entry-list-filter.ts";

const route = readFileSync("app/api/admin/ledger/route.ts", "utf8");
const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const day = "2026-09-20";
const at = (hour: number) => `${day}T${String(hour).padStart(2, "0")}:00:00+07:00`;
const cash = (amount: number) => [{ amount, fund_account: { id: 1, display_name: "매장 현금" } }];
const bank = (amount: number) => [{ amount, fund_account: { id: 2, display_name: "BABA 법인계좌" } }];
const tx = (id: number, fields: Partial<TransactionRow>): TransactionRow => ({
  id, type: "expense", status: "confirmed", business_date: day, occurred_at: at(9 + (id % 12)), amount: 1_000, source_type: "manual", ...fields,
});

// Visible rows plus every kind the ledger hides (dropped or flagged as system adjustment).
const transactions: TransactionRow[] = [
  // Payroll: actual payment + advance are visible; accrued company cost and reversals are not.
  tx(1, { type: "payroll_payment", source_type: "payroll_payment_group", source_key: "payroll-group:2026-09", amount: 50_000_000, movements: bank(-50_000_000), category: { name: "급여/인건비" } }),
  tx(2, { type: "expense_recognition", source_type: "payroll_completed_batch", source_key: "payroll-batch:2026-09", amount: 50_000_000, recognition_month: "2026-09-01", category: { name: "급여/인건비" } }),
  tx(3, { type: "payroll_payment", source_type: "manual", source_key: "payroll-advance-payment:abc", amount: 500_000, memo: "Quan 급여 가불", source_snapshot: { paymentKind: "advance", employee: "Quan" }, movements: cash(-500_000) }),
  tx(4, { type: "payroll_payment", source_type: "payroll_advance_payment_reversal", correction_of_id: 3, amount: 500_000, movements: cash(500_000) }),
  tx(5, { type: "payroll_payment", source_type: "payroll_payment_group_reversal", correction_of_id: 1, amount: 50_000_000, movements: bank(50_000_000) }),
  // Card: deposit, fee close and a valid difference are visible; reversals and technical rows are not.
  tx(10, { type: "card_settlement_deposit", source_type: "card_settlement_deposit", amount: 9_500_000, movements: bank(9_500_000) }),
  tx(11, { type: "expense", source_type: "card_fee_month_close", amount: 300_000, category: { name: "카드 수수료" } }),
  tx(12, { type: "expense", source_type: "card_settlement_difference", amount: 20_000, category: { name: "카드 수수료" }, source_snapshot: { matchedGrossAmount: 1_000_000, depositAmount: 980_000, differenceAmount: 20_000 } }),
  tx(13, { type: "expense", source_type: "card_settlement_difference_reversal", correction_of_id: 12, economic_effect_sign: -1, amount: 20_000 }),
  tx(14, { type: "expense", source_type: "card_fee_month_close_reversal", correction_of_id: 11, economic_effect_sign: -1, amount: 300_000 }),
  tx(15, { type: "card_settlement_deposit", source_type: "card_settlement_deposit_reversal", correction_of_id: 10, amount: 9_500_000, movements: bank(-9_500_000) }),
  tx(16, { type: "expense", source_type: "card_settlement_difference", amount: 5_000, memo: "기술적 보정 · 카드 상세 전환 상쇄" }),
  // Other hidden kinds.
  tx(20, { type: "opening", source_type: "opening", amount: 1_000_000, movements: cash(1_000_000) }),
  tx(21, { type: "expense", source_type: "ledger_correction", correction_of_id: 999, economic_effect_sign: -1, amount: 700, memo: "시스템 정정" }),
  tx(22, { type: "expense", source_type: "manual", amount: 3_000, memo: "잘못 입력", movements: cash(-3_000) }),
  tx(23, { type: "expense", source_type: "ledger_correction", correction_of_id: 22, economic_effect_sign: -1, amount: 3_000 }),
  tx(24, { type: "balance_adjustment", source_type: "manual", amount: 900, memo: "월말 잔액 맞춤", movements: cash(900) }),
  tx(25, { type: "balance_adjustment", source_type: "technical_adjustment", amount: 400, movements: cash(400) }),
  tx(26, { type: "income", source_type: "manual", amount: 2_000, memo: "기타 수입", movements: cash(2_000) }),
];
const entries: LedgerEntry[] = buildLedgerEntries(transactions, [], new Map(), [], "2026-09");
const idsFor = (filter: LedgerEntryFilter) => entries.filter(entry => entryMatchesListFilter(entry, filter)).map(entry => entry.transactionId).sort((a, b) => Number(a) - Number(b));
const allIds = idsFor("all");

test("no filter except 조정 can show a row that 전체 hides", () => {
  for (const filter of LEDGER_ENTRY_FILTERS) {
    if (filter === "adjustment") continue;
    const ids = idsFor(filter);
    assert.deepEqual(ids.filter(id => !allIds.includes(id)), [], filter);
  }
  // 조정 can only add manual balance adjustments, nothing else.
  assert.deepEqual(idsFor("adjustment"), [24]);
  for (const entry of entries.filter(entry => !allIds.includes(entry.transactionId))) {
    const reachable = LEDGER_ENTRY_FILTERS.filter(filter => entryMatchesListFilter(entry, filter));
    assert.deepEqual(reachable, entry.transactionId === 24 ? ["adjustment"] : [], `transaction ${entry.transactionId}`);
  }
});

test("전체 still shows exactly the previously visible rows, with the same day subtotal", () => {
  assert.deepEqual(allIds, [1, 3, 10, 11, 12, 26]);
  const before = entries.filter(entry => !entry.isSystemAdjustment);
  assert.deepEqual(entries.filter(entry => entryMatchesListFilter(entry, "all")), before);
  const subtotal = (rows: LedgerEntry[]) => rows.reduce((sum, entry) => {
    const value = entryDisplaySubtotal(entry);
    return { income: sum.income + value.income, expense: sum.expense + value.expense };
  }, { income: 0, expense: 0 });
  assert.deepEqual(subtotal(entries.filter(entry => entryMatchesListFilter(entry, "all"))), subtotal(before));
});

test("급여 shows only displayable payroll payments and advances, never accrued company cost or reversals", () => {
  assert.deepEqual(idsFor("payroll"), [1, 3]);
  // payroll_completed_batch accrual is dropped before any filter runs, so it can't duplicate the payment.
  assert.equal(entries.some(entry => entry.transactionId === 2), false);
  for (const id of [4, 5]) assert.equal(entries.find(entry => entry.transactionId === id)?.isSystemAdjustment, true, `reversal ${id}`);
  assert.equal(new Set(idsFor("payroll")).size, idsFor("payroll").length);
  assert.match(readFileSync("lib/ledger/entries.ts", "utf8"), /if \(row\.type === "expense_recognition" && row\.source_type === "payroll_completed_batch"\) continue;/);
});

test("카드 shows only visible deposits, valid differences and fees; reversals and technical rows stay hidden", () => {
  assert.deepEqual(idsFor("card"), [10, 11, 12]);
  for (const id of [13, 14, 15, 16]) assert.equal(entries.find(entry => entry.transactionId === id)?.isSystemAdjustment, true, `hidden card row ${id}`);
  // Cancelled legacy differences (September normalization) are never loaded at all.
  assert.match(route, /\.from\("ledger_transactions"\)\s*\.select\(TRANSACTION_SELECT\)\s*\.eq\("status", "confirmed"\)\.gte\("business_date", start\)/);
  assert.match(route, /\.eq\("status", "confirmed"\)\s*\.eq\("source_type", "ledger_correction"\)/);
});

test("page applies every filter through the shared helper only", () => {
  const loop = page.slice(page.indexOf("const groups = useMemo"), page.indexOf("const businessAccounts = useMemo"));
  assert.match(loop, /for \(const entry of listEntries\) \{\s*if \(!entryMatchesListFilter\(entry, filter\)\) continue;/);
  assert.doesNotMatch(loop, /isSystemAdjustment|filter ===/);
  const filterSource = readFileSync("lib/ledger/entry-list-filter.ts", "utf8");
  assert.match(filterSource, /^  if \(entry\.isSystemAdjustment\) return filter === "adjustment" && entry\.userAdjustment === "balance";$/m);
  assert.match(filterSource, /^  if \(entry\.paymentDifference\) return filter === "adjustment";$/m);
});
