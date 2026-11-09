// CUKCUK in-progress (open) order collection: pure policy, no I/O.
//
// Server-only callers inject a transport (lib/pos/cukcuk/open-orders-sync-server.ts).
// Browsers never reach this module's transport; they read the central snapshot.
//
// Contract notes (verify with a read-only probe before activation):
// - Order Status=1 is the in-progress order (operator definition). Status=4 is
//   documented only as "looks paid" (docs/cukcuk-api-capability-map.md); every
//   other value is unknown. Only Status=1 counts toward the open estimate.
// - Order Status is NOT the receipt payment_status (pos_sales_receipts); the two
//   are never mixed. Receipts link to orders through receipt raw_json.OrderId.
// - ErrorType/Code 102 is CUKCUK's concurrent-request rejection (existing sync).
//   Code 7 and HTTP/Code 401 are treated as credential problems: one re-login,
//   then the run fails. The exact meaning of 7 is not documented in this repo.
import { calculateStoreBusinessDate } from "../../store-settings/business-time-core.ts";

export const ORDER_PAGE_LIMIT = 100;
export const ORDER_STATUS_OPEN = 1;
export const ORDER_STATUS_PAID_CANDIDATE = 4;
export const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export type OrderStatusClass = "open" | "paid_candidate" | "unknown";

export type OpenOrderErrorCode =
  | "provider_http_failure"
  | "provider_timeout"
  | "provider_token_expired"
  | "provider_error_7"
  | "provider_busy_102"
  | "provider_failure"
  | "orders_total_missing"
  | "orders_total_changed"
  | "orders_page_count_mismatch"
  | "orders_duplicate_id"
  | "orders_invalid_row"
  | "orders_page_bound"
  | "order_detail_mismatch"
  | "order_detail_lines_missing"
  | "order_detail_duplicate_line";

export class OpenOrderSyncError extends Error {
  code: OpenOrderErrorCode;
  constructor(code: OpenOrderErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "OpenOrderSyncError";
    this.code = code;
  }
}

type Json = Record<string, unknown>;

export type OrderRequest =
  | { kind: "page"; page: number; limit: number; branchId: string; lastSyncDate: string }
  | { kind: "detail"; orderId: string };

export type OrderTransport = {
  /** Refreshes the credentials the transport uses for later sends. */
  login(): Promise<void>;
  /** Must throw OpenOrderSyncError("provider_timeout") when the request times out. */
  send(request: OrderRequest): Promise<{ status: number | null; json: unknown }>;
  sleep?(ms: number): Promise<void>;
};

const isObject = (value: unknown): value is Json =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const pick = (record: Json, keys: string[]) => {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return undefined;
};

const toId = (value: unknown) => {
  if (typeof value !== "string") return "";
  const id = value.trim().toLowerCase();
  return id && id !== ZERO_UUID ? id : "";
};

const toFiniteNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export function classifyOrderStatus(status: unknown): OrderStatusClass {
  const value = toFiniteNumber(status);
  if (value === ORDER_STATUS_OPEN) return "open";
  if (value === ORDER_STATUS_PAID_CANDIDATE) return "paid_candidate";
  return "unknown";
}

/** Maps one provider response to a failure code, or null when it is a usable success. */
export function providerFailureCode(httpStatus: number | null, json: unknown): OpenOrderErrorCode | null {
  const envelope = isObject(json) ? json : null;
  const code = toFiniteNumber(envelope?.Code);
  const errorType = toFiniteNumber(envelope?.ErrorType);
  if (httpStatus === 401 || code === 401) return "provider_token_expired";
  if (code === 102 || errorType === 102) return "provider_busy_102";
  if (code === 7 || errorType === 7) return "provider_error_7";
  if (httpStatus === null || httpStatus < 200 || httpStatus >= 300) return "provider_http_failure";
  if (!envelope || envelope.Success !== true) return "provider_failure";
  return null;
}

export type ProviderCallState = { relogins: number; maxRelogins: number };

/**
 * One logical call: 102 backs off serially (3 attempts), a credential failure
 * re-logs in once per run. Timeouts and everything else fail the run; the
 * next scheduled run retries from scratch (no partial cursor is kept).
 */
export async function callProvider(
  transport: OrderTransport,
  request: OrderRequest,
  state: ProviderCallState,
  retryDelayMs = 1500
) {
  const sleep = transport.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let busyAttempts = 0;
  for (;;) {
    const { status, json } = await transport.send(request);
    const failure = providerFailureCode(status, json);
    if (!failure) return json as Json;
    if ((failure === "provider_token_expired" || failure === "provider_error_7") && state.relogins < state.maxRelogins) {
      state.relogins++;
      await transport.login();
      continue;
    }
    if (failure === "provider_busy_102" && busyAttempts < 2) {
      busyAttempts++;
      await sleep(retryDelayMs * busyAttempts);
      continue;
    }
    const envelope = isObject(json) ? json : {};
    throw new OpenOrderSyncError(
      failure,
      `${request.kind} HTTP ${status ?? "none"} Code ${String(envelope.Code ?? "none")} ErrorType ${String(envelope.ErrorType ?? "none")}`
    );
  }
}

export type OrderSummary = {
  orderId: string;
  orderNo: string | null;
  status: number | null;
  statusClass: OrderStatusClass;
  orderDate: string;
  totalAmount: number;
  raw: Json;
};

export function normalizeOrderSummary(row: unknown): OrderSummary {
  if (!isObject(row)) throw new OpenOrderSyncError("orders_invalid_row");
  const orderId = toId(pick(row, ["Id", "ID", "OrderId", "OrderID"]));
  const orderDate = pick(row, ["Date", "OrderDate"]);
  const totalAmount = toFiniteNumber(pick(row, ["TotalAmount", "Amount"]));
  if (!orderId || typeof orderDate !== "string" || !Number.isFinite(Date.parse(orderDate)) || totalAmount === null || totalAmount < 0) {
    throw new OpenOrderSyncError("orders_invalid_row", orderId || "missing id");
  }
  const status = toFiniteNumber(row.Status);
  const orderNo = pick(row, ["No", "OrderNo", "Code"]);
  return {
    orderId,
    orderNo: typeof orderNo === "string" || typeof orderNo === "number" ? String(orderNo) : null,
    status,
    statusClass: classifyOrderStatus(status),
    orderDate: new Date(orderDate).toISOString(),
    totalAmount,
    raw: row,
  };
}

/**
 * Collects every page implied by Total (max 100 per page). A changed Total, a
 * short/long page or an ID seen twice (rows shifted between pages) fails the
 * whole run: a partial list is never returned.
 */
export async function fetchAllOrderPages(
  transport: OrderTransport,
  params: { branchId: string; lastSyncDate: string; limit?: number; maxPages?: number; retryDelayMs?: number },
  state: ProviderCallState
) {
  const limit = params.limit ?? ORDER_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > ORDER_PAGE_LIMIT) throw new OpenOrderSyncError("orders_page_bound", "limit");
  const maxPages = params.maxPages ?? 50;
  const orders: OrderSummary[] = [];
  const seen = new Set<string>();
  let total: number | null = null;
  let pages = 0;
  for (let page = 1; ; page++) {
    if (page > maxPages) throw new OpenOrderSyncError("orders_page_bound");
    const json = await callProvider(transport, { kind: "page", page, limit, branchId: params.branchId, lastSyncDate: params.lastSyncDate }, state, params.retryDelayMs);
    const pageTotal = json.Total;
    if (typeof pageTotal !== "number" || !Number.isSafeInteger(pageTotal) || pageTotal < 0) throw new OpenOrderSyncError("orders_total_missing");
    if (total === null) total = pageTotal;
    else if (pageTotal !== total) throw new OpenOrderSyncError("orders_total_changed", `${total} -> ${pageTotal}`);
    if (!Array.isArray(json.Data)) throw new OpenOrderSyncError("orders_invalid_row", "Data");
    const expected = Math.min(limit, Math.max(0, total - (page - 1) * limit));
    if (json.Data.length !== expected) throw new OpenOrderSyncError("orders_page_count_mismatch", `page ${page} expected ${expected} got ${json.Data.length}`);
    pages++;
    for (const row of json.Data) {
      const order = normalizeOrderSummary(row);
      if (seen.has(order.orderId)) throw new OpenOrderSyncError("orders_duplicate_id", order.orderId);
      seen.add(order.orderId);
      orders.push(order);
    }
    if (orders.length >= total) break;
  }
  if (orders.length !== total) throw new OpenOrderSyncError("orders_page_count_mismatch", "final");
  return { orders, total, pages };
}

export type OrderLine = {
  detailId: string;
  parentDetailId: string | null;
  additionId: string | null;
  itemId: string | null;
  itemName: string;
  unitName: string | null;
  quantity: number;
  price: number;
  amount: number;
  lineStatus: number | null;
  isOption: boolean;
  isOrphanOption: boolean;
  isCanceled: boolean;
};

function normalizeLine(row: unknown): OrderLine {
  if (!isObject(row)) throw new OpenOrderSyncError("order_detail_lines_missing", "line");
  const detailId = toId(pick(row, ["Id", "ID", "OrderDetailId", "OrderDetailID"]));
  const quantity = toFiniteNumber(row.Quantity);
  if (!detailId || quantity === null) throw new OpenOrderSyncError("order_detail_lines_missing", detailId || "line id");
  const parentDetailId = toId(pick(row, ["ParentId", "ParentID"])) || null;
  const additionId = toId(pick(row, ["AdditionId", "AdditionID", "InventoryItemAdditionID"])) || null;
  const itemName = pick(row, ["ItemName", "Name"]);
  const unitName = pick(row, ["UnitName"]);
  return {
    detailId,
    parentDetailId,
    additionId,
    itemId: toId(pick(row, ["ItemId", "ItemID"])) || null,
    itemName: typeof itemName === "string" ? itemName.trim() : "",
    unitName: typeof unitName === "string" ? unitName.trim() : null,
    quantity,
    price: toFiniteNumber(pick(row, ["Price", "UnitPrice"])) ?? 0,
    amount: toFiniteNumber(row.Amount) ?? 0,
    lineStatus: toFiniteNumber(row.Status),
    isOption: Boolean(parentDetailId || additionId),
    isOrphanOption: false,
    // Quantity reduced to zero (or negative return lines) carries no current sale.
    isCanceled: quantity <= 0,
  };
}

/**
 * Detail lines are de-duplicated by detail ID (identical repeats collapse, conflicting
 * repeats fail). Options/additions are lines with a parent or addition reference; an
 * option whose parent is absent is kept as an option and flagged, never promoted.
 */
export function normalizeOrderLines(rows: unknown): OrderLine[] {
  if (!Array.isArray(rows)) throw new OpenOrderSyncError("order_detail_lines_missing");
  const byId = new Map<string, { line: OrderLine; fingerprint: string }>();
  for (const row of rows) {
    const line = normalizeLine(row);
    const fingerprint = JSON.stringify(line);
    const existing = byId.get(line.detailId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new OpenOrderSyncError("order_detail_duplicate_line", line.detailId);
      continue;
    }
    byId.set(line.detailId, { line, fingerprint });
  }
  const lines = [...byId.values()].map((entry) => entry.line);
  for (const line of lines) {
    if (line.parentDetailId && !byId.has(line.parentDetailId)) line.isOrphanOption = true;
  }
  return lines;
}

export type CollectedOrder = OrderSummary & {
  businessDate: string;
  tableName: string | null;
  lines: OrderLine[] | null;
};

/** Applies GET orders/{id}: the detail must be the same order and carry OrderDetails. */
export function mergeOrderDetail(summary: OrderSummary, detailJson: unknown, cutoff: string): CollectedOrder {
  const data = isObject(detailJson) && isObject(detailJson.Data) ? detailJson.Data : null;
  if (!data) throw new OpenOrderSyncError("order_detail_mismatch", summary.orderId);
  const detailSummary = normalizeOrderSummary(data);
  if (detailSummary.orderId !== summary.orderId) throw new OpenOrderSyncError("order_detail_mismatch", summary.orderId);
  const tableName = pick(data, ["TableName"]);
  // The detail is newer than the list row: its status, amount and lines win.
  return {
    ...detailSummary,
    businessDate: calculateStoreBusinessDate(detailSummary.orderDate, cutoff),
    tableName: typeof tableName === "string" ? tableName : null,
    lines: normalizeOrderLines(pick(data, ["OrderDetails", "Details"])),
  };
}

export function summaryOnly(summary: OrderSummary, cutoff: string): CollectedOrder {
  return { ...summary, businessDate: calculateStoreBusinessDate(summary.orderDate, cutoff), tableName: null, lines: null };
}

export function orderLineTotals(lines: OrderLine[]) {
  const active = lines.filter((line) => !line.isCanceled);
  const menu = active.filter((line) => !line.isOption);
  return {
    menuLineCount: menu.length,
    optionLineCount: active.length - menu.length,
    itemQuantity: menu.reduce((sum, line) => sum + line.quantity, 0),
    lineAmount: active.reduce((sum, line) => sum + line.amount, 0),
    orphanOptionCount: active.filter((line) => line.isOrphanOption).length,
  };
}

export type ReceiptLink = { orderId: string; receiptId: number; paymentStatus: number | null; isCanceled: boolean | null };

export type UncertainReason =
  | "multiple_receipts"
  | "paid_without_receipt"
  | "unknown_status"
  | "open_without_lines"
  | "open_after_canceled_receipt";

export type ClassifiedOrders = {
  open: (CollectedOrder & { lines: OrderLine[] })[];
  uncertain: { orderId: string; orderNo: string | null; reason: UncertainReason; amount: number }[];
  converted: number;
  receiptPending: number;
  receiptCanceled: number;
  otherBusinessDate: number;
  /** Raw POS order Status counts for the business date ("null" when absent). */
  statusCounts: Record<string, number>;
};

/**
 * Splits a snapshot for one business date against the receipts table (the paid-sales
 * source of truth). An order with a paid receipt is already in paid sales and is never
 * added again; anything that cannot be placed with certainty is reported, not summed.
 */
export function classifyOrdersForBusinessDate(
  orders: CollectedOrder[],
  receipts: ReceiptLink[],
  businessDate: string
): ClassifiedOrders {
  const links = new Map<string, ReceiptLink[]>();
  const receiptSeen = new Set<number>();
  for (const receipt of receipts) {
    const orderId = toId(receipt.orderId);
    if (!orderId || receiptSeen.has(receipt.receiptId)) continue;
    receiptSeen.add(receipt.receiptId);
    links.set(orderId, [...(links.get(orderId) ?? []), receipt]);
  }
  const result: ClassifiedOrders = { open: [], uncertain: [], converted: 0, receiptPending: 0, receiptCanceled: 0, otherBusinessDate: 0, statusCounts: {} };
  for (const order of orders) {
    if (order.businessDate !== businessDate) {
      result.otherBusinessDate++;
      continue;
    }
    const statusKey = String(order.status);
    result.statusCounts[statusKey] = (result.statusCounts[statusKey] ?? 0) + 1;
    const linked = links.get(order.orderId) ?? [];
    const uncertain = (reason: UncertainReason) =>
      result.uncertain.push({ orderId: order.orderId, orderNo: order.orderNo, reason, amount: order.totalAmount });
    // A canceled receipt re-issued as a paid one (seen in production: status 4 + 3 on one
    // OrderId) is one sale. Only non-canceled receipts decide; two of those stay uncertain.
    const active = linked.filter((receipt) => !(receipt.isCanceled === true || receipt.paymentStatus === 4 || receipt.paymentStatus === 5));
    if (active.length > 1) uncertain("multiple_receipts");
    else if (active.length === 1) {
      if (active[0].paymentStatus === 3) result.converted++;
      // Unpaid receipts belong to the pending-payment flow; never mixed into this estimate.
      else result.receiptPending++;
    } else if (linked.length > 0) {
      // Only canceled receipts: an order still open in POS may have been re-opened.
      if (order.statusClass === "open") uncertain("open_after_canceled_receipt");
      else result.receiptCanceled++;
    } else if (order.statusClass === "open") {
      if (order.lines) result.open.push(order as CollectedOrder & { lines: OrderLine[] });
      else uncertain("open_without_lines");
    } else if (order.statusClass === "paid_candidate") uncertain("paid_without_receipt");
    else uncertain("unknown_status");
  }
  return result;
}

/**
 * Full rescan of one business date. LastSyncDate is only a lower bound for the list
 * request (24h before the business day starts); membership is decided from each
 * order's own date, and every run replaces the snapshot, so quantity changes,
 * cancellations and payment transitions are picked up even when LastSyncDate lags.
 */
export async function collectOpenOrderSnapshot(
  transport: OrderTransport,
  input: { branchId: string; businessDate: string; windowFrom: string; cutoff: string; limit?: number; retryDelayMs?: number }
) {
  const windowStart = Date.parse(input.windowFrom);
  if (!Number.isFinite(windowStart)) throw new OpenOrderSyncError("orders_page_bound", "window");
  const state: ProviderCallState = { relogins: 0, maxRelogins: 1 };
  const lastSyncDate = new Date(windowStart - 24 * 3600_000).toISOString();
  const listed = await fetchAllOrderPages(transport, { branchId: input.branchId, lastSyncDate, limit: input.limit, retryDelayMs: input.retryDelayMs }, state);
  const selected = listed.orders.filter((order) => calculateStoreBusinessDate(order.orderDate, input.cutoff) === input.businessDate);
  const orders: CollectedOrder[] = [];
  let detailCount = 0;
  // Serial detail reads: CUKCUK rejects concurrent requests (102). Unverified statuses
  // (e.g. 3/7/8) are also read, so their menu lines exist once the mapping is confirmed;
  // until then they are reported as uncertain and the KPI is marked incomplete.
  for (const summary of selected) {
    if (summary.statusClass === "paid_candidate") {
      orders.push(summaryOnly(summary, input.cutoff));
      continue;
    }
    const detail = await callProvider(transport, { kind: "detail", orderId: summary.orderId }, state, input.retryDelayMs);
    detailCount++;
    orders.push(mergeOrderDetail(summary, detail, input.cutoff));
  }
  return {
    orders,
    manifest: {
      businessDate: input.businessDate,
      lastSyncDate,
      total: listed.total,
      pages: listed.pages,
      enumeratedCount: listed.orders.length,
      selectedCount: selected.length,
      detailCount,
      relogins: state.relogins,
    },
  };
}

export type OpenOrderRpc = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Claim -> collect -> commit, or record the failure. The DB claim is the single
 * run lock (one active lease per scope) and also throttles: a fresh success makes
 * extra triggers return without calling CUKCUK.
 */
export async function runOpenOrderSync(
  deps: { rpc: OpenOrderRpc; transport: OrderTransport; uuid: () => string },
  input: { scope: string; branchId: string; businessDate: string; windowFrom: string; cutoff: string; limit?: number; retryDelayMs?: number }
): Promise<Record<string, unknown>> {
  const runId = deps.uuid();
  const ownerToken = deps.uuid();
  const claim = await deps.rpc("pos_open_orders_claim", {
    p_run_id: runId, p_owner_token: ownerToken, p_scope: input.scope, p_branch_id: input.branchId, p_business_date: input.businessDate,
  });
  if (claim.status !== "collecting") return claim;
  try {
    await deps.transport.login();
    const { orders, manifest } = await collectOpenOrderSnapshot(deps.transport, input);
    // Raw provider rows (customer names/phones) are not persisted.
    const payload = orders.map((order) => ({
      orderId: order.orderId, orderNo: order.orderNo, status: order.status, statusClass: order.statusClass,
      orderDate: order.orderDate, businessDate: order.businessDate, totalAmount: order.totalAmount,
      tableName: order.tableName, lines: order.lines,
    }));
    return await deps.rpc("pos_open_orders_commit", {
      p_run_id: runId, p_owner_token: ownerToken, p_manifest: manifest, p_orders: payload,
    });
  } catch (error) {
    const code = error instanceof OpenOrderSyncError ? error.code : "collection_failed";
    try {
      await deps.rpc("pos_open_orders_fail", { p_run_id: runId, p_owner_token: ownerToken, p_code: code });
    } catch {
      /* The lease expires on its own; the last good snapshot stays marked by its time. */
    }
    return { status: "failed", code };
  }
}

export type OpenOrderSyncState = {
  businessDate: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
};

export type OpenOrderKpiStatus = "not_enabled" | "closed" | "unavailable" | "stale" | "ok";

export type OpenOrderKpi = {
  status: OpenOrderKpiStatus;
  businessDate: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  ageSeconds: number | null;
  paid: { amount: number; receiptCount: number };
  open: { amount: number; orderCount: number; menuLineCount: number; optionLineCount: number; itemQuantity: number } | null;
  uncertain: { orderCount: number; amount: number; reasons: Partial<Record<UncertainReason, number>> } | null;
  provisional: { amount: number; count: number; averageAmount: number } | null;
  /**
   * True only for status "ok" with no uncertain order and no option line whose parent is
   * missing. When false the estimate covers confirmed Status=1 orders only.
   */
  complete: boolean;
  statusCounts: Record<string, number> | null;
};

/**
 * Daily KPI contract. Paid values are the existing receipt-based numbers, unchanged.
 * Open estimates exist only for the live, unclosed business date with a fresh,
 * successful snapshot; otherwise they are null (never 0) with the last good time.
 */
export function buildOpenOrderKpi(input: {
  enabled: boolean;
  businessDate: string;
  isLiveBusinessDay: boolean;
  isClosed: boolean;
  paid: { amount: number; receiptCount: number };
  sync: OpenOrderSyncState | null;
  classified: ClassifiedOrders | null;
  now: Date;
  staleAfterMs?: number;
}): OpenOrderKpi {
  const sync = input.sync && input.sync.businessDate === input.businessDate ? input.sync : null;
  const lastSuccessAt = sync?.lastSuccessAt ?? null;
  const ageMs = lastSuccessAt ? input.now.getTime() - Date.parse(lastSuccessAt) : null;
  const base = {
    businessDate: input.businessDate,
    lastSuccessAt,
    lastAttemptAt: sync?.lastAttemptAt ?? null,
    lastErrorCode: sync?.lastErrorCode ?? null,
    ageSeconds: ageMs === null || !Number.isFinite(ageMs) ? null : Math.max(0, Math.round(ageMs / 1000)),
    paid: input.paid,
    open: null,
    uncertain: null,
    provisional: null,
    complete: false,
    statusCounts: null,
  };
  if (!input.enabled) return { ...base, status: "not_enabled" };
  // After close (or for any non-live date) the estimate is never added to confirmed sales.
  if (input.isClosed || !input.isLiveBusinessDay) return { ...base, status: "closed" };
  if (!sync || !lastSuccessAt || !input.classified || ageMs === null || !Number.isFinite(ageMs)) return { ...base, status: "unavailable" };
  if (ageMs > (input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)) return { ...base, status: "stale" };

  let orphanOptions = 0;
  const open = input.classified.open.reduce(
    (sum, order) => {
      const totals = orderLineTotals(order.lines);
      orphanOptions += totals.orphanOptionCount;
      sum.amount += order.totalAmount;
      sum.orderCount += 1;
      sum.menuLineCount += totals.menuLineCount;
      sum.optionLineCount += totals.optionLineCount;
      sum.itemQuantity += totals.itemQuantity;
      return sum;
    },
    { amount: 0, orderCount: 0, menuLineCount: 0, optionLineCount: 0, itemQuantity: 0 }
  );
  const reasons: Partial<Record<UncertainReason, number>> = {};
  for (const item of input.classified.uncertain) reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
  const count = input.paid.receiptCount + open.orderCount;
  const amount = input.paid.amount + open.amount;
  return {
    ...base,
    status: "ok",
    open,
    uncertain: {
      orderCount: input.classified.uncertain.length,
      amount: input.classified.uncertain.reduce((sum, item) => sum + item.amount, 0),
      reasons,
    },
    provisional: { amount, count, averageAmount: count > 0 ? Math.round(amount / count) : 0 },
    complete: input.classified.uncertain.length === 0 && orphanOptions === 0,
    statusCounts: input.classified.statusCounts,
  };
}
