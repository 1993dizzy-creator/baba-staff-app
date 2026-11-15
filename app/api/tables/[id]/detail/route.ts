import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { readTableDetail } from "@/lib/sales/table-detail-server";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie" };

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) return NextResponse.json({ ok: false, code: auth.code }, { status: auth.status, headers });
    const { id } = await context.params;
    if (!/^[a-f0-9-]{36}$/i.test(id)) return NextResponse.json({ ok: false, code: "TABLE_NOT_FOUND" }, { status: 404, headers });
    const detail = await readTableDetail(id.toLowerCase());
    return NextResponse.json(detail ? { ok: true, detail } : { ok: false, code: "TABLE_NOT_FOUND" }, { status: detail ? 200 : 404, headers });
  } catch {
    return NextResponse.json({ ok: false, code: "TABLE_DETAIL_UNAVAILABLE" }, { status: 503, headers });
  }
}
