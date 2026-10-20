import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { runKegSafetyChange } from "@/lib/inventory/keg-safety-server";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code, code: auth.code }, { status: auth.status });
    const { id } = await params;
    const sessionId = Number(id);
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return NextResponse.json({ ok: false, code: "KEG_INVALID_REQUEST" }, { status: 400 });
    const body = await req.json();
    return await runKegSafetyChange({ action: "edit-start", itemId: null, sessionId, actorUsername: auth.actor.username, body });
  } catch {
    return NextResponse.json({ ok: false, code: "KEG_SAFETY_UNAVAILABLE" }, { status: 503 });
  }
}
