import "server-only";

import type { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  BABA_SESSION_IDLE_SECONDS,
  createServerSessionPayload,
  createServerSessionTokenFromPayload,
  isServerSessionConfigured,
  refreshServerSessionPayload,
  verifyServerSessionToken,
  type ServerSessionPayload,
  type SessionPayloadV2,
} from "@/lib/auth/session-token";

export {
  BABA_SESSION_ABSOLUTE_SECONDS,
  BABA_SESSION_CLOCK_SKEW_SECONDS,
  BABA_SESSION_IDLE_SECONDS,
  BABA_SESSION_REFRESH_MIN_INTERVAL_SECONDS,
  BABA_SESSION_REFRESH_WINDOW_SECONDS,
  BABA_SESSION_VERSION,
  createServerSessionPayload,
  createServerSessionToken,
  createServerSessionTokenFromPayload,
  isServerSessionConfigured,
  refreshServerSessionPayload,
  verifyServerSessionToken,
  type LegacySessionPayload,
  type ServerSessionPayload,
  type SessionPayloadV2,
} from "@/lib/auth/session-token";

export const BABA_SESSION_COOKIE = "baba_session";
export const BABA_SESSION_MAX_AGE_SECONDS = BABA_SESSION_IDLE_SECONDS;

export async function readServerSession() {
  if (!isServerSessionConfigured()) {
    throw new Error("BABA_SESSION_SECRET must be at least 32 bytes.");
  }
  const cookieStore = await cookies();
  return verifyServerSessionToken(cookieStore.get(BABA_SESSION_COOKIE)?.value);
}

function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

export function setServerSessionCookie(
  response: NextResponse,
  userId: string | number
) {
  const now = Math.floor(Date.now() / 1000);
  const payload = createServerSessionPayload(userId, now);
  setServerSessionPayloadCookie(response, payload, now);
}

export function setServerSessionPayloadCookie(
  response: NextResponse,
  payload: SessionPayloadV2,
  now = Math.floor(Date.now() / 1000)
) {
  response.cookies.set({
    name: BABA_SESSION_COOKIE,
    value: createServerSessionTokenFromPayload(payload),
    ...sessionCookieOptions(Math.max(0, payload.exp - now)),
  });
}

export function refreshServerSessionCookie(
  response: NextResponse,
  payload: ServerSessionPayload,
  now = Math.floor(Date.now() / 1000)
) {
  const refreshed = refreshServerSessionPayload(payload, now);
  if (!refreshed) return false;
  setServerSessionPayloadCookie(response, refreshed, now);
  return true;
}

export function clearServerSessionCookie(response: NextResponse) {
  response.cookies.set({
    name: BABA_SESSION_COOKIE,
    value: "",
    ...sessionCookieOptions(0),
  });
}
