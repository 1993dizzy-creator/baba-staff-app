import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Links unused prepayments to received purchases (allocations only; no new outflow).
export async function POST(request: Request) {
  const auth = await requireLedgerActor(); if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const allowed = new Set(["requestId", "partyId", "allocations"]);
  if (!body || Object.keys(body).some(key => !allowed.has(key)) || !Number.isSafeInteger(Number(body.partyId)) || !Array.isArray(body.allocations) || body.allocations.length === 0)
    return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  if (typeof body.requestId !== "string" || !UUID.test(body.requestId)) return ledgerJson({ ok: false, code: "INVALID_REQUEST_ID" }, 400);
  const { data, error } = await supabaseServer.rpc("ledger_apply_supplier_prepayment_v1", {
    p_request_id: body.requestId, p_party_id: Number(body.partyId), p_allocations: body.allocations, p_actor_user_id: auth.actor.id,
  });
  if (error) {
    if (String(error.message ?? "").includes("LEDGER_MONTH_CLOSED")) return ledgerJson({ ok: false, code: "LEDGER_MONTH_CLOSED" }, 409);
    console.error("[LEDGER_PREPAYMENT_APPLY_FAILED]", { code: error.code });
    return ledgerJson({ ok: false, code: "PREPAYMENT_APPLY_FAILED" }, 500);
  }
  const result = data as { status?: string } | null;
  if (result?.status !== "applied") {
    const status = result?.status ?? "PREPAYMENT_APPLY_FAILED";
    return ledgerJson({ ok: false, code: status.toUpperCase() }, status === "forbidden" ? 403
      : ["idempotency_conflict", "idempotency_state_invalid", "prepayment_insufficient", "amount_exceeds_outstanding", "duplicate_allocation"].includes(status) ? 409 : 400);
  }
  return ledgerJson({ ok: true, result }, 201);
}
