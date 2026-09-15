import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (
    !Number.isSafeInteger(id) || id < 1 || !body ||
    Object.keys(body).some((key) => key !== "reason") ||
    typeof body.reason !== "string" || !body.reason.trim()
  ) {
    return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  }

  try {
    const { data, error } = await supabaseServer.rpc("ledger_cancel_card_reconciliation_v1", {
      p_reconciliation_id: id,
      p_reason: body.reason.trim(),
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "cancelled") {
      const status = String(result.status ?? "CARD_CANCELLATION_FAILED");
      const httpStatus = status === "forbidden" ? 403
        : status === "not_found" ? 404
          : ["month_closed", "already_cancelled", "invalid_state"].includes(status) ? 409
            : 400;
      return ledgerJson({ ok: false, code: status.toUpperCase(), result }, httpStatus);
    }
    return ledgerJson({ ok: true, result });
  } catch (error) {
    console.error("[LEDGER_CARD_CANCELLATION_FAILED]", error);
    return ledgerJson({ ok: false, code: "CARD_CANCELLATION_FAILED" }, 500);
  }
}
