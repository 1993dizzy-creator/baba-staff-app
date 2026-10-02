import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { loadLedgerPayrollCost } from "@/lib/ledger/payroll-cost-server";

export const dynamic = "force-dynamic";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// Month payroll company cost for ledger P&L: finalized (completed batch) or
// predicted (Payroll engine, display only). Read-only.
export async function GET(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response) return auth.response;
  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!MONTH.test(month)) return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
  try {
    return ledgerJson({ ok: true, ...await loadLedgerPayrollCost(month) });
  } catch (error) {
    console.error("[LEDGER_PAYROLL_COST_GET_FAILED]", error);
    return ledgerJson({ ok: false, code: "PAYROLL_COST_LOAD_FAILED" }, 500);
  }
}
