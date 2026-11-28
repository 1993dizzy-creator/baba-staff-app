import { NextResponse } from "next/server";
import { clearServerSessionCookie, readServerSession } from "@/lib/auth/server-session";
import { pushDeviceHash, readPushDeviceToken } from "@/lib/notifications/push/device";
import { revokePushSession } from "@/lib/notifications/push/server";

export async function POST(request: Request) {
  // 01-B: stop this session's push device (or every device of the session when the push device
  // cookie is unknown) and record the logout, so a registration still in flight is refused. Short
  // timeout; logout itself never fails (missing push DB, DB error or unreadable session only skip it).
  try {
    const token = readPushDeviceToken(request);
    await revokePushSession(await readServerSession(), token ? pushDeviceHash(token) : null);
  } catch {
    // ignore: the device rows still expire with the session and are re-checked before each send
  }
  const response = NextResponse.json({ ok: true });
  clearServerSessionCookie(response);
  return response;
}
