import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { cleaningFeatureEnabled, confirmTableCleaning } from "@/lib/sales/table-cleaning-server";

const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie" };
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let stage = "origin";
  const reject = (code: string, status: number, at = stage) => {
    // Fixed codes/stages only: no actor, token, receipt payload or DB error text.
    console.warn("[TABLE_CLEANING_REJECTED]", { stage: at, code, status });
    return NextResponse.json({ ok: false, code, stage: at }, { status, headers });
  };
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin) return reject("FORBIDDEN", 403);
    stage = "authentication";
    const auth = await getAuthenticatedActor();
    if (!auth.ok) return reject(auth.code, auth.status);
    stage = "authorization";
    if (!["master", "owner", "manager", "leader", "staff"].includes(auth.actor.role)) return reject("FORBIDDEN", 403);
    stage = "feature";
    if (!cleaningFeatureEnabled()) return reject("CLEANING_DISABLED", 503);
    stage = "request";
    const { id } = await context.params;
    if (!/^[a-f0-9-]{36}$/i.test(id)) return reject("TABLE_NOT_FOUND", 404);
    const text = await request.text();
    if (text.length > 2048) return reject("INVALID_REQUEST", 400);
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!body || !/^[a-f0-9-]{36}$/i.test(body.requestId) || !/^\d{4}-\d{2}-\d{2}$/.test(body.businessDate)
      || !Number.isSafeInteger(body.receiptId) || body.receiptId < 1 || !/^[a-f0-9]{32}$/.test(body.evidenceKey)) {
      return reject("INVALID_REQUEST", 400);
    }
    stage = "service";
    const result = await confirmTableCleaning(id.toLowerCase(), auth.actor.id, body);
    console.info("[TABLE_CLEANING_CONFIRMED]", { stage: result.overview ? "complete" : "reload", status: 200 });
    return NextResponse.json({ ok: true, ...result }, { headers });
  } catch (error) {
    const stale = error instanceof Error && error.message === "CLEANING_STALE";
    const reported = error && typeof error === "object" && "stage" in error ? String(error.stage) : stage;
    const safeStage = ["feature", "context", "evidence", "confirm_rpc"].includes(reported) ? reported : stage;
    return reject(stale ? "CLEANING_STALE" : "CLEANING_UNAVAILABLE", stale ? 409 : 503, safeStage);
  }
}
