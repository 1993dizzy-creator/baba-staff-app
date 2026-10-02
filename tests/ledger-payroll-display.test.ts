import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildLedgerEntries, entryDisplaySubtotal, entryMatchesExpenseFilter, isPayrollPaymentOutflow } =
  require("../lib/ledger/entries.ts") as typeof import("../lib/ledger/entries");
const { entryDisplayBadgeKind, entryDisplayBadgeLabel } =
  require("../lib/ledger/entry-display-badge.ts") as typeof import("../lib/ledger/entry-display-badge");
const { entryDisplayAmountSign, entryDisplayAmountTone } =
  require("../lib/ledger/entry-display-amount.ts") as typeof import("../lib/ledger/entry-display-amount");
const { entryCategoryEmoji } =
  require("../lib/ledger/entry-display-emoji.ts") as typeof import("../lib/ledger/entry-display-emoji");
const { computePaidExpenseTotal } =
  require("../lib/ledger/payables.ts") as typeof import("../lib/ledger/payables");
const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const route = readFileSync("app/api/admin/ledger/route.ts", "utf8");

const build = (rows: Parameters<typeof buildLedgerEntries>[0]) =>
  buildLedgerEntries(rows, [], new Map(), [], "2026-09");

test("only payroll_completed_batch expense_recognition is omitted from entries", () => {
  const rows = [
    { id: 1254, type: "expense_recognition", source_type: "payroll_completed_batch", source_key: "payroll-batch:1:company-cost", status: "confirmed", business_date: "2026-09-11", recognition_month: "2026-08-01", amount: 172_539_197, category: { name: "급여/인건비" }, movements: [] },
    { id: 1255, type: "expense_recognition", source_type: "other_month_close", status: "confirmed", business_date: "2026-09-11", amount: 100 },
    { id: 1256, type: "expense", source_type: "payroll_completed_batch", status: "confirmed", business_date: "2026-09-11", amount: 200 },
    { id: 1257, type: "expense_recognition", source_type: "payroll_other", status: "confirmed", business_date: "2026-09-11", amount: 300 },
  ];
  const entries = build(rows);
  assert.deepEqual(entries.map(entry => entry.transactionId).sort(), [1255, 1256, 1257]);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].recognition_month, "2026-08-01");
});

test("actual payroll payment outflow is a red display expense with unchanged transfer direction", () => {
  const [entry] = build([{
    id: 1300, type: "payroll_payment", source_type: "payroll_payment_group", status: "confirmed",
    business_date: "2026-09-10", amount: 137_195_248,
    movements: [{ amount: -137_195_248, fund_account: { display_name: "법인" } }],
  }]);
  assert.equal(entry.direction, "transfer");
  assert.equal(entry.participatesInProfit, false);
  assert.equal(entry.fundFlow, "outflow");
  assert.equal(entry.accountName, "법인");
  assert.equal(isPayrollPaymentOutflow(entry), true);
  assert.equal(entryDisplayBadgeLabel(entryDisplayBadgeKind(entry), "ko"), "지출");
  assert.equal(entryCategoryEmoji(entry), "👥");
  assert.equal(entryDisplayAmountSign(entry), "−");
  assert.equal(entryDisplayAmountTone(entry), "expense");
  assert.equal(entryMatchesExpenseFilter(entry), true);
  assert.deepEqual(entryDisplaySubtotal(entry), { income: 0, expense: 137_195_248 });
  assert.match(page, /amountClassByTone\[entryDisplayAmountTone\(entry\)\]/);
  assert.match(page, /if \(!entryMatchesListFilter\(entry, filter\)\) continue;/);
  assert.match(readFileSync("lib/ledger/entry-list-filter.ts", "utf8"), /case "expense": return entryMatchesExpenseFilter\(entry\);/);
  assert.match(page, /group\.expense \+= subtotal\.expense/);
});

test("payroll inflow and movement-free rows are not display expenses", () => {
  const entries = build([
    { id: 1, type: "payroll_payment", source_type: "payroll_advance_payment_reversal", status: "confirmed", business_date: "2026-09-10", amount: 100, movements: [{ amount: 100 }] },
    { id: 2, type: "payroll_payment", source_type: "manual", status: "confirmed", business_date: "2026-09-10", amount: 100, movements: [] },
  ]);
  for (const entry of entries) {
    assert.equal(entry.direction, "transfer");
    assert.equal(isPayrollPaymentOutflow(entry), false);
    assert.equal(entryDisplayBadgeKind(entry), "transfer");
    assert.equal(entryDisplayAmountSign(entry), "");
    assert.equal(entryDisplayAmountTone(entry), "transfer");
    assert.equal(entryMatchesExpenseFilter(entry), false);
    assert.deepEqual(entryDisplaySubtotal(entry), { income: 0, expense: 0 });
  }
});

test("advance outflow enters the daily display subtotal but not P&L", () => {
  const [entry] = build([{
    id: 1, type: "payroll_payment", source_type: "manual", source_key: "payroll-advance-payment:2026-09-02:user:4",
    source_snapshot: { paymentKind: "advance", employee: "Quan" },
    status: "confirmed", business_date: "2026-09-02", amount: 100,
    movements: [{ amount: -100, fund_account: { display_name: "현금" } }],
  }]);
  assert.equal(entry.title, "Quan 급여 가불");
  assert.equal(entryCategoryEmoji(entry), "👥");
  assert.equal(entryDisplayBadgeKind(entry), "expense");
  assert.equal(entryDisplayAmountSign(entry), "−");
  assert.equal(entryDisplayAmountTone(entry), "expense");
  assert.equal(entry.accountName, "현금");
  assert.deepEqual(entryDisplaySubtotal(entry), { income: 0, expense: 100 });
  assert.equal(entry.participatesInProfit, false);
  const recognizedCost = computePaidExpenseTotal([{
    id: 1254, amount: 172_539_197, economicEffectSign: 1, sourceType: "payroll_completed_batch",
    correctionOfId: null, payableStatus: null, allocatedAmount: 0, corrections: [],
  }]);
  assert.equal(recognizedCost, 172_539_197);
});

test("ordinary transfer, payable, unpaid expense and investment retain their display rules", () => {
  const entries = build([
    { id: 1, type: "transfer", source_type: "manual", status: "confirmed", business_date: "2026-09-10", amount: 100, movements: [{ amount: -100 }, { amount: 100 }] },
    { id: 2, type: "payable_payment", source_type: "manual", status: "confirmed", business_date: "2026-09-10", amount: 100, movements: [{ amount: -100 }] },
    { id: 3, type: "expense", source_type: "manual", status: "confirmed", business_date: "2026-09-10", amount: 100, payable: { original_amount: 100, allocations: [] } },
    { id: 4, type: "investment", source_type: "owner_investment", status: "confirmed", business_date: "2026-09-10", amount: 100, movements: [{ amount: -100 }], source_snapshot: { entryType: "recovery" } },
  ]);
  const byId = (id: number) => entries.find(entry => entry.transactionId === id)!;
  assert.equal(entryDisplayBadgeKind(byId(1)), "transfer");
  assert.equal(entryDisplayAmountTone(byId(1)), "transfer");
  assert.equal(entryMatchesExpenseFilter(byId(1)), false);
  assert.equal(entryDisplayBadgeKind(byId(2)), "payment");
  assert.equal(entryDisplayAmountTone(byId(2)), "transfer");
  assert.equal(entryDisplayAmountSign(byId(2)), "");
  assert.equal(entryMatchesExpenseFilter(byId(2)), false);
  assert.equal(entryDisplayBadgeKind(byId(3)), "unpaid");
  assert.equal(entryDisplayAmountTone(byId(3)), "expense");
  assert.equal(entryMatchesExpenseFilter(byId(3)), true);
  assert.equal(entryDisplayBadgeKind(byId(4)), "investment");
  assert.equal(entryDisplayAmountSign(byId(4)), "−");
  assert.equal(entryDisplayAmountTone(byId(4)), "transfer");
  assert.equal(entryMatchesExpenseFilter(byId(4)), false);
});

test("the API keeps raw transactions and computes summary expense before building display entries", () => {
  assert.match(route, /const paidExpense = computePaidExpenseTotal\(paidExpenseRoots\)/);
  assert.match(route, /const displayedExpense = computeDisplayedExpense\(paidExpense, transactions\)/);
  assert.match(route, /const entries = \[\s*\.\.\.buildLedgerEntries\(displayTransactions,/);
  assert.match(route, /operatingProfit: recognizedIncome - expense/);
  assert.match(route, /profitTransactions: profitRows, parties: partiesResult\.data \?\? \[\], partners, transactions: displayTransactions, entries/);
});

test("production-shaped August company cost stays off the daily list while four cash payments total 149,405,248", () => {
  const amounts = [137_195_248, 7_650_000, 3_000_000, 1_560_000];
  const dates = ["2026-09-10", "2026-09-10", "2026-09-11", "2026-09-12"];
  const rows = [
    { id: 1254, type: "expense_recognition", source_type: "payroll_completed_batch", status: "confirmed", business_date: "2026-09-11", recognition_month: "2026-08-01", amount: 172_539_197, movements: [] },
    ...amounts.map((amount, index) => ({
      id: 1300 + index, type: "payroll_payment", source_type: "payroll_payment_group",
      status: "confirmed", business_date: dates[index], amount,
      movements: [{ amount: -amount, fund_account: { display_name: index === 0 ? "법인" : "현금" } }],
    })),
  ];
  const entries = build(rows);
  assert.equal(entries.length, 4);
  assert.equal(entries.some(entry => entry.transactionId === 1254), false);
  assert.equal(entries.reduce((sum, entry) => sum + entryDisplaySubtotal(entry).expense, 0), 149_405_248);
  assert.deepEqual(entries.map(entry => entry.direction), ["transfer", "transfer", "transfer", "transfer"]);
});
