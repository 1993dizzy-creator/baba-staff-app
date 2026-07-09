import type { SupabaseClient } from "@supabase/supabase-js";
import { roundDecimal } from "@/lib/inventory/number";

const POS_SALES_PAGE_SIZE = 1000;

type SupabaseClientLike = Pick<SupabaseClient, "from">;

type KegTrackingMappingRow = {
  inventory_item_id: number | string | null;
  pos_product_id: number | string | null;
  quantity_per_pos_unit: number | string | null;
};

type ActiveKegSessionRow = {
  id: number | string;
  inventory_item_id: number | string;
  started_at: string;
  capacity_quantity: number | string;
  capacity_unit: string | null;
};

type PosProductRow = {
  id: number | string;
  pos_item_id: string | null;
  item_id: string | null;
  item_code: string | null;
  item_name: string | null;
  unit_name: string | null;
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

type PosReceiptRow = {
  id: number | string;
  ref_date: string | null;
  synced_at: string | null;
  updated_at: string | null;
  payment_status: number | null;
  is_canceled: boolean | null;
};

export type KegProgress = {
  activeSessionId: number;
  startedAt: string;
  capacityMl: number;
  soldMl: number;
  usagePercent: number;
  remainingPercent: number;
  salesBreakdown?: KegSalesBreakdown;
};

export type KegSalesBreakdown = {
  totalUnits: number;
  regularUnits: number;
  regularSoldMl: number;
  regularAverageMl: number | null;
  towerUnits: number;
  towerSoldMl: number;
  towerAverageMl: number | null;
  otherUnits: number;
  otherSoldMl: number;
};

const asPositiveNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const asOptionalKey = (value: unknown) => {
  const text = String(value ?? "").trim();
  return text ? text : null;
};

const normalizeClassifyText = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d");

const classifyKegProduct = (
  product: PosProductRow | undefined
): "regular" | "tower" | "other" => {
  const unitName = normalizeClassifyText(product?.unit_name);
  if (unitName) {
    return unitName.includes("thap") ||
      unitName.includes("tower") ||
      unitName.includes("타워")
      ? "tower"
      : "regular";
  }

  const itemName = normalizeClassifyText(product?.item_name);
  if (itemName) {
    return itemName.includes("thap") ||
      itemName.includes("tower") ||
      itemName.includes("타워")
      ? "tower"
      : "regular";
  }

  return "other";
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

const chunkArray = <T,>(values: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const buildKegProgress = (params: {
  session: ActiveKegSessionRow;
  capacityMl: number;
  soldMl: number;
  salesBreakdown?: KegSalesBreakdown;
}) => {
  const soldMl = roundDecimal(params.soldMl);
  const usagePercent = roundDecimal((soldMl / params.capacityMl) * 100);
  const remainingPercent = roundDecimal(Math.max(0, 100 - usagePercent));

  return {
    activeSessionId: Number(params.session.id),
    startedAt: params.session.started_at,
    capacityMl: params.capacityMl,
    soldMl,
    usagePercent,
    remainingPercent,
    salesBreakdown: params.salesBreakdown,
  } satisfies KegProgress;
};

export async function fetchKegProgressByItemId(params: {
  supabase: SupabaseClientLike;
  inventoryItems: Array<Record<string, unknown>>;
  kegCandidateIds: number[];
}) {
  const { supabase, inventoryItems, kegCandidateIds } = params;
  const progressByItemId = new Map<number, KegProgress>();
  if (kegCandidateIds.length === 0) return progressByItemId;

  const { data: mappingsData, error: mappingError } = await supabase
    .from("inventory_keg_tracking_mappings")
    .select("inventory_item_id, pos_product_id, quantity_per_pos_unit")
    .in("inventory_item_id", kegCandidateIds)
    .eq("is_active", true)
    .eq("target_type", "product")
    .eq("unit", "ml");

  if (mappingError) throw mappingError;

  const mappings = (mappingsData || []) as KegTrackingMappingRow[];
  if (mappings.length === 0) return progressByItemId;

  const activeTrackingItemIds = Array.from(
    new Set(
      mappings
        .map((mapping) => Number(mapping.inventory_item_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );

  const { data: sessionsData, error: sessionError } = await supabase
    .from("inventory_keg_sessions")
    .select("id, inventory_item_id, started_at, capacity_quantity, capacity_unit")
    .in("inventory_item_id", activeTrackingItemIds)
    .eq("status", "active");

  if (sessionError) throw sessionError;

  const activeSessionByItemId = new Map<number, ActiveKegSessionRow>();
  for (const session of (sessionsData || []) as ActiveKegSessionRow[]) {
    const itemId = Number(session.inventory_item_id);
    if (Number.isFinite(itemId) && itemId > 0) {
      activeSessionByItemId.set(itemId, session);
    }
  }

  if (activeSessionByItemId.size === 0) return progressByItemId;

  const activeSessionItemIds = Array.from(activeSessionByItemId.keys());
  const activeSessionMappings = mappings.filter((mapping) =>
    activeSessionByItemId.has(Number(mapping.inventory_item_id))
  );
  const productIds = Array.from(
    new Set(
      activeSessionMappings
        .map((mapping) => Number(mapping.pos_product_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );
  const inventoryById = new Map(
    inventoryItems.map((item) => [Number(item.id), item])
  );

  for (const itemId of activeSessionItemIds) {
    const session = activeSessionByItemId.get(itemId);
    const inventoryItem = inventoryById.get(itemId);
    if (!session || !inventoryItem) continue;

    const sessionStartTime = Date.parse(session.started_at);
    const capacityMl =
      asPositiveNumber(session.capacity_quantity) ||
      asPositiveNumber(inventoryItem.package_content_quantity);
    if (!Number.isFinite(sessionStartTime) || capacityMl <= 0) continue;

    progressByItemId.set(
      itemId,
      buildKegProgress({ session, capacityMl, soldMl: 0 })
    );
  }

  if (productIds.length === 0) return progressByItemId;

  const productRows: PosProductRow[] = [];
  for (const ids of chunkArray(productIds, 500)) {
    const { data, error } = await supabase
      .from("pos_products")
      .select("id, pos_item_id, item_id, item_code, item_name, unit_name")
      .in("id", ids);

    if (error) throw error;
    productRows.push(...((data || []) as PosProductRow[]));
  }

  const productById = new Map(
    productRows.map((product) => [Number(product.id), product])
  );
  const earliestStartedAt = Array.from(activeSessionByItemId.values()).reduce(
    (earliest, session) =>
      !earliest || session.started_at < earliest ? session.started_at : earliest,
    ""
  );

  const receiptRows: PosReceiptRow[] = [];
  for (let from = 0; ; from += POS_SALES_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("pos_sales_receipts")
      .select("id, ref_date, synced_at, updated_at, payment_status, is_canceled")
      .eq("payment_status", 3)
      .or(
        `ref_date.gte.${earliestStartedAt},synced_at.gte.${earliestStartedAt},updated_at.gte.${earliestStartedAt}`
      )
      .order("ref_date", { ascending: false, nullsFirst: false })
      .range(from, from + POS_SALES_PAGE_SIZE - 1);

    if (error) throw error;
    receiptRows.push(...((data || []) as PosReceiptRow[]));
    if (!data || data.length < POS_SALES_PAGE_SIZE) break;
  }

  const lineRowsById = new Map<string, PosReceiptLineRow>();
  const receiptIds = receiptRows
    .map((receipt) => Number(receipt.id))
    .filter((id) => Number.isFinite(id) && id > 0);

  for (const ids of chunkArray(receiptIds, 500)) {
    const { data, error } = await supabase
      .from("pos_sales_receipt_lines")
      .select(
        "id, receipt_id, item_id, item_code, quantity, is_option, is_excluded, is_canceled, payment_status, ref_date, synced_at, updated_at"
      )
      .in("receipt_id", ids)
      .eq("payment_status", 3);

    if (error) throw error;
    for (const line of (data || []) as PosReceiptLineRow[]) {
      lineRowsById.set(String(line.id), line);
    }
  }

  for (let from = 0; ; from += POS_SALES_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("pos_sales_receipt_lines")
      .select(
        "id, receipt_id, item_id, item_code, quantity, is_option, is_excluded, is_canceled, payment_status, ref_date, synced_at, updated_at"
      )
      .eq("payment_status", 3)
      .or(
        `ref_date.gte.${earliestStartedAt},synced_at.gte.${earliestStartedAt},updated_at.gte.${earliestStartedAt}`
      )
      .order("ref_date", { ascending: false, nullsFirst: false })
      .range(from, from + POS_SALES_PAGE_SIZE - 1);

    if (error) throw error;
    for (const line of (data || []) as PosReceiptLineRow[]) {
      lineRowsById.set(String(line.id), line);
    }
    if (!data || data.length < POS_SALES_PAGE_SIZE) break;
  }

  const lineRows = Array.from(lineRowsById.values());
  const missingReceiptIds = Array.from(
    new Set(
      lineRows
        .map((line) => Number(line.receipt_id))
        .filter((id) => Number.isFinite(id) && id > 0)
        .filter((id) => !receiptIds.includes(id))
    )
  );
  for (const ids of chunkArray(missingReceiptIds, 500)) {
    const { data, error } = await supabase
      .from("pos_sales_receipts")
      .select("id, ref_date, synced_at, updated_at, payment_status, is_canceled")
      .in("id", ids);

    if (error) throw error;
    receiptRows.push(...((data || []) as PosReceiptRow[]));
  }

  const receiptById = new Map(
    receiptRows.map((receipt) => [Number(receipt.id), receipt])
  );
  const linesByKey = new Map<string, PosReceiptLineRow[]>();

  for (const line of lineRows) {
    if (
      line.is_option === true ||
      line.is_excluded === true ||
      line.is_canceled === true ||
      Number(line.payment_status) !== 3
    ) {
      continue;
    }

    const receipt = receiptById.get(Number(line.receipt_id));
    if (
      !receipt ||
      receipt.is_canceled === true ||
      Number(receipt.payment_status) !== 3
    ) {
      continue;
    }

    const itemId = asOptionalKey(line.item_id);
    const itemCode = asOptionalKey(line.item_code);
    const keys = [
      itemId ? `item_id:${itemId}` : null,
      itemCode ? `item_code:${itemCode}` : null,
    ].filter((key): key is string => Boolean(key));

    for (const key of keys) {
      const existing = linesByKey.get(key) || [];
      existing.push(line);
      linesByKey.set(key, existing);
    }
  }

  for (const itemId of activeTrackingItemIds) {
    const session = activeSessionByItemId.get(itemId);
    const inventoryItem = inventoryById.get(itemId);
    if (!session || !inventoryItem) continue;

    const sessionStartTime = Date.parse(session.started_at);
    const capacityMl =
      asPositiveNumber(session.capacity_quantity) ||
      asPositiveNumber(inventoryItem.package_content_quantity);
    if (!Number.isFinite(sessionStartTime) || capacityMl <= 0) continue;

    let soldMl = 0;
    let regularUnits = 0;
    let regularSoldMl = 0;
    let towerUnits = 0;
    let towerSoldMl = 0;
    let otherUnits = 0;
    let otherSoldMl = 0;
    const itemMappings = activeSessionMappings.filter(
      (mapping) => Number(mapping.inventory_item_id) === itemId
    );

    for (const mapping of itemMappings) {
      const product = productById.get(Number(mapping.pos_product_id));
      const category = classifyKegProduct(product);
      const quantityPerPosUnit = asPositiveNumber(
        mapping.quantity_per_pos_unit
      );
      if (!product || quantityPerPosUnit <= 0) continue;

      const posItemId = asOptionalKey(product.pos_item_id);
      const itemIdKey = asOptionalKey(product.item_id);
      const itemCode = asOptionalKey(product.item_code);
      const productKeys = [
        posItemId ? `item_id:${posItemId}` : null,
        itemIdKey ? `item_id:${itemIdKey}` : null,
        itemCode ? `item_code:${itemCode}` : null,
      ].filter((key): key is string => Boolean(key));

      const countedLineIds = new Set<string>();
      for (const key of productKeys) {
        for (const line of linesByKey.get(key) || []) {
          const lineId = String(line.id);
          if (countedLineIds.has(lineId)) continue;
          const receipt = receiptById.get(Number(line.receipt_id));
          const referenceTime = getLineReferenceTime(line, receipt);
          if (referenceTime === null || referenceTime < sessionStartTime) {
            continue;
          }

          countedLineIds.add(lineId);
          const quantity = asPositiveNumber(line.quantity);
          const lineSoldMl = quantity * quantityPerPosUnit;
          soldMl += lineSoldMl;
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
    }

    const roundedRegularUnits = roundDecimal(regularUnits);
    const roundedTowerUnits = roundDecimal(towerUnits);
    const roundedOtherUnits = roundDecimal(otherUnits);
    const roundedRegularSoldMl = roundDecimal(regularSoldMl);
    const roundedTowerSoldMl = roundDecimal(towerSoldMl);
    const roundedOtherSoldMl = roundDecimal(otherSoldMl);
    progressByItemId.set(
      itemId,
      buildKegProgress({
        session,
        capacityMl,
        soldMl,
        salesBreakdown: {
          totalUnits: roundDecimal(
            roundedRegularUnits + roundedTowerUnits + roundedOtherUnits
          ),
          regularUnits: roundedRegularUnits,
          regularSoldMl: roundedRegularSoldMl,
          regularAverageMl:
            roundedRegularUnits > 0
              ? Math.round(roundedRegularSoldMl / roundedRegularUnits)
              : null,
          towerUnits: roundedTowerUnits,
          towerSoldMl: roundedTowerSoldMl,
          towerAverageMl:
            roundedTowerUnits > 0
              ? Math.round(roundedTowerSoldMl / roundedTowerUnits)
              : null,
          otherUnits: roundedOtherUnits,
          otherSoldMl: roundedOtherSoldMl,
        },
      })
    );
  }

  return progressByItemId;
}
