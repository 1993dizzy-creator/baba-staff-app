import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { loadPayrollOverview } from "@/lib/payroll/overview-server";
import { needsPayrollEstimate, resolveLedgerPayrollCost, type LedgerPayrollCost, type PayrollEstimateSource } from "@/lib/ledger/payroll-cost";

// The Payroll engine is heavy, so a month's estimate is reused for a short time by
// this server instance. Completed months never call it.
const ESTIMATE_TTL_MS = 60_000;
const estimateCache = new Map<string, { at: number; promise: Promise<PayrollEstimateSource> }>();

async function computePayrollEstimate(month: string): Promise<PayrollEstimateSource> {
  try {
    const overview = await loadPayrollOverview(month);
    const companyCost = Number(overview.summary.totalCompanyCostAmount);
    if (!Number.isFinite(companyCost)) return { ok: false };
    return {
      ok: true,
      // Raw Payroll summary: meal allowance is booked separately in the ledger, so it
      // is deliberately not added here (unlike the Payroll overview API's display summary).
      companyCost,
      unavailableCount: overview.employees.filter((employee) => employee.calculationStatus === "unavailable").length,
      reviewCount: overview.employees.filter((employee) => employee.calculationStatus === "requires_review").length,
    };
  } catch {
    return { ok: false };
  }
}

export function loadPayrollEstimate(month: string, now = Date.now()) {
  const cached = estimateCache.get(month);
  if (cached && now - cached.at < ESTIMATE_TTL_MS) return cached.promise;
  const promise = computePayrollEstimate(month);
  estimateCache.set(month, { at: now, promise });
  // A failed estimate is not cached.
  void promise.then((result) => { if (!result.ok) estimateCache.delete(month); });
  return promise;
}

export async function loadLedgerPayrollCost(month: string): Promise<LedgerPayrollCost> {
  const monthStart = `${month}-01`;
  const [batchResult, firstBatchResult, recognitionResult] = await Promise.all([
    supabaseServer.from("payroll_payment_batches").select("status,actual_company_cost_total").eq("payroll_month", monthStart).maybeSingle(),
    supabaseServer.from("payroll_payment_batches").select("payroll_month").order("payroll_month", { ascending: true }).limit(1).maybeSingle(),
    supabaseServer.from("ledger_transactions").select("amount,economic_effect_sign")
      .eq("status", "confirmed").eq("type", "expense_recognition").eq("source_type", "payroll_completed_batch").eq("recognition_month", monthStart),
  ]);
  for (const result of [batchResult, firstBatchResult, recognitionResult]) if (result.error) throw result.error;
  const batch = batchResult.data ? { status: batchResult.data.status, actualCompanyCostTotal: batchResult.data.actual_company_cost_total } : null;
  const firstPayrollMonth = firstBatchResult.data?.payroll_month ? String(firstBatchResult.data.payroll_month).slice(0, 7) : null;
  const recognizedAmount = (recognitionResult.data ?? []).reduce((sum, row) => sum + Number(row.amount) * Number(row.economic_effect_sign ?? 1), 0);
  const estimate = needsPayrollEstimate(batch, month, firstPayrollMonth) ? await loadPayrollEstimate(month) : null;
  return resolveLedgerPayrollCost({ month, batch, firstPayrollMonth, recognizedAmount, estimate });
}
