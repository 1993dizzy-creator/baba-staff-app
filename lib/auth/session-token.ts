import { createHmac, timingSafeEqual } from "node:crypto";

export const BABA_SESSION_VERSION = 2 as const;
export const BABA_SESSION_IDLE_SECONDS = 60 * 60 * 24 * 30;
export const BABA_SESSION_REFRESH_WINDOW_SECONDS = 60 * 60 * 24 * 7;
export const BABA_SESSION_REFRESH_MIN_INTERVAL_SECONDS = 60 * 60 * 24;
export const BABA_SESSION_ABSOLUTE_SECONDS = 60 * 60 * 24 * 180;
export const BABA_SESSION_CLOCK_SKEW_SECONDS = 60 * 5;

export type LegacySessionPayload = {
  v: 1;
  uid: string;
  exp: number;
};

export type SessionPayloadV2 = {
  v: 2;
  uid: string;
  iat: number;
  refreshedAt: number;
  exp: number;
  absoluteExp: number;
};

export type ServerSessionPayload = LegacySessionPayload | SessionPayloadV2;

const MAX_POSTGRES_BIGINT = BigInt("9223372036854775807");

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isPositiveBigintId(value: string) {
  if (!/^\d+$/.test(value)) return false;
  try {
    const id = BigInt(value);
    return id > BigInt(0) && id <= MAX_POSTGRES_BIGINT;
  } catch {
    return false;
  }
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function getSessionSecret() {
  const secret = process.env.BABA_SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("BABA_SESSION_SECRET must be at least 32 bytes.");
  }
  return secret;
}

export function isServerSessionConfigured() {
  const secret = process.env.BABA_SESSION_SECRET;
  return Boolean(secret && Buffer.byteLength(secret, "utf8") >= 32);
}

function sign(encodedPayload: string) {
  return createHmac("sha256", getSessionSecret())
    .update(encodedPayload)
    .digest("base64url");
}

function encodeAndSign(payload: ServerSessionPayload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function createServerSessionPayload(
  userId: string | number,
  now = nowInSeconds()
): SessionPayloadV2 {
  const uid = String(userId);
  if (!isPositiveBigintId(uid)) {
    throw new Error("A positive numeric user id is required for the server session.");
  }
  if (!isSafeTimestamp(now)) {
    throw new Error("A valid current timestamp is required for the server session.");
  }

  const absoluteExp = now + BABA_SESSION_ABSOLUTE_SECONDS;
  return {
    v: BABA_SESSION_VERSION,
    uid,
    iat: now,
    refreshedAt: now,
    exp: Math.min(now + BABA_SESSION_IDLE_SECONDS, absoluteExp),
    absoluteExp,
  };
}

export function createServerSessionToken(
  userId: string | number,
  now = nowInSeconds()
) {
  return encodeAndSign(createServerSessionPayload(userId, now));
}

export function createServerSessionTokenFromPayload(payload: SessionPayloadV2) {
  return encodeAndSign(payload);
}

function isValidV1Payload(
  payload: Partial<LegacySessionPayload>,
  now: number
): payload is LegacySessionPayload {
  return (
    payload.v === 1 &&
    typeof payload.uid === "string" &&
    isPositiveBigintId(payload.uid) &&
    isSafeTimestamp(payload.exp) &&
    payload.exp > now
  );
}

function isValidV2Payload(
  payload: Partial<SessionPayloadV2>,
  now: number
): payload is SessionPayloadV2 {
  if (
    payload.v !== BABA_SESSION_VERSION ||
    typeof payload.uid !== "string" ||
    !isPositiveBigintId(payload.uid) ||
    !isSafeTimestamp(payload.iat) ||
    !isSafeTimestamp(payload.refreshedAt) ||
    !isSafeTimestamp(payload.exp) ||
    !isSafeTimestamp(payload.absoluteExp)
  ) {
    return false;
  }

  if (
    payload.iat > now + BABA_SESSION_CLOCK_SKEW_SECONDS ||
    payload.refreshedAt > now + BABA_SESSION_CLOCK_SKEW_SECONDS ||
    payload.refreshedAt < payload.iat ||
    payload.exp <= now ||
    payload.absoluteExp <= now ||
    payload.exp > payload.absoluteExp ||
    payload.exp < payload.refreshedAt ||
    payload.absoluteExp < payload.iat ||
    payload.absoluteExp - payload.iat > BABA_SESSION_ABSOLUTE_SECONDS ||
    payload.exp - payload.refreshedAt >
      BABA_SESSION_IDLE_SECONDS + BABA_SESSION_CLOCK_SKEW_SECONDS
  ) {
    return false;
  }

  return true;
}

export function verifyServerSessionToken(
  token: string | undefined | null,
  now = nowInSeconds()
): ServerSessionPayload | null {
  if (!token || !isSafeTimestamp(now)) return null;
  const [encoded, signature, extra] = token.split(".");
  if (
    !encoded ||
    !signature ||
    extra ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature)
  ) {
    return null;
  }

  const expected = sign(encoded);
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as Partial<ServerSessionPayload>;
    if (payload.v === 1) {
      return isValidV1Payload(payload, now) ? payload : null;
    }
    if (payload.v === BABA_SESSION_VERSION) {
      return isValidV2Payload(payload, now) ? payload : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function refreshServerSessionPayload(
  payload: ServerSessionPayload,
  now = nowInSeconds()
): SessionPayloadV2 | null {
  if (!isSafeTimestamp(now)) return null;

  if (payload.v === 1) {
    return createServerSessionPayload(payload.uid, now);
  }

  if (payload.exp - now > BABA_SESSION_REFRESH_WINDOW_SECONDS) return null;
  if (
    now - payload.refreshedAt < BABA_SESSION_REFRESH_MIN_INTERVAL_SECONDS
  ) {
    return null;
  }

  const nextExp = Math.min(
    now + BABA_SESSION_IDLE_SECONDS,
    payload.absoluteExp
  );
  if (nextExp <= payload.exp || nextExp <= now) return null;

  return {
    ...payload,
    refreshedAt: now,
    exp: nextExp,
  };
}
