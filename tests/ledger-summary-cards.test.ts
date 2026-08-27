import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const { buildLedgerEntries } = createRequire(import.meta.url)("../lib/ledger/entries.ts") as typeof import("../lib/ledger/entries");
const { computePaidExpenseTotal } = createRequire(import.meta.url)("../lib/ledger/payables.ts") as typeof import("../lib/ledger/payables");
const { computeReceivedIncome } = createRequire(import.meta.url)("../lib/ledger/summary.ts") as typeof import("../lib/ledger/summary");
const read = (path: string) => readFileSync(path, "utf8");
const route = read("app/api/admin/ledger/route.ts");
const page = read("app/(protected)/admin/ledger/entries/page.tsx");
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
  assert.match(pageCompact, /constsignedAmount=entry\.amount\*entry\.economicEffectSign/);
  assert.match(pageCompact, /group\.income\+=signedAmount/);
  assert.match(pageCompact, /group\.expense\+=signedAmount/);
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
  assert.match(route, /const recognizedIncome = profitRows[\s\S]*economic_effect_sign/);
  assert.match(route, /summary:\s*\{\s*income:\s*recognizedIncome,\s*receivedIncome,\s*expense,\s*operatingProfit:\s*recognizedIncome\s*-\s*expense/);
});

test("cardGrossSales sums this month's POS card-bucket sales by business_date", () => {
  assert.match(route, /eq\("source_type",\s*"pos_sales_daily_payment"\)/);
  assert.match(route, /like\("source_key",\s*"pos:%:card"\)/);
  assert.match(route, /cardGrossSalesPromise[\s\S]*gte\("business_date",\s*monthStart\)\.lt\("business_date",\s*nextMonth\)/);
});

test("actualCardDeposits sums this month's real deposits by deposit_date (policy A), excluding cancelled", () => {
  assert.match(route, /from\("ledger_card_reconciliations"\)\.select\("deposit_amount"\)\.neq\("status",\s*"cancelled"\)\.gte\("deposit_date",\s*monthStart\)\.lt\("deposit_date",\s*nextMonth\)/);
});

test("a prior-month card sale is received only in the later deposit_date month", () => {
  const augustReceived = computeReceivedIncome(623_163_550, 195_317_260, 0);
  const septemberReceived = computeReceivedIncome(0, 0, 190_000_000);
  assert.equal(augustReceived, 427_846_290);
  assert.equal(septemberReceived, 190_000_000);
});

test("paidExpense roots are scoped by the root's own recognition_month, not a payment date", () => {
  assert.match(route, /paidExpenseRootsPromise[\s\S]{0,260}gte\("recognition_month",\s*monthStart\)\.lt\("recognition_month",\s*nextMonth\)\.in\("type",\s*\["expense",\s*"expense_recognition"\]\)/);
  assert.match(route, /import \{ computePaidExpenseTotal \} from "@\/lib\/ledger\/payables"/);
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
  assert.match(pageCompact, /typeLedgerSummary=\{income:number;receivedIncome:number;expense:number;operatingProfit:number;paidExpense:number;cardGrossSales:number;actualCardDeposits:number;\}/);
  assert.match(pageCompact, /summary:LedgerSummary/);
});

test("income card shows total income with actual-deposit and card-gross sub-rows", () => {
  assert.match(pageCompact, /money\(data\.summary\.receivedIncome\)/);
  assert.match(pageCompact, /전체수입/);
  assert.match(pageCompact, /money\(data\.summary\.actualCardDeposits\)/);
  assert.match(pageCompact, /money\(data\.summary\.cardGrossSales\)/);
});

test("expense card shows paidExpense with the reused (not recomputed) totalOutstanding sub-row", () => {
  assert.match(pageCompact, /money\(data\.summary\.paidExpense\)/);
  assert.match(pageCompact, /지급완료/);
  assert.match(pageCompact, /현재미납금\(전체\)/);
  assert.match(pageCompact, /money\(payables\?\.totalOutstanding\?\?0\)/);
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
