// Web Push input validation shared by the subscription routes and the sender (01-B).
// The server never trusts a client-submitted endpoint: only HTTPS URLs on the standard browser
// push services are accepted (same allow list as the DB check constraint). There is no generic
// "send to any URL" path, no custom port, no user info, no IP literal, no localhost/private host.
// The sender re-checks every stored endpoint before each request; the HTTP client does not follow
// redirects, and the host names belong to the push providers (no attacker-controlled DNS).

export const PUSH_ENDPOINT_MAX_LENGTH = 1024;

const HOST_EXACT = new Set([
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "web.push.apple.com",
]);
const HOST_SUFFIX = [/^[a-z0-9-]{1,63}\.push\.apple\.com$/, /^[a-z0-9-]{1,63}\.notify\.windows\.com$/];
const ENDPOINT_SHAPE =
  /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]{1,63}\.push\.apple\.com|[a-z0-9-]{1,63}\.notify\.windows\.com)\/[A-Za-z0-9_~:./%=?&+-]+$/;

export function isAllowedPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > PUSH_ENDPOINT_MAX_LENGTH || !ENDPOINT_SHAPE.test(value) || value.includes("..")) {
    return false;
  }
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname;
  return HOST_EXACT.has(host) || HOST_SUFFIX.some((pattern) => pattern.test(host));
}

function base64UrlBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  try {
    return Uint8Array.from(Buffer.from(value.replace(/=+$/, ""), "base64url"));
  } catch {
    return null;
  }
}

/** P-256 uncompressed public key (65 bytes, 0x04 prefix) and a 16-byte auth secret. */
export function isValidPushKeys(p256dh: unknown, auth: unknown): p256dh is string {
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 100 || auth.length > 30) return false;
  const key = base64UrlBytes(p256dh);
  const secret = base64UrlBytes(auth);
  return !!key && key.length === 65 && key[0] === 4 && !!secret && secret.length === 16;
}

export type PushSubscriptionInput = { endpoint: string; p256dh: string; auth: string };

/** Accepts the browser's PushSubscription.toJSON() shape only. */
export function parsePushSubscription(value: unknown): PushSubscriptionInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["endpoint", "keys", "expirationTime"].includes(key))) return null;
  if (record.expirationTime !== undefined && record.expirationTime !== null && typeof record.expirationTime !== "number") return null;
  const keys = record.keys as Record<string, unknown> | undefined;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)
    || Object.keys(keys).some((key) => key !== "p256dh" && key !== "auth")) return null;
  if (!isAllowedPushEndpoint(record.endpoint) || !isValidPushKeys(keys.p256dh, keys.auth)) return null;
  return { endpoint: record.endpoint, p256dh: keys.p256dh as string, auth: keys.auth as string };
}
