import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import { supabaseServer } from "@/lib/supabase/server";
import { resolutionWorkEnabled } from "@/lib/sales/admin-resolution-server";
import { getResolutionWork, previewResolutionInventory } from "@/lib/sales/admin-resolution-work";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(req: Request, context: Context) {
  const auth = await requireRole(["owner", "master", "manager"]);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code }, { status: auth.status });
  if (!resolutionWorkEnabled()) return NextResponse.json({ ok: true, enabled: false }, { headers: { "Cache-Control": "no-store" } });
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  const query = new URL(req.url).searchParams.get("products");
  if (query !== null) {
    if (!resolutionWorkEnabled()) return NextResponse.json({ ok: false, error: "feature_disabled" }, { status: 503 });
    if (!query.trim() || query.length > 80) return NextResponse.json({ ok: false, error: "invalid_query" }, { status: 400 });
    const { data, error } = await supabaseServer.from("pos_products").select("id,item_code,item_name,unit_price,tax_rate")
      .eq("is_active", true).ilike("item_code", `${query.trim()}%`).order("item_code").limit(30);
    return NextResponse.json({ ok: !error, products: error ? [] : data }, { status: error ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  }
  try { return NextResponse.json({ ok: true, enabled: resolutionWorkEnabled(), actorUsername: auth.actor.username, canExecuteInventory: auth.actor.role !== "manager", ...await getResolutionWork(id, auth.actor.id) }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ ok: false, error: "resolution_work_unavailable" }, { status: 409 }); }
}
export async function POST(req: Request, context: Context) {
  const auth = await requireRole(["owner", "master", "manager"]);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code }, { status: auth.status });
  if (!resolutionWorkEnabled()) return NextResponse.json({ ok: false, error: "feature_disabled" }, { status: 503 });
  const id = Number((await context.params).id);
  const body = await req.json().catch(() => null);
  if (!Number.isSafeInteger(id) || id < 1 || !body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ ok: false, error: "invalid_input" }, { status: 400 });
  if (!["preview", "correct", "confirm"].includes(body.action)) return NextResponse.json({ ok: false, error: "invalid_action" }, { status: 400 });
  if (body.action === "confirm" && auth.actor.role === "manager") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  try {
    if (body.action === "preview") return NextResponse.json({ ok: true, ...await previewResolutionInventory(id, auth.actor.id) });
    if (typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId) ||
      typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 2000) return NextResponse.json({ ok: false, error: "invalid_input" }, { status: 400 });
    const request = body.action === "confirm" ? { requestId: body.requestId, reason: body.reason.trim(), reviewId: body.reviewId,
      approveReclose: body.approveReclose === true, closureFingerprint: body.closureFingerprint ?? null } : {
      requestId: body.requestId, reason: body.reason.trim(), resolutionId: body.resolutionId, resolutionVersion: body.resolutionVersion,
      expectedRevision: body.expectedRevision, fingerprint: body.fingerprint, decision: body.decision, amount: body.amount,
      payments: Array.isArray(body.payments) && body.payments.length <= 4 ? body.payments.map((p: Record<string, unknown> | null) => ({ method: p?.method, amount: p?.amount })) : null,
      lines: Array.isArray(body.lines) && body.lines.length <= 500 ? body.lines.map((l: Record<string, unknown> | null) => ({ id: l?.id, productId: l?.productId,
        quantity: l?.quantity, unit_price: l?.unit_price, discount_amount: l?.discount_amount, tax_rate: l?.tax_rate })) : null,
      taxMode: body.taxMode, refundConfirmed: body.refundConfirmed === true,
      refundEvidence: typeof body.refundEvidence === "string" ? body.refundEvidence.trim() : null,
      approveReclose: body.approveReclose === true, closureFingerprint: body.closureFingerprint ?? null,
    };
    const { data, error } = await supabaseServer.rpc(body.action === "confirm" ? "sales_confirm_admin_resolution_inventory_v2" : "sales_correct_admin_resolution_v2", {
      p_receipt_id: id, p_actor_user_id: auth.actor.id, p_request: request,
    });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    return NextResponse.json({ ok: true, ...data });
  } catch { return NextResponse.json({ ok: false, error: "resolution_work_failed" }, { status: 409 }); }
}
