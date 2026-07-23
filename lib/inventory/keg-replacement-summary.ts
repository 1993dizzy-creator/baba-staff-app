import type { SupabaseClient } from "@supabase/supabase-js";

type SupabaseClientLike = Pick<SupabaseClient, "from">;
const POS_SALES_PAGE_SIZE = 500;
const roundDecimal = (value: number) => Math.round(value * 1000) / 1000;

export type KegSalesBreakdown = {
  /** Sum of POS receipt-line quantities matched to this keg's mapped products (not a stock/ml unit — a count of sold POS lines/units). */
  totalUnits: number;
  expectedTotalMl?: number;
  regularUnits: number;
  regularSoldMl: number;
  regularAllocatedMl?: number;
  regularAverageMl: number | null;
  towerUnits: number;
  towerSoldMl: number;
  towerAllocatedMl?: number;
  towerAverageMl: number | null;
  otherUnits: number;
  otherSoldMl: number;
  otherAllocatedMl?: number;
  otherAverageMl: number | null;
  /** Legacy field kept for old clients; prefer regularAverageMl/towerAverageMl for display. */
  averageCapacityMlPerUnit: number;
};

export type PreviousKegSummary = {
  sessionId: number;
  startedAt: string | null;
  endedAt: string | null;
  capacityMl: number;
  soldMl: number;
  lossMl: number;
  overageMl: number;
  usagePercent: number;
  lossPercent: number;
  salesBreakdown?: KegSalesBreakdown;
  salesBreakdownMismatch: boolean;
};

type ClosedKegSessionRow = {
  id: number | string;
  inventory_item_id: number | string;
  ended_log_id: number | string | null;
  started_at: string | null;
  ended_at: string | null;
  capacity_quantity: number | string | null;
  sold_quantity: number | string | null;
  loss_quantity: number | string | null;
};

type KegTrackingMappingRow = {
  pos_product_id: number | string | null;
  quantity_per_pos_unit: number | string | null;
};

type PosProductRow = {
  id: number | string;
  pos_item_id: string | null;
  item_id: string | null;
  item_code: string | null;
  item_name: string | null;
  unit_name: string | null;
};

type PosReceiptRow = {
  id: number | string;
  ref_date: string | null;
  synced_at: string | null;
  updated_at: string | null;
  payment_status: number | null;
  is_canceled: boolean | null;
};

type PosReceiptLineRow = {
  id: number | string;
  receipt_id: number | string | null;
  item_id: string | null;
  item_code: string | null;
  quantity: number | string | null;
  is_option: boolean | null;
  is_excluded: boolean | null;
  is_canceled: boolean | null;
  payment_status: number | null;
  ref_date: string | null;
  synced_at: string | null;
  updated_at: string | null;
};

const asNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const asOptionalKey = (value: unknown) => {
  const text = String(value ?? "").trim();
  return text ? text : null;
};

const chunkArray = <T,>(values: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const quotePostgrestValue = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export const buildKegLineMatchFilter = (products: PosProductRow[]) => {
  const itemIds = Array.from(
    new Set(
      products
        .flatMap((product) => [product.pos_item_id, product.item_id])
        .map(asOptionalKey)
        .filter((key): key is string => key !== null)
    )
  );
  const itemCodes = Array.from(
    new Set(
      products
        .map((product) => asOptionalKey(product.item_code))
        .filter((key): key is string => key !== null)
    )
  );
  return [
    itemIds.length > 0
      ? `item_id.in.(${itemIds.map(quotePostgrestValue).join(",")})`
      : null,
    itemCodes.length > 0
      ? `item_code.in.(${itemCodes.map(quotePostgrestValue).join(",")})`
      : null,
  ]
    .filter((filter): filter is string => filter !== null)
    .join(",");
};

const getLineReferenceTime = (
  line: PosReceiptLineRow,
  receipt: PosReceiptRow | undefined
) => {
  const candidates = [
    line.ref_date,
    receipt?.ref_date,
    line.synced_at,
    receipt?.synced_at,
    line.updated_at,
    receipt?.updated_at,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const time = Date.parse(candidate);
    if (Number.isFinite(time)) return time;
  }

  return null;
};

/**
 * Classifies a mapped POS product as "regular" (single glass/cup) vs "tower"
 * (large-format shared pour) for the sales breakdown display. Deliberately
 * keyed off `pos_products.unit_name` first — a POS-controlled sales-unit
 * field (e.g. "Cốc"/"Tháp") — rather than free-text `item_name`, since menu
 * item names change more often than the selling-unit field. Falls back to
 * item_name only when unit_name is missing, and to "other" when neither is
 * available (so unknown data is never silently mislabeled as "regular").
 */
const normalizeClassifyText = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d");

const TOWER_KEYWORDS = ["thap", "tower", "타워"];

const classifyMappingCategory = (
  product: PosProductRow | undefined
): "regular" | "tower" | "other" => {
  const unitName = normalizeClassifyText(product?.unit_name);
  if (unitName) {
    return TOWER_KEYWORDS.some((keyword) => unitName.includes(keyword))
      ? "tower"
      : "regular";
  }

  const itemName = normalizeClassifyText(product?.item_name);
  if (itemName) {
    return TOWER_KEYWORDS.some((keyword) => itemName.includes(keyword))
      ? "tower"
      : "regular";
  }

  return "other";
};

/**
 * Re-derives a sold-unit breakdown (regular glass vs tower vs unclassified)
 * for a single closed keg session, purely for display. This intentionally
 * mirrors the matching used by the replace_inventory_keg RPC's soldMl
 * calculation (same mapping -> pos_products -> receipt_lines -> receipts
 * join, same is_option/is_excluded/is_canceled/payment_status filters, same
 * session-window bound) so the totals stay consistent with the already
 * stored soldMl — but it does NOT change or feed back into that soldMl
 * value in any way.
 */
export async function fetchAllKegReceiptLinePages(
  fetchPage: (
    from: number,
    to: number
  ) => Promise<{ data: PosReceiptLineRow[] | null; error: unknown }>,
  pageSize = POS_SALES_PAGE_SIZE
) {
  const lineById = new Map<string, PosReceiptLineRow>();
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw error;
    for (const line of data || []) {
      lineById.set(String(line.id), line);
    }
    if (!data || data.length < pageSize) break;
  }
  return Array.from(lineById.values());
}

export function buildKegSalesBreakdown(params: {
  mappings: KegTrackingMappingRow[];
  products: PosProductRow[];
  receipts: PosReceiptRow[];
  lines: PosReceiptLineRow[];
  startedAt: string;
  endedAt: string;
  capacityMl: number;
}): KegSalesBreakdown {
  const productById = new Map<number, PosProductRow>(
    params.products.map((product) => [Number(product.id), product])
  );
  const receiptById = new Map<number, PosReceiptRow>(
    params.receipts.map((receipt) => [Number(receipt.id), receipt])
  );
  const startMs = Date.parse(params.startedAt);
  const endMs = Date.parse(params.endedAt);
  let regularUnits = 0;
  let regularSoldMl = 0;
  let towerUnits = 0;
  let towerSoldMl = 0;
  let otherUnits = 0;
  let otherSoldMl = 0;
  const countedLineIds = new Set<string>();

  for (const mapping of params.mappings) {
    const product = productById.get(Number(mapping.pos_product_id));
    const posItemId = asOptionalKey(product?.pos_item_id);
    const itemIdKey = asOptionalKey(product?.item_id);
    const itemCode = asOptionalKey(product?.item_code);
    const category = classifyMappingCategory(product);
    const quantityPerPosUnit = asNumber(mapping.quantity_per_pos_unit);
    if (quantityPerPosUnit <= 0) continue;

    for (const line of params.lines) {
      const lineId = String(line.id);
      if (countedLineIds.has(lineId)) continue;
      if (
        line.is_option === true ||
        line.is_excluded === true ||
        line.is_canceled === true ||
        Number(line.payment_status) !== 3
      ) {
        continue;
      }

      const lineItemId = asOptionalKey(line.item_id);
      const lineItemCode = asOptionalKey(line.item_code);
      const matches =
        (posItemId !== null && lineItemId === posItemId) ||
        (itemIdKey !== null && lineItemId === itemIdKey) ||
        (itemCode !== null && lineItemCode === itemCode);
      if (!matches) continue;

      const receipt = receiptById.get(Number(line.receipt_id));
      if (
        !receipt ||
        receipt.is_canceled === true ||
        Number(receipt.payment_status) !== 3
      ) {
        continue;
      }

      const referenceTime = getLineReferenceTime(line, receipt);
      if (
        referenceTime === null ||
        referenceTime < startMs ||
        referenceTime >= endMs
      ) {
        continue;
      }

      countedLineIds.add(lineId);
      const quantity = asNumber(line.quantity);
      const lineSoldMl = quantity * quantityPerPosUnit;
      if (category === "tower") {
        towerUnits += quantity;
        towerSoldMl += lineSoldMl;
      } else if (category === "other") {
        otherUnits += quantity;
        otherSoldMl += lineSoldMl;
      } else {
        regularUnits += quantity;
        regularSoldMl += lineSoldMl;
      }
    }
  }

  const roundedRegularUnits = roundDecimal(regularUnits);
  const roundedTowerUnits = roundDecimal(towerUnits);
  const roundedOtherUnits = roundDecimal(otherUnits);
  const roundedRegularSoldMl = roundDecimal(regularSoldMl);
  const roundedTowerSoldMl = roundDecimal(towerSoldMl);
  const roundedOtherSoldMl = roundDecimal(otherSoldMl);
  const totalUnits = roundDecimal(
    roundedRegularUnits + roundedTowerUnits + roundedOtherUnits
  );
  const expectedTotalMl = roundDecimal(
    roundedRegularSoldMl + roundedTowerSoldMl + roundedOtherSoldMl
  );
  const regularAllocatedMl =
    expectedTotalMl > 0
      ? roundDecimal(params.capacityMl * (roundedRegularSoldMl / expectedTotalMl))
      : 0;
  const towerAllocatedMl =
    expectedTotalMl > 0
      ? roundDecimal(params.capacityMl * (roundedTowerSoldMl / expectedTotalMl))
      : 0;
  const otherAllocatedMl =
    expectedTotalMl > 0
      ? roundDecimal(params.capacityMl * (roundedOtherSoldMl / expectedTotalMl))
      : 0;

  return {
    totalUnits,
    expectedTotalMl,
    regularUnits: roundedRegularUnits,
    regularSoldMl: roundedRegularSoldMl,
    regularAllocatedMl,
    regularAverageMl:
      roundedRegularUnits > 0
        ? Math.round(roundedRegularSoldMl / roundedRegularUnits)
        : null,
    towerUnits: roundedTowerUnits,
    towerSoldMl: roundedTowerSoldMl,
    towerAllocatedMl,
    towerAverageMl:
      roundedTowerUnits > 0
        ? Math.round(roundedTowerSoldMl / roundedTowerUnits)
        : null,
    otherUnits: roundedOtherUnits,
    otherSoldMl: roundedOtherSoldMl,
    otherAllocatedMl,
    otherAverageMl:
      roundedOtherUnits > 0
        ? Math.round(roundedOtherSoldMl / roundedOtherUnits)
        : null,
    averageCapacityMlPerUnit:
      totalUnits > 0 ? Math.round(params.capacityMl / totalUnits) : 0,
  };
}

export const computeKegSalesBreakdown = async (
  supabase: SupabaseClientLike,
  params: {
    inventoryItemId: number;
    startedAt: string;
    endedAt: string;
    capacityMl: number;
    throwOnError?: boolean;
  }
): Promise<KegSalesBreakdown | null> => {
  try {
    const { data: mappingsData, error: mappingError } = await supabase
      .from("inventory_keg_tracking_mappings")
      .select("pos_product_id, quantity_per_pos_unit")
      .eq("inventory_item_id", params.inventoryItemId)
      .eq("is_active", true)
      .eq("target_type", "product");

    if (mappingError) throw mappingError;

    const mappings = (mappingsData || []) as KegTrackingMappingRow[];
    const productIds = Array.from(
      new Set(
        mappings
          .map((mapping) => Number(mapping.pos_product_id))
          .filter((id) => Number.isFinite(id) && id > 0)
      )
    );

    if (productIds.length === 0) return null;

    const { data: productsData, error: productError } = await supabase
      .from("pos_products")
      .select("id, pos_item_id, item_id, item_code, item_name, unit_name")
      .in("id", productIds);

    if (productError) throw productError;

    const productById = new Map<number, PosProductRow>(
      ((productsData || []) as PosProductRow[]).map((product) => [
        Number(product.id),
        product,
      ])
    );

    const receipts: PosReceiptRow[] = [];
    for (let from = 0; ; from += POS_SALES_PAGE_SIZE) {
      const { data, error } = await supabase
        .from("pos_sales_receipts")
        .select("id, ref_date, synced_at, updated_at, payment_status, is_canceled")
        .eq("payment_status", 3)
        .or(
          `ref_date.gte.${params.startedAt},synced_at.gte.${params.startedAt},updated_at.gte.${params.startedAt}`
        )
        .order("id", { ascending: true })
        .range(from, from + POS_SALES_PAGE_SIZE - 1);
      if (error) throw error;
      receipts.push(...((data || []) as PosReceiptRow[]));
      if (!data || data.length < POS_SALES_PAGE_SIZE) break;
    }
    const receiptIds = receipts
      .map((receipt) => Number(receipt.id))
      .filter((id) => Number.isFinite(id) && id > 0);

    const emptyBreakdown: KegSalesBreakdown = {
      totalUnits: 0,
      expectedTotalMl: 0,
      regularUnits: 0,
      regularSoldMl: 0,
      regularAllocatedMl: 0,
      regularAverageMl: null,
      towerUnits: 0,
      towerSoldMl: 0,
      towerAllocatedMl: 0,
      towerAverageMl: null,
      otherUnits: 0,
      otherSoldMl: 0,
      otherAllocatedMl: 0,
      otherAverageMl: null,
      averageCapacityMlPerUnit: 0,
    };

    if (receiptIds.length === 0) return emptyBreakdown;

    const lineMatchFilter = buildKegLineMatchFilter(
      Array.from(productById.values())
    );
    if (!lineMatchFilter) return emptyBreakdown;

    const lineById = new Map<string, PosReceiptLineRow>();
    for (const chunk of chunkArray(receiptIds, 500)) {
      const chunkLines = await fetchAllKegReceiptLinePages(async (from, to) => {
        const { data, error } = await supabase
          .from("pos_sales_receipt_lines")
          .select(
            "id, receipt_id, item_id, item_code, quantity, is_option, is_excluded, is_canceled, payment_status, ref_date, synced_at, updated_at"
          )
          .in("receipt_id", chunk)
          .eq("payment_status", 3)
          .or(lineMatchFilter)
          .order("id", { ascending: true })
          .range(from, to);
        return {
          data: (data || []) as PosReceiptLineRow[],
          error,
        };
      });
      for (const line of chunkLines) {
        lineById.set(String(line.id), line);
      }
    }
    return buildKegSalesBreakdown({
      mappings,
      products: Array.from(productById.values()),
      receipts,
      lines: Array.from(lineById.values()),
      startedAt: params.startedAt,
      endedAt: params.endedAt,
      capacityMl: params.capacityMl,
    });
  } catch (error) {
    if (params.throwOnError) throw error;
    console.error("[KEG_SALES_BREAKDOWN_ERROR]", error);
    return null;
  }
};

/**
 * Looks up the previous (closed) keg session for each keg_replace log so its
 * sold/remaining/loss figures can be shown alongside the "케그 교체" note.
 * Returns nothing for logs with no matching closed session (e.g. the very
 * first replacement, when there was no prior active session to close).
 *
 * Sales-unit breakdown (regular/tower) is only computed for sessions that
 * actually sold something, so a day with no keg_replace log — or a keg
 * replace whose previous session sold nothing — never triggers the extra
 * POS-line queries.
 */
export async function fetchPreviousKegSummariesByLogId(
  supabase: SupabaseClientLike,
  logIds: Array<number | string>
): Promise<Map<number, PreviousKegSummary>> {
  const summaryByLogId = new Map<number, PreviousKegSummary>();

  const safeLogIds = Array.from(
    new Set(
      logIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );

  if (safeLogIds.length === 0) return summaryByLogId;

  const { data, error } = await supabase
    .from("inventory_keg_sessions")
    .select(
      "id, inventory_item_id, ended_log_id, started_at, ended_at, capacity_quantity, sold_quantity, loss_quantity"
    )
    .eq("status", "closed")
    .in("ended_log_id", safeLogIds);

  if (error) throw error;

  for (const row of (data || []) as ClosedKegSessionRow[]) {
    const endedLogId = Number(row.ended_log_id);
    if (!Number.isFinite(endedLogId) || endedLogId <= 0) continue;
    if (row.sold_quantity === null || row.capacity_quantity === null) continue;

    const capacityMl = asNumber(row.capacity_quantity);
    const soldMl = asNumber(row.sold_quantity);
    const lossMl =
      row.loss_quantity === null
        ? Math.max(capacityMl - soldMl, 0)
        : asNumber(row.loss_quantity);

    let salesBreakdown: KegSalesBreakdown | undefined;
    let salesBreakdownMismatch = false;
    if (soldMl > 0 && row.started_at && row.ended_at) {
      const breakdown = await computeKegSalesBreakdown(supabase, {
        inventoryItemId: Number(row.inventory_item_id),
        startedAt: row.started_at,
        endedAt: row.ended_at,
        capacityMl,
      });
      if (breakdown) {
        salesBreakdown = breakdown;
        salesBreakdownMismatch =
          roundDecimal(Number(breakdown.expectedTotalMl ?? 0)) !==
          roundDecimal(soldMl);
      }
    }

    summaryByLogId.set(endedLogId, {
      sessionId: Number(row.id),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      capacityMl,
      soldMl,
      lossMl,
      overageMl: Math.max(soldMl - capacityMl, 0),
      usagePercent: capacityMl > 0 ? roundDecimal((soldMl / capacityMl) * 100) : 0,
      lossPercent: capacityMl > 0 ? roundDecimal((lossMl / capacityMl) * 100) : 0,
      salesBreakdown,
      salesBreakdownMismatch,
    });
  }

  return summaryByLogId;
}
