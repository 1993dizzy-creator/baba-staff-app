import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

const ALLOWED_FIELDS = new Set(["title", "amount", "memo", "reason"]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;

  const { id: rawId } = await context.params;
  const transactionId = Number(rawId);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const amount = typeof body?.amount === "number" || typeof body?.amount === "string"
    ? Number(body.amount) : NaN;
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0 || !body ||
      Object.keys(body).some(key => !ALLOWED_FIELDS.has(key)) ||
      typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 160 ||
      (typeof body.amount === "string" && !/^[0-9]+$/.test(body.amount)) ||
      !Number.isSafeInteger(amount) || amount <= 0 ||
      (body.memo !== null && typeof body.memo !== "string") ||
      (typeof body.memo === "string" && body.memo.length > 2000) ||
      typeof body.reason !== "string" || !body.reason.trim() || body.reason.trim().length > 500) {
    return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  }

  try {
    const { data, error } = await supabaseServer.rpc("ledger_edit_manual_transaction_v1", {
      p_transaction_id: transactionId,
      p_title: (body.title as string).trim(),
      p_amount: amount,
      p_memo: typeof body.memo === "string" ? body.memo.trim() || null : null,
      p_reason: (body.reason as string).trim(),
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "updated") {
      const status = result.status === "forbidden" ? 403 : result.status === "not_found" ? 404
        : ["month_closed", "unchanged", "already_corrected", "invalid_movements"].includes(result.status ?? "") ? 409 : 400;
      return ledgerJson({ ok: false, code: String(result.status ?? "MANUAL_EDIT_FAILED").toUpperCase() }, status);
    }
    return ledgerJson({ ok: true, result });
  } catch (error) {
    console.error("[LEDGER_MANUAL_EDIT_FAILED]", error);
    return ledgerJson({ ok: false, code: "MANUAL_EDIT_FAILED" }, 500);
  }
}
