import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { cleaningFeatureEnabled, confirmTableCleaning } from "@/lib/sales/table-cleaning-server";

const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie" };
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin) return NextResponse.json({ ok: false, code: "FORBIDDEN" }, { status: 403, headers });
    const auth = await getAuthenticatedActor();
    if (!auth.ok) return NextResponse.json({ ok: false, code: auth.code }, { status: auth.status, headers });
    if (!["master", "owner", "manager", "leader", "staff"].includes(auth.actor.role)) return NextResponse.json({ ok: false, code: "FORBIDDEN" }, { status: 403, headers });
    if (!cleaningFeatureEnabled()) return NextResponse.json({ ok: false, code: "CLEANING_DISABLED" }, { status: 503, headers });
    const { id } = await context.params;
    if (!/^[a-f0-9-]{36}$/i.test(id)) return NextResponse.json({ ok: false, code: "TABLE_NOT_FOUND" }, { status: 404, headers });
    const text = await request.text();
    if (text.length > 2048) return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400, headers });
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!body || !/^[a-f0-9-]{36}$/i.test(body.requestId) || !/^\d{4}-\d{2}-\d{2}$/.test(body.businessDate)
      || !Number.isSafeInteger(body.receiptId) || body.receiptId < 1 || !/^[a-f0-9]{32}$/.test(body.evidenceKey)) {
      return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400, headers });
    }
    return NextResponse.json({ ok: true, ...await confirmTableCleaning(id.toLowerCase(), auth.actor.id, body) }, { headers });
  } catch (error) {
    const stale = error instanceof Error && error.message === "CLEANING_STALE";
    return NextResponse.json({ ok: false, code: stale ? "CLEANING_STALE" : "CLEANING_UNAVAILABLE" }, { status: stale ? 409 : 503, headers });
  }
}
