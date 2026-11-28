import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Push device identity + generation (01-B, FINAL-2). One httpOnly cookie per browser, signed by the
// server (HMAC-SHA256 with the existing session secret, separate domain tag), so the client can
// neither forge nor reorder it. The DB keeps only SHA-256(d).
//
//   d  random device id (per browser), t  server time (ms) the id was created,
//   g  generation: +1 on every login and logout in this browser (computed from the cookie the
//      browser sends, so later logins always carry a strictly larger g; no DB write),
//   n  random nonce of this generation, s  server time (ms) this generation was issued,
//   u/i  the session (user id, session iat) it belongs to (null after logout).
//
// Push routes act only when this cookie matches the authenticated session. A request issued before
// an account switch carries the older generation and is refused by the DB's per-device floor,
// whatever the session seconds are. Issued by: login (g+1), logout (g+1, no user), and
// /api/session only when the cookie is missing or belongs to another session (pre-existing logins).
// It is not an authentication credential: every push route still requires the signed session.

export const PUSH_DEVICE_COOKIE = "baba_push_device";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
const TAG = "baba-push-device-v1|";

export type PushDevice = { d: string; t: number; g: number; n: string; s: number; u: number | null; i: number | null };

function secret() {
  const value = process.env.BABA_SESSION_SECRET;
  return value && Buffer.byteLength(value, "utf8") >= 32 ? value : null;
}

const sign = (key: string, encoded: string) => createHmac("sha256", key).update(TAG + encoded).digest("base64url");
const isId = (value: unknown, length: number): value is string => typeof value === "string" && value.length === length && /^[A-Za-z0-9_-]+$/.test(value);
const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function readCookie(header: string | null) {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index >= 0 && part.slice(0, index).trim() === PUSH_DEVICE_COOKIE) return part.slice(index + 1).trim();
  }
  return null;
}

/** Verified cookie of this request, or null (absent, malformed, bad signature, no secret). */
export function readPushDevice(request: Request): PushDevice | null {
  const key = secret();
  const raw = readCookie(request.headers.get("cookie"));
  if (!key || !raw || raw.length > 600) return null;
  const [encoded, signature, extra] = raw.split(".");
  if (!encoded || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const expected = Buffer.from(sign(key, encoded), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<PushDevice> & { v?: number };
    if (value.v !== 1 || !isId(value.d, 43) || !isPositive(value.t) || !isPositive(value.g) || !isId(value.n, 22)) return null;
    const u = value.u ?? null, i = value.i ?? null;
    if ((u === null) !== (i === null) || (u !== null && (!isPositive(u) || !isPositive(i)))) return null;
    // s: generation issue time (cookies issued before it existed count as the oldest).
    const s = isPositive(value.s) ? value.s : 0;
    return { d: value.d, t: value.t, g: value.g, n: value.n, s, u, i };
  } catch {
    return null;
  }
}

/** Next generation for this browser (same device id when the previous cookie was valid). */
export function nextPushDevice(previous: PushDevice | null, owner: { uid: number; iat: number } | null, nowMs = Date.now()): PushDevice {
  return {
    d: previous?.d ?? randomBytes(32).toString("base64url"),
    t: previous?.t ?? nowMs,
    g: (previous?.g ?? 0) + 1,
    n: randomBytes(16).toString("base64url"),
    s: nowMs,
    u: owner?.uid ?? null,
    i: owner?.iat ?? null,
  };
}

export const pushDeviceMatchesSession = (device: PushDevice | null, uid: number, iat: number | undefined): device is PushDevice =>
  !!device && device.u === uid && typeof iat === "number" && device.i === iat;

export const pushDeviceHash = (device: PushDevice) => createHash("sha256").update(device.d, "utf8").digest("base64url");

/** Cookie options for NextResponse.cookies.set; null when the session secret is unavailable. */
export function pushDeviceCookie(device: PushDevice) {
  const key = secret();
  if (!key) return null;
  const encoded = Buffer.from(JSON.stringify({ v: 1, ...device }), "utf8").toString("base64url");
  return {
    name: PUSH_DEVICE_COOKIE,
    value: `${encoded}.${sign(key, encoded)}`,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  };
}

/** Fields the DB needs to order requests of one browser. */
export const pushDeviceArgs = (device: PushDevice) => ({
  p_device_hash: pushDeviceHash(device), p_device_generation: device.g, p_device_nonce: device.n, p_device_issued_ms: device.t,
});
