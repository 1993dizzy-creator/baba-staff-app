import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import {
  buildInventoryItemsResponse,
  canToggleInventoryItemActiveStatus,
  fetchActiveKegTrackingMappings,
  fetchInventoryItems,
  getInventoryKegCandidateIds,
} from "@/lib/inventory/items-server";
import { fetchKegProgressByItemId } from "@/lib/inventory/keg-progress";
import {
  fetchInventoryStatusByItemId,
  inventoryStatusMapToRecord,
  type InventoryStatusTimingMetric,
} from "@/lib/inventory/stock-check-status-server";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SERVER_TIMING_METRICS = [
  "auth",
  "items",
  "mapping",
  "business",
  "sale_deduction",
  "stock_check",
  "status_queries_wall",
  "status",
  "keg",
  "enrich_wall",
  "total",
] as const;

type ServerTimingMetric =
  | (typeof SERVER_TIMING_METRICS)[number]
  | InventoryStatusTimingMetric;

const createServerTiming = () => {
  const routeStartedAt = performance.now();
  const durations = new Map<ServerTimingMetric, number>(
    SERVER_TIMING_METRICS.map((name) => [name, 0])
  );
  const record = (name: ServerTimingMetric, durationMs: number) => {
    durations.set(name, Math.max(0, durationMs));
  };
  const header = () => {
    record("total", performance.now() - routeStartedAt);
    return SERVER_TIMING_METRICS.map(
      (name) => `${name};dur=${(durations.get(name) || 0).toFixed(1)}`
    ).join(", ");
  };

  return { record, header };
};

const errorResponse = (
  timing: ReturnType<typeof createServerTiming>,
  error: string,
  status: number
) =>
  NextResponse.json(
    { ok: false, error, code: error },
    { status, headers: { "Server-Timing": timing.header() } }
  );

export async function GET(request: Request) {
  const timing = createServerTiming();

  try {
    const authStartedAt = performance.now();
    let auth;
    try {
      auth = await getAuthenticatedActor();
    } finally {
      timing.record("auth", performance.now() - authStartedAt);
    }
    if (!auth.ok) {
      return errorResponse(timing, auth.code, auth.status);
    }

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

    const itemsStartedAt = performance.now();
    let inventoryItems;
    try {
      inventoryItems = await fetchInventoryItems({
        supabase: supabaseAdmin,
        includeInactive,
      });
    } finally {
      timing.record("items", performance.now() - itemsStartedAt);
    }

    const activeItemIds = inventoryItems
      .filter((item) => item.is_active !== false)
      .map((item) => Number(item.id))
      .filter((id) => Number.isInteger(id) && id > 0);
    const kegCandidateIds = getInventoryKegCandidateIds(inventoryItems);

    const enrichStartedAt = performance.now();
    const statusStartedAt = performance.now();
    const statusPromise = fetchInventoryStatusByItemId({
      supabase: supabaseAdmin,
      itemIds: activeItemIds,
      timing: timing.record,
    }).finally(() => {
      timing.record("status", performance.now() - statusStartedAt);
    });

    const mappingStartedAt = performance.now();
    const mappingPromise = fetchActiveKegTrackingMappings({
      supabase: supabaseAdmin,
      kegCandidateIds,
    }).finally(() => {
      timing.record("mapping", performance.now() - mappingStartedAt);
    });
    const kegStartedAt = performance.now();
    const kegPromise = mappingPromise
      .then((activeMappings) =>
        fetchKegProgressByItemId({
          supabase: supabaseAdmin,
          inventoryItems,
          kegCandidateIds,
          preloadedMappings: activeMappings,
        })
      )
      .finally(() => {
        timing.record("keg", performance.now() - kegStartedAt);
      });

    const [statusByItemId, activeMappings, kegProgressByItemId] =
      await Promise.all([statusPromise, mappingPromise, kegPromise]);
    timing.record("enrich_wall", performance.now() - enrichStartedAt);

    const kegProgressMap = Object.fromEntries(
      Array.from(kegProgressByItemId.entries()).map(([itemId, progress]) => [
        String(itemId),
        progress,
      ])
    );

    return NextResponse.json(
      {
        ok: true,
        items: buildInventoryItemsResponse({
          items: inventoryItems,
          activeMappings,
        }),
        statusMap: inventoryStatusMapToRecord(statusByItemId),
        kegProgressMap,
      },
      { headers: { "Server-Timing": timing.header() } }
    );
  } catch (error) {
    console.error("[INVENTORY_BOOTSTRAP_GET_ERROR]", error);
    return errorResponse(timing, "inventory_bootstrap_load_failed", 500);
  }
}
