import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getBusinessDate } from "@/lib/common/business-time";
import { resolveInventoryBusinessDate } from "@/lib/inventory/inventory-business-time";
import { addStoreDays } from "@/lib/store-settings/business-time-core";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type StockCheckLogRow = {
  item_id: number | string | null;
  business_date: string | null;
  created_at: string | null;
};

type SaleDeductionLogRow = {
  item_id: number | string | null;
};

type InventoryStatus = {
  lastStockCheckDate: string | null;
  daysSinceStockCheck: number | null;
  needsStockCheck: boolean;
};

const STOCK_CHECK_STALE_DAYS = 7;
const SALE_DEDUCTION_ACTIVE_LOOKBACK_DAYS = 60;

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const chunkArray = <T,>(values: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const getBusinessDateTime = (dateKey: string) =>
  new Date(`${dateKey}T12:00:00+07:00`).getTime();

const getDaysBetweenBusinessDates = (fromDateKey: string, toDateKey: string) => {
  const fromTime = getBusinessDateTime(fromDateKey);
  const toTime = getBusinessDateTime(toDateKey);

  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return null;

  return Math.max(0, Math.floor((toTime - fromTime) / 86_400_000));
};

// Fallback only, for legacy inventory_logs rows saved before business_date
// existed on this table. This runs once per row inside a loop, so it
// deliberately uses the plain legacy cutoff calculation instead of an async
// store-settings lookup (see resolveInventoryBusinessDate's doc comment).
const getStockCheckDateKey = (log: StockCheckLogRow) => {
  if (log.business_date) return String(log.business_date);
  if (!log.created_at) return null;

  const createdAt = new Date(log.created_at);
  if (Number.isNaN(createdAt.getTime())) return null;

  return getBusinessDate(createdAt);
};

const parseItemIds = (value: unknown) => {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .map((item) => Number(item))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
};

const fetchRecentSaleDeductionItemIds = async (
  itemIds: number[],
  currentBusinessDate: string
) => {
  const activeItemIds = new Set<number>();
  if (itemIds.length === 0) return activeItemIds;

  const fromBusinessDate = addStoreDays(
    currentBusinessDate,
    -SALE_DEDUCTION_ACTIVE_LOOKBACK_DAYS
  );

  for (const itemIdChunk of chunkArray(itemIds, 500)) {
    const { data, error } = await supabaseAdmin
      .from("inventory_logs")
      .select("item_id")
      .in("item_id", itemIdChunk)
      .eq("reason", "sale_deduction")
      .eq("source", "pos_sales")
      .gte("business_date", fromBusinessDate)
      .lte("business_date", currentBusinessDate);

    if (error) throw error;

    for (const log of (data || []) as SaleDeductionLogRow[]) {
      const itemId = Number(log.item_id);
      if (Number.isFinite(itemId) && itemId > 0) {
        activeItemIds.add(itemId);
      }
    }
  }

  return activeItemIds;
};

const fetchStockCheckStatusByItemId = async (
  itemIds: number[],
  currentBusinessDate: string,
  saleDeductionActiveItemIds: Set<number>
) => {
  const statusByItemId = new Map<number, InventoryStatus>();

  itemIds.forEach((itemId) => {
    statusByItemId.set(itemId, {
      lastStockCheckDate: null,
      daysSinceStockCheck: null,
      needsStockCheck: true,
    });
  });

  if (itemIds.length === 0) return statusByItemId;

  const latestByItemId = new Map<number, string>();

  for (const itemIdChunk of chunkArray(itemIds, 500)) {
    const { data, error } = await supabaseAdmin
      .from("inventory_logs")
      .select("item_id, business_date, created_at")
      .in("item_id", itemIdChunk)
      .eq("reason", "stock_check")
      .order("business_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (error) throw error;

    for (const log of (data || []) as StockCheckLogRow[]) {
      const itemId = Number(log.item_id);
      if (!Number.isFinite(itemId) || itemId <= 0) continue;

      const dateKey = getStockCheckDateKey(log);
      if (!dateKey) continue;

      const currentLatest = latestByItemId.get(itemId);
      if (!currentLatest || dateKey > currentLatest) {
        latestByItemId.set(itemId, dateKey);
      }
    }
  }

  latestByItemId.forEach((lastStockCheckDate, itemId) => {
    const daysSinceStockCheck = getDaysBetweenBusinessDates(
      lastStockCheckDate,
      currentBusinessDate
    );
    const hasRecentSaleDeduction = saleDeductionActiveItemIds.has(itemId);

    statusByItemId.set(itemId, {
      lastStockCheckDate,
      daysSinceStockCheck,
      needsStockCheck:
        !hasRecentSaleDeduction &&
        (daysSinceStockCheck === null ||
          daysSinceStockCheck >= STOCK_CHECK_STALE_DAYS),
    });
  });

  saleDeductionActiveItemIds.forEach((itemId) => {
    const existing = statusByItemId.get(itemId);
    if (!existing) return;

    statusByItemId.set(itemId, {
      ...existing,
      needsStockCheck: false,
    });
  });

  return statusByItemId;
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const itemIds = parseItemIds(body?.itemIds);

    if (itemIds.length === 0) {
      return NextResponse.json({ ok: true, statusMap: {} });
    }

    const currentBusinessDate = (await resolveInventoryBusinessDate()).businessDate;
    const saleDeductionActiveItemIds = await fetchRecentSaleDeductionItemIds(
      itemIds,
      currentBusinessDate
    );
    const stockCheckStatusByItemId = await fetchStockCheckStatusByItemId(
      itemIds,
      currentBusinessDate,
      saleDeductionActiveItemIds
    );

    const statusMap = Object.fromEntries(
      Array.from(stockCheckStatusByItemId.entries()).map(([itemId, status]) => [
        String(itemId),
        status,
      ])
    );

    return NextResponse.json({ ok: true, statusMap });
  } catch (error) {
    console.error("[INVENTORY_ITEMS_STATUS_POST_ERROR]", error);

    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}
