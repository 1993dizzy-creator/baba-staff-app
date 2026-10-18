import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";
import { PAYMENT_REFRESH_MESSAGES } from "@/lib/ledger/payable-payment-messages";

export async function POST(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const allowed = new Set(["partyId", "fundAccountId", "occurredAt", "amount", "allocations", "memo", "requestId"]);
  if (!body || Object.keys(body).some(k => !allowed.has(k)) || !Number.isInteger(Number(body.partyId)) || !Number.isInteger(Number(body.fundAccountId))) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  const headerKey = request.headers.get("Idempotency-Key");
  if (headerKey && body.requestId && headerKey !== body.requestId) return ledgerJson({ ok: false, code: "IDEMPOTENCY_CONFLICT" }, 409);
  const requestId = headerKey || body.requestId;
  // Keyless clients must refresh/upgrade; never invent a key or fall back to V1.
  if (!requestId) return ledgerJson({ ok: false, code: "IDEMPOTENCY_KEY_REQUIRED", action: "refresh", message: PAYMENT_REFRESH_MESSAGES }, 428);
  if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) return ledgerJson({ ok: false, code: "INVALID_REQUEST_ID" }, 400);
  const { data, error } = await supabaseServer.rpc("ledger_pay_payables_v2", {
    p_request_id: requestId, p_party_id: body.partyId, p_fund_account_id: body.fundAccountId,
    p_occurred_at: body.occurredAt, p_amount: body.amount, p_allocations: body.allocations ?? null,
    p_memo: body.memo || null, p_actor_user_id: auth.actor.id,
  });
  if (error) {
    console.error("[LEDGER_PAYABLE_PAYMENT_FAILED]", { code: error.code });
    return ledgerJson({ ok: false, code: "PAYABLE_PAYMENT_FAILED" }, 500);
  }
  const result = data as { status?: string } | null;
  if (result?.status !== "paid") {
    const status = result?.status ?? "PAYABLE_PAYMENT_FAILED";
    return ledgerJson({ ok: false, code: status.toUpperCase() }, status === "forbidden" ? 403 : ["idempotency_conflict", "idempotency_state_invalid", "amount_exceeds_outstanding", "already_paid", "invalid_allocation"].includes(status) ? 409 : 400);
  }
  return ledgerJson({ ok: true, result }, 201);
}
