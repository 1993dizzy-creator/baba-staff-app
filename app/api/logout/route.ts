import { NextResponse } from "next/server";
import { clearServerSessionCookie, readServerSession } from "@/lib/auth/server-session";
import { revokePushSession } from "@/lib/notifications/push/server";

export async function POST() {
  // 01-B: stop this session's push devices first (short timeout). Logout itself never fails:
  // a missing push DB, a DB error or an unreadable session only skips the revoke.
  try {
    await revokePushSession(await readServerSession());
  } catch {
    // ignore: the device rows still expire with the session and are re-checked before each send
  }
  const response = NextResponse.json({ ok: true });
  clearServerSessionCookie(response);
  return response;
}
