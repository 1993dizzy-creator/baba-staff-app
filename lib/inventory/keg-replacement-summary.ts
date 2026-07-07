import type { SupabaseClient } from "@supabase/supabase-js";
import { roundDecimal } from "@/lib/inventory/number";

type SupabaseClientLike = Pick<SupabaseClient, "from">;

export type KegSalesBreakdown = {
  /** Sum of POS receipt-line quantities matched to this keg's mapped products (not a stock/ml unit — a count of sold POS lines/units). */
  totalUnits: number;
  regularUnits: number;
  towerUnits: number;
  otherUnits: number;
  /** capacityMl / totalUnits — average keg volume per sold unit, not soldMl / totalUnits (see classifyMappingCategory doc). */
  averageCapacityMlPerUnit: number;
};

export type PreviousKegSummary = {
  sessionId: number;
  startedAt: string | null;
  endedAt: string | null;
  capacityMl: number;
  soldMl: number;
  lossMl: number;
  usagePercent: number;
  lossPercent: number;
  salesBreakdown?: KegSalesBreakdown;
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
const TOWER_KEYWORDS = ["tháp", "thap", "tower", "타워"];

const classifyMappingCategory = (
  product: PosProductRow | undefined
): "regular" | "tower" | "other" => {
  const unitName = (product?.unit_name || "").trim().toLowerCase();
  if (unitName) {
    return TOWER_KEYWORDS.some((keyword) => unitName.includes(keyword))
      ? "tower"
      : "regular";
  }

  const itemName = (product?.item_name || "").trim().toLowerCase();
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
const computeSalesBreakdown = async (
  supabase: SupabaseClientLike,
  params: {
    inventoryItemId: number;
    startedAt: string;
    endedAt: string;
    capacityMl: number;
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

    const { data: receiptsData, error: receiptError } = await supabase
      .from("pos_sales_receipts")
      .select("id, ref_date, synced_at, updated_at, payment_status, is_canceled")
      .eq("payment_status", 3)
      .or(
        `ref_date.gte.${params.startedAt},synced_at.gte.${params.startedAt},updated_at.gte.${params.startedAt}`
      );

    if (receiptError) throw receiptError;

    const receipts = (receiptsData || []) as PosReceiptRow[];
    const receiptById = new Map<number, PosReceiptRow>(
      receipts.map((receipt) => [Number(receipt.id), receipt])
    );
    const receiptIds = receipts
      .map((receipt) => Number(receipt.id))
      .filter((id) => Number.isFinite(id) && id > 0);

    const emptyBreakdown: KegSalesBreakdown = {
      totalUnits: 0,
      regularUnits: 0,
      towerUnits: 0,
      otherUnits: 0,
      averageCapacityMlPerUnit: 0,
    };

    if (receiptIds.length === 0) return emptyBreakdown;

    const lines: PosReceiptLineRow[] = [];
    for (const chunk of chunkArray(receiptIds, 500)) {
      const { data: lineData, error: lineError } = await supabase
        .from("pos_sales_receipt_lines")
        .select(
          "id, receipt_id, item_id, item_code, quantity, is_option, is_excluded, is_canceled, payment_status, ref_date, synced_at, updated_at"
        )
        .in("receipt_id", chunk)
        .eq("payment_status", 3);

      if (lineError) throw lineError;
      lines.push(...((lineData || []) as PosReceiptLineRow[]));
    }

    const startMs = Date.parse(params.startedAt);
    const endMs = Date.parse(params.endedAt);

    let regularUnits = 0;
    let towerUnits = 0;
    let otherUnits = 0;

    for (const mapping of mappings) {
      const product = productById.get(Number(mapping.pos_product_id));
      const posItemId = asOptionalKey(product?.pos_item_id);
      const itemIdKey = asOptionalKey(product?.item_id);
      const itemCode = asOptionalKey(product?.item_code);
      const category = classifyMappingCategory(product);

      for (const line of lines) {
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

        const quantity = asNumber(line.quantity);
        if (category === "tower") towerUnits += quantity;
        else if (category === "other") otherUnits += quantity;
        else regularUnits += quantity;
      }
    }

    const totalUnits = roundDecimal(regularUnits + towerUnits + otherUnits);

    return {
      totalUnits,
      regularUnits: roundDecimal(regularUnits),
      towerUnits: roundDecimal(towerUnits),
      otherUnits: roundDecimal(otherUnits),
      averageCapacityMlPerUnit:
        totalUnits > 0 ? Math.round(params.capacityMl / totalUnits) : 0,
    };
  } catch (error) {
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
    if (soldMl > 0 && row.started_at && row.ended_at) {
      const breakdown = await computeSalesBreakdown(supabase, {
        inventoryItemId: Number(row.inventory_item_id),
        startedAt: row.started_at,
        endedAt: row.ended_at,
        capacityMl,
      });
      if (breakdown) salesBreakdown = breakdown;
    }

    summaryByLogId.set(endedLogId, {
      sessionId: Number(row.id),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      capacityMl,
      soldMl,
      lossMl,
      usagePercent: capacityMl > 0 ? roundDecimal((soldMl / capacityMl) * 100) : 0,
      lossPercent: capacityMl > 0 ? roundDecimal((lossMl / capacityMl) * 100) : 0,
      salesBreakdown,
    });
  }

  return summaryByLogId;
}
