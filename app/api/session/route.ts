import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import {
  clearServerSessionCookie,
  refreshServerSessionCookie,
} from "@/lib/auth/server-session";
import { schedulePushSessionTouch } from "@/lib/notifications/push/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) {
      const response = NextResponse.json(
        { authenticated: false, code: auth.code },
        {
          status: auth.status,
          headers: { "Cache-Control": "no-store" },
        }
      );
      if (auth.status === 401) clearServerSessionCookie(response);
      return response;
    }

    const response = NextResponse.json(
      {
        authenticated: true,
        user: auth.actor,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
    const refreshed = refreshServerSessionCookie(response, auth.session);
    // 01-B: the refreshed expiry also extends this session's push devices (v1 legacy sessions
    // never registered any).
    if (refreshed && auth.session.v === 2) {
      try { schedulePushSessionTouch(refreshed); } catch { /* best effort */ }
    }
    return response;
  } catch (error) {
    console.error("[SESSION_GET_ERROR]", error);
    return NextResponse.json(
      { authenticated: false, code: "SESSION_CHECK_FAILED" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
