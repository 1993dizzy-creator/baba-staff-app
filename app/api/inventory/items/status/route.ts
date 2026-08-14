import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { resolveInventoryBusinessDate } from "@/lib/inventory/inventory-business-time";
import {
  buildInventoryStatusByItemId,
  type LatestStockCheckRow,
} from "@/lib/inventory/stock-check-status-core";
import { addStoreDays } from "@/lib/store-settings/business-time-core";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type SaleDeductionLogRow = {
  item_id: number | string | null;
};

const SALE_DEDUCTION_ACTIVE_LOOKBACK_DAYS = 60;

const chunkArray = <T,>(values: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
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

const fetchLatestStockChecks = async (itemIds: number[]) => {
  const results = await Promise.all(
    chunkArray(itemIds, 500).map((itemIdChunk) =>
      supabaseAdmin.rpc("inventory_latest_stock_checks_v1", {
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
};

export async function POST(req: Request) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const body = await req.json();
    const itemIds = parseItemIds(body?.itemIds);

    if (itemIds.length === 0) {
      return NextResponse.json({ ok: true, statusMap: {} });
    }

    const currentBusinessDate = (await resolveInventoryBusinessDate()).businessDate;
    const [saleDeductionActiveItemIds, latestStockChecks] = await Promise.all([
      fetchRecentSaleDeductionItemIds(itemIds, currentBusinessDate),
      fetchLatestStockChecks(itemIds),
    ]);
    const stockCheckStatusByItemId = buildInventoryStatusByItemId({
      itemIds,
      currentBusinessDate,
      saleDeductionActiveItemIds,
      latestStockChecks,
    });

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
      { ok: false, error: "inventory_status_load_failed" },
      { status: 500 }
    );
  }
}
