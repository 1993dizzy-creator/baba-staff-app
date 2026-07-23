import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { resolveInventoryBusinessDate } from "@/lib/inventory/inventory-business-time";
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

type CurrentInventoryItem = {
  id: number;
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
  source: string | null;
  business_date: string | null;
};

type InventoryPriceLog = {
  id: number;
  item_id: number | null;
  old_price: string | number | null;
  new_price: string | number | null;
  diff: string | number | null;
  business_date: string | null;
  changed_at?: string | null;
  source: string | null;
  reason: string | null;
};

type ItemStatus = "existing" | "new" | "missing";
type MovementReason = Extract<
  InventoryReasonValue,
  "purchase" | "stock_check" | "service" | "other" | "sale_deduction"
>;

type ItemAccumulator = {
  purchaseQuantity: number;
  purchaseLogCount: number;
  purchaseAmountKnown: number;
  purchaseHasKnownPrice: boolean;
  purchaseHasMissingPrice: boolean;
  stockCheckNetChange: number;
  serviceNetChange: number;
  otherNetChange: number;
  saleDeductionNetChange: number;
  saleDeductionDeduction: number;
  stockCheckDeduction: number;
  serviceDeduction: number;
  otherDeduction: number;
  saleDeductionAmountFromLogs: number;
  saleDeductionDeductionWithPrice: number;
  saleDeductionHasMissingLogPrice: boolean;
};

type MonthlyItemResult = {
  itemId: number;
  code: string | null;
  name: string;
  nameVi: string | null;
  unit: string | null;
  supplier: string | null;
  supplierLabel: string | null;
  part: string | null;
  category: string | null;
  categoryVi: string | null;
  baselineQuantity: number | null;
  latestQuantity: number | null;
  stockNetChange: number;
  baselinePurchasePrice: number | null;
  latestPurchasePrice: number | null;
  registeredPrice: number | null;
  purchasePriceDiff: number | null;
  priceChangedDate: string | null;
  priceChangeEvents: PriceChangeEvent[];
  purchaseQuantity: number;
  purchaseLogCount: number;
  purchaseAmount: number | null;
  purchaseAmountMissing: boolean;
  stockCheckNetChange: number;
  serviceNetChange: number;
  otherNetChange: number;
  saleDeductionNetChange: number;
  saleDeductionDeduction: number;
  stockCheckDeduction: number;
  serviceDeduction: number;
  otherDeduction: number;
  saleDeductionAmount: number | null;
  saleDeductionAmountMissing: boolean;
  estimatedDeductionAmount: number | null;
  status: ItemStatus;
};

type PriceChangeEvent = {
  businessDate: string;
  previousPrice: number | null;
  newPrice: number;
  diff: number | null;
  source: string;
  reason: string | null;
  purchaseQuantity?: number | null;
};

type SupplierSummary = {
  supplier: string | null;
  supplierLabel: string | null;
  itemCount: number;
  purchaseQuantity: number;
  purchaseAmountKnown: number;
  purchaseAmountMissingCount: number;
  items: MonthlyItemResult[];
};

type SupplierSummaryAccumulator = SupplierSummary & {
  itemMap: Map<string, MonthlyItemResult>;
};

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

const getSupplierLabel = (supplier?: string | null) => {
  const trimmed = supplier?.trim();
  return trimmed || null;
};

const isValidMonth = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

const getMonthRange = (month: string) => {
  const [year, monthNumber] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const lastDay = new Date(year, monthNumber, 0).getDate();
  const monthEnd = `${month}-${String(lastDay).padStart(2, "0")}`;

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
  purchaseAmountKnown: 0,
  purchaseHasKnownPrice: false,
  purchaseHasMissingPrice: false,
  stockCheckNetChange: 0,
  serviceNetChange: 0,
  otherNetChange: 0,
  saleDeductionNetChange: 0,
  saleDeductionDeduction: 0,
  stockCheckDeduction: 0,
  serviceDeduction: 0,
  otherDeduction: 0,
  saleDeductionAmountFromLogs: 0,
  saleDeductionDeductionWithPrice: 0,
  saleDeductionHasMissingLogPrice: false,
});

const addMovement = (
  target: ItemAccumulator,
  reason: MovementReason,
  changeQuantity: number,
  purchasePrice?: number | null
) => {
  if (reason === "purchase") {
    if (changeQuantity > 0) {
      target.purchaseQuantity = roundDecimal(
        target.purchaseQuantity + changeQuantity
      );
      target.purchaseLogCount += 1;

      if (purchasePrice !== null && purchasePrice !== undefined) {
        target.purchaseAmountKnown = roundDecimal(
          target.purchaseAmountKnown + changeQuantity * purchasePrice
        );
        target.purchaseHasKnownPrice = true;
      } else {
        target.purchaseHasMissingPrice = true;
      }
    }
    return;
  }

  if (changeQuantity === 0) return;

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

  if (reason === "sale_deduction") {
    target.saleDeductionNetChange = roundDecimal(
      target.saleDeductionNetChange + changeQuantity
    );
    return;
  }

  target.otherNetChange = roundDecimal(target.otherNetChange + changeQuantity);
};

const buildPriceChangeEvents = (
  priceLogs: InventoryPriceLog[]
) => {
  return [...priceLogs]
    .sort((a, b) => {
      const aDate = a.business_date ?? "";
      const bDate = b.business_date ?? "";
      const dateCompare = aDate.localeCompare(bDate);
      if (dateCompare !== 0) return dateCompare;
      return a.id - b.id;
    })
    .reduce<PriceChangeEvent[]>((events, log) => {
      const businessDate = log.business_date;
      const newPrice = toNullableNumber(log.new_price);

      if (!businessDate || newPrice === null) return events;

      events.push({
        businessDate,
        previousPrice: toNullableNumber(log.old_price),
        newPrice,
        diff: toNullableNumber(log.diff),
        source: log.source || "system",
        reason: log.reason,
        purchaseQuantity: null,
      });

      return events;
    }, []);
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

const getCurrentInventoryItems = async () => {
  const { data, error } = await supabaseAdmin
    .from("inventory")
    .select(
      `
        id,
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
    );

  if (error) throw error;

  return ((data ?? []) as CurrentInventoryItem[]).map((item) => ({
    id: item.id,
    item_id: item.id,
    item_name: item.item_name,
    item_name_vi: item.item_name_vi,
    part: item.part,
    category: item.category,
    category_vi: item.category_vi,
    quantity: item.quantity,
    unit: item.unit,
    code: item.code,
    purchase_price: item.purchase_price,
    supplier: item.supplier,
  })) satisfies SnapshotItem[];
};

const createSupplierPurchaseItem = (
  log: InventoryLog,
  baseItem: MonthlyItemResult | undefined,
  supplier: string | null,
  supplierLabel: string | null
): MonthlyItemResult => ({
  itemId: log.item_id ?? log.id * -1,
  code: baseItem?.code ?? log.code ?? null,
  name:
    baseItem?.name?.trim() ||
    log.item_name?.trim() ||
    log.item_name_vi?.trim() ||
    "-",
  nameVi:
    baseItem?.nameVi?.trim() ||
    log.item_name_vi?.trim() ||
    null,
  unit: baseItem?.unit ?? log.unit ?? null,
  supplier,
  supplierLabel,
  part: baseItem?.part ?? log.part ?? null,
  category: baseItem?.category ?? log.category ?? null,
  categoryVi: baseItem?.categoryVi ?? log.category_vi ?? null,
  baselineQuantity: baseItem?.baselineQuantity ?? null,
  latestQuantity: baseItem?.latestQuantity ?? null,
  stockNetChange: baseItem?.stockNetChange ?? 0,
  baselinePurchasePrice: baseItem?.baselinePurchasePrice ?? null,
  latestPurchasePrice: baseItem?.latestPurchasePrice ?? null,
  registeredPrice: baseItem?.registeredPrice ?? null,
  purchasePriceDiff: baseItem?.purchasePriceDiff ?? null,
  priceChangedDate: baseItem?.priceChangedDate ?? null,
  priceChangeEvents: baseItem?.priceChangeEvents ?? [],
  purchaseQuantity: 0,
  purchaseLogCount: 0,
  purchaseAmount: null,
  purchaseAmountMissing: false,
  stockCheckNetChange: baseItem?.stockCheckNetChange ?? 0,
  serviceNetChange: baseItem?.serviceNetChange ?? 0,
  otherNetChange: baseItem?.otherNetChange ?? 0,
  saleDeductionNetChange: baseItem?.saleDeductionNetChange ?? 0,
  saleDeductionDeduction: baseItem?.saleDeductionDeduction ?? 0,
  stockCheckDeduction: baseItem?.stockCheckDeduction ?? 0,
  serviceDeduction: baseItem?.serviceDeduction ?? 0,
  otherDeduction: baseItem?.otherDeduction ?? 0,
  saleDeductionAmount: baseItem?.saleDeductionAmount ?? null,
  saleDeductionAmountMissing: baseItem?.saleDeductionAmountMissing ?? false,
  estimatedDeductionAmount: baseItem?.estimatedDeductionAmount ?? null,
  status: baseItem?.status ?? "existing",
});

const buildSupplierSummary = (
  logs: InventoryLog[],
  itemResultMap: Map<number, MonthlyItemResult>
) => {
  const map = new Map<string, SupplierSummaryAccumulator>();

  for (const log of logs) {
    const normalizedReason = normalizeInventoryReason(log.reason);
    const changeQuantity = roundDecimal(toNumber(log.change_quantity));

    if (normalizedReason !== "purchase" || changeQuantity <= 0) continue;

    const supplier = log.new_supplier?.trim() || null;
    const supplierKey = supplier || "__none__";
    const supplierLabel = getSupplierLabel(supplier);
    const existing =
      map.get(supplierKey) ??
      ({
        supplier,
        supplierLabel,
        itemCount: 0,
        purchaseQuantity: 0,
        purchaseAmountKnown: 0,
        purchaseAmountMissingCount: 0,
        items: [],
        itemMap: new Map<string, MonthlyItemResult>(),
      } satisfies SupplierSummaryAccumulator);

    const purchasePrice = toNullableNumber(log.new_purchase_price);
    const purchaseAmount =
      purchasePrice === null ? null : roundDecimal(changeQuantity * purchasePrice);
    const itemKey =
      log.item_id !== null && log.item_id !== undefined
        ? String(log.item_id)
        : `log:${log.id}`;
    const baseItem =
      log.item_id !== null && log.item_id !== undefined
        ? itemResultMap.get(Number(log.item_id))
        : undefined;
    const supplierItem =
      existing.itemMap.get(itemKey) ??
      createSupplierPurchaseItem(log, baseItem, supplier, supplierLabel);

    existing.purchaseQuantity = roundDecimal(
      existing.purchaseQuantity + changeQuantity
    );
    supplierItem.purchaseQuantity = roundDecimal(
      supplierItem.purchaseQuantity + changeQuantity
    );
    supplierItem.purchaseLogCount += 1;

    if (purchaseAmount === null) {
      existing.purchaseAmountMissingCount += 1;
      supplierItem.purchaseAmountMissing = true;
    } else {
      existing.purchaseAmountKnown = roundDecimal(
        existing.purchaseAmountKnown + purchaseAmount
      );
      supplierItem.purchaseAmount = roundDecimal(
        (supplierItem.purchaseAmount ?? 0) + purchaseAmount
      );
    }

    existing.itemMap.set(itemKey, supplierItem);

    map.set(supplierKey, existing);
  }

  return [...map.values()].map((supplier) => {
    const items = [...supplier.itemMap.values()].sort((a, b) => {
      const amountA = a.purchaseAmount ?? 0;
      const amountB = b.purchaseAmount ?? 0;
      const amountDiff = amountB - amountA;
      if (amountDiff !== 0) return amountDiff;

      const quantityDiff = b.purchaseQuantity - a.purchaseQuantity;
      if (quantityDiff !== 0) return quantityDiff;

      return a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });

    return {
      supplier: supplier.supplier,
      supplierLabel: supplier.supplierLabel,
      itemCount: items.length,
      purchaseQuantity: supplier.purchaseQuantity,
      purchaseAmountKnown: supplier.purchaseAmountKnown,
      purchaseAmountMissingCount: supplier.purchaseAmountMissingCount,
      items,
    } satisfies SupplierSummary;
  }).sort((a, b) => {
    const amountDiff = b.purchaseAmountKnown - a.purchaseAmountKnown;
    if (amountDiff !== 0) return amountDiff;

    const quantityDiff = b.purchaseQuantity - a.purchaseQuantity;
    if (quantityDiff !== 0) return quantityDiff;

    return (a.supplierLabel ?? "").localeCompare(b.supplierLabel ?? "", undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
};

const fetchMonthlyInventoryLogs = async (
  monthStart: string,
  toDate: string
): Promise<InventoryLog[]> => {
  const pageSize = 1000;
  let from = 0;
  const result: InventoryLog[] = [];

  while (true) {
    const { data, error } = await supabaseAdmin
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
          source,
          business_date
        `
      )
      .gte("business_date", monthStart)
      .lte("business_date", toDate)
      .order("business_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;

    const page = (data ?? []) as InventoryLog[];
    result.push(...page);

    if (page.length < pageSize) break;

    from += pageSize;
  }

  return result;
};

export async function GET(request: Request) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const { searchParams } = new URL(request.url);
    const requestedMonth = searchParams.get("month");

    // Single settings lookup per request: the current businessDate is needed
    // both to default an unspecified month and to cap "this month" at today
    // instead of the full calendar month-end.
    const { businessDate: currentBusinessDate } = await resolveInventoryBusinessDate();
    const currentMonth = currentBusinessDate.slice(0, 7);
    const month = requestedMonth || currentMonth;

    if (!isValidMonth(month)) {
      return NextResponse.json(
        { ok: false, message: "Invalid month format. Use YYYY-MM." },
        { status: 400 }
      );
    }

    const { monthStart, monthEnd } = getMonthRange(month);
    const isCurrentMonth = month === currentMonth;
    const toDate = isCurrentMonth ? currentBusinessDate : monthEnd;

    const baselineBatchQuery = supabaseAdmin
      .from("inventory_snapshot_batches")
      .select("id, snapshot_date")
      .lt("snapshot_date", monthStart)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const latestBatchQuery = isCurrentMonth
      ? Promise.resolve({ data: null, error: null })
      : supabaseAdmin
          .from("inventory_snapshot_batches")
          .select("id, snapshot_date")
          .gte("snapshot_date", monthStart)
          .lte("snapshot_date", monthEnd)
          .order("snapshot_date", { ascending: false })
          .limit(1)
          .maybeSingle();

    const [
      { data: baselineBatch, error: baselineError },
      latestBatchResult,
    ] = await Promise.all([baselineBatchQuery, latestBatchQuery]);

    if (baselineError) throw baselineError;
    if (latestBatchResult.error) throw latestBatchResult.error;

    const baseline = (baselineBatch ?? null) as SnapshotBatch | null;
    const latest = (latestBatchResult.data ?? null) as SnapshotBatch | null;

    const [baselineItems, latestItems] = await Promise.all([
      getSnapshotItems(baseline?.id ?? null),
      isCurrentMonth
        ? getCurrentInventoryItems()
        : getSnapshotItems(latest?.id ?? null),
    ]);

    const [allLogs, { data: priceLogs, error: priceLogsError }] =
      await Promise.all([
        fetchMonthlyInventoryLogs(monthStart, toDate),
        supabaseAdmin
          .from("inventory_price_logs")
          .select(
            `
              id,
              item_id,
              old_price,
              new_price,
              diff,
              business_date,
              source,
              reason
            `
          )
          .gte("business_date", monthStart)
          .lte("business_date", toDate)
          .order("business_date", { ascending: true })
          .order("id", { ascending: true }),
      ]);

    if (priceLogsError) throw priceLogsError;

    const baselineMap = getItemMap(baselineItems);
    const latestMap = getItemMap(latestItems);
    const itemIds = new Set<number>([
      ...baselineMap.keys(),
      ...latestMap.keys(),
      ...allLogs
        .map((log) => log.item_id)
        .filter((itemId): itemId is number => itemId !== null),
      ...((priceLogs ?? []) as InventoryPriceLog[])
        .map((log) => log.item_id)
        .filter((itemId): itemId is number => itemId !== null),
    ]);

    const itemMovementMap = new Map<number, ItemAccumulator>();
    const itemPriceLogMap = new Map<number, InventoryPriceLog[]>();
    const registeredPriceMap = new Map<number, number>();
    let unclassifiedLogCount = 0;

    const safeItemIds = [...itemIds];

    if (safeItemIds.length > 0) {
      const { data: registeredPriceLogs, error: registeredPriceLogsError } =
        await supabaseAdmin
          .from("inventory_price_logs")
          .select(
            `
              id,
              item_id,
              old_price,
              new_price,
              business_date,
              changed_at,
              reason
            `
          )
          .in("item_id", safeItemIds)
          .eq("reason", "create")
          .is("old_price", null)
          .order("business_date", { ascending: true })
          .order("changed_at", { ascending: true })
          .order("id", { ascending: true });

      if (registeredPriceLogsError) throw registeredPriceLogsError;

      for (const log of (registeredPriceLogs ?? []) as InventoryPriceLog[]) {
        if (log.item_id === null || log.item_id === undefined) continue;

        const itemId = Number(log.item_id);
        if (registeredPriceMap.has(itemId)) continue;

        const registeredPrice = toNullableNumber(log.new_price);
        if (registeredPrice !== null) {
          registeredPriceMap.set(itemId, registeredPrice);
        }
      }
    }

    for (const log of (priceLogs ?? []) as InventoryPriceLog[]) {
      if (log.item_id === null || log.item_id === undefined) continue;

      const itemId = Number(log.item_id);
      const existing = itemPriceLogMap.get(itemId) ?? [];
      existing.push(log);
      itemPriceLogMap.set(itemId, existing);
    }

    for (const log of allLogs) {
      const businessDate = log.business_date;
      const itemId = log.item_id;
      const reasonFromLog = normalizeInventoryReason(log.reason);
      const normalizedReason =
        log.source === "pos_sales" && reasonFromLog === "unclassified"
          ? ("sale_deduction" as const)
          : reasonFromLog;

      if (!businessDate || normalizedReason === "unclassified") {
        unclassifiedLogCount += 1;
        continue;
      }

      if (
        normalizedReason !== "purchase" &&
        normalizedReason !== "stock_check" &&
        normalizedReason !== "service" &&
        normalizedReason !== "other" &&
        normalizedReason !== "sale_deduction"
      ) {
        unclassifiedLogCount += 1;
        continue;
      }

      const changeQuantity = roundDecimal(toNumber(log.change_quantity));
      const logPurchasePrice = toNullableNumber(log.new_purchase_price);

      if (itemId !== null && itemId !== undefined) {
        const safeItemId = Number(itemId);
        const itemAccumulator =
          itemMovementMap.get(safeItemId) ?? createItemAccumulator();

        addMovement(
          itemAccumulator,
          normalizedReason,
          changeQuantity,
          logPurchasePrice
        );

        if (changeQuantity < 0 && normalizedReason !== "purchase") {
          const abs = roundDecimal(Math.abs(changeQuantity));
          if (normalizedReason === "sale_deduction") {
            itemAccumulator.saleDeductionDeduction = roundDecimal(itemAccumulator.saleDeductionDeduction + abs);
            const logPrice = toNullableNumber(log.new_purchase_price) ?? toNullableNumber(log.prev_purchase_price);
            if (logPrice !== null) {
              itemAccumulator.saleDeductionAmountFromLogs = roundDecimal(
                itemAccumulator.saleDeductionAmountFromLogs + abs * logPrice
              );
              itemAccumulator.saleDeductionDeductionWithPrice = roundDecimal(
                itemAccumulator.saleDeductionDeductionWithPrice + abs
              );
            } else {
              itemAccumulator.saleDeductionHasMissingLogPrice = true;
            }
          } else if (normalizedReason === "stock_check") itemAccumulator.stockCheckDeduction = roundDecimal(itemAccumulator.stockCheckDeduction + abs);
          else if (normalizedReason === "service") itemAccumulator.serviceDeduction = roundDecimal(itemAccumulator.serviceDeduction + abs);
          else itemAccumulator.otherDeduction = roundDecimal(itemAccumulator.otherDeduction + abs);
        }

        itemMovementMap.set(safeItemId, itemAccumulator);
      }
    }

    const items: MonthlyItemResult[] = [...itemIds].map((itemId) => {
      const baselineItem = baselineMap.get(itemId) ?? null;
      const latestItem = latestMap.get(itemId) ?? null;
      const displayItem = latestItem ?? baselineItem;
      const movement = itemMovementMap.get(itemId) ?? createItemAccumulator();
      const supplier = latestItem?.supplier ?? baselineItem?.supplier ?? null;

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
      const registeredPrice =
        registeredPriceMap.get(itemId) ??
        baselinePurchasePrice ??
        latestPurchasePrice;
      const purchasePriceUsed = baselinePurchasePrice ?? latestPurchasePrice;
      const purchasePriceDiff =
        baselinePurchasePrice !== null && latestPurchasePrice !== null
          ? roundDecimal(latestPurchasePrice - baselinePurchasePrice)
          : null;
      const priceChangeEvents = buildPriceChangeEvents(
        itemPriceLogMap.get(itemId) ?? []
      );
      const priceChangedDate = priceChangeEvents[0]?.businessDate ?? null;
      const purchaseAmount =
        movement.purchaseQuantity > 0 && movement.purchaseHasKnownPrice
          ? roundDecimal(movement.purchaseAmountKnown)
          : null;
      const purchaseAmountMissing =
        movement.purchaseQuantity > 0 && movement.purchaseHasMissingPrice;
      const status: ItemStatus =
        baselineItem && latestItem ? "existing" : latestItem ? "new" : "missing";

      return {
        itemId,
        code: displayItem?.code ?? null,
        name: displayItem?.item_name || displayItem?.item_name_vi || "-",
        nameVi: displayItem?.item_name_vi ?? null,
        unit: displayItem?.unit ?? null,
        supplier,
        supplierLabel: getSupplierLabel(supplier),
        part: displayItem?.part ?? null,
        category: displayItem?.category ?? null,
        categoryVi: displayItem?.category_vi ?? null,

        baselineQuantity,
        latestQuantity,
        stockNetChange,

        baselinePurchasePrice,
        latestPurchasePrice,
        registeredPrice,
        purchasePriceDiff,
        priceChangedDate,
        priceChangeEvents,

        purchaseQuantity: movement.purchaseQuantity,
        purchaseLogCount: movement.purchaseLogCount,
        purchaseAmount,
        purchaseAmountMissing,

        stockCheckNetChange: movement.stockCheckNetChange,
        serviceNetChange: movement.serviceNetChange,
        otherNetChange: movement.otherNetChange,
        saleDeductionNetChange: movement.saleDeductionNetChange,

        saleDeductionDeduction: movement.saleDeductionDeduction,
        stockCheckDeduction: movement.stockCheckDeduction,
        serviceDeduction: movement.serviceDeduction,
        otherDeduction: movement.otherDeduction,
        ...(() => {
          const saleQtyWithoutLogPrice = roundDecimal(
            movement.saleDeductionDeduction - movement.saleDeductionDeductionWithPrice
          );
          const saleAmtFromItemPrice =
            saleQtyWithoutLogPrice > 0 && purchasePriceUsed !== null
              ? roundDecimal(saleQtyWithoutLogPrice * purchasePriceUsed)
              : 0;
          const saleDeductionHasMissingPrice =
            movement.saleDeductionHasMissingLogPrice && purchasePriceUsed === null;
          const saleDeductionAmount =
            movement.saleDeductionDeduction > 0
              ? movement.saleDeductionDeductionWithPrice > 0 || purchasePriceUsed !== null
                ? roundDecimal(movement.saleDeductionAmountFromLogs + saleAmtFromItemPrice)
                : null
              : null;

          const otherDeductionQty =
            movement.stockCheckDeduction + movement.serviceDeduction + movement.otherDeduction;
          const otherDeductionAmount =
            otherDeductionQty > 0 && purchasePriceUsed !== null
              ? roundDecimal(otherDeductionQty * purchasePriceUsed)
              : 0;
          const saleAmt = saleDeductionAmount ?? 0;
          const totalDeductionQty = movement.saleDeductionDeduction + otherDeductionQty;
          const estimatedDeductionAmount =
            totalDeductionQty > 0 && (saleAmt > 0 || otherDeductionAmount > 0)
              ? roundDecimal(saleAmt + otherDeductionAmount)
              : null;

          return { saleDeductionAmount, saleDeductionAmountMissing: saleDeductionHasMissingPrice, estimatedDeductionAmount };
        })(),

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

    const purchaseAmountKnown = [...itemMovementMap.values()].reduce(
      (sum, movement) => sum + movement.purchaseAmountKnown,
      0
    );

    let purchaseItemCount = 0;
    let purchaseAmountMissingCount = 0;
    let stockNetChangeSum = 0;
    let purchaseQuantitySum = 0;
    let purchaseLogCountSum = 0;
    let stockCheckNetChangeSum = 0;
    let serviceNetChangeSum = 0;
    let otherNetChangeSum = 0;
    let saleDeductionNetChangeSum = 0;
    const itemResultMap = new Map<number, MonthlyItemResult>();

    for (const item of items) {
      if (item.purchaseQuantity > 0) purchaseItemCount += 1;
      if (item.purchaseAmountMissing) purchaseAmountMissingCount += 1;

      stockNetChangeSum += item.stockNetChange;
      purchaseQuantitySum += item.purchaseQuantity;
      purchaseLogCountSum += item.purchaseLogCount;
      stockCheckNetChangeSum += item.stockCheckNetChange;
      serviceNetChangeSum += item.serviceNetChange;
      otherNetChangeSum += item.otherNetChange;
      saleDeductionNetChangeSum += item.saleDeductionNetChange;

      itemResultMap.set(item.itemId, item);
    }

    const supplierSummary = buildSupplierSummary(
      allLogs,
      itemResultMap
    );

    return NextResponse.json({
      ok: true,
      month,
      range: {
        fromDate: monthStart,
        toDate,
      },
      summary: {
        stockNetChange: roundDecimal(stockNetChangeSum),

        purchaseQuantity: roundDecimal(purchaseQuantitySum),
        purchaseLogCount: purchaseLogCountSum,
        purchaseItemCount,
        purchaseAmountKnown: roundDecimal(purchaseAmountKnown),
        purchaseAmountMissingCount,

        stockCheckNetChange: roundDecimal(stockCheckNetChangeSum),
        serviceNetChange: roundDecimal(serviceNetChangeSum),
        otherNetChange: roundDecimal(otherNetChangeSum),
        saleDeductionNetChange: roundDecimal(saleDeductionNetChangeSum),

        unclassifiedLogCount,
      },
      supplierSummary,
      items,
    });
  } catch (error) {
    console.error("[INVENTORY_MONTHLY_GET_ERROR]", error);

    return NextResponse.json(
      { ok: false, error: "inventory_monthly_load_failed" },
      { status: 500 }
    );
  }
}
