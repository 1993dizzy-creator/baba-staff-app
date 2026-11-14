import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const reply = (body: unknown, status: number) => NextResponse.json(body, { status, headers });

// Confirmation is the only write opened to all five active staff roles. The RPC
// rechecks live users flags and authorizes this exact transition under a row lock.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) return reply({ ok: false, code: auth.code }, auth.status);
    const { id } = await context.params;
    const reservationId = Number(id);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(reservationId)) {
      return reply({ ok: false, code: "invalid_input" }, 400);
    }
    let input: unknown;
    try { input = await req.json(); } catch { return reply({ ok: false, code: "invalid_input" }, 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return reply({ ok: false, code: "invalid_input" }, 400);
    }
    const version = (input as Record<string, unknown>).expectedVersion;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version >= 2147483647) {
      return reply({ ok: false, code: "invalid_input" }, 400);
    }
    const { data, error } = await supabaseServer.rpc("reservation_transition_v1", {
      p_actor_user_id: auth.actor.id,
      p_reservation_id: reservationId,
      p_expected_version: version,
      p_to_status: "confirmed",
      p_reason: null,
    });
    if (error || !data) return reply({ ok: false, code: "RESERVATIONS_UNAVAILABLE" }, 503);
    if (data.status !== "ok") {
      const status = ({ forbidden: 403, not_found: 404, invalid_input: 400,
        version_conflict: 409, invalid_transition: 409 } as Record<string, number>)[data.status];
      return status ? reply({ ok: false, code: data.status }, status)
        : reply({ ok: false, code: "RESERVATIONS_UNAVAILABLE" }, 503);
    }
    // Never forward full-contact mutation responses or arbitrary database fields.
    const r = data.reservation;
    if (!r || r.id !== reservationId || r.status !== "confirmed" || !Number.isInteger(r.version)
      || !Number.isSafeInteger(r.confirmedBy) || typeof r.confirmedAt !== "string") {
      return reply({ ok: false, code: "RESERVATIONS_UNAVAILABLE" }, 503);
    }
    return reply({ ok: true, reservation: { id: r.id, status: r.status, version: r.version,
      confirmedBy: r.confirmedBy, confirmedAt: r.confirmedAt } }, 200);
  } catch {
    return reply({ ok: false, code: "RESERVATIONS_UNAVAILABLE" }, 503);
  }
}
