import type { SupabaseClient } from "@supabase/supabase-js";
import { roundDecimal } from "@/lib/inventory/number";
import {
  calculateKegSalesForSession,
  type KegSalesBreakdown,
} from "@/lib/inventory/keg-progress-core";
import { buildKegLineMatchFilter } from "@/lib/inventory/keg-replacement-summary";

const POS_SALES_PAGE_SIZE = 1000;
const POS_RECEIPT_ID_CHUNK_SIZE = 500;

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

export type { KegSalesBreakdown } from "@/lib/inventory/keg-progress-core";

export type KegProgressTimingMetric =
  | "mapping"
  | "session_product"
  | "receipts"
  | "receipt_lines"
  | "timestamp_lines"
  | "line_queries_wall"
  | "missing_receipts"
  | "compute";

type KegProgressTiming = (
  name: KegProgressTimingMetric,
  durationMs: number
) => void;

const asPositiveNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const chunkArray = <T,>(values: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
};

const fetchLinePages = async (
  fetchPage: (
    from: number,
    to: number
  ) => PromiseLike<{ data: unknown[] | null; error: unknown }>
) => {
  const linesById = new Map<string, PosReceiptLineRow>();

  for (let from = 0; ; from += POS_SALES_PAGE_SIZE) {
    const { data, error } = await fetchPage(
      from,
      from + POS_SALES_PAGE_SIZE - 1
    );
    if (error) throw error;

    const lines = (data || []) as PosReceiptLineRow[];
    for (const line of lines) {
      linesById.set(String(line.id), line);
    }
    if (lines.length < POS_SALES_PAGE_SIZE) break;
  }

  return Array.from(linesById.values());
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
  timing?: KegProgressTiming;
}) {
  const { supabase, inventoryItems, kegCandidateIds, timing } = params;
  const progressByItemId = new Map<number, KegProgress>();
  if (kegCandidateIds.length === 0) return progressByItemId;

  const mappingStartedAt = performance.now();
  let mappingResult;
  try {
    mappingResult = await supabase
      .from("inventory_keg_tracking_mappings")
      .select("inventory_item_id, pos_product_id, quantity_per_pos_unit")
      .in("inventory_item_id", kegCandidateIds)
      .eq("is_active", true)
      .eq("target_type", "product")
      .eq("unit", "ml");
  } finally {
    timing?.("mapping", performance.now() - mappingStartedAt);
  }
  const { data: mappingsData, error: mappingError } = mappingResult;

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

  const mappedProductIds = Array.from(
    new Set(
      mappings
        .map((mapping) => Number(mapping.pos_product_id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );
  const sessionProductStartedAt = performance.now();
  let sessionProductResult;
  try {
    sessionProductResult = await Promise.all([
      supabase
        .from("inventory_keg_sessions")
        .select("id, inventory_item_id, started_at, capacity_quantity, capacity_unit")
        .in("inventory_item_id", activeTrackingItemIds)
        .eq("status", "active"),
      Promise.all(
        chunkArray(mappedProductIds, 500).map((ids) =>
          supabase
            .from("pos_products")
            .select("id, pos_item_id, item_id, item_code, item_name, unit_name")
            .in("id", ids)
        )
      ),
    ]);
  } finally {
    timing?.(
      "session_product",
      performance.now() - sessionProductStartedAt
    );
  }
  const [sessionResult, productResults] = sessionProductResult;
  const { data: sessionsData, error: sessionError } = sessionResult;

  if (sessionError) throw sessionError;
  const productRows: PosProductRow[] = [];
  for (const { data, error } of productResults) {
    if (error) throw error;
    productRows.push(...((data || []) as PosProductRow[]));
  }

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

  if (mappedProductIds.length === 0) return progressByItemId;

  const lineMatchFilter = buildKegLineMatchFilter(productRows);
  const earliestStartedAt = Array.from(activeSessionByItemId.values()).reduce(
    (earliest, session) =>
      !earliest || session.started_at < earliest ? session.started_at : earliest,
    ""
  );

  const receiptRows: PosReceiptRow[] = [];
  const receiptsStartedAt = performance.now();
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
  timing?.("receipts", performance.now() - receiptsStartedAt);

  const lineRowsById = new Map<string, PosReceiptLineRow>();
  const receiptIds = receiptRows
    .map((receipt) => Number(receipt.id))
    .filter((id) => Number.isFinite(id) && id > 0);
  const lineSelect =
    "id, receipt_id, item_id, item_code, quantity, is_option, is_excluded, is_canceled, payment_status, ref_date, synced_at, updated_at";
  const lineTimeFilter =
    `ref_date.gte.${earliestStartedAt},synced_at.gte.${earliestStartedAt},updated_at.gte.${earliestStartedAt}`;
  const lineRequests: Array<Promise<PosReceiptLineRow[]>> = [];
  const lineQueriesStartedAt = performance.now();
  const receiptLinesStartedAt = performance.now();
  let receiptLineRequestCount = 0;
  let completedReceiptLineRequestCount = 0;

  if (lineMatchFilter) {
    for (const receiptIdChunk of chunkArray(receiptIds, POS_RECEIPT_ID_CHUNK_SIZE)) {
      receiptLineRequestCount += 1;
      lineRequests.push(
        fetchLinePages((from, to) =>
          supabase
            .from("pos_sales_receipt_lines")
            .select(lineSelect)
            .in("receipt_id", receiptIdChunk)
            .eq("payment_status", 3)
            .or(lineMatchFilter)
            .order("id", { ascending: true })
            .range(from, to)
        ).finally(() => {
          completedReceiptLineRequestCount += 1;
          if (completedReceiptLineRequestCount === receiptLineRequestCount) {
            timing?.(
              "receipt_lines",
              performance.now() - receiptLinesStartedAt
            );
          }
        })
      );
    }
    const timestampLinesStartedAt = performance.now();
    lineRequests.push(
      fetchLinePages((from, to) =>
        supabase
          .from("pos_sales_receipt_lines")
          .select(lineSelect)
          .eq("payment_status", 3)
          .or(lineMatchFilter)
          .or(lineTimeFilter)
          .order("id", { ascending: true })
          .range(from, to)
      ).finally(() => {
        timing?.(
          "timestamp_lines",
          performance.now() - timestampLinesStartedAt
        );
      })
    );
  }

  const matchingLineGroups = await Promise.all(lineRequests);
  timing?.("line_queries_wall", performance.now() - lineQueriesStartedAt);
  for (const line of matchingLineGroups.flat()) {
    lineRowsById.set(String(line.id), line);
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
  const missingReceiptsStartedAt = performance.now();
  for (const ids of chunkArray(missingReceiptIds, 500)) {
    const { data, error } = await supabase
      .from("pos_sales_receipts")
      .select("id, ref_date, synced_at, updated_at, payment_status, is_canceled")
      .in("id", ids);

    if (error) throw error;
    receiptRows.push(...((data || []) as PosReceiptRow[]));
  }
  timing?.(
    "missing_receipts",
    performance.now() - missingReceiptsStartedAt
  );

  const computeStartedAt = performance.now();
  for (const itemId of activeTrackingItemIds) {
    const session = activeSessionByItemId.get(itemId);
    const inventoryItem = inventoryById.get(itemId);
    if (!session || !inventoryItem) continue;

    const sessionStartTime = Date.parse(session.started_at);
    const capacityMl =
      asPositiveNumber(session.capacity_quantity) ||
      asPositiveNumber(inventoryItem.package_content_quantity);
    if (!Number.isFinite(sessionStartTime) || capacityMl <= 0) continue;

    const itemMappings = activeSessionMappings.filter(
      (mapping) => Number(mapping.inventory_item_id) === itemId
    );
    const sales = calculateKegSalesForSession({
      mappings: itemMappings,
      products: productRows,
      receipts: receiptRows,
      lines: lineRows,
      startedAt: session.started_at,
    });
    progressByItemId.set(
      itemId,
      buildKegProgress({
        session,
        capacityMl,
        soldMl: sales.soldMl,
        salesBreakdown: sales.salesBreakdown,
      })
    );
  }
  timing?.("compute", performance.now() - computeStartedAt);

  return progressByItemId;
}
