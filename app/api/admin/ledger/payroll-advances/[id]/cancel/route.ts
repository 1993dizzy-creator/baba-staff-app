import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";
import { parsePayrollAdvanceCancelInput, payrollAdvanceCancelErrorStatus } from "@/lib/ledger/payroll-advance";

// The only way to cancel a ledger-created salary advance: cancels the payroll
// adjustment and appends a cash reversal in one transaction
// (ledger_cancel_payroll_advance_payment_v1). The original stays as history.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const { id } = await context.params;
  const input = parsePayrollAdvanceCancelInput(id, await request.json().catch(() => null));
  if (!input) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);

  try {
    const { data, error } = await supabaseServer.rpc("ledger_cancel_payroll_advance_payment_v1", {
      p_transaction_id: input.transactionId,
      p_reason: input.reason,
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    // Cancelling twice is not an error: the first reversal is returned.
    if (result.status === "already_cancelled") return ledgerJson({ ok: true, alreadyCancelled: true, result });
    if (result.status !== "cancelled") {
      const status = String(result.status ?? "PAYROLL_ADVANCE_CANCEL_FAILED");
      return ledgerJson({ ok: false, code: status.toUpperCase(), result }, payrollAdvanceCancelErrorStatus(status));
    }
    return ledgerJson({ ok: true, result });
  } catch (error) {
    console.error("[LEDGER_PAYROLL_ADVANCE_CANCEL_FAILED]", error);
    return ledgerJson({ ok: false, code: "PAYROLL_ADVANCE_CANCEL_FAILED" }, 500);
  }
}
