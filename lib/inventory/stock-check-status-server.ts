import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveInventoryBusinessDate } from "@/lib/inventory/inventory-business-time";
import {
  buildInventoryStatusByItemId,
  type InventoryStatus,
  type LatestStockCheckRow,
} from "@/lib/inventory/stock-check-status-core";
import { addStoreDays } from "@/lib/store-settings/business-time-core";

type SupabaseClientLike = Pick<SupabaseClient, "from" | "rpc">;

type SaleDeductionLogRow = {
  item_id: number | string | null;
};

export type InventoryStatusTimingMetric =
  | "business"
  | "sale_deduction"
  | "stock_check"
  | "status_queries_wall";

type InventoryStatusTiming = (
  name: InventoryStatusTimingMetric,
  durationMs: number
) => void;

const SALE_DEDUCTION_ACTIVE_LOOKBACK_DAYS = 60;

const chunkArray = <T,>(values: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

export const parseInventoryItemIds = (value: unknown) => {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .map((item) => Number(item))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
};

async function fetchRecentSaleDeductionItemIds(params: {
  supabase: SupabaseClientLike;
  itemIds: number[];
  currentBusinessDate: string;
}) {
  const activeItemIds = new Set<number>();
  if (params.itemIds.length === 0) return activeItemIds;

  const fromBusinessDate = addStoreDays(
    params.currentBusinessDate,
    -SALE_DEDUCTION_ACTIVE_LOOKBACK_DAYS
  );

  for (const itemIdChunk of chunkArray(params.itemIds, 500)) {
    const { data, error } = await params.supabase
      .from("inventory_logs")
      .select("item_id")
      .in("item_id", itemIdChunk)
      .eq("reason", "sale_deduction")
      .eq("source", "pos_sales")
      .gte("business_date", fromBusinessDate)
      .lte("business_date", params.currentBusinessDate);

    if (error) throw error;

    for (const log of (data || []) as SaleDeductionLogRow[]) {
      const itemId = Number(log.item_id);
      if (Number.isFinite(itemId) && itemId > 0) activeItemIds.add(itemId);
    }
  }

  return activeItemIds;
}

async function fetchLatestStockChecks(params: {
  supabase: SupabaseClientLike;
  itemIds: number[];
}) {
  const results = await Promise.all(
    chunkArray(params.itemIds, 500).map((itemIdChunk) =>
      params.supabase.rpc("inventory_latest_stock_checks_v1", {
        p_item_ids: itemIdChunk,
      })
    )
  );
  const latestStockChecks: LatestStockCheckRow[] = [];

  for (const { data, error } of results) {
    if (error) throw error;
    latestStockChecks.push(...((data || []) as LatestStockCheckRow[]));
  }

  return latestStockChecks;
}

export async function fetchInventoryStatusByItemId(params: {
  supabase: SupabaseClientLike;
  itemIds: number[];
  timing?: InventoryStatusTiming;
}) {
  if (params.itemIds.length === 0) {
    return new Map<number, InventoryStatus>();
  }

  const businessStartedAt = performance.now();
  let currentBusinessDate: string;
  try {
    currentBusinessDate = (await resolveInventoryBusinessDate()).businessDate;
  } finally {
    params.timing?.("business", performance.now() - businessStartedAt);
  }

  const queriesStartedAt = performance.now();
  const saleDeductionStartedAt = performance.now();
  const stockCheckStartedAt = performance.now();
  const [saleDeductionActiveItemIds, latestStockChecks] = await Promise.all([
    fetchRecentSaleDeductionItemIds({
      supabase: params.supabase,
      itemIds: params.itemIds,
      currentBusinessDate,
    }).finally(() => {
      params.timing?.(
        "sale_deduction",
        performance.now() - saleDeductionStartedAt
      );
    }),
    fetchLatestStockChecks({
      supabase: params.supabase,
      itemIds: params.itemIds,
    }).finally(() => {
      params.timing?.("stock_check", performance.now() - stockCheckStartedAt);
    }),
  ]);
  params.timing?.(
    "status_queries_wall",
    performance.now() - queriesStartedAt
  );

  return buildInventoryStatusByItemId({
    itemIds: params.itemIds,
    currentBusinessDate,
    saleDeductionActiveItemIds,
    latestStockChecks,
  });
}

export const inventoryStatusMapToRecord = (
  statusByItemId: Map<number, InventoryStatus>
) => Object.fromEntries(
  Array.from(statusByItemId.entries()).map(([itemId, status]) => [
    String(itemId),
    status,
  ])
);
