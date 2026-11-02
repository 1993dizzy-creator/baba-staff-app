import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const auth = await requireRole(["owner", "master"]);
  if (!auth.ok) return NextResponse.json({ ok: false, code: auth.code }, { status: auth.status });
  if (process.env.POS_CUKCUK_RELIABLE_INGESTION !== "enabled") return NextResponse.json({ ok: false, code: "RELIABLE_INGESTION_DISABLED" }, { status: 409 });
  const body = await req.json().catch(() => null);
  const id = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  if (body?.action === "evidence" && id(body.receiptId)) {
    const { data, error } = await supabaseServer.rpc("pos_ingest_shadow_evidence", { p_receipt_id: body.receiptId });
    return error ? NextResponse.json({ ok: false, code: "INGESTION_EVIDENCE_UNAVAILABLE" }, { status: 503 }) : NextResponse.json({ ok: true, result: data });
  }
  if (!body || body.action !== "resolve" || !id(body.snapshotId) || !(body.expectedHead === null || id(body.expectedHead)) ||
      typeof body.expectedCanonicalHash !== "string" || !/^[a-f0-9]{32}$/.test(body.expectedCanonicalHash) ||
      typeof body.evidence !== "string" || body.evidence.trim().length < 10 || body.evidence.length > 2000) {
    return NextResponse.json({ ok: false, code: "INVALID_INGESTION_RESOLUTION" }, { status: 400 });
  }
  const { data, error } = await supabaseServer.rpc("pos_ingest_resolve", {
    p_snapshot_id: body.snapshotId, p_expected_head: body.expectedHead, p_expected_canonical_hash: body.expectedCanonicalHash,
    p_actor_id: auth.actor.id, p_evidence: body.evidence,
  });
  if (error) return NextResponse.json({ ok: false, code: error.code === "42501" ? "FORBIDDEN" : "INGESTION_RESOLUTION_CONFLICT" }, { status: error.code === "42501" ? 403 : 409 });
  return NextResponse.json({ ok: true, result: data });
}
