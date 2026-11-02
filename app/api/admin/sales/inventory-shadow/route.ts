import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import { inventoryShadowAction, isInventoryShadowEnabled, shadowSqlState } from "@/lib/sales/inventory-shadow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function valid(body: Record<string, unknown>) {
  const positive = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  const text = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= 2000;
  const times = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v) &&
    Object.values(v).every(x => typeof x === "string" && x.length <= 40);
  if (body.mode !== undefined && body.mode !== "shadow") return false;
  switch (body.action) {
    case "run": return body.limit === undefined || (positive(body.limit) && Number(body.limit) <= 50);
    case "compare": return positive(body.itemId);
    case "retry": case "status": return positive(body.jobId);
    case "confirm_coverage": return positive(body.logId) && text(body.proof);
    case "resolve_timing": return positive(body.versionId) && times(body.effectiveTimes) && text(body.proof) &&
      ["physical_event", "historical_correction"].includes(String(body.timeBasis));
    case "resolve_plan": return positive(body.versionId) && text(body.proof) && Array.isArray(body.targets) && body.targets.length <= 2000;
    case "movement": return positive(body.logId) && text(body.proof) && text(body.effectiveAt) &&
      ["count", "purchase", "physical_return", "adjustment"].includes(String(body.kind));
    case "capture": return positive(body.receiptId) && text(body.observationKey) && String(body.observationKey).length <= 200 &&
      (body.sourceSequence === null || positive(body.sourceSequence)) &&
      (body.sourceComplete === undefined || typeof body.sourceComplete === "boolean") &&
      (body.proof === undefined || text(body.proof)) &&
      (body.effectiveAt === undefined || body.effectiveAt === null || text(body.effectiveAt)) &&
      (body.effectiveTimes === undefined || times(body.effectiveTimes)) &&
      (body.timeBasis === undefined || ["unknown", "physical_event", "historical_correction"].includes(String(body.timeBasis)));
    default: return false;
  }
}

export async function POST(req: Request) {
  const auth = await requireRole(["owner", "master"]);
  if (!auth.ok) return NextResponse.json({ ok: false, code: auth.code }, { status: auth.status });
  if (!isInventoryShadowEnabled()) return NextResponse.json({ ok: false, code: "SHADOW_DISABLED" }, { status: 409 });
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || !valid(body as Record<string, unknown>))
    return NextResponse.json({ ok: false, code: "INVALID_SHADOW_REQUEST" }, { status: 400 });
  try {
    const input = body as Record<string, unknown>;
    const result = await inventoryShadowAction(String(input.action), input, auth.actor.username);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const code = shadowSqlState(error);
    return NextResponse.json({ ok: false, code, mode: "shadow" }, { status: code === "42501" ? 403 : 409 });
  }
}
