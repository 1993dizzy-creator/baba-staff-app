import { loadPayrollLedgerSource, validLedgerSyncMonth } from "@/lib/ledger/employee-costs";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

// Repair only: normal payments and cancellations project their Ledger groups in the DB RPC.
export async function POST(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as { month?: unknown } | null;
  if (!body || !validLedgerSyncMonth(body.month)) return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
  try {
    const source = await loadPayrollLedgerSource(body.month);
    if (!source.batch) return ledgerJson({ ok: true, month: body.month, batchStatus: "missing", companyCostTotal: 0, paymentGroupCount: 0 });

    const costResult = await supabaseServer.rpc("ledger_sync_payroll_batch_company_cost_v1", {
      p_batch_id: source.batch.id,
      p_actor_user_id: auth.actor.id,
    });
    if (costResult.error) throw costResult.error;
    const groupResults = [];
    for (const group of source.paymentGroups) {
      const result = await supabaseServer.rpc("ledger_project_payroll_payment_group_v1", {
        p_payroll_month: source.batch.payroll_month,
        p_payment_date: group.paymentDate,
        p_fund_account_id: group.fundAccountId,
        p_actor_user_id: auth.actor.id,
      });
      if (result.error) throw result.error;
      groupResults.push(result.data);
    }
    return ledgerJson({ ok: true, month: body.month, batchStatus: source.batch.status,
      companyCostResult: costResult.data, companyCostTotal: source.companyCostTotal,
      paymentGroupCount: groupResults.length, paymentGroupResults: groupResults });
  } catch (error) {
    console.error("[LEDGER_PAYROLL_SYNC_FAILED]", error);
    return ledgerJson({ ok: false, code: "PAYROLL_SYNC_FAILED" }, 500);
  }
}
