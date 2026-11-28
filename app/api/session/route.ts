import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import {
  clearServerSessionCookie,
  refreshServerSessionCookie,
} from "@/lib/auth/server-session";
import { schedulePushSessionTouch } from "@/lib/notifications/push/server";
import { nextPushDevice, pushDeviceCookie, pushDeviceMatchesSession, readPushDevice } from "@/lib/notifications/push/device";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
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
    // 01-B: a browser whose push device cookie is missing or belongs to another session (e.g. a
    // login made before this cookie existed) gets its next generation here. Cookie only, no DB write.
    if (auth.session.v === 2 && !pushDeviceMatchesSession(readPushDevice(request), auth.actor.id, auth.session.iat)) {
      const pushDevice = pushDeviceCookie(nextPushDevice(readPushDevice(request), { uid: auth.actor.id, iat: auth.session.iat }));
      if (pushDevice) response.cookies.set(pushDevice);
    }
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
