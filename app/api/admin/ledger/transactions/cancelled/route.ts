import { getBusinessMonthEndBoundary } from "@/lib/common/business-time";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// Manual transactions deleted ("삭제" = audited cancel) in a business month, with who, when
// and why. Read only; the normal ledger list and every total exclude these rows.
export async function GET(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response) return auth.response;
  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!MONTH.test(month)) return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
  const { businessDateExclusive } = getBusinessMonthEndBoundary(month);
  try {
    const { data: rows, error } = await supabaseServer.from("ledger_transactions")
      .select("id,type,business_date,amount,memo,display_snapshot,category:ledger_categories(name),movements:ledger_movements(amount,fund_account:ledger_fund_accounts(display_name))")
      .eq("source_type", "manual").eq("status", "cancelled").gte("business_date", `${month}-01`).lt("business_date", businessDateExclusive)
      .order("business_date").order("id").limit(200);
    if (error) throw error;
    const ids = (rows ?? []).map(row => Number(row.id));
    const { data: audits, error: auditError } = ids.length
      ? await supabaseServer.from("ledger_audit_logs").select("entity_id,reason,created_at,actor_user_id")
        .eq("entity_type", "transaction").eq("action", "manual_transaction_cancelled").in("entity_id", ids).order("id")
      : { data: [], error: null };
    if (auditError) throw auditError;
    const byId = new Map((audits ?? []).map(audit => [Number(audit.entity_id), audit]));
    return ledgerJson({
      ok: true, month,
      // Rows cancelled earlier by other flows have no 'manual_transaction_cancelled' audit row.
      transactions: (rows ?? []).map(row => {
        const audit = byId.get(Number(row.id));
        return { ...row, cancellation: audit ? { reason: audit.reason, at: audit.created_at, actorUserId: audit.actor_user_id } : null };
      }),
    });
  } catch (error) {
    console.error("[LEDGER_CANCELLED_LIST_FAILED]", error);
    return ledgerJson({ ok: false, code: "CANCELLED_LIST_FAILED" }, 500);
  }
}
