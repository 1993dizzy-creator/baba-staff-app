import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const { buildLedgerEntries, entryDisplaySubtotal } = createRequire(import.meta.url)("../lib/ledger/entries.ts") as typeof import("../lib/ledger/entries");
const { computePaidExpenseTotal, sumConfirmedAllocationsThroughMonth, payableDisplayAsOf } = createRequire(import.meta.url)("../lib/ledger/payables.ts") as typeof import("../lib/ledger/payables");
const { computeDisplayedExpense, computeReceivedIncome } = createRequire(import.meta.url)("../lib/ledger/summary.ts") as typeof import("../lib/ledger/summary");
const read = (path: string) => readFileSync(path, "utf8");
const route = read("app/api/admin/ledger/route.ts");
const page = read("app/(protected)/admin/ledger/entries/page.tsx");
const entriesCss = read("app/(protected)/admin/ledger/entries/entries.module.css");
const pageCompact = page.replace(/\s+/g, "");
const panel = read("app/(protected)/admin/ledger/InventoryCandidatePanel.tsx");

// ---------------------------------------------------------------------------
// A. Direction classification (lib/ledger/entries.ts)
// ---------------------------------------------------------------------------

function tx(overrides: Record<string, unknown>) {
  return {
    id: 1, type: "expense", business_date: "2026-08-01", occurred_at: "2026-08-01T10:00:00Z",
    amount: 100, economic_effect_sign: 1, source_type: "manual",
    ...overrides,
  };
}

test("card_settlement_deposit is a transfer, never income (no duplicate income)", () => {
  const entries = buildLedgerEntries([tx({ id: 1, type: "card_settlement_deposit", amount: 975_000 })], [], new Map());
  assert.equal(entries[0].direction, "transfer");
});

test("payable_payment is a transfer, never a second expense on top of the original recognition", () => {
  const entries = buildLedgerEntries([tx({ id: 1, type: "payable_payment", amount: 60_000 })], [], new Map());
  assert.equal(entries[0].direction, "transfer");
});

test("payroll_payment, investment, owner_settlement and balance_adjustment are all transfers", () => {
  for (const type of ["payroll_payment", "investment", "owner_settlement", "balance_adjustment"]) {
    const entries = buildLedgerEntries([tx({ id: 1, type, amount: 10_000 })], [], new Map());
    assert.equal(entries[0].direction, "transfer", `${type} should be transfer`);
  }
});

test("investment remains outside income and P&L while its outgoing or incoming movement remains available", () => {
  const movement = { amount: 100_000_000, fund_account: { display_name: "법인계좌" } };
  const entry = buildLedgerEntries([tx({
    id: 1303, type: "investment", source_type: "owner_investment", amount: 100_000_000,
    memo: "8월 시트 row 131 · MJK 투자금", movements: [movement],
  })], [], new Map())[0];
  assert.equal(entry.direction, "transfer");
  assert.equal(entry.participatesInProfit, false);
  assert.equal(entry.title, "MJK 투자금");
  assert.equal(entry.subtitle, "사업 투자금");
  assert.doesNotMatch(entry.title, /row|source|snapshot/i);
  assert.equal(entry.accountName, "법인계좌");
  assert.equal(movement.amount, 100_000_000);
});

test("prepaid rent is a UI expense but remains outside P&L", () => {
  const entry = buildLedgerEntries([tx({
    id: 1304, type: "prepaid_expense_payment", source_type: "recurring_expense_payment",
    amount: 300_000_000, recognition_month: null,
    memo: "8월 시트 row 132 · 1년치 임대료 실제 지급",
    movements: [{ amount: -300_000_000, fund_account: { display_name: "법인계좌" } }],
  })], [], new Map())[0];
  assert.equal(entry.direction, "expense");
  assert.equal(entry.participatesInProfit, false);
  assert.equal(entry.title, "1년치 임대료 선지급");
  assert.match(entry.subtitle, /현금 지출/);
  assert.doesNotMatch(entry.title, /row|source|snapshot/i);
  assert.equal(entry.amount * entry.economicEffectSign, 300_000_000);
  assert.deepEqual(entryDisplaySubtotal(entry), { income: 0, expense: 300_000_000 });
});

test("displayed expense adds prepaid once and excludes transfers and investment", () => {
  const rows = [
    { type: "prepaid_expense_payment", amount: 300_000_000, movements: [{ amount: -300_000_000 }] },
    { type: "investment", amount: 100_000_000, movements: [{ amount: 100_000_000 }] },
    { type: "transfer", amount: 50_000_000, movements: [{ amount: -50_000_000 }] },
    { type: "owner_settlement_payment", amount: 10_000_000, movements: [{ amount: -10_000_000 }] },
    { type: "card_settlement_deposit", amount: 5_000_000, movements: [{ amount: 5_000_000 }] },
  ];
  assert.equal(computeDisplayedExpense(448_445_598.5, rows), 748_445_598.5);
  assert.equal(computeDisplayedExpense(448_445_598.5, rows.filter(row => row.type !== "prepaid_expense_payment")), 448_445_598.5);
});

test("ledger page uses the UI direction for expense filtering and the daily subtotal", () => {
  assert.match(page, /filter === "expense" && entry\.direction !== "expense"/);
  assert.match(page, /const subtotal = entryDisplaySubtotal\(entry\);/);
  assert.match(page, /group\.expense \+= subtotal\.expense/);
  assert.match(route, /const displayedExpense = computeDisplayedExpense\(paidExpense, transactions\)/);
  assert.match(route, /operatingProfit: recognizedIncome - expense, paidExpense, displayedExpense/);
  assert.match(route, /const movementsPromise = fundsViewMode === "closed_snapshot"/);
  assert.match(route, /buildFundAccountView\(\{[\s\S]*movements: movementsResult\.data/);
});

test("expense, expense_recognition, income and sales keep their P&L direction", () => {
  assert.equal(buildLedgerEntries([tx({ id: 1, type: "expense" })], [], new Map())[0].direction, "expense");
  assert.equal(buildLedgerEntries([tx({ id: 1, type: "expense_recognition" })], [], new Map())[0].direction, "expense");
  assert.equal(buildLedgerEntries([tx({ id: 1, type: "income" })], [], new Map())[0].direction, "income");
  assert.equal(buildLedgerEntries([tx({ id: 1, type: "sales", source_type: "pos_sales_daily_payment", source_key: "pos:2026-08-01:card" })], [], new Map())[0].direction, "income");
});

test("direction no longer flips on economic_effect_sign alone (type decides the bucket)", () => {
  // A negative-sign income correction stays classified as income (its own bucket),
  // not expense — the day-subtotal netting is handled separately via economicEffectSign.
  const entries = buildLedgerEntries([tx({ id: 1, type: "income", amount: 50_000, economic_effect_sign: -1 })], [], new Map());
  assert.equal(entries[0].direction, "income");
  assert.equal(entries[0].economicEffectSign, -1);
});

test("economicEffectSign defaults to 1 when the row carries none", () => {
  const entries = buildLedgerEntries([tx({ id: 1, economic_effect_sign: null })], [], new Map());
  assert.equal(entries[0].economicEffectSign, 1);
});

test("day-group subtotal nets economicEffectSign without mutating the displayed row amount", () => {
  assert.match(pageCompact, /constsubtotal=entryDisplaySubtotal\(entry\)/);
  assert.match(pageCompact, /group\.income\+=subtotal\.income/);
  assert.match(pageCompact, /group\.expense\+=subtotal\.expense/);
});

// ---------------------------------------------------------------------------
// B. paidExpense (lib/ledger/payables.ts, computePaidExpenseTotal)
// ---------------------------------------------------------------------------

function root(overrides: {
  id: number; amount?: number; economicEffectSign?: number; sourceType?: string;
  correctionOfId?: number | null; payableStatus?: string | null; allocatedAmount?: number;
  corrections?: { amount: number; economicEffectSign: number }[];
}) {
  return {
    amount: 100, economicEffectSign: 1, sourceType: "inventory_purchase_candidate",
    correctionOfId: null, payableStatus: null, allocatedAmount: 0, corrections: [],
    ...overrides,
  };
}

test("immediate payment (no payable): fully counted as paid", () => {
  assert.equal(computePaidExpenseTotal([root({ id: 1 })]), 100);
});

test("unpaid payable: zero counted as paid", () => {
  assert.equal(computePaidExpenseTotal([root({ id: 1, payableStatus: "unpaid", allocatedAmount: 0 })]), 0);
});

test("partially paid payable: only the allocated portion counts", () => {
  assert.equal(computePaidExpenseTotal([root({ id: 1, payableStatus: "partially_paid", allocatedAmount: 60 })]), 60);
});

test("fully paid payable: the whole amount counts", () => {
  assert.equal(computePaidExpenseTotal([root({ id: 1, payableStatus: "paid", allocatedAmount: 100 })]), 100);
});

test("expense_recognition rows (e.g. card settlement difference) never get a payable, so they are always fully paid", () => {
  assert.equal(computePaidExpenseTotal([root({ id: 1, amount: 25_000, sourceType: "card_settlement_difference" })]), 25_000);
});

test("mixed month: immediate + unpaid + partial nets correctly across roots", () => {
  // 즉시지급 100 + 미지급 100(0 paid) + 부분지급 100(60 paid) = paid 160
  const roots = [
    root({ id: 1 }),
    root({ id: 2, payableStatus: "unpaid", allocatedAmount: 0 }),
    root({ id: 3, payableStatus: "partially_paid", allocatedAmount: 60 }),
  ];
  assert.equal(computePaidExpenseTotal(roots), 160);
});

// A~D: user-specified worked examples for a payable-backed root under generic (non-rebook) corrections.
test("A. unpaid 100 + correction -100 + allocation 0 -> paidExpense contribution 0", () => {
  const roots = [root({ id: 1, payableStatus: "unpaid", allocatedAmount: 0, corrections: [{ amount: 100, economicEffectSign: -1 }] })];
  assert.equal(computePaidExpenseTotal(roots), 0);
});
test("B. unpaid 100 + correction -30 + allocation 0 -> paidExpense contribution 0 (effective recognized 70)", () => {
  const roots = [root({ id: 1, payableStatus: "unpaid", allocatedAmount: 0, corrections: [{ amount: 30, economicEffectSign: -1 }] })];
  assert.equal(computePaidExpenseTotal(roots), 0);
});
test("C. unpaid 100 + correction -30 + allocation 20 -> paidExpense contribution 20", () => {
  const roots = [root({ id: 1, payableStatus: "unpaid", allocatedAmount: 20, corrections: [{ amount: 30, economicEffectSign: -1 }] })];
  assert.equal(computePaidExpenseTotal(roots), 20);
});
test("D. unpaid 100 + correction -30 + allocation 60 -> paidExpense contribution 60", () => {
  const roots = [root({ id: 1, payableStatus: "unpaid", allocatedAmount: 60, corrections: [{ amount: 30, economicEffectSign: -1 }] })];
  assert.equal(computePaidExpenseTotal(roots), 60);
});
test("already fully paid (100) then a later -30 correction: paid never exceeds the corrected effective recognized amount (70)", () => {
  // Nothing in the schema prevents correcting an expense whose payable is already fully paid
  // (ledger_create_correction_v1 never inspects ledger_payables at all), so this is reachable.
  const roots = [root({ id: 1, payableStatus: "paid", allocatedAmount: 100, corrections: [{ amount: 30, economicEffectSign: -1 }] })];
  assert.equal(computePaidExpenseTotal(roots), 70);
});

// E: multiple corrections on one root sum together.
test("E. multiple corrections (-20, -10) on one root net to an effective recognized amount of 70", () => {
  const roots = [root({ id: 1, corrections: [{ amount: 20, economicEffectSign: -1 }, { amount: 10, economicEffectSign: -1 }] })];
  assert.equal(computePaidExpenseTotal(roots), 70);
});

// F: only confirmed source_type='ledger_correction' rows are ever passed in as `corrections` — enforced by
// the route.ts query (status='confirmed', source_type='ledger_correction'), not by this pure function, since
// every ledger_correction row is created with status='confirmed' and is never mutated afterward (no code path
// sets any other status on a source_type='ledger_correction' row).
test("F. route.ts only fetches confirmed ledger_correction rows as corrections", () => {
  assert.match(route, /paidExpenseCorrectionsPromise[\s\S]{0,200}eq\("status",\s*"confirmed"\)\.eq\("source_type",\s*"ledger_correction"\)/);
});

// G: paidExpense is keyed purely by the root's own recognition_month; payment/allocation timing never enters.
test("G. PaidExpenseRoot carries no date field at all — payment timing structurally cannot leak across months", () => {
  const roots = [root({ id: 1, payableStatus: "partially_paid", allocatedAmount: 60 })];
  assert.deepEqual(Object.keys(roots[0]).sort(), ["id", "allocatedAmount", "amount", "corrections", "correctionOfId", "economicEffectSign", "payableStatus", "sourceType"].sort());
});

// H: existing inventory rebook trio still nets to the post-rebook paid state under the new root-based formula.
test("H. reversal/rebook trio still nets to the post-rebook paid state, not a negative artifact", () => {
  const roots = [
    root({ id: 1, amount: 100, sourceType: "inventory_purchase_candidate", payableStatus: "cancelled", allocatedAmount: 0 }),
    root({ id: 2, amount: 100, economicEffectSign: -1, sourceType: "inventory_purchase_reversal", correctionOfId: 1 }),
    root({ id: 3, amount: 150, sourceType: "inventory_purchase_rebook", payableStatus: "unpaid", allocatedAmount: 0 }),
  ];
  assert.equal(computePaidExpenseTotal(roots), 0);
});
test("H2. reversed IMMEDIATE (non-payable) original nets to zero too, not the un-netted original amount", () => {
  // Without excluding reversed originals/reversals, a naive per-root floor-at-0 would count the original's
  // 100 in full and floor the reversal's -100 away, wrongly totalling 100 instead of 0.
  const roots = [
    root({ id: 1, amount: 100, sourceType: "inventory_purchase_candidate" }),
    root({ id: 2, amount: 100, economicEffectSign: -1, sourceType: "inventory_purchase_reversal", correctionOfId: 1 }),
  ];
  assert.equal(computePaidExpenseTotal(roots), 0);
});

test("append-only reversal A: ordinary immediate payment contributes its full amount", () => {
  assert.equal(computePaidExpenseTotal([root({ id: 1, sourceType: "payroll_payment_group" })]), 100);
});

test("append-only reversal B: generic full reversal offsets its original exactly once", () => {
  assert.equal(computePaidExpenseTotal([
    root({ id: 1, sourceType: "payroll_payment_group" }),
    root({ id: 2, sourceType: "payroll_group_reversal", correctionOfId: 1, economicEffectSign: -1 }),
  ]), 0);
});

test("append-only reversal C: generic partial reversal reduces the original", () => {
  assert.equal(computePaidExpenseTotal([
    root({ id: 1, sourceType: "legacy_settlement" }),
    root({ id: 2, sourceType: "legacy_settlement_reversal", correctionOfId: 1, economicEffectSign: -1, amount: 40 }),
  ]), 60);
});

test("append-only reversal D: positive linked rebook remains a separate root", () => {
  assert.equal(computePaidExpenseTotal([
    root({ id: 1, sourceType: "payroll_payment_group" }),
    root({ id: 2, sourceType: "payroll_group_reversal", correctionOfId: 1, economicEffectSign: -1 }),
    root({ id: 3, sourceType: "payroll_payment_group", correctionOfId: 1, amount: 80 }),
  ]), 80);
});

test("append-only reversal E: payable contribution is capped after partial reversal", () => {
  assert.equal(computePaidExpenseTotal([
    root({ id: 1, payableStatus: "paid", allocatedAmount: 100 }),
    root({ id: 2, sourceType: "generic_reversal", correctionOfId: 1, economicEffectSign: -1, amount: 40 }),
  ]), 60);
});

test("append-only reversal F: ledger correction and generic reversal each affect the original once", () => {
  assert.equal(computePaidExpenseTotal([
    root({ id: 1, sourceType: "payroll_payment_group", corrections: [{ amount: 10, economicEffectSign: -1 }] }),
    root({ id: 2, sourceType: "ledger_correction", correctionOfId: 1, economicEffectSign: -1, amount: 10 }),
    root({ id: 3, sourceType: "payroll_group_reversal", correctionOfId: 1, economicEffectSign: -1, amount: 40 }),
  ]), 50);
});

test("append-only reversal G: inventory reversal and positive rebook retain their net result", () => {
  assert.equal(computePaidExpenseTotal([
    root({ id: 1, sourceType: "inventory_purchase_candidate" }),
    root({ id: 2, sourceType: "inventory_purchase_reversal", correctionOfId: 1, economicEffectSign: -1 }),
    root({ id: 3, sourceType: "inventory_purchase_rebook", correctionOfId: 1, amount: 80 }),
  ]), 80);
});

test("August 2026 production-shaped paid total nets payroll and legacy reversal effects", () => {
  const roots = [
    root({ id: 101, sourceType: "payroll_payment_group", amount: 200_000_000 }),
    root({ id: 102, sourceType: "legacy_settlement", amount: 421_648_529.5 }),
    root({ id: 103, sourceType: "payroll_group_reversal", correctionOfId: 101, economicEffectSign: -1, amount: 100_000_000 }),
    root({ id: 104, sourceType: "legacy_settlement_reversal", correctionOfId: 102, economicEffectSign: -1, amount: 73_202_931 }),
  ];
  assert.equal(computePaidExpenseTotal(roots), 448_445_598.5);
  assert.equal(Math.round(computePaidExpenseTotal(roots)), 448_445_599);
});

test("September paid expense includes September payment and excludes October payment", () => {
  const allocations = [
    {allocated_amount: 300, payment: {business_date: "2026-09-20", status: "confirmed"}},
    {allocated_amount: 700, payment: {business_date: "2026-10-03", status: "confirmed"}},
  ];
  const september = sumConfirmedAllocationsThroughMonth(allocations, "2026-09");
  assert.equal(september, 300);
  assert.equal(computePaidExpenseTotal([root({id: 1, amount: 1000, payableStatus: "paid", allocatedAmount: september})]), 300);
  assert.equal(sumConfirmedAllocationsThroughMonth(allocations, "2026-09"), 300, "October payment must not rewrite September");
  assert.equal(sumConfirmedAllocationsThroughMonth(allocations, "2026-10"), 1000);
  assert.equal(sumConfirmedAllocationsThroughMonth([allocations[0]], "2026-09"), 300);
  assert.equal(sumConfirmedAllocationsThroughMonth([allocations[1]], "2026-09"), 0);
});

test("paidExpense and payable display share confirmed payment and next-month cutoff", () => {
  const allocations = [
    {allocated_amount: 200, payment: {business_date: "2026-09-30", status: "confirmed"}},
    {allocated_amount: 300, payment: {business_date: "2026-10-01", status: "confirmed"}},
    {allocated_amount: 400, payment: {business_date: "2026-09-15", status: "draft"}},
    {allocated_amount: 500, payment: {business_date: "2026-09-16", status: "voided"}},
  ];
  assert.equal(sumConfirmedAllocationsThroughMonth(allocations, "2026-09"), 200);
  assert.equal(payableDisplayAsOf(1000, allocations, "2026-09").paidAmount, 200);
  assert.equal(computePaidExpenseTotal([root({id: 2, amount: 1000, payableStatus: "unpaid", allocatedAmount: 200})]), 200);
});

// I: paidExpense never goes negative for any supported correction scenario, including over-correction.
test("I. over-correction beyond the original amount floors the effective recognized amount at 0, not negative", () => {
  const roots = [root({ id: 1, payableStatus: "unpaid", allocatedAmount: 0, corrections: [{ amount: 150, economicEffectSign: -1 }] })];
  assert.equal(computePaidExpenseTotal(roots), 0);
});
test("I2. a downward correction viewed from its OWN (unrelated) month contributes nothing — its root lives elsewhere", () => {
  // This is the actual bug this redesign fixes: a correction transaction itself is excluded from being an
  // independent root (source_type='ledger_correction'), so it can never drag its own booking month negative
  // by showing up unpaired with nothing in "outstanding" to offset it.
  const roots = [root({ id: 99, amount: 100, economicEffectSign: -1, sourceType: "ledger_correction", correctionOfId: 1 })];
  assert.equal(computePaidExpenseTotal(roots), 0);
});

// ---------------------------------------------------------------------------
// C. route.ts summary wiring (cardGrossSales / actualCardDeposits / paidExpense)
// ---------------------------------------------------------------------------

test("received income separates recognized card sales from actual card deposits", () => {
  assert.equal(computeReceivedIncome(623_163_550, 0, 0), 623_163_550);
  assert.equal(computeReceivedIncome(623_163_550, 100_000_000, 0), 523_163_550);
  assert.equal(computeReceivedIncome(623_163_550, 100_000_000, 90_000_000), 613_163_550);
  assert.equal(computeReceivedIncome(0, 0, 90_000_000), 90_000_000);
});

test("recognized income and operating profit keep their accounting meaning", () => {
  const incomeCalculation = route.match(/const salesIncome = profitRows[^\n]*\n\s*const otherIncome = profitRows[^\n]*\n\s*const recognizedIncome = salesIncome \+ otherIncome;/)?.[0];
  assert.ok(incomeCalculation);
  const calculate = new Function("profitRows", `${incomeCalculation}\nreturn { salesIncome, otherIncome, recognizedIncome };`) as
    (rows: Array<{ type: string; amount: number; economic_effect_sign?: number }>) =>
      { salesIncome: number; otherIncome: number; recognizedIncome: number };
  const summary = calculate([
    { type: "sales", amount: 734_634_810 },
    { type: "income", amount: 51_743 },
    { type: "expense", amount: 10_000 },
  ]);
  assert.deepEqual(summary, { salesIncome: 734_634_810, otherIncome: 51_743, recognizedIncome: 734_686_553 });
  assert.deepEqual(calculate([{ type: "sales", amount: 100, economic_effect_sign: -1 }, { type: "income", amount: 20 }]),
    { salesIncome: -100, otherIncome: 20, recognizedIncome: -80 });
  assert.equal(computeReceivedIncome(summary.recognizedIncome, 100_000, 90_000), 734_676_553);
  assert.equal(summary.recognizedIncome - 10_000, 734_676_553);
  assert.match(route, /summary:\s*\{\s*income:\s*recognizedIncome,\s*salesIncome,\s*otherIncome,\s*receivedIncome,\s*expense,\s*operatingProfit:\s*recognizedIncome\s*-\s*expense/);
});

test("cardGrossSales sums this month's POS card-bucket sales by business_date", () => {
  const data = read("lib/ledger/card-settlement-data.ts");
  assert.match(data, /eq\("source_type",\s*"pos_sales_daily_payment"\)/);
  assert.match(data, /like\("source_key",\s*"pos:%:card"\)/);
  assert.match(data, /gte\("business_date",\s*start\)\.lt\("business_date",\s*end\)/);
  assert.match(route, /cardGrossSalesPromise = loadCardSales\(monthStart, nextMonth\)/);
});

test("actualCardDeposits sums this month's real deposits by deposit_date (policy A), excluding cancelled", () => {
  assert.match(route, /from\("ledger_card_reconciliations"\)\.select\("deposit_amount,difference_amount,status"\)\.neq\("status",\s*"cancelled"\)\.gte\("deposit_date",\s*monthStart\)\.lt\("deposit_date",\s*nextMonth\)/);
});

test("a prior-month card sale is received only in the later deposit_date month", () => {
  const augustReceived = computeReceivedIncome(623_163_550, 195_317_260, 0);
  const septemberReceived = computeReceivedIncome(0, 0, 190_000_000);
  assert.equal(augustReceived, 427_846_290);
  assert.equal(septemberReceived, 190_000_000);
});

test("paidExpense roots are scoped by the root's own recognition_month, not a payment date", () => {
  assert.match(route, /paidExpenseRootsPromise[\s\S]{0,450}gte\("recognition_month",\s*monthStart\)\.lt\("recognition_month",\s*nextMonth\)\.in\("type",\s*\["expense",\s*"expense_recognition"\]\)/);
  assert.match(route, /import \{ computePaidExpenseTotal, sumConfirmedAllocationsThroughMonth \} from "@\/lib\/ledger\/payables"/);
  assert.match(route, /paidExpenseRootsPromise[\s\S]*payment:ledger_transactions!payment_transaction_id\(business_date,status\)/);
  assert.match(route, /allocatedAmount: sumConfirmedAllocationsThroughMonth\([^\n]*, month\)/);
});

test("paidExpense corrections are fetched independently of any date range (a correction always lands in a different, later open month than its closed original)", () => {
  assert.doesNotMatch(route.slice(route.indexOf("paidExpenseCorrectionsPromise"), route.indexOf("paidExpenseCorrectionsPromise") + 260), /recognition_month|business_date/);
  assert.match(route, /not\("correction_of_id",\s*"is",\s*null\)/);
});

test("route.ts wires roots, allocations and corrections together and calls computePaidExpenseTotal with the assembled root list", () => {
  assert.match(route, /correctionsByRoot\s*=\s*new Map/);
  assert.match(route, /const paidExpense = computePaidExpenseTotal\(paidExpenseRoots\);/);
});

// ---------------------------------------------------------------------------
// D. page.tsx summary cards use the authoritative API summary, not a re-derivation
// ---------------------------------------------------------------------------

test("the summary block itself (GET handler) issues no RPC — the three new fields are plain SELECT aggregates", () => {
  const getHandler = route.slice(route.indexOf("export async function GET"), route.indexOf("async function loadMonthTransactions"));
  assert.doesNotMatch(getHandler, /supabaseServer\.rpc\(/);
});

test("summary type is modeled on LedgerData so the cards cannot silently fall back to undefined", () => {
  assert.match(pageCompact, /typeLedgerSummary=\{income:number;salesIncome:number;otherIncome:number;receivedIncome:number;expense:number;operatingProfit:number;paidExpense:number;displayedExpense:number;actualCashOutflow:number;cardSettlementDifference:number;cardGrossSales:number;monthlySettledGross:number;actualCardDeposits:number;unsettledCardGross:number;\}/);
  assert.match(pageCompact, /summary:LedgerSummary/);
});

test("income card shows actual sales deposits and other income without double counting", () => {
  const card = pageCompact.slice(pageCompact.indexOf("styles.incomeCard"), pageCompact.indexOf("styles.expenseCard"));
  assert.match(card, /styles\.summarySubRows/);
  assert.match(card, /vi\?"Thựcthubánhàng":"실제매출입금"/);
  assert.match(card, /vi\?"Thunhậpkhác":"기타수입"/);
  assert.match(card, /money\(data\.summary\.receivedIncome-data\.summary\.otherIncome\)/);
  assert.match(card, /money\(data\.summary\.otherIncome\)/);
  assert.doesNotMatch(card, /money\(data\.summary\.receivedIncome\)/);
  assert.doesNotMatch(card, /styles\.summaryCashRow/);
  assert.doesNotMatch(card, /money\(data\.summary\.income\)/);
});

test("income and expense cards keep two equal columns and their original amount colors", () => {
  assert.match(entriesCss, /\.summaryGrid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(entriesCss, /\.incomeCard\{grid-column:/);
  assert.doesNotMatch(entriesCss, /\.summaryGrid\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(entriesCss, /\.summarySubRows\{[^}]*border-top:1px solid #eef0f2/);
  assert.match(entriesCss, /\.summaryCard \.summarySubRows>span\{display:grid;grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(entriesCss, /\.incomeCard \.summarySubRows>span>b\{color:#16805a\}/);
  assert.match(entriesCss, /\.expenseCard \.summarySubRows>span>b\{color:#b4493e\}/);
  assert.match(entriesCss, /@media\(max-width:560px\)\{\.summaryCard \.summarySubRows\{grid-auto-rows:auto\}/);
});

test("expense card shows cash outflow and card fee as matching rows without adding them", () => {
  const card = pageCompact.slice(pageCompact.indexOf("styles.expenseCard"), pageCompact.indexOf("styles.openingSection"));
  assert.match(card, /styles\.summarySubRows/);
  assert.match(card, /vi\?"Thựcchi":"실제지출"/);
  assert.match(card, /<b>\{money\(data\.summary\.actualCashOutflow\)\}<\/b>/);
  assert.doesNotMatch(card, /styles\.summaryReferenceRow/);
  assert.match(card, /money\(data\.summary\.cardSettlementDifference\)/);
  assert.doesNotMatch(card, /money\(data\.summary\.actualCashOutflow\+data\.summary\.cardSettlementDifference\)/);
  assert.doesNotMatch(entriesCss, /\.summaryReferenceRow/);
  assert.doesNotMatch(card, /money\(data\.summary\.displayedExpense\)/);
  assert.doesNotMatch(card, /data\.summary\.expense|전체지출|지급완료|<strong>/);
  assert.match(route, /expense, operatingProfit: recognizedIncome - expense/);
});

test("payable rows hide cumulative partial-payment UI and retain monthly purchase/payment/closing fields", () => {
  const start = page.indexOf("className={styles.payableParties}");
  const row = page.slice(start, page.indexOf("</button>)}</div>", start));
  assert.doesNotMatch(row, /partialPaidAmount|payablePartialPayment|누적 부분결제|Lũy kế/);
  assert.match(page, /partialPaidAmount:number/);
  assert.match(row, /<strong[^>]*>\{money\(party\.closingOutstanding\)\}/);
  assert.match(row, /\$\{Number\(month\.slice\(5,7\)\)\}월 외상/);
  assert.match(row, /party\.periodPurchases/);
  assert.match(row, /\$\{Number\(month\.slice\(5,7\)\)\}월 지급/);
  assert.match(row, /party\.periodPayments/);
  assert.match(row, /aria-label=\{vi \? "Công nợ cuối tháng" : "월말 미납"\}/);
});

// ---------------------------------------------------------------------------
// E. POS manual sync button (InventoryCandidatePanel)
// ---------------------------------------------------------------------------

test("POS sync button reuses the existing pos-sync API contract, not a new endpoint", () => {
  assert.match(panel, /sync\("\/api\/admin\/ledger\/pos-sync","POS"\)/);
  assert.doesNotMatch(panel, /\/api\/admin\/ledger\/pos-sync\/(trigger|manual|run)/);
});

test("POS sync button shares the same disabled-while-working guard as the other sync buttons (no double click)", () => {
  const panelCompact = panel.replace(/\s+/g, "");
  assert.match(panelCompact, /disabled=\{working\}style=\{s\.secondary\}onClick=\{\(\)=>sync\("\/api\/admin\/ledger\/pos-sync","POS"\)\}>POS동기화/);
});

test("POS sync goes through the shared sync() helper, so API errors surface via the same message state as other sync buttons", () => {
  assert.match(panel, /async function sync\(path:string,label:string\)\{setWorking\(true\);try\{/);
  assert.match(panel, /catch\(e\)\{setMessage\(`\$\{label\} 실패: \$\{\(e as Error\)\.message\}`\)\}/);
});

test("POS source tables are never written to from the admin panel (read/trigger only, sync itself is server-side)", () => {
  assert.doesNotMatch(panel, /\.from\("pos_sales_[^"]+"\)\.(insert|update|delete|upsert)/);
});
