import { requireRole } from "@/lib/auth/server-auth";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { parsePendingResolutionBody } from "@/lib/sales/pos-pending-payment-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DB exception -> client code. Anything else stays a generic failure.
const RPC_ERROR_CODES: Record<string, number> = {
  receipt_revision_conflict: 409,
  receipt_not_pending: 409,
  receipt_pending_review_not_due: 409,
  receipt_month_closed: 409,
  receipt_business_day_closed: 409,
  receipt_not_found: 404,
  receipt_source_not_pending_resolvable: 400,
  receipt_evidence_required: 400,
  receipt_invalid_payment_method: 400,
  receipt_invalid_cash_received: 400,
  receipt_invalid_final_amount: 400,
};

// Pending (CUKCUK payment_status 1, 30+ minutes) -> paid or canceled.
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireRole(["owner", "master", "manager"]);
  if (!auth.ok) return NextResponse.json({ ok: false, code: auth.code }, { status: auth.status });

  const { id } = await context.params;
  const receiptId = Number(id);
  if (!Number.isSafeInteger(receiptId) || receiptId < 1) {
    return NextResponse.json({ ok: false, code: "invalid_receipt_id" }, { status: 400 });
  }
  const input = parsePendingResolutionBody(await req.json().catch(() => null));
  if (!input) return NextResponse.json({ ok: false, code: "invalid_input" }, { status: 400 });

  const { data, error } = await supabaseServer.rpc("admin_resolve_pending_sales_receipt_v1", {
    p_receipt_id: receiptId,
    p_expected_revision: input.expectedRevision,
    p_request_id: input.requestId,
    p_actor_username: auth.actor.username,
    p_resolution: input.resolution,
    p_payment_method: input.paymentMethod,
    p_cash_received_amount: input.cashReceivedAmount,
    p_evidence_note: input.evidenceNote,
  });
  if (error) {
    const code = Object.keys(RPC_ERROR_CODES).find((key) => error.message.includes(key));
    if (code) return NextResponse.json({ ok: false, code }, { status: RPC_ERROR_CODES[code] });
    console.error("[ADMIN_SALES_PENDING_RESOLUTION_ERROR]", error.code ?? "unknown");
    return NextResponse.json({ ok: false, code: "resolution_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, result: data });
}
