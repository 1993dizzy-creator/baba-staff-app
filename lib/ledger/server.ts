import "server-only";

import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { canManageLedger } from "./authorization";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function ledgerJson(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function requireLedgerActor() {
  const auth = await getAuthenticatedActor();
  if (!auth.ok) return { actor: null, response: ledgerJson({ ok: false, code: auth.code }, auth.status) };
  if (!canManageLedger(auth.actor.role)) return { actor: null, response: ledgerJson({ ok: false, code: "FORBIDDEN" }, 403) };
  return { actor: auth.actor, response: null };
}
