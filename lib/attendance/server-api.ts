import "server-only";

import { NextResponse } from "next/server";
import {
  getAuthenticatedActor,
  type AuthenticatedActor,
  type AuthenticationFailureCode,
} from "@/lib/auth/server-auth";
import { isAttendanceRole } from "@/lib/attendance/api-policy";

export const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export function attendanceJson(
  body: Record<string, unknown>,
  status = 200
) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

type AttendanceAuthenticationResult =
  | { ok: true; actor: AuthenticatedActor }
  | {
      ok: false;
      status: 401 | 403 | 500;
      code: AuthenticationFailureCode;
    };

export async function requireAttendanceActor(): Promise<AttendanceAuthenticationResult> {
  const auth = await getAuthenticatedActor();
  if (!auth.ok) return auth;
  if (!isAttendanceRole(auth.actor.role)) {
    return { ok: false, status: 403, code: "FORBIDDEN" };
  }
  return { ok: true, actor: auth.actor };
}

export function attendanceAuthFailure(result: {
  status: 401 | 403 | 500;
  code: AuthenticationFailureCode;
}) {
  return attendanceJson({ ok: false, code: result.code }, result.status);
}
