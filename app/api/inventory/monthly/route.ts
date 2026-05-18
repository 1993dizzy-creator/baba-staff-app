import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getVietnamDateParts } from "@/lib/common/business-time";
import {
  type InventoryReasonValue,
  normalizeInventoryReason,
} from "@/lib/inventory/reasons";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type SnapshotBatch = {
  id: number;
  snapshot_date: string | null;
};

type SnapshotItem = {
  id: number;
  item_id: number | null;
  item_name: string | null;
  item_name_vi: string | null;
  part: string | null;
  category: string | null;
  category_vi: string | null;
  quantity: string | number | null;
  unit: string | null;
  code: string | null;
  purchase_price: string | number | null;
  supplier: string | null;
};

type InventoryLog = {
  id: number;
  item_id: number | null;
  item_name: string | null;
  item_name_vi: string | null;
  part: string | null;
  category: string | null;
  category_vi: string | null;
  change_quantity: string | number | null;
  unit: string | null;
  code: string | null;
  new_purchase_price: string | number | null;
  prev_purchase_price: string | number | null;
  new_supplier: string | null;
  prev_supplier: string | null;
  reason: string | null;
  business_date: string | null;
};

type ItemStatus = "existing" | "new" | "missing";
type MovementReason = Extract<
  InventoryReasonValue,
  "purchase" | "stock_check" | "service" | "other"
>;

type ItemAccumulator = {
  purchaseQuantity: number;
  purchaseLogCount: number;
  stockCheckNetChange: number;
  serviceNetChange: number;
  otherNetChange: number;
  totalLogNetChange: number;
};

type DayAccumulator = {
  businessDate: string;
  purchaseQuantity: number;
  purchaseLogCount: number;
  stockCheckNetChange: number;
  serviceNetChange: number;
  otherNetChange: number;
  totalLogNetChange: number;
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Server error";

const toNumber = (value: unknown) => {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const toNullableNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

const roundDecimal = (value: number) => Math.round(value * 1000) / 1000;

const formatDateKey = (date: Date) => date.toISOString().slice(0, 10);

const getDefaultMonth = () => {
  const parts = getVietnamDateParts();
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(
    2,
    "0"
  )}`;
};

const isValidMonth = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

const getMonthRange = (month: string) => {
  const [year, monthNumber] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const monthEnd = formatDateKey(new Date(Date.UTC(year, monthNumber, 0)));

  return { monthStart, monthEnd };
};

const getItemMap = (items: SnapshotItem[]) => {
  const map = new Map<number, SnapshotItem>();

  for (const item of items) {
    if (item.item_id !== null && item.item_id !== undefined) {
      map.set(Number(item.item_id), item);
    }
  }

  return map;
};

const createItemAccumulator = (): ItemAccumulator => ({
  purchaseQuantity: 0,
  purchaseLogCount: 0,
  stockCheckNetChange: 0,
  serviceNetChange: 0,
  otherNetChange: 0,
  totalLogNetChange: 0,
});

const getDayAccumulator = (
  dayMap: Map<string, DayAccumulator>,
  businessDate: string
) => {
  const existing = dayMap.get(businessDate);

  if (existing) return existing;

  const next: DayAccumulator = {
    businessDate,
    purchaseQuantity: 0,
    purchaseLogCount: 0,
    stockCheckNetChange: 0,
    serviceNetChange: 0,
    otherNetChange: 0,
    totalLogNetChange: 0,
  };

  dayMap.set(businessDate, next);
  return next;
};

const addMovement = (
  target: ItemAccumulator | DayAccumulator,
  reason: MovementReason,
  changeQuantity: number
) => {
  if (reason === "purchase") {
    if (changeQuantity > 0) {
      target.purchaseQuantity = roundDecimal(
        target.purchaseQuantity + changeQuantity
      );
      target.purchaseLogCount += 1;
    }
    return;
  }

  if (changeQuantity === 0) return;

  target.totalLogNetChange = roundDecimal(target.totalLogNetChange + changeQuantity);

  if (reason === "stock_check") {
    target.stockCheckNetChange = roundDecimal(
      target.stockCheckNetChange + changeQuantity
    );
    return;
  }

  if (reason === "service") {
    target.serviceNetChange = roundDecimal(target.serviceNetChange + changeQuantity);
    return;
  }

  target.otherNetChange = roundDecimal(target.otherNetChange + changeQuantity);
};

const getSnapshotItems = async (batchId: number | null) => {
  if (!batchId) return [] as SnapshotItem[];

  const { data, error } = await supabaseAdmin
    .from("inventory_snapshot_items")
    .select(
      `
        id,
        item_id,
        item_name,
        item_name_vi,
        part,
        category,
        category_vi,
        quantity,
        unit,
        code,
        purchase_price,
        supplier
      `
    )
    .eq("batch_id", batchId);

  if (error) throw error;

  return (data ?? []) as SnapshotItem[];
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const month = searchParams.get("month") || getDefaultMonth();

  if (!isValidMonth(month)) {
    return NextResponse.json(
      { ok: false, message: "Invalid month format. Use YYYY-MM." },
      { status: 400 }
    );
  }

  try {
    const { monthStart, monthEnd } = getMonthRange(month);

    const { data: baselineBatch, error: baselineError } = await supabaseAdmin
      .from("inventory_snapshot_batches")
      .select("id, snapshot_date")
      .lt("snapshot_date", monthStart)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (baselineError) throw baselineError;

    const { data: latestBatch, error: latestError } = await supabaseAdmin
      .from("inventory_snapshot_batches")
      .select("id, snapshot_date")
      .gte("snapshot_date", monthStart)
      .lte("snapshot_date", monthEnd)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestError) throw latestError;

    const baseline = (baselineBatch ?? null) as SnapshotBatch | null;
    const latest = (latestBatch ?? null) as SnapshotBatch | null;
    const toDate = latest?.snapshot_date || monthEnd;

    const [baselineItems, latestItems] = await Promise.all([
      getSnapshotItems(baseline?.id ?? null),
      getSnapshotItems(latest?.id ?? null),
    ]);

    const { data: logs, error: logsError } = await supabaseAdmin
      .from("inventory_logs")
      .select(
        `
          id,
          item_id,
          item_name,
          item_name_vi,
          part,
          category,
          category_vi,
          change_quantity,
          unit,
          code,
          new_purchase_price,
          prev_purchase_price,
          new_supplier,
          prev_supplier,
          reason,
          business_date
        `
      )
      .gte("business_date", monthStart)
      .lte("business_date", toDate)
      .order("business_date", { ascending: true });

    if (logsError) throw logsError;

    const baselineMap = getItemMap(baselineItems);
    const latestMap = getItemMap(latestItems);
    const itemIds = new Set<number>([
      ...baselineMap.keys(),
      ...latestMap.keys(),
      ...((logs ?? []) as InventoryLog[])
        .map((log) => log.item_id)
        .filter((itemId): itemId is number => itemId !== null),
    ]);

    const itemMovementMap = new Map<number, ItemAccumulator>();
    const dayMap = new Map<string, DayAccumulator>();
    let unclassifiedLogCount = 0;

    for (const log of (logs ?? []) as InventoryLog[]) {
      const businessDate = log.business_date;
      const itemId = log.item_id;
      const normalizedReason = normalizeInventoryReason(log.reason);

      if (!businessDate || normalizedReason === "unclassified") {
        unclassifiedLogCount += 1;
        continue;
      }

      if (
        normalizedReason !== "purchase" &&
        normalizedReason !== "stock_check" &&
        normalizedReason !== "service" &&
        normalizedReason !== "other"
      ) {
        unclassifiedLogCount += 1;
        continue;
      }

      const changeQuantity = roundDecimal(toNumber(log.change_quantity));

      if (itemId !== null && itemId !== undefined) {
        const safeItemId = Number(itemId);
        const itemAccumulator =
          itemMovementMap.get(safeItemId) ?? createItemAccumulator();

        addMovement(itemAccumulator, normalizedReason, changeQuantity);
        itemMovementMap.set(safeItemId, itemAccumulator);
      }

      const dayAccumulator = getDayAccumulator(dayMap, businessDate);
      addMovement(dayAccumulator, normalizedReason, changeQuantity);
    }

    const items = [...itemIds].map((itemId) => {
      const baselineItem = baselineMap.get(itemId) ?? null;
      const latestItem = latestMap.get(itemId) ?? null;
      const displayItem = latestItem ?? baselineItem;
      const movement = itemMovementMap.get(itemId) ?? createItemAccumulator();

      const baselineQuantity =
        baselineItem === null ? null : toNumber(baselineItem.quantity);
      const latestQuantity =
        latestItem === null ? null : toNumber(latestItem.quantity);
      const baselineQuantityForDiff = baselineQuantity ?? 0;
      const latestQuantityForDiff = latestQuantity ?? 0;
      const stockNetChange = roundDecimal(
        latestQuantityForDiff - baselineQuantityForDiff
      );

      const baselinePurchasePrice = toNullableNumber(
        baselineItem?.purchase_price
      );
      const latestPurchasePrice = toNullableNumber(latestItem?.purchase_price);
      const purchasePriceUsed = baselinePurchasePrice ?? latestPurchasePrice;
      const purchasePriceDiff =
        baselinePurchasePrice !== null && latestPurchasePrice !== null
          ? roundDecimal(latestPurchasePrice - baselinePurchasePrice)
          : null;
      const purchaseAmount =
        movement.purchaseQuantity > 0 && purchasePriceUsed !== null
          ? roundDecimal(movement.purchaseQuantity * purchasePriceUsed)
          : null;
      const status: ItemStatus =
        baselineItem && latestItem ? "existing" : latestItem ? "new" : "missing";

      return {
        itemId,
        code: displayItem?.code ?? null,
        name: displayItem?.item_name || displayItem?.item_name_vi || "-",
        nameVi: displayItem?.item_name_vi ?? null,
        unit: displayItem?.unit ?? null,
        supplier: latestItem?.supplier ?? baselineItem?.supplier ?? null,
        part: displayItem?.part ?? null,
        category: displayItem?.category ?? null,
        categoryVi: displayItem?.category_vi ?? null,

        baselineQuantity,
        latestQuantity,
        stockNetChange,

        baselinePurchasePrice,
        latestPurchasePrice,
        purchasePriceUsed,
        purchasePriceDiff,

        purchaseQuantity: movement.purchaseQuantity,
        purchaseLogCount: movement.purchaseLogCount,
        purchaseAmount,

        stockCheckNetChange: movement.stockCheckNetChange,
        serviceNetChange: movement.serviceNetChange,
        otherNetChange: movement.otherNetChange,
        totalLogNetChange: movement.totalLogNetChange,

        status,
      };
    });

    items.sort((a, b) => {
      const purchaseDiff = b.purchaseQuantity - a.purchaseQuantity;
      if (purchaseDiff !== 0) return purchaseDiff;

      const stockDiff =
        Math.abs(b.stockNetChange) - Math.abs(a.stockNetChange);
      if (stockDiff !== 0) return stockDiff;

      const nameCompare = a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      if (nameCompare !== 0) return nameCompare;

      return String(a.code || "").localeCompare(String(b.code || ""), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });

    const purchaseItems = items.filter((item) => item.purchaseQuantity > 0);
    const purchaseAmountKnown = items.reduce(
      (sum, item) => sum + (item.purchaseAmount ?? 0),
      0
    );
    const purchaseAmountMissingCount = items.filter(
      (item) => item.purchaseQuantity > 0 && item.purchasePriceUsed === null
    ).length;

    const days = [...dayMap.values()].sort((a, b) =>
      a.businessDate.localeCompare(b.businessDate)
    );

    return NextResponse.json({
      ok: true,
      month,
      range: {
        fromDate: monthStart,
        toDate,
      },
      baseline: {
        snapshotId: baseline?.id ?? null,
        snapshotDate: baseline?.snapshot_date ?? null,
      },
      latest: {
        snapshotId: latest?.id ?? null,
        snapshotDate: latest?.snapshot_date ?? null,
      },
      summary: {
        stockNetChange: roundDecimal(
          items.reduce((sum, item) => sum + item.stockNetChange, 0)
        ),

        purchaseQuantity: roundDecimal(
          items.reduce((sum, item) => sum + item.purchaseQuantity, 0)
        ),
        purchaseLogCount: items.reduce(
          (sum, item) => sum + item.purchaseLogCount,
          0
        ),
        purchaseItemCount: purchaseItems.length,
        purchaseAmountKnown: roundDecimal(purchaseAmountKnown),
        purchaseAmountMissingCount,

        stockCheckNetChange: roundDecimal(
          items.reduce((sum, item) => sum + item.stockCheckNetChange, 0)
        ),
        serviceNetChange: roundDecimal(
          items.reduce((sum, item) => sum + item.serviceNetChange, 0)
        ),
        otherNetChange: roundDecimal(
          items.reduce((sum, item) => sum + item.otherNetChange, 0)
        ),

        unclassifiedLogCount,
      },
      days,
      items,
    });
  } catch (error) {
    console.error("[INVENTORY_MONTHLY_GET_ERROR]", error);

    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}
