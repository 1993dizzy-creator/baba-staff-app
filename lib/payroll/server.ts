import "server-only";

import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";

export const PAYROLL_NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

export function payrollJson(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: PAYROLL_NO_STORE_HEADERS });
}

export async function requirePayrollActor() {
  const auth = await getAuthenticatedActor();
  if (!auth.ok) return { actor: null, response: payrollJson({ ok: false, code: auth.code }, auth.status) };
  if (!['owner', 'master'].includes(auth.actor.role)) {
    return { actor: null, response: payrollJson({ ok: false, code: "FORBIDDEN" }, 403) };
  }
  return { actor: auth.actor, response: null };
}
