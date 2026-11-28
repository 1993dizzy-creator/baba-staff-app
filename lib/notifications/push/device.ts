import { createHash, randomBytes } from "node:crypto";

// Push device identity (01-B). An httpOnly random cookie set by the push routes only; the DB keeps
// its SHA-256 (base64url), never the value. It separates two devices of the same staff member whose
// sessions were issued in the same second (session iat is in seconds), so a logout on one device
// never stops push on the other and a late registration of the logged-out device is refused.
// It is not an authentication credential: every push route still requires the signed session.

export const PUSH_DEVICE_COOKIE = "baba_push_device";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

export function readPushDeviceToken(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== PUSH_DEVICE_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return TOKEN.test(value) ? value : null;
  }
  return null;
}

export const newPushDeviceToken = () => randomBytes(32).toString("base64url");

export const pushDeviceHash = (token: string) => createHash("sha256").update(token, "utf8").digest("base64url");

export function pushDeviceCookie(token: string) {
  return {
    name: PUSH_DEVICE_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  };
}
