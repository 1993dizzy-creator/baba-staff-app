import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import { supabaseServer } from "@/lib/supabase/server";
import { resolutionSchemaReady, resolutionWritesEnabled } from "@/lib/sales/admin-resolution-server";
import { validResolutionPayments } from "@/lib/sales/pending-resolution-policy";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(_req: Request, context: Context) {
  const auth = await requireRole(["owner", "master", "manager"]);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code }, { status: auth.status });
  if (!resolutionSchemaReady()) return NextResponse.json({ ok: true, enabled: false, schemaReady: false }, { headers: { "Cache-Control": "no-store" } });
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  const { data, error } = await supabaseServer.rpc("sales_get_pending_resolution_v1", { p_receipt_id: id, p_actor_user_id: auth.actor.id });
  if (error) return NextResponse.json({ ok: false, error: "resolution_unavailable" }, { status: 503 });
  const status = data?.status === "not_found" ? 404 : data?.status === "forbidden" ? 403 : 200;
  return NextResponse.json({ ok: status === 200, enabled: resolutionWritesEnabled(), schemaReady: true, workAvailable: process.env.POS_ADMIN_RESOLUTION_V2_SCHEMA_READY === "true", ...data }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request, context: Context) {
  const auth = await requireRole(["owner", "master", "manager"]);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code }, { status: auth.status });
  if (!resolutionWritesEnabled()) return NextResponse.json({ ok: false, error: "feature_disabled" }, { status: 503 });
  const id = Number((await context.params).id);
  const body = await req.json().catch(() => null);
  if (!Number.isSafeInteger(id) || id < 1 || !body || typeof body !== "object" || Array.isArray(body) ||
      typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 2000 ||
      typeof body.evidence !== "string" || !body.evidence.trim() || body.evidence.length > 2000 ||
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
      typeof body.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(body.fingerprint) ||
      typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId) ||
      (body.decision !== "paid" && body.decision !== "canceled") ||
      (body.decision === "paid" ? !validResolutionPayments(body.amount, body.payments) : body.amount !== 0 || !Array.isArray(body.payments) || body.payments.length !== 0)) {
    return NextResponse.json({ ok: false, error: "invalid_input" }, { status: 400 });
  }
  // Whitelist data; actor identity and role always come from the signed session.
  const request = {
    requestId: body.requestId, expectedRevision: body.expectedRevision, fingerprint: body.fingerprint,
    decision: body.decision, amount: body.amount, payments: body.payments,
    reason: body.reason.trim(), evidence: body.evidence.trim(),
    collectionAdjustmentConfirmed: body.collectionAdjustmentConfirmed === true,
    allowReclose: body.allowReclose === true, closureFingerprint: body.closureFingerprint ?? null,
  };
  const { data, error } = await supabaseServer.rpc(process.env.POS_ADMIN_RESOLUTION_V2_SCHEMA_READY === "true" ? "sales_resolve_pending_receipt_v2" : "sales_resolve_pending_receipt_v1", {
    p_receipt_id: id, p_actor_user_id: auth.actor.id, p_request: request,
  });
  if (error) return NextResponse.json({ ok: false, error: error.message === "POS_RESOLUTION_RECLOSE_FAILED" ? "reclose_failed" : "resolution_failed" }, { status: 409 });
  const status = data?.status === "resolved" ? 200 : data?.status === "forbidden" ? 403 : data?.status === "not_found" ? 404 : 409;
  return NextResponse.json({ ok: status === 200, ...data }, { status });
}
