import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextResponse } from "next/server";
import { cookies } from "next/headers";

export const BABA_SESSION_COOKIE = "baba_session";
export const BABA_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

type SessionPayload = {
  v: 1;
  uid: string;
  exp: number;
};

const MAX_POSTGRES_BIGINT = BigInt("9223372036854775807");

function isPositiveBigintId(value: string) {
  if (!/^\d+$/.test(value)) return false;
  try {
    const id = BigInt(value);
    return id > BigInt(0) && id <= MAX_POSTGRES_BIGINT;
  } catch {
    return false;
  }
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

export function createServerSessionToken(userId: string | number) {
  const normalizedUserId = String(userId);
  if (!isPositiveBigintId(normalizedUserId)) {
    throw new Error("A positive numeric user id is required for the server session.");
  }
  const payload: SessionPayload = {
    v: 1,
    uid: normalizedUserId,
    exp: Math.floor(Date.now() / 1000) + BABA_SESSION_MAX_AGE_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function verifyServerSessionToken(token: string | undefined | null) {
  if (!token) return null;
  const [encoded, signature, extra] = token.split(".");
  if (
    !encoded ||
    !signature ||
    extra ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature)
  ) return null;

  const expected = sign(encoded);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as Partial<SessionPayload>;
    if (
      payload.v !== 1 ||
      typeof payload.uid !== "string" ||
      !isPositiveBigintId(payload.uid) ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

export async function readServerSession() {
  getSessionSecret();
  const cookieStore = await cookies();
  return verifyServerSessionToken(cookieStore.get(BABA_SESSION_COOKIE)?.value);
}

export function setServerSessionCookie(
  response: NextResponse,
  userId: string | number
) {
  response.cookies.set({
    name: BABA_SESSION_COOKIE,
    value: createServerSessionToken(userId),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: BABA_SESSION_MAX_AGE_SECONDS,
  });
}

export function clearServerSessionCookie(response: NextResponse) {
  response.cookies.set({
    name: BABA_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
