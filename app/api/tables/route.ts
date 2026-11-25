import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { readTableOverview } from "@/lib/sales/table-overview-server";
import { logTablesReadFailure } from "@/lib/sales/table-read-diagnostics";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie" };

export async function GET() {
  const started = Date.now();
  try {
    // All roles share this read-only page. This rechecks the signed session and live users flags.
    const auth = await getAuthenticatedActor();
    if (!auth.ok) return NextResponse.json({ ok: false, code: auth.code }, { status: auth.status, headers });
    return NextResponse.json({ ok: true, overview: await readTableOverview() }, { headers });
  } catch (error) {
    logTablesReadFailure("response", error, started);
    return NextResponse.json({ ok: false, code: "TABLES_UNAVAILABLE" }, { status: 503, headers });
  }
}
