// CUKCUK in-progress (open) order collection: pure policy, no I/O.
//
// Server-only callers inject a transport (lib/pos/cukcuk/open-orders-sync-server.ts).
// Browsers never reach this module's transport; they read the central snapshot.
//
// Contract notes (verify with a read-only probe before activation):
// - Order Status=1 is in progress; Status=3 requests payment (not yet paid).
//   Confirmed by the operator's 2026-11-10 Status 1 -> 3 -> 4 observation. Status=4 is
//   documented only as "looks paid" (docs/cukcuk-api-capability-map.md). Status=5
//   is canceled (official meaning supplied by the operator, 2026-11-11).
//   Other values stay unknown. Status=1/3 can count toward the open estimate.
// - Order Status is NOT the receipt payment_status (pos_sales_receipts); the two
//   are never mixed. Receipts link to orders through receipt raw_json.OrderId.
// - ErrorType/Code 102 is CUKCUK's concurrent-request rejection (existing sync).
//   Code 7 and HTTP/Code 401 are treated as credential problems: one re-login,
//   then the run fails. The exact meaning of 7 is not documented in this repo.
import { addStoreDays, calculateStoreBusinessDate } from "../../store-settings/business-time-core.ts";

export const ORDER_PAGE_LIMIT = 100;
export const ORDER_STATUS_OPEN = 1;
export const ORDER_STATUS_PAYMENT_REQUESTED = 3;
export const ORDER_STATUS_PAID_CANDIDATE = 4;
export const ORDER_STATUS_CANCELED = 5;
export const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export type OrderStatusClass = "open" | "paid_candidate" | "canceled" | "unknown";

const OPEN_ORDER_ERROR_CODES = [
  "provider_http_failure", "provider_timeout", "provider_token_expired", "provider_error_7",
  "provider_busy_102", "provider_failure", "orders_total_missing", "orders_total_changed",
  "orders_page_count_mismatch", "orders_duplicate_id", "orders_invalid_row", "orders_page_bound",
  "order_detail_mismatch", "order_detail_lines_missing", "order_detail_duplicate_line",
  "orders_vanished_unconfirmed", "run_deadline_exceeded",
] as const;
export type OpenOrderErrorCode = typeof OPEN_ORDER_ERROR_CODES[number];

const DIAGNOSTIC_STAGES = ["page", "detail", "vanished_detail", "vanished_limit", "run"] as const;
const DIAGNOSTIC_REASONS = [
  "row_not_object", "order_id_missing", "order_id_invalid", "order_date_invalid", "total_amount_invalid",
  "page_data_not_array", "detail_data_missing", "detail_data_invalid", "detail_id_mismatch", "vanished_id_mismatch",
  "vanished_business_date_mismatch", "vanished_limit", "unexpected_error",
] as const;
type OpenOrderDiagnosticContext = {
  stage?: typeof DIAGNOSTIC_STAGES[number];
  reason?: typeof DIAGNOSTIC_REASONS[number];
  causeCode?: OpenOrderErrorCode;
  page?: number;
  rowIndex?: number;
  vanishedCount?: number;
  confirmedCount?: number;
};
export type OpenOrderSyncDiagnostic = OpenOrderDiagnosticContext & { code: string };

export class OpenOrderSyncError extends Error {
  code: OpenOrderErrorCode;
  diagnostic?: OpenOrderDiagnosticContext;
  constructor(code: OpenOrderErrorCode, detail?: string, diagnostic?: OpenOrderDiagnosticContext) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "OpenOrderSyncError";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

function withDiagnostic(error: unknown, context: OpenOrderDiagnosticContext) {
  if (!(error instanceof OpenOrderSyncError)) return error;
  error.diagnostic = { ...error.diagnostic, ...context, causeCode: error.diagnostic?.causeCode ?? error.code };
  return error;
}

/** Strict projection for logs: never message/stack/IDs/raw rows or arbitrary provider values. */
function syncFailureDiagnostic(error: unknown, code: string): OpenOrderSyncDiagnostic {
  const allowedCodes: readonly string[] = [...OPEN_ORDER_ERROR_CODES, ...OPEN_ORDERS_DB_ERRORS,
    "open_orders_permission_denied", "open_orders_rpc_missing", "open_orders_persistence_failed", "collection_failed"];
  const context = error instanceof OpenOrderSyncError ? error.diagnostic : undefined;
  const diagnostic: OpenOrderSyncDiagnostic = { code: allowedCodes.includes(code) ? code : "collection_failed", stage: "run" };
  if (context?.stage && DIAGNOSTIC_STAGES.includes(context.stage)) diagnostic.stage = context.stage;
  if (context?.reason && DIAGNOSTIC_REASONS.includes(context.reason)) diagnostic.reason = context.reason;
  if (context?.causeCode && (OPEN_ORDER_ERROR_CODES as readonly string[]).includes(context.causeCode)) diagnostic.causeCode = context.causeCode;
  for (const key of ["page", "rowIndex", "vanishedCount", "confirmedCount"] as const) {
    const value = context?.[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) diagnostic[key] = value;
  }
  return diagnostic;
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
  if (value === ORDER_STATUS_OPEN || value === ORDER_STATUS_PAYMENT_REQUESTED) return "open";
  if (value === ORDER_STATUS_PAID_CANDIDATE) return "paid_candidate";
  if (value === ORDER_STATUS_CANCELED) return "canceled";
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

/** Must equal the claim lease in docs/sql/pos-open-orders-v1-draft.sql ("3 minutes"). */
export const OPEN_ORDERS_LEASE_MS = 180_000;
/** Upper bound of one CUKCUK request (transport AbortSignal timeout, also used for login). */
export const OPEN_ORDERS_REQUEST_TIMEOUT_MS = 15_000;
/**
 * Collection budget measured from a successful claim. A request only starts if it can
 * finish (worst case: its timeout) before this deadline, so collection ends by
 * claim + 150s and the commit still has >= 30s of lease. Past the deadline the run
 * fails (run_deadline_exceeded) instead of racing a newer run after lease expiry.
 */
export const OPEN_ORDERS_RUN_BUDGET_MS = 150_000;

export type ProviderCallState = { relogins: number; maxRelogins: number; deadlineAt?: number; now?: () => number };

/** Throws when an action needing `needMs` could not finish before the run deadline. */
export function assertWithinDeadline(state: ProviderCallState, needMs: number, what: string) {
  if (state.deadlineAt === undefined) return;
  if ((state.now ?? Date.now)() + needMs > state.deadlineAt) throw new OpenOrderSyncError("run_deadline_exceeded", what);
}

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
    assertWithinDeadline(state, OPEN_ORDERS_REQUEST_TIMEOUT_MS, request.kind);
    const { status, json } = await transport.send(request);
    const failure = providerFailureCode(status, json);
    if (!failure) return json as Json;
    if ((failure === "provider_token_expired" || failure === "provider_error_7") && state.relogins < state.maxRelogins) {
      state.relogins++;
      assertWithinDeadline(state, 2 * OPEN_ORDERS_REQUEST_TIMEOUT_MS, "relogin");
      await transport.login();
      continue;
    }
    if (failure === "provider_busy_102" && busyAttempts < 2) {
      busyAttempts++;
      assertWithinDeadline(state, retryDelayMs * busyAttempts + OPEN_ORDERS_REQUEST_TIMEOUT_MS, "busy_backoff");
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
  if (!isObject(row)) throw new OpenOrderSyncError("orders_invalid_row", undefined, { reason: "row_not_object" });
  const rawId = pick(row, ["Id", "ID", "OrderId", "OrderID"]);
  const orderId = toId(rawId);
  const orderDate = pick(row, ["Date", "OrderDate"]);
  const totalAmount = toFiniteNumber(pick(row, ["TotalAmount", "Amount"]));
  if (!orderId) throw new OpenOrderSyncError("orders_invalid_row", undefined, {
    reason: rawId === undefined || (typeof rawId === "string" && !rawId.trim()) ? "order_id_missing" : "order_id_invalid",
  });
  if (typeof orderDate !== "string" || !Number.isFinite(Date.parse(orderDate))) {
    throw new OpenOrderSyncError("orders_invalid_row", undefined, { reason: "order_date_invalid" });
  }
  if (totalAmount === null || totalAmount < 0) throw new OpenOrderSyncError("orders_invalid_row", undefined, { reason: "total_amount_invalid" });
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
    try {
      if (page > maxPages) throw new OpenOrderSyncError("orders_page_bound");
      const json = await callProvider(transport, { kind: "page", page, limit, branchId: params.branchId, lastSyncDate: params.lastSyncDate }, state, params.retryDelayMs);
      const pageTotal = json.Total;
      if (typeof pageTotal !== "number" || !Number.isSafeInteger(pageTotal) || pageTotal < 0) throw new OpenOrderSyncError("orders_total_missing");
      if (total === null) total = pageTotal;
      else if (pageTotal !== total) throw new OpenOrderSyncError("orders_total_changed", `${total} -> ${pageTotal}`);
      if (!Array.isArray(json.Data)) throw new OpenOrderSyncError("orders_invalid_row", undefined, { reason: "page_data_not_array" });
      const expected = Math.min(limit, Math.max(0, total - (page - 1) * limit));
      if (json.Data.length !== expected) throw new OpenOrderSyncError("orders_page_count_mismatch", `page ${page} expected ${expected} got ${json.Data.length}`);
      pages++;
      for (const [rowIndex, row] of json.Data.entries()) {
        let order: OrderSummary;
        try { order = normalizeOrderSummary(row); }
        catch (error) { throw withDiagnostic(error, { stage: "page", page, rowIndex }); }
        if (seen.has(order.orderId)) throw new OpenOrderSyncError("orders_duplicate_id", order.orderId);
        seen.add(order.orderId);
        orders.push(order);
      }
      if (orders.length >= total) break;
    } catch (error) { throw withDiagnostic(error, { stage: "page", page }); }
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
    // Line Status is a separate POS field (probe: header 4 with every line 1). It is stored
    // raw and never used for order classification or line cancellation.
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
  /** Independent DB receipt evidence; status/ID remain last observed provider facts. */
  closureReceiptId?: number | null;
  closureConfirmedAt?: string | null;
  providerObservedAt?: string | null;
};

/** Applies GET orders/{id}: the detail must be the same order and carry OrderDetails. */
export function mergeOrderDetail(summary: OrderSummary, detailJson: unknown, cutoff: string): CollectedOrder {
  const data = isObject(detailJson) && isObject(detailJson.Data) ? detailJson.Data : null;
  if (!data) throw new OpenOrderSyncError("order_detail_mismatch", undefined,
    { reason: isObject(detailJson) && detailJson.Data != null ? "detail_data_invalid" : "detail_data_missing" });
  const detailSummary = normalizeOrderSummary(data);
  if (detailSummary.orderId !== summary.orderId) throw new OpenOrderSyncError("order_detail_mismatch", undefined, { reason: "detail_id_mismatch" });
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

/** Read-time diagnostics only: never remove Status 6 or use it as a cancellation rule. */
export function orderDetailReview(order: CollectedOrder & { lines: OrderLine[] }) {
  const totals = orderLineTotals(order.lines);
  return {
    orderId: order.orderId,
    orderNo: order.orderNo,
    headerAmount: order.totalAmount,
    lineAmount: totals.lineAmount,
    amountMismatch: totals.lineAmount !== order.totalAmount,
    // Status 6 has been observed but its menu-level meaning is still unverified.
    unverifiedLineStatusCount: order.lines.filter((line) => line.lineStatus === 6).length,
    orphanOptionCount: totals.orphanOptionCount,
  };
}

export type ReceiptLink = { orderId: string; receiptId: number; paymentStatus: number | null; isCanceled: boolean | null; businessDate?: string };

/** Receipt cancellation alone never proves order cancellation. Same/next business day only. */
export function singlePaidOrderReceipt(orderId: string, businessDate: string, receipts: ReceiptLink[]) {
  if (!toId(orderId)) return null;
  const matches = receipts.filter((receipt) => toId(receipt.orderId) === toId(orderId)
    && [businessDate, addStoreDays(businessDate, 1)].includes(receipt.businessDate ?? ""));
  const unique = new Map<number, ReceiptLink>();
  for (const receipt of matches) {
    if (!Number.isSafeInteger(receipt.receiptId) || receipt.receiptId <= 0) return null;
    const prior = unique.get(receipt.receiptId);
    if (prior && (prior.paymentStatus !== receipt.paymentStatus || prior.isCanceled !== receipt.isCanceled
      || prior.businessDate !== receipt.businessDate)) return null;
    unique.set(receipt.receiptId, receipt);
  }
  const active = [...unique.values()].filter((receipt) => !(receipt.isCanceled === true || receipt.paymentStatus === 4 || receipt.paymentStatus === 5));
  return active.length === 1 && active[0].paymentStatus === 3 ? active[0] : null;
}

export type UncertainReason =
  | "multiple_receipts"
  | "paid_without_receipt"
  | "unknown_status"
  | "open_without_lines"
  | "closure_evidence_changed"
  | "open_after_canceled_receipt";

export type ClassifiedOrders = {
  open: (CollectedOrder & { lines: OrderLine[] })[];
  uncertain: { orderId: string; orderNo: string | null; reason: UncertainReason; amount: number }[];
  converted: number;
  canceled: number;
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
  const result: ClassifiedOrders = { open: [], uncertain: [], converted: 0, canceled: 0, receiptPending: 0, receiptCanceled: 0, otherBusinessDate: 0, statusCounts: {} };
  for (const order of orders) {
    if (order.businessDate !== businessDate) {
      result.otherBusinessDate++;
      continue;
    }
    const statusKey = String(order.status);
    result.statusCounts[statusKey] = (result.statusCounts[statusKey] ?? 0) + 1;
    const linked = links.get(order.orderId) ?? [];
    // Persisted snapshots may still classify Status 3 as unknown. Raw header status
    // is authoritative for this policy; no migration or stored-data rewrite needed.
    const statusClass = classifyOrderStatus(order.status);
    const uncertain = (reason: UncertainReason) =>
      result.uncertain.push({ orderId: order.orderId, orderNo: order.orderNo, reason, amount: order.totalAmount });
    const classifyUnpaid = () => {
      if (statusClass === "open") {
        if (order.lines) result.open.push({ ...order, statusClass, lines: order.lines });
        else uncertain("open_without_lines");
      } else if (statusClass === "canceled") result.canceled++;
      else if (statusClass === "paid_candidate") uncertain("paid_without_receipt");
      else uncertain("unknown_status");
    };
    // A canceled receipt re-issued as a paid one (seen in production: status 4 + 3 on one
    // OrderId) is one sale. Only non-canceled receipts decide; two of those stay uncertain.
    const active = linked.filter((receipt) => !(receipt.isCanceled === true || receipt.paymentStatus === 4 || receipt.paymentStatus === 5));
    if (active.length > 1) uncertain("multiple_receipts");
    else if (active.length === 1) {
      if (active[0].paymentStatus === 3) result.converted++;
      else {
        result.receiptPending++;
        // Payment Status 1 is pending, not paid. Count the linked order's header
        // once (never add the receipt amount). Other receipt statuses stay excluded.
        if (order.closureReceiptId) uncertain("closure_evidence_changed");
        else if (active[0].paymentStatus === 1) classifyUnpaid();
      }
    } else if (linked.length > 0) {
      // Only canceled receipts: an order still open in POS may have been re-opened.
      if (statusClass === "open") uncertain("open_after_canceled_receipt");
      else result.receiptCanceled++;
    } else if (order.closureReceiptId) uncertain("closure_evidence_changed");
    else classifyUnpaid();
  }
  return result;
}

/** Orders that were not finished in the previous snapshot (open or unverified status). */
export function unfinishedOrderIds(previous: { orderId: string; statusClass: OrderStatusClass; status?: number | null }[]) {
  return previous.filter((order) => order.statusClass !== "paid_candidate" && order.statusClass !== "canceled"
    && order.status !== ORDER_STATUS_CANCELED).map((order) => toId(order.orderId)).filter(Boolean);
}

export const MAX_VANISHED_CONFIRMATIONS = 20;

/**
 * FULL collection of one business date — the only mode used. Incremental collection
 * (LastSyncDate near "now" to fetch only changed orders) is NOT used anywhere: the
 * 2026-11-09 read-only probe returned Total=0 for it, and nothing guarantees it returns
 * every changed order. LastSyncDate here is a fixed wide lower bound (24h before the
 * business day starts), never a cursor; membership comes from each order's own Date;
 * completeness comes from Total + page checks; every run replaces the snapshot.
 *
 * Termination is never inferred from absence. The probe showed finished (paid) orders
 * stay listed with Status=4, so an order unfinished in the previous snapshot that is
 * missing from a full list is re-read by ID; if that read cannot confirm it, the run
 * fails (orders_vanished_unconfirmed) and the previous snapshot is kept instead of
 * being overwritten by a false "0 open orders". A list where every order is finished
 * (or a day that never had orders) still commits a real 0.
 */
export async function collectOpenOrderSnapshot(
  transport: OrderTransport,
  input: { branchId: string; businessDate: string; windowFrom: string; cutoff: string; limit?: number; retryDelayMs?: number;
    previousUnfinishedIds?: string[]; previousOrders?: CollectedOrder[];
    loadReceiptEvidence?: () => Promise<ReceiptLink[]>; deadlineAt?: number; now?: () => number }
) {
  const windowStart = Date.parse(input.windowFrom);
  if (!Number.isFinite(windowStart)) throw new OpenOrderSyncError("orders_page_bound", "window");
  const state: ProviderCallState = { relogins: 0, maxRelogins: 1, deadlineAt: input.deadlineAt, now: input.now };
  const lastSyncDate = new Date(windowStart - 24 * 3600_000).toISOString();
  const listed = await fetchAllOrderPages(transport, { branchId: input.branchId, lastSyncDate, limit: input.limit, retryDelayMs: input.retryDelayMs }, state);
  const selected = listed.orders.filter((order) => calculateStoreBusinessDate(order.orderDate, input.cutoff) === input.businessDate);
  const orders: CollectedOrder[] = [];
  let detailCount = 0;
  // Serial detail reads: CUKCUK rejects concurrent requests (102). Unverified statuses
  // (e.g. 7/8) are also read, so their menu lines exist once the mapping is confirmed;
  // until then they are reported as uncertain and the KPI is marked incomplete.
  for (const summary of selected) {
    if (summary.statusClass === "paid_candidate" || summary.statusClass === "canceled") {
      orders.push(summaryOnly(summary, input.cutoff));
      continue;
    }
    try {
      const detail = await callProvider(transport, { kind: "detail", orderId: summary.orderId }, state, input.retryDelayMs);
      detailCount++;
      orders.push(mergeOrderDetail(summary, detail, input.cutoff));
    } catch (error) { throw withDiagnostic(error, { stage: "detail" }); }
  }

  const listedIds = new Set(selected.map((order) => order.orderId));
  const vanished = [...new Set(input.previousUnfinishedIds ?? [])].map(toId).filter((id) => id && !listedIds.has(id));
  if (vanished.length > MAX_VANISHED_CONFIRMATIONS) throw new OpenOrderSyncError("orders_vanished_unconfirmed", undefined,
    { stage: "vanished_limit", reason: "vanished_limit", vanishedCount: vanished.length, confirmedCount: 0 });
  let confirmedCount = 0;
  let receiptEvidence: Promise<ReceiptLink[]> | undefined;
  for (const orderId of vanished) {
    let confirmed: CollectedOrder;
    try {
      const detail = await callProvider(transport, { kind: "detail", orderId }, state, input.retryDelayMs);
      detailCount++;
      const data = isObject(detail.Data) ? detail.Data : null;
      if (!data) throw new OpenOrderSyncError("order_detail_mismatch", undefined,
        { reason: detail.Data != null ? "detail_data_invalid" : "detail_data_missing" });
      const detailSummary = normalizeOrderSummary(data);
      // Validate identity/date before menu parsing, so absent lines cannot hide a
      // wrong-order response or a response outside this business day.
      if (detailSummary.orderId !== orderId) throw new OpenOrderSyncError("order_detail_mismatch", undefined, { reason: "vanished_id_mismatch" });
      if (calculateStoreBusinessDate(detailSummary.orderDate, input.cutoff) !== input.businessDate) {
        throw new OpenOrderSyncError("order_detail_mismatch", undefined, { reason: "vanished_business_date_mismatch" });
      }
      confirmed = mergeOrderDetail(detailSummary, detail, input.cutoff);
    } catch (error) {
      // Never repair provider Data.Id. Only missing identity/data may use an independent
      // paid receipt; wrong identity/date and provider errors remain hard failures.
      const missingIdentity = error instanceof OpenOrderSyncError
        && ["order_id_missing", "detail_data_missing"].includes(error.diagnostic?.reason ?? "");
      const previous = input.previousOrders?.find((order) => toId(order.orderId) === orderId);
      if (missingIdentity && input.loadReceiptEvidence && previous?.businessDate === input.businessDate
        && Number.isFinite(Date.parse(previous.orderDate)) && calculateStoreBusinessDate(previous.orderDate, input.cutoff) === input.businessDate
        && Number.isFinite(previous.totalAmount) && previous.totalAmount >= 0 && (previous.lines === null || Array.isArray(previous.lines))) {
        try {
          assertWithinDeadline(state, OPEN_ORDERS_REQUEST_TIMEOUT_MS, "receipt_evidence");
          receiptEvidence ??= input.loadReceiptEvidence();
          const receipt = singlePaidOrderReceipt(orderId, input.businessDate, await receiptEvidence);
          assertWithinDeadline(state, 0, "receipt_evidence");
          if (receipt) {
            orders.push({ ...previous, raw: {}, closureReceiptId: receipt.receiptId });
            confirmedCount++;
            continue;
          }
        } catch (evidenceError) {
          if (evidenceError instanceof OpenOrderSyncError && evidenceError.code === "run_deadline_exceeded") throw evidenceError;
          // An unavailable receipt read is not evidence. Keep the original missing-ID failure.
        }
      }
      const context: OpenOrderDiagnosticContext = { ...(error instanceof OpenOrderSyncError ? error.diagnostic : {}),
        stage: "vanished_detail", vanishedCount: vanished.length, confirmedCount,
        ...(error instanceof OpenOrderSyncError ? {} : { reason: "unexpected_error" as const }),
        causeCode: error instanceof OpenOrderSyncError ? error.code : undefined };
      if (error instanceof OpenOrderSyncError && error.code === "run_deadline_exceeded") throw withDiagnostic(error, context);
      throw new OpenOrderSyncError("orders_vanished_unconfirmed", undefined, context);
    }
    if (confirmed.orderId !== orderId || confirmed.businessDate !== input.businessDate) {
      throw new OpenOrderSyncError("orders_vanished_unconfirmed", undefined, { stage: "vanished_detail",
        reason: confirmed.orderId !== orderId ? "vanished_id_mismatch" : "vanished_business_date_mismatch",
        vanishedCount: vanished.length, confirmedCount });
    }
    orders.push(confirmed);
    confirmedCount++;
  }
  return {
    orders,
    manifest: {
      businessDate: input.businessDate,
      mode: "full",
      lastSyncDate,
      total: listed.total,
      pages: listed.pages,
      enumeratedCount: listed.orders.length,
      selectedCount: selected.length,
      previousUnfinishedCount: input.previousUnfinishedIds?.length ?? 0,
      vanishedConfirmedCount: vanished.length,
      detailCount,
      relogins: state.relogins,
    },
  };
}

/**
 * The only RPC names the server calls: public SECURITY INVOKER wrappers (service_role
 * only) over the private SECURITY DEFINER functions (docs/sql/pos-open-orders-v1-draft.sql).
 */
export const OPEN_ORDERS_RPC = {
  claim: "pos_open_orders_claim",
  commit: "pos_open_orders_commit",
  fail: "pos_open_orders_fail",
  read: "pos_open_orders_read",
} as const;

/** Error messages raised by the internal functions; passed through unchanged. */
export const OPEN_ORDERS_DB_ERRORS = [
  "open_orders_lease_lost",
  "open_orders_payload_invalid",
  "open_orders_run_conflict",
  "open_orders_scope_invalid",
  "open_orders_business_date_out_of_range",
  "open_orders_vanished",
] as const;

/** Maps a Supabase RPC error to a safe code (no SQL detail leaves the server). */
export function openOrdersRpcErrorCode(error: { message?: string; code?: string }) {
  const message = error.message ?? "";
  if ((OPEN_ORDERS_DB_ERRORS as readonly string[]).includes(message)) return message;
  if (error.code === "42501") return "open_orders_permission_denied";
  if (error.code === "PGRST202" || error.code === "42883") return "open_orders_rpc_missing";
  return "open_orders_persistence_failed";
}

export type OpenOrderRpc = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Claim -> collect -> commit, or record the failure. The DB claim is the single
 * run lock (one active lease per scope) and also throttles: a fresh success makes
 * extra triggers return without calling CUKCUK.
 */
export async function runOpenOrderSync(
  deps: { rpc: OpenOrderRpc; transport: OrderTransport; uuid: () => string; now?: () => number;
    onDiagnostic?: (diagnostic: OpenOrderSyncDiagnostic) => void;
    loadReceiptEvidence?: (businessDate: string) => Promise<ReceiptLink[]> },
  input: { scope: string; branchId: string; businessDate: string; windowFrom: string; cutoff: string; limit?: number; retryDelayMs?: number }
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const runId = deps.uuid();
  const ownerToken = deps.uuid();
  const claim = await deps.rpc(OPEN_ORDERS_RPC.claim, {
    p_run_id: runId, p_owner_token: ownerToken, p_scope: input.scope, p_branch_id: input.branchId, p_business_date: input.businessDate,
  });
  if (claim.status !== "collecting") return claim;
  // The DB lease started at claim; the app deadline is measured from the same point.
  const deadlineAt = now() + OPEN_ORDERS_RUN_BUDGET_MS;
  try {
    // The previous snapshot of this date decides which orders must still be accounted for.
    const previous = await deps.rpc(OPEN_ORDERS_RPC.read, { p_scope: input.scope, p_business_date: input.businessDate });
    const previousOrders = Array.isArray(previous?.orders) ? (previous.orders as CollectedOrder[]) : [];
    assertWithinDeadline({ relogins: 0, maxRelogins: 0, deadlineAt, now }, OPEN_ORDERS_REQUEST_TIMEOUT_MS, "login");
    await deps.transport.login();
    const { orders, manifest } = await collectOpenOrderSnapshot(deps.transport, {
      ...input, previousOrders, previousUnfinishedIds: unfinishedOrderIds(previousOrders), deadlineAt, now,
      // Old commit RPCs ignore unknown JSON fields: never send receipt fallback to
      // an unupgraded DB that cannot preserve/validate its independent evidence.
      loadReceiptEvidence: previous.recoveryContractVersion === 2 && deps.loadReceiptEvidence
        ? () => deps.loadReceiptEvidence!(input.businessDate) : undefined,
    });
    // Raw provider rows (customer names/phones) are not persisted.
    const payload = orders.map((order) => ({
      orderId: order.orderId, orderNo: order.orderNo, status: order.status, statusClass: order.statusClass,
      orderDate: order.orderDate, businessDate: order.businessDate, totalAmount: order.totalAmount,
      tableName: order.tableName, lines: order.lines,
      ...(order.closureReceiptId ? { closureReceiptId: order.closureReceiptId } : {}),
    }));
    return await deps.rpc(OPEN_ORDERS_RPC.commit, {
      p_run_id: runId, p_owner_token: ownerToken, p_manifest: manifest, p_orders: payload,
    });
  } catch (error) {
    // DB guard codes (e.g. open_orders_vanished from commit) are kept; anything else is generic.
    const code = error instanceof OpenOrderSyncError
      ? error.code
      : error instanceof Error && /^open_orders_[a-z_]{1,40}$/.test(error.message) ? error.message : "collection_failed";
    try {
      await deps.rpc(OPEN_ORDERS_RPC.fail, { p_run_id: runId, p_owner_token: ownerToken, p_code: code });
    } catch {
      /* The lease expires on its own; the last good snapshot stays marked by its time. */
    }
    try { deps.onDiagnostic?.(syncFailureDiagnostic(error, code)); } catch { /* Diagnostics never change the run outcome. */ }
    return { status: "failed", code };
  }
}

export type OpenOrderSyncState = {
  businessDate: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
};

export type OpenOrderKpiStatus = "not_enabled" | "closed" | "unavailable" | "incomplete" | "stale" | "ok";

/** The latest attempt could not confirm that previously unfinished orders ended. */
export const INCOMPLETE_SYNC_CODES = new Set(["orders_vanished_unconfirmed", "open_orders_vanished"]);

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
  /** Open-order menu diagnostics, separate from excluded uncertain order amounts. */
  detailWarnings: ReturnType<typeof orderDetailReview>[] | null;
  /**
   * True only for status "ok" with no uncertain order and no option line whose parent is
   * missing, no detail amount mismatch and no unverified Status 6 line.
   * Header-based Status=1/3 estimates remain included when only menu details need review.
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
    detailWarnings: null,
    complete: false,
    statusCounts: null,
  };
  if (!input.enabled) return { ...base, status: "not_enabled" };
  // After close (or for any non-live date) the estimate is never added to confirmed sales.
  if (input.isClosed || !input.isLiveBusinessDay) return { ...base, status: "closed" };
  if (!sync || !lastSuccessAt || !input.classified || ageMs === null || !Number.isFinite(ageMs)) return { ...base, status: "unavailable" };
  // last_error_code is cleared on every success, so a vanished code means the newest
  // attempt failed to confirm order endings: the older snapshot is not shown as current.
  if (sync.lastErrorCode && INCOMPLETE_SYNC_CODES.has(sync.lastErrorCode)) return { ...base, status: "incomplete" };
  if (ageMs > (input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)) return { ...base, status: "stale" };

  const detailWarnings = input.classified.open.map(orderDetailReview).filter(
    (review) => review.amountMismatch || review.unverifiedLineStatusCount > 0 || review.orphanOptionCount > 0
  );
  const open = input.classified.open.reduce(
    (sum, order) => {
      const totals = orderLineTotals(order.lines);
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
    detailWarnings,
    complete: input.classified.uncertain.length === 0 && detailWarnings.length === 0,
    statusCounts: input.classified.statusCounts,
  };
}
