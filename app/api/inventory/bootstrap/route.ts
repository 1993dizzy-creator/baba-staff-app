import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import {
  buildInventoryBootstrapResponse,
  createInventoryBootstrapTiming,
  fetchInventoryBootstrapBase,
  fetchInventoryBootstrapEnrichment,
} from "@/lib/inventory/bootstrap-server";
import { canToggleInventoryItemActiveStatus } from "@/lib/inventory/items-server";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const errorResponse = (
  timing: ReturnType<typeof createInventoryBootstrapTiming>,
  error: string,
  status: number
) =>
  NextResponse.json(
    { ok: false, error, code: error },
    { status, headers: { "Server-Timing": timing.header() } }
  );

export async function GET(request: Request) {
  const timing = createInventoryBootstrapTiming();

  try {
    const authStartedAt = performance.now();
    let auth;
    try {
      auth = await getAuthenticatedActor();
    } finally {
      timing.record("auth", performance.now() - authStartedAt);
    }
    if (!auth.ok) return errorResponse(timing, auth.code, auth.status);

    const includeInactive =
      new URL(request.url).searchParams.get("includeInactive") === "true";
    if (
      includeInactive &&
      !canToggleInventoryItemActiveStatus(auth.actor.role)
    ) {
      return errorResponse(
        timing,
        "inventory_item_inactive_list_forbidden",
        403
      );
    }

    const base = await fetchInventoryBootstrapBase({
      supabase: supabaseAdmin,
      includeInactive,
      timing,
    });
    const enrichment = await fetchInventoryBootstrapEnrichment({
      supabase: supabaseAdmin,
      base,
      timing,
    });

    return NextResponse.json(buildInventoryBootstrapResponse({ base, enrichment }), {
      headers: { "Server-Timing": timing.header() },
    });
  } catch (error) {
    console.error("[INVENTORY_BOOTSTRAP_GET_ERROR]", error);
    return errorResponse(timing, "inventory_bootstrap_load_failed", 500);
  }
}
