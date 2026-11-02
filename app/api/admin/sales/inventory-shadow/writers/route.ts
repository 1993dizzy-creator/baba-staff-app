import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const auth = await requireRole(["owner", "master"]);
  if (!auth.ok) return NextResponse.json({ ok: false, code: auth.code }, { status: auth.status });
  if (process.env.POS_INVENTORY_SHADOW_MODE !== "shadow") return NextResponse.json({ ok: false, code: "SHADOW_DISABLED" }, { status: 409 });
  const b = await req.json().catch(() => null);
  if (b?.mode !== undefined && b.mode !== "shadow") return NextResponse.json({ ok: false, code: "INVALID_WRITER_REQUEST" }, { status: 400 });
  let rpc: string, args: Record<string, unknown> = { p_actor: auth.actor.username };
  const id = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  const uuid = (v: unknown) => typeof v === "string" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(v);
  const evidence = uuid(b?.requestId) && typeof b?.proof === "string" && b.proof.trim().length >= 10 && b.proof.length <= 2000;
  const time = (v: unknown) => typeof v === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
  if (b?.action === "observation_policy" && id(b.receiptId)) {
    const { receiptObservationPolicy } = await import("@/lib/sales/inventory-shadow-observation-server");
    return NextResponse.json({ ok: true, result: await receiptObservationPolicy(b.receiptId) });
  }
  if (b?.action === "inspect") rpc = "inventory_writer_inspect";
  else if (b?.action === "signed_compare" && id(b.itemId)) { rpc = "pos_signed_compare"; args.p_item = b.itemId; }
  else if (b?.action === "define_epoch" && evidence && id(b.itemId) && time(b.startsAt) && ["ml", "g", "each"].includes(b.baseUnit)
    && b.factors && typeof b.factors === "object" && !Array.isArray(b.factors) && (b.expectedEpoch === null || id(b.expectedEpoch))) {
    rpc = "pos_signed_define_epoch"; args = { ...args, p_item: b.itemId, p_from: b.startsAt, p_base: b.baseUnit, p_factors: b.factors,
      p_expected: b.expectedEpoch, p_proof: b.proof, p_request: b.requestId };
  } else if (b?.action === "revise_event" && evidence && uuid(b.eventId) && id(b.epochId) && time(b.effectiveAt) && typeof b.unit === "string"
    && (b.expectedRevision === null || id(b.expectedRevision)) && (b.timingEventId == null || uuid(b.timingEventId))) {
    rpc = "pos_signed_revise_event"; args = { ...args, p_event: b.eventId, p_epoch: b.epochId, p_unit: b.unit, p_at: b.effectiveAt,
      p_expected: b.expectedRevision, p_proof: b.proof, p_request: b.requestId, p_timing_event: b.timingEventId ?? null };
  } else if (b?.action === "adopt_receipt" && evidence && id(b.receiptId) && time(b.expectedReceiptUpdatedAt) && Array.isArray(b.targets) && b.targets.length <= 1000) {
    const { receiptObservationPolicy } = await import("@/lib/sales/inventory-shadow-observation-server");
    const policy = await receiptObservationPolicy(b.receiptId);
    if (!policy.signedAdoptionAllowed) return NextResponse.json({ ok: false, code: "SIGNED_OBSERVATION_EXCLUDED", policy, retryable: false }, { status: 409 });
    rpc = "pos_signed_adopt_receipt"; args = { ...args, p_receipt: b.receiptId, p_expected_at: b.expectedReceiptUpdatedAt,
      p_targets: b.targets, p_proof: JSON.stringify({ proof: b.proof, observationPolicy: policy }), p_request: b.requestId };
  } else if (b?.action === "observe_sale" && evidence && id(b.receiptId) && time(b.expectedReceiptUpdatedAt)
    && (b.parentVersion === null || id(b.parentVersion)) && ["sale", "correction", "cancel"].includes(b.kind) && Array.isArray(b.targets) && b.targets.length <= 1000) {
    rpc = "pos_signed_observe_sale"; args = { ...args, p_receipt: b.receiptId, p_parent: b.parentVersion, p_kind: b.kind,
      p_targets: b.targets, p_expected_at: b.expectedReceiptUpdatedAt, p_proof: b.proof, p_request: b.requestId };
  } else if (b?.action === "reconcile_day" && uuid(b.requestId) && uuid(b.runId) && b.external && typeof b.external === "object"
    && Array.isArray(b.external.entries) && b.external.entries.length <= 50000) {
    rpc = "pos_signed_reconcile_day"; args = { ...args, p_run: b.runId, p_external: b.external, p_request: b.requestId };
  }
  else if (b?.action === "drain" && Number.isInteger(b.limit) && b.limit >= 1 && b.limit <= 100) {
    rpc = "inventory_writer_shadow_drain"; args.p_limit = b.limit;
  } else if (b?.action === "compare" && Number.isSafeInteger(b.itemId) && b.itemId > 0) {
    rpc = "inventory_writer_compare"; args.p_item = b.itemId;
  } else if (b?.action === "attest" && typeof b.eventId === "string" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(b.eventId)
    && typeof b.expectedHash === "string" && /^[\da-f]{64}$/.test(b.expectedHash) && typeof b.effectiveAt === "string"
    && typeof b.proof === "string" && b.proof.trim().length >= 10 && b.proof.length <= 2000) {
    rpc = "inventory_writer_attest";args = { ...args, p_event: b.eventId, p_expected_hash: b.expectedHash, p_effective_at: b.effectiveAt,
      p_evidence: { proof: b.proof, ...(typeof b.physicalEventRef === "string" ? { physicalEventRef: b.physicalEventRef } : {}) } };
  } else return NextResponse.json({ ok: false, code: "INVALID_WRITER_REQUEST" }, { status: 400 });
  const { data, error } = await supabaseServer.rpc(rpc, args);
  return error ? NextResponse.json({ ok: false, code: error.code === "42501" ? "FORBIDDEN" : "WRITER_CONTRACT_UNAVAILABLE" }, { status: error.code === "42501" ? 403 : 409 })
    : NextResponse.json({ ok: true, result: data });
}
