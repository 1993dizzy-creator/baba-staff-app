import { supabaseServer } from "@/lib/supabase/server";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import {
  parsePayrollAdvanceInput,
  payrollAdvanceEmployees,
  payrollAdvanceErrorStatus,
  type PayrollAdvanceEmployeeRow,
} from "@/lib/ledger/payroll-advance";

export const dynamic = "force-dynamic";

// Active payroll-eligible employees for the 👥 가불 manual entry.
export async function GET() {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const { data, error } = await supabaseServer.from("users")
    .select("id,name,full_name,username,is_active,role,is_system_account,payroll_eligible_override,attendance_tracking_enabled,part")
    .eq("is_active", true).eq("is_system_account", false).order("id");
  if (error) {
    console.error("[LEDGER_PAYROLL_ADVANCE_EMPLOYEES_FAILED]", error);
    return ledgerJson({ ok: false, code: "PAYROLL_ADVANCE_EMPLOYEES_READ_FAILED" }, 500);
  }
  return ledgerJson({ ok: true, employees: payrollAdvanceEmployees((data ?? []) as PayrollAdvanceEmployeeRow[]) });
}

// The only write path for new salary advances: payroll advance adjustment +
// payroll_payment cash outflow + movement + audit, written atomically by
// ledger_create_payroll_advance_payment_v1. requestId makes retries idempotent.
export async function POST(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const input = parsePayrollAdvanceInput(await request.json().catch(() => null));
  if (!input) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("ledger_create_payroll_advance_payment_v1", {
      p_request_id: input.requestId,
      p_user_id: input.userId,
      p_amount: input.amount,
      p_occurred_at: input.occurredAt,
      p_from_account_id: input.fromAccountId,
      p_memo: input.memo,
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    // A replayed requestId returns the advance it already created.
    if (result.status === "duplicate") return ledgerJson({ ok: true, replayed: true, result }, 200);
    if (result.status !== "created") {
      const status = String(result.status ?? "PAYROLL_ADVANCE_CREATE_FAILED");
      return ledgerJson({ ok: false, code: status.toUpperCase(), result }, payrollAdvanceErrorStatus(status));
    }
    return ledgerJson({ ok: true, result }, 201);
  } catch (error) {
    console.error("[LEDGER_PAYROLL_ADVANCE_POST_FAILED]", error);
    return ledgerJson({ ok: false, code: "PAYROLL_ADVANCE_CREATE_FAILED" }, 500);
  }
}
