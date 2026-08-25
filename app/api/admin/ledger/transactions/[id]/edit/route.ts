import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { isLedgerCalendarDate, parseInventoryRebookAmount } from "@/lib/ledger/inventory-rebook-input";
import { supabaseServer } from "@/lib/supabase/server";

const PAYMENT_MODES = new Set(["immediate", "payable"]);
const allowedFields = new Set([
  "paymentMode", "categoryId", "fundAccountId", "dueDate",
  "amount", "memo", "reason",
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const { id: rawId } = await context.params;
  const transactionId = Number(rawId);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const paymentMode = String(body?.paymentMode ?? "");
  const amount = parseInventoryRebookAmount(body?.amount);
  const categoryId = Number(body?.categoryId);
  const fundAccountId = body?.fundAccountId == null ? null : Number(body.fundAccountId);
  const dueDate = body?.dueDate == null || body.dueDate === "" ? null : String(body.dueDate);
  if (
    !Number.isSafeInteger(transactionId) || transactionId <= 0 || !body ||
    Object.keys(body).some((key) => !allowedFields.has(key)) ||
    !PAYMENT_MODES.has(paymentMode) ||
    !Number.isSafeInteger(categoryId) || categoryId <= 0 ||
    amount === null ||
    (paymentMode === "immediate" && (!Number.isSafeInteger(fundAccountId) || Number(fundAccountId) <= 0)) ||
    (dueDate !== null && !isLedgerCalendarDate(dueDate)) ||
    (body.memo != null && typeof body.memo !== "string") ||
    typeof body.reason !== "string" || !body.reason.trim()
  ) {
    return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  }

  try {
    const { data, error } = await supabaseServer.rpc("ledger_rebook_inventory_transaction_v1", {
      p_original_transaction_id: transactionId,
      p_payment_mode: paymentMode,
      p_category_id: categoryId,
      p_fund_account_id: paymentMode === "immediate" ? fundAccountId : null,
      p_due_date: paymentMode === "payable" ? dueDate : null,
      p_amount: amount,
      p_memo: body.memo || null,
      p_reason: body.reason,
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "rebooked") {
      const code = String(result.status ?? "INVENTORY_EDIT_FAILED").toUpperCase();
      const status = result.status === "forbidden" ? 403
        : result.status === "not_found" ? 404
          : result.status === "month_closed" || result.status === "payable_already_paid" || result.status === "already_rebooked" ? 409
            : 400;
      return ledgerJson({ ok: false, code }, status);
    }
    return ledgerJson({ ok: true, result }, 201);
  } catch (error) {
    console.error("[LEDGER_INVENTORY_TRANSACTION_EDIT_FAILED]", error);
    return ledgerJson({ ok: false, code: "INVENTORY_EDIT_FAILED" }, 500);
  }
}
