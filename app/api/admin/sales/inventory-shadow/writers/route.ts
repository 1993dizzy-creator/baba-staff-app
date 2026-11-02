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
  if (b?.action === "inspect") rpc = "inventory_writer_inspect";
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
