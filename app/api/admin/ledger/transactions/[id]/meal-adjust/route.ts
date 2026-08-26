import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { parseMealFinalAmount } from "@/lib/ledger/meal-adjust-input";
import { supabaseServer } from "@/lib/supabase/server";

const allowedFields = new Set(["finalAmount", "reason"]);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;

  const { id: rawId } = await context.params;
  const transactionId = Number(rawId);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const finalAmount = parseMealFinalAmount(body?.finalAmount);
  if (
    !Number.isSafeInteger(transactionId) || transactionId <= 0 || !body ||
    Object.keys(body).some((key) => !allowedFields.has(key)) ||
    finalAmount === null || typeof body.reason !== "string" || !body.reason.trim()
  ) {
    return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  }

  try {
    const { data, error } = await supabaseServer.rpc(
      "ledger_adjust_open_meal_transaction_v1",
      {
        p_original_transaction_id: transactionId,
        p_final_amount: finalAmount,
        p_reason: body.reason.trim(),
        p_actor_user_id: auth.actor.id,
      },
    );
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "created" && result.status !== "unchanged") {
      const code = String(result.status ?? "MEAL_ADJUST_FAILED").toUpperCase();
      const status = result.status === "forbidden" ? 403
        : result.status === "not_found" ? 404
          : result.status === "original_month_closed" || result.status === "adjustment_business_month_closed" ? 409
            : 400;
      return ledgerJson({ ok: false, code }, status);
    }
    return ledgerJson({ ok: true, result }, result.status === "created" ? 201 : 200);
  } catch (error) {
    console.error("[LEDGER_MEAL_ADJUST_FAILED]", error);
    return ledgerJson({ ok: false, code: "MEAL_ADJUST_FAILED" }, 500);
  }
}
