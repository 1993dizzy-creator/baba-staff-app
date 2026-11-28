import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { loadBusinessTimeAdapter } from "@/lib/store-settings/business-time-adapter";
import { addStoreDays } from "@/lib/store-settings/business-time-core";
import { openOrdersScope } from "@/lib/pos/cukcuk/open-orders-scope";
import { OPEN_ORDERS_RPC, type CollectedOrder, type OrderLine, type OpenOrderSyncState } from "@/lib/pos/cukcuk/open-orders-core";
import { babaTableCatalog } from "./baba-table-catalog";
import { fetchAllExactPages } from "./daily-sales-summary";
import { buildTableOverview, type TableReceipt } from "./table-overview";
import { logTablesReadFailure, tablesReadBudget, tablesReadErrorCode, tablesReadTimedOut } from "./table-read-diagnostics";

export function validOrders(orders: unknown): orders is CollectedOrder[] {
  if (!Array.isArray(orders)) return false;
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return orders.every(order => order && typeof order.orderId === "string" && order.orderId.trim()
    && typeof order.businessDate === "string" && typeof order.orderDate === "string" && Number.isFinite(Date.parse(order.orderDate))
    && (order.orderNo === null || typeof order.orderNo === "string")
    && (order.status === null || finite(order.status))
    && (order.tableName === null || typeof order.tableName === "string")
    && finite(order.totalAmount) && order.totalAmount >= 0
    && (order.lines === null || Array.isArray(order.lines) && order.lines.every((line: OrderLine) =>
      line && typeof line.detailId === "string" && typeof line.itemName === "string"
      && finite(line.quantity) && finite(line.price) && finite(line.amount))));
}

/** Only central read RPC + receipt evidence. No Cron invocation or order transport.
 * One request budget (12 s, inside the board's 20 s limit) covers every stage; a timed-out stage
 * is not repeated by a fallback read. A failed read returns the existing read_failed overview,
 * which the board shows as a delayed refresh of its last good view (never as current facts). */
export async function readTableOverview(now = new Date()) {
  const budget = tablesReadBudget();
  // One configured context for this request's fixed `now`, including fallback.
  // Both settings RPCs use the same deadline as the snapshot/receipt stages.
  let businessTime: Awaited<ReturnType<typeof loadBusinessTimeAdapter>> | undefined;
  const loadRequestTime = async () => businessTime ??= await loadBusinessTimeAdapter(now, { signal: budget.signal() });
  let skipRead = false;
  if (process.env.BABA_TABLE_CLEANING_ENABLED?.trim() === "true" || process.env.BABA_TABLE_AUTO_NORMAL_ENABLED?.trim() === "true") {
    try {
      const { readCleaningState } = await import("./table-cleaning-server");
      const state = await readCleaningState(now, budget.remaining(), budget, async () => {
        const time = await loadRequestTime();
        if (!budget.allows()) throw Object.assign(Error("TABLES_READ_BUDGET_EXHAUSTED"), { timedOut: true });
        return time;
      });
      if (state) return state.overview;
    } catch (error) {
      // Conservative fallback to the original paid/unknown snapshot, never fake idle. Not after a
      // timeout (the snapshot read inside the context would time out again) or without budget.
      skipRead = (error as { timedOut?: unknown })?.timedOut === true || tablesReadTimedOut(tablesReadErrorCode(error)) || !budget.allows();
      // The atomic RPC can reject p_day if a cutoff/revision changed since the
      // settings read. This is a required revalidation, not a duplicate lookup.
      if (!skipRead && (error as { code?: unknown })?.code === "40001") businessTime = undefined;
      // Without a resolved setting there is no safe day/snapshot to build. Do not
      // repeat a timed-out settings lookup just to fabricate a fallback response.
      if (skipRead && !businessTime) throw error;
    }
  }
  const time = await loadRequestTime();
  skipRead ||= !budget.allows();
  const businessDate = time.databaseBusinessDate;
  const enabled = process.env.POS_OPEN_ORDERS_READ_ENABLED?.trim() === "true";
  const catalog = babaTableCatalog();
  let sync: OpenOrderSyncState | null = null;
  let orders: CollectedOrder[] = [];
  let receipts: TableReceipt[] = [];
  let receiptVersions: Record<number, string> = {};
  let readFailed = false;
  let stage: "snapshot" | "receipts" = "snapshot", started = Date.now();
  if (enabled && skipRead) readFailed = true;
  else if (enabled) {
    try {
      const result = await supabaseServer.rpc(OPEN_ORDERS_RPC.read, {
        p_scope: openOrdersScope(), p_business_date: businessDate,
      }).abortSignal(budget.signal());
      if (result.error) throw result.error;
      if (!result.data) throw Error("SNAPSHOT_UNAVAILABLE");
      const payload = result.data as { sync: OpenOrderSyncState | null; orders: unknown };
      const timestampOrNull = (value: unknown) => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
      if (payload.sync !== null && (!payload.sync || typeof payload.sync !== "object"
        || typeof payload.sync.businessDate !== "string" || !timestampOrNull(payload.sync.lastSuccessAt)
        || !timestampOrNull(payload.sync.lastAttemptAt)
        || !(payload.sync.lastErrorCode === null || typeof payload.sync.lastErrorCode === "string"))) throw Error("SNAPSHOT_INVALID");
      sync = payload.sync;
      // JSON numeric fields from PostgreSQL can be serialized as numbers or decimal strings.
      const rows: unknown = Array.isArray(payload.orders)
        ? payload.orders.map(order => ({ ...order, totalAmount: typeof order?.totalAmount === "number" ||
          typeof order?.totalAmount === "string" && order.totalAmount.trim() ? Number(order.totalAmount) : NaN, raw: {} })) : null;
      if (!validOrders(rows)) throw Error("SNAPSHOT_INVALID");
      // Keep already-read facts as unverified history if receipt reads fail below.
      orders = rows;
      stage = "receipts"; started = Date.now();
      type Row = { id: number; payment_status: number | null; is_canceled: boolean | null; order_id: string | null; business_date: string; table_name: string | null; ref_date: string | null;
        final_amount: number | string | null; ref_no: string | null; status_changed_at: string | null };
      const evidence = await fetchAllExactPages<Row>((from, to) => supabaseServer.from("pos_sales_receipts")
        .select("id,payment_status,is_canceled,order_id:raw_json->>OrderId,business_date,table_name:raw_json->>TableName,ref_date,final_amount,ref_no,status_changed_at", { count: "exact" })
        .eq("source", "cukcuk").in("business_date", [businessDate, addStoreDays(businessDate, 1)])
        .order("id", { ascending: true }).abortSignal(budget.signal()).range(from, to));
      if (evidence.error) throw evidence.error;
      if (!evidence.data) throw Error("RECEIPTS_UNAVAILABLE");
      receipts = evidence.data.map(row => ({ orderId: row.order_id ?? "", receiptId: row.id, paymentStatus: row.payment_status,
        isCanceled: row.is_canceled, businessDate: row.business_date, tableName: row.table_name, paidAt: row.ref_date }));
      receiptVersions = Object.fromEntries(evidence.data.map(row => [row.id, JSON.stringify([row.final_amount, row.ref_no, row.status_changed_at])]));
    } catch (error) {
      logTablesReadFailure(stage, error, started);
      // Retain the last successful timestamp for the operator, but never certify old rows as current.
      readFailed = true;
      sync = sync ? { ...sync, lastErrorCode: "read_failed" } : null;
    }
  }
  return buildTableOverview({ businessDate, now, enabled, catalog, sync, orders, receipts, readFailed,
    cutoff: time.snapshot.cutoff, businessTime: time.snapshot, receiptVersions });
}
