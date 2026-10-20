import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { runKegSafetyChange } from "@/lib/inventory/keg-safety-server";

export async function POST(req: Request) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code, code: auth.code }, { status: auth.status });
    const body = await req.json();
    const itemId = Number(body?.itemId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) return NextResponse.json({ ok: false, code: "KEG_INVALID_REQUEST" }, { status: 400 });
    return await runKegSafetyChange({ action: "replace", itemId, sessionId: null, actorUsername: auth.actor.username, body });
  } catch {
    return NextResponse.json({ ok: false, code: "KEG_SAFETY_UNAVAILABLE" }, { status: 503 });
  }
}
