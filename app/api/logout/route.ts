import { NextResponse } from "next/server";
import { clearServerSessionCookie, readServerSession } from "@/lib/auth/server-session";
import { nextPushDevice, pushDeviceCookie, readPushDevice } from "@/lib/notifications/push/device";
import { revokePushSession } from "@/lib/notifications/push/server";

export async function POST(request: Request) {
  // 01-B: this browser moves to its next push generation (no user). The DB raises the browser's
  // floor to it and stops its push rows, so any push request issued before this logout is refused
  // when it arrives. Without a push device cookie the whole session is revoked. Short timeout;
  // logout itself never fails (missing push DB, DB error or unreadable session only skip it).
  const previous = readPushDevice(request);
  const loggedOut = previous ? nextPushDevice(previous, null) : null;
  try {
    await revokePushSession(await readServerSession(), loggedOut);
  } catch {
    // ignore: the device rows still expire with the session and are re-checked before each send
  }
  const response = NextResponse.json({ ok: true });
  clearServerSessionCookie(response);
  const cookie = loggedOut ? pushDeviceCookie(loggedOut) : null;
  if (cookie) response.cookies.set(cookie);
  return response;
}
