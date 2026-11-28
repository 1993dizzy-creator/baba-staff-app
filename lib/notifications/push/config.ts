import "server-only";

// Web Push configuration (01-B). Values are read from the server environment and are never
// logged, returned (except the public key) or stored. Push stays unavailable unless every item is
// present and well-formed AND WEB_PUSH_ENABLED is exactly "true" (default OFF).
//   WEB_PUSH_ENABLED   global switch ("true" to send; anything else = off)
//   VAPID_PUBLIC_KEY   base64url P-256 public key (65 bytes)
//   VAPID_PRIVATE_KEY  base64url P-256 private key (32 bytes)
//   VAPID_SUBJECT      mailto: or https: contact URI required by push services

export const PUSH_ENV_NAMES = ["WEB_PUSH_ENABLED", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;

export type PushConfig =
  | { ok: true; publicKey: string; privateKey: string; subject: string }
  | { ok: false; reason: "disabled" | "not_configured" };

const bytes = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return -1;
  try { return Buffer.from(value, "base64url").length; } catch { return -1; }
};

export function getPushConfig(env: Record<string, string | undefined> = process.env): PushConfig {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = env.VAPID_SUBJECT?.trim() ?? "";
  const configured = bytes(publicKey) === 65 && Buffer.from(publicKey, "base64url")[0] === 4
    && bytes(privateKey) === 32
    && /^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject) && subject.length <= 200;
  if (!configured) return { ok: false, reason: "not_configured" };
  if (env.WEB_PUSH_ENABLED !== "true") return { ok: false, reason: "disabled" };
  return { ok: true, publicKey, privateKey, subject };
}
