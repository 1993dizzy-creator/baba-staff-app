import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { resolveLedgerPayrollCost, needsPayrollEstimate, payrollTrackedForMonth } = require("../lib/ledger/payroll-cost.ts") as typeof import("../lib/ledger/payroll-cost");
const { buildProvisionalOperatingProfit } = require("../lib/ledger/provisional-operating-profit.ts") as typeof import("../lib/ledger/provisional-operating-profit");
const { calculatePayrollInsuranceTotals } = require("../lib/payroll/insurance.ts") as typeof import("../lib/payroll/insurance");

const server = readFileSync("lib/ledger/payroll-cost-server.ts", "utf8");
const route = readFileSync("app/api/admin/ledger/payroll-cost/route.ts", "utf8");
const dashboard = readFileSync("app/(protected)/admin/ledger/page.tsx", "utf8");
const monthCloseSheet = readFileSync("app/(protected)/admin/ledger/entries/MonthCloseSheet.tsx", "utf8");
const migration = readFileSync("supabase/migrations/20261003090000_close_ledger_before_payroll_payment.sql", "utf8");
const strip = (source: string) => source.replace(/\/\/.*$/gm, "");

// September ledger: payroll not yet in expense (it is booked when the batch completes).
const september = { income: 400_000_000, expense: 150_000_000, operatingProfit: 250_000_000 };
const estimate = (companyCost: number, unavailableCount = 0, reviewCount = 0) => ({ ok: true as const, companyCost, unavailableCount, reviewCount });
const resolve = (overrides: Partial<Parameters<typeof resolveLedgerPayrollCost>[0]>) => resolveLedgerPayrollCost({
  month: "2026-09", batch: null, firstPayrollMonth: "2026-06", recognizedAmount: 0, estimate: estimate(165_000_000), ...overrides,
});
const pnl = (payroll: ReturnType<typeof resolveLedgerPayrollCost>, summary = september) =>
  buildProvisionalOperatingProfit({ isCurrentMonth: false, summary, payroll, currentCard: null, previousCard: null });

test("Case A: September closed, no batch yet → predicted 165,000,000 in P&L", () => {
  const payroll = resolve({});
  assert.deepEqual({ status: payroll.status, amount: payroll.amount, adjustment: payroll.adjustment }, { status: "predicted", amount: 165_000_000, adjustment: 165_000_000 });
  const result = pnl(payroll);
  assert.equal(result.mode, "provisional");
  assert.equal(result.needsCheck, false);
  assert.equal(result.provisionalExpense, 315_000_000);
  assert.equal(result.operatingProfit, 85_000_000);
  assert.deepEqual(result.payroll, { status: "predicted", amount: 165_000_000 });
});

test("Case B/C: batch paying (0/18 or 5/18 paid) → still the full predicted cost", () => {
  for (const status of ["draft", "paying"]) {
    const payroll = resolve({ batch: { status, actualCompanyCostTotal: 0 } });
    assert.equal(payroll.status, "predicted");
    assert.equal(payroll.batchStatus, status);
    // Paid salaries are cash movements, never expense, so the predicted cost is not reduced.
    assert.equal(payroll.adjustment, 165_000_000);
    assert.equal(pnl(payroll).operatingProfit, 85_000_000);
  }
});

test("Case D: batch completed 167,320,000 → finalized; the prediction is not used", () => {
  const notBooked = resolve({ batch: { status: "completed", actualCompanyCostTotal: "167320000" }, estimate: null });
  assert.deepEqual({ status: notBooked.status, amount: notBooked.amount, adjustment: notBooked.adjustment }, { status: "finalized", amount: 167_320_000, adjustment: 167_320_000 });
  // Once the recognition row exists, the ledger expense already has it: nothing is added.
  const booked = resolve({ batch: { status: "completed", actualCompanyCostTotal: 167_320_000 }, recognizedAmount: 167_320_000, estimate: estimate(165_000_000) });
  assert.equal(booked.status, "finalized");
  assert.equal(booked.adjustment, 0);
  const summary = { income: 400_000_000, expense: 317_320_000, operatingProfit: 82_680_000 };
  const result = pnl(booked, summary);
  assert.equal(result.mode, "final");
  assert.equal(result.operatingProfit, 82_680_000);
  assert.deepEqual(result.payroll, { status: "finalized", amount: 167_320_000 });
  // The estimate is only requested when no completed batch exists.
  assert.equal(needsPayrollEstimate({ status: "completed", actualCompanyCostTotal: 1 }, "2026-09", "2026-06"), false);
  assert.equal(needsPayrollEstimate({ status: "paying", actualCompanyCostTotal: 0 }, "2026-09", "2026-06"), true);
  assert.equal(needsPayrollEstimate(null, "2026-09", "2026-06"), true);
});

test("Case E: October payment cash does not add September's cost to October", () => {
  // October's recognized amount counts only recognition_month = October rows.
  assert.match(server, /\.eq\("source_type", "payroll_completed_batch"\)\.eq\("recognition_month", monthStart\)/);
  const october = resolveLedgerPayrollCost({ month: "2026-10", batch: null, firstPayrollMonth: "2026-06", recognizedAmount: 0, estimate: estimate(170_000_000) });
  assert.equal(october.adjustment, 170_000_000);
  // The finalized September recognition is recognition_month 2026-09 (business_date 10/10): DB-tested in
  // tests/ledger-payroll-close-first-db.test.mjs. payroll_payment rows never reach operating profit.
  assert.doesNotMatch(strip(server), /payroll_payment"/);
});

test("predicted and finalized are never both counted", () => {
  for (const recognizedAmount of [0, 100_000_000, 167_320_000, 200_000_000]) {
    const finalized = resolve({ batch: { status: "completed", actualCompanyCostTotal: 167_320_000 }, recognizedAmount });
    assert.equal(recognizedAmount + finalized.adjustment!, Math.max(recognizedAmount, 167_320_000));
    const predicted = resolve({ recognizedAmount });
    assert.equal(recognizedAmount + predicted.adjustment!, Math.max(recognizedAmount, 165_000_000));
  }
});

test("advances never reduce company cost; meal allowance is not added", () => {
  const base = { preInsurancePayoutAmounts: [10_000_000, 8_000_000], employeeDeductionAmounts: [1_000_000, 800_000], employerAmounts: [2_000_000, 1_600_000], directorAmount: 500_000 };
  const withoutAdvance = calculatePayrollInsuranceTotals(base);
  const withAdvance = calculatePayrollInsuranceTotals({ ...base, advanceAmounts: [3_000_000, 0] });
  assert.equal(withAdvance.totalCompanyCostAmount, withoutAdvance.totalCompanyCostAmount);
  assert.equal(withAdvance.totalNetAmount, withoutAdvance.totalNetAmount - 3_000_000);
  // The server reads the raw Payroll summary (no meal), not the overview API's meal-inclusive summary.
  assert.match(server, /import \{ loadPayrollOverview \} from "@\/lib\/payroll\/overview-server";/);
  assert.match(server, /Number\(overview\.summary\.totalCompanyCostAmount\)/);
  assert.doesNotMatch(strip(server), /mealAllowance|loadMealAllowanceCostSummary|projectedSummary/);
});

test("an unavailable calculation is shown as unavailable, never 0, and month close is not blocked", () => {
  for (const payroll of [resolve({ estimate: { ok: false } }), resolve({ estimate: null }), resolve({ estimate: estimate(165_000_000, 2) })]) {
    assert.equal(payroll.status, "unavailable");
    assert.equal(payroll.amount, null);
    assert.equal(payroll.adjustment, null);
    const result = pnl(payroll);
    assert.equal(result.needsCheck, true);
    assert.equal(result.operatingProfit, null);
    assert.ok(result.warnings.includes("PAYROLL_UNAVAILABLE"));
  }
  // requires_review employees still produce a prediction (reported as reviewCount).
  assert.equal(resolve({ estimate: estimate(165_000_000, 0, 3) }).reviewCount, 3);
  assert.doesNotMatch(monthCloseSheet, /PAYROLL_NOT_COMPLETED/);
});

test("months before the first payroll batch are not tracked (no prediction)", () => {
  assert.equal(payrollTrackedForMonth("2026-05", "2026-06"), false);
  assert.equal(payrollTrackedForMonth("2026-06", "2026-06"), true);
  assert.equal(payrollTrackedForMonth("2026-05", null), true);
  const payroll = resolve({ month: "2026-05", estimate: null });
  assert.equal(payroll.status, "not_tracked");
  assert.equal(payroll.adjustment, 0);
  assert.equal(pnl(payroll).mode, "final");
});

test("August regression: completed and booked batch keeps the final operating profit", () => {
  const payroll = resolveLedgerPayrollCost({ month: "2026-08", batch: { status: "completed", actualCompanyCostTotal: 150_000_000 }, firstPayrollMonth: "2026-06", recognizedAmount: 150_000_000, estimate: null });
  const summary = { income: 380_000_000, expense: 300_000_000, operatingProfit: 80_000_000 };
  const result = pnl(payroll, summary);
  assert.equal(result.mode, "final");
  assert.equal(result.operatingProfit, 80_000_000);
  assert.equal(result.payrollAdjustment, 0);
});

test("API, dashboard and KO/VI labels", () => {
  assert.match(route, /requireLedgerActor\(\)/);
  assert.match(route, /export async function GET/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(strip(server), /\.(insert|update|upsert|rpc)\(|\)\s*\.delete\(/);
  // Short-lived cache; failures are not cached.
  assert.match(server, /ESTIMATE_TTL_MS = 60_000/);
  assert.match(server, /if \(!result\.ok\) estimateCache\.delete\(month\)/);
  assert.ok(dashboard.includes("/api/admin/ledger/payroll-cost?month=${month}"));
  for (const label of ['payrollPredicted: "예상"', 'payrollFinalized: "확정"', 'payrollPredicted: "Dự kiến"', 'payrollFinalized: "Đã chốt"', 'payrollCost: "급여/인건비"', 'payrollCost: "Chi phí lương"']) {
    assert.ok(dashboard.includes(label), label);
  }
  // No separate finalize button / workflow.
  assert.doesNotMatch(dashboard, /finalizePayroll|payroll-cost\/finalize/);
});

test("migration: one narrow closed-month exception, no new tables or workflows", () => {
  assert.doesNotMatch(migration, /create table|alter table/i);
  assert.match(migration, /ledger_payroll_finalization_allowed_v1/);
  assert.match(migration, /source_type='payroll_completed_batch'|source_type = 'payroll_completed_batch'/);
  assert.match(migration, /revoke all on function public\.ledger_payroll_finalization_allowed_v1\(public\.ledger_transactions\) from public, anon, authenticated, service_role/i);
});
