import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildInventoryItemsResponse,
  fetchActiveKegTrackingMappings,
  fetchInventoryItems,
  getInventoryKegCandidateIds,
  type InventoryReadItem,
} from "@/lib/inventory/items-server";
import {
  fetchKegProgressByItemId,
  type KegProgress,
  type KegTrackingMappingRow,
} from "@/lib/inventory/keg-progress";
import {
  fetchInventoryStatusByItemId,
  inventoryStatusMapToRecord,
  type InventoryStatusTimingMetric,
} from "@/lib/inventory/stock-check-status-server";
import type { InventoryStatus } from "@/lib/inventory/stock-check-status-core";

type SupabaseClientLike = Pick<SupabaseClient, "from" | "rpc">;

export const INVENTORY_BOOTSTRAP_TIMING_METRICS = [
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
  "first_chunk",
  "total",
] as const;

export type InventoryBootstrapTimingMetric =
  | (typeof INVENTORY_BOOTSTRAP_TIMING_METRICS)[number]
  | InventoryStatusTimingMetric;

export type InventoryBootstrapTiming = ReturnType<
  typeof createInventoryBootstrapTiming
>;

export type InventoryBootstrapBase = {
  inventoryItems: InventoryReadItem[];
  supplierPartners: Array<{ id: number; name: string }>;
  supplierAliases: Array<{ id: number; supplierName: string; status: "pending" | "linked" | "ignored"; businessPartnerId: number | null }>;
  supplierPartnerNames: Map<number, string>;
  activeItemIds: number[];
  kegCandidateIds: number[];
};

export type InventoryBootstrapEnrichment = {
  activeMappings: KegTrackingMappingRow[];
  statusByItemId: Map<number, InventoryStatus>;
  kegProgressByItemId: Map<number, KegProgress>;
};

export function createInventoryBootstrapTiming() {
  const routeStartedAt = performance.now();
  const durations = new Map<InventoryBootstrapTimingMetric, number>(
    INVENTORY_BOOTSTRAP_TIMING_METRICS.map((name) => [name, 0])
  );
  const record = (name: InventoryBootstrapTimingMetric, durationMs: number) => {
    durations.set(name, Math.max(0, durationMs));
  };
  const snapshot = () => {
    record("total", performance.now() - routeStartedAt);
    return Object.fromEntries(
      INVENTORY_BOOTSTRAP_TIMING_METRICS.map((name) => [
        name,
        Number((durations.get(name) || 0).toFixed(1)),
      ])
    ) as Record<(typeof INVENTORY_BOOTSTRAP_TIMING_METRICS)[number], number>;
  };
  const header = (
    names: readonly InventoryBootstrapTimingMetric[] =
      INVENTORY_BOOTSTRAP_TIMING_METRICS
  ) => {
    const values = snapshot();
    return names.map((name) => `${name};dur=${values[name].toFixed(1)}`).join(", ");
  };

  return { record, snapshot, header };
}

export async function fetchInventoryBootstrapBase(params: {
  supabase: SupabaseClientLike;
  includeInactive: boolean;
  timing: InventoryBootstrapTiming;
}) {
  const itemsStartedAt = performance.now();
  let inventoryItems: InventoryReadItem[];
  let partnerRows: Array<{ id: number | string; name: string }>;
  let aliasRows: Array<{ id: number | string; supplier_name: string; status: "pending" | "linked" | "ignored"; business_partner_id: number | string | null }>;
  try {
    const [items, partners, aliases] = await Promise.all([
      fetchInventoryItems({ supabase: params.supabase, includeInactive: params.includeInactive }),
      params.supabase.from("business_partners").select("id,name").eq("is_active", true).order("name"),
      params.supabase.from("business_partner_supplier_aliases").select("id,supplier_name,status,business_partner_id").in("status", ["pending", "linked", "ignored"]).order("supplier_name"),
    ]);
    if (partners.error) throw partners.error;
    if (aliases.error) throw aliases.error;
    inventoryItems = items;
    partnerRows = (partners.data ?? []) as typeof partnerRows;
    aliasRows = (aliases.data ?? []) as typeof aliasRows;
  } finally {
    params.timing.record("items", performance.now() - itemsStartedAt);
  }

  return {
    inventoryItems,
    supplierPartners: partnerRows.map(row => ({ id: Number(row.id), name: row.name })),
    supplierAliases: aliasRows.map(row => ({ id: Number(row.id), supplierName: row.supplier_name, status: row.status, businessPartnerId: row.business_partner_id === null ? null : Number(row.business_partner_id) })),
    supplierPartnerNames: new Map(partnerRows.map(row => [Number(row.id), row.name])),
    activeItemIds: inventoryItems
      .filter((item) => item.is_active !== false)
      .map((item) => Number(item.id))
      .filter((id) => Number.isInteger(id) && id > 0),
    kegCandidateIds: getInventoryKegCandidateIds(inventoryItems),
  } satisfies InventoryBootstrapBase;
}

export async function fetchInventoryBootstrapEnrichment(params: {
  supabase: SupabaseClientLike;
  base: InventoryBootstrapBase;
  timing: InventoryBootstrapTiming;
}) {
  const enrichStartedAt = performance.now();
  const statusStartedAt = performance.now();
  const statusPromise = fetchInventoryStatusByItemId({
    supabase: params.supabase,
    itemIds: params.base.activeItemIds,
    timing: params.timing.record,
  }).finally(() => {
    params.timing.record("status", performance.now() - statusStartedAt);
  });

  const mappingStartedAt = performance.now();
  const mappingPromise = fetchActiveKegTrackingMappings({
    supabase: params.supabase,
    kegCandidateIds: params.base.kegCandidateIds,
  }).finally(() => {
    params.timing.record("mapping", performance.now() - mappingStartedAt);
  });
  const kegStartedAt = performance.now();
  const kegPromise = mappingPromise
    .then((activeMappings) =>
      fetchKegProgressByItemId({
        supabase: params.supabase,
        inventoryItems: params.base.inventoryItems,
        kegCandidateIds: params.base.kegCandidateIds,
        preloadedMappings: activeMappings,
      })
    )
    .finally(() => {
      params.timing.record("keg", performance.now() - kegStartedAt);
    });

  try {
    const [statusByItemId, activeMappings, kegProgressByItemId] =
      await Promise.all([statusPromise, mappingPromise, kegPromise]);
    return {
      activeMappings,
      statusByItemId,
      kegProgressByItemId,
    } satisfies InventoryBootstrapEnrichment;
  } finally {
    params.timing.record("enrich_wall", performance.now() - enrichStartedAt);
  }
}

export const buildInventoryBootstrapResponse = (params: {
  base: InventoryBootstrapBase;
  enrichment: InventoryBootstrapEnrichment;
}) => ({
  ok: true as const,
  items: buildInventoryItemsResponse({
    items: params.base.inventoryItems,
    activeMappings: params.enrichment.activeMappings,
    supplierPartnerNames: params.base.supplierPartnerNames,
  }),
  supplierPartners: params.base.supplierPartners,
  supplierAliases: params.base.supplierAliases,
  statusMap: inventoryStatusMapToRecord(params.enrichment.statusByItemId),
  kegProgressMap: Object.fromEntries(
    Array.from(params.enrichment.kegProgressByItemId.entries()).map(
      ([itemId, progress]) => [String(itemId), progress]
    )
  ),
});

export const buildInventoryBootstrapInitialItems = (
  base: InventoryBootstrapBase
) =>
  buildInventoryItemsResponse({
    items: base.inventoryItems,
    activeMappings: [],
    supplierPartnerNames: base.supplierPartnerNames,
  });

export const buildInventoryBootstrapEnrichmentEvent = (
  enrichment: InventoryBootstrapEnrichment
) => ({
  statusMap: inventoryStatusMapToRecord(enrichment.statusByItemId),
  kegProgressMap: Object.fromEntries(
    Array.from(enrichment.kegProgressByItemId.entries()).map(
      ([itemId, progress]) => [String(itemId), progress]
    )
  ),
  activeKegTrackingItemIds: Array.from(
    new Set(
      enrichment.activeMappings
        .map((mapping) => Number(mapping.inventory_item_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  ),
});
