import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth/server-auth";
import { inventoryShadowReadiness } from "@/lib/sales/inventory-shadow-readiness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 2000;
const id = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
function validScan(v: unknown) {
  if (!record(v) || !(v.total === null || (typeof v.total === "number" && Number.isSafeInteger(v.total) && v.total >= 0)) ||
      !Array.isArray(v.pages) || !Array.isArray(v.details) || v.pages.length > 100 || v.details.length > 5000) return false;
  return v.pages.every(p => record(p) && id(p.page) && id(p.limit) && Array.isArray(p.refs) && p.refs.length <= 100 && p.refs.every(text)) &&
    v.details.every(d => record(d) && text(d.refId) && typeof d.ok === "boolean" && (d.semanticHash === null || text(d.semanticHash)));
}
function valid(b: Record<string, unknown>) {
  if (b.mode !== undefined && b.mode !== "shadow") return false;
  if (b.action === "gate") return true;
  if (b.action === "source") return id(b.receiptId);
  if (b.action === "writer") return id(b.logId);
  if (b.action === "transfer_writer") return id(b.logId) && typeof b.expectedLogHash === "string" && /^[a-f0-9]{64}$/.test(b.expectedLogHash) &&
    ["count", "purchase", "adjustment", "physical_return"].includes(String(b.kind)) && text(b.effectiveAt) && text(b.proof);
  if (b.action !== "recovery" || !record(b.manifest)) return false;
  const m = b.manifest;
  return record(m.scope) && text(m.scope.branchId) && text(m.scope.from) && text(m.scope.toExclusive) &&
    validScan(m.first) && validScan(m.verification) && Array.isArray(m.localRefs) && m.localRefs.length <= 5000 && m.localRefs.every(text);
}
export async function POST(req: Request) {
  const auth = await requireRole(["owner", "master"]);
  if (!auth.ok) return NextResponse.json({ ok: false, code: auth.code }, { status: auth.status });
  if (process.env.POS_INVENTORY_SHADOW_MODE !== "shadow")
    return NextResponse.json({ ok: false, code: "SHADOW_DISABLED" }, { status: 409 });
  const body: unknown = await req.json().catch(() => null);
  if (!record(body) || !valid(body)) return NextResponse.json({ ok: false, code: "INVALID_SHADOW_CONTRACT_REQUEST" }, { status: 400 });
  try { return NextResponse.json({ ok: true, ...await inventoryShadowReadiness(body, auth.actor.username) }); }
  catch (error) {
    const raw = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const code = /^[A-Z0-9]{5}$/.test(raw) ? raw : "SHADOW_CONTRACT_UNAVAILABLE";
    return NextResponse.json({ ok: false, code }, { status: code === "42501" ? 403 : 409 });
  }
}
