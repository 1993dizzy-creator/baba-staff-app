import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { resolveConfiguredBusinessDate } from "@/lib/store-settings/business-time-adapter";
import { addStoreDays } from "@/lib/store-settings/business-time-core";
import { openOrdersScope } from "@/lib/pos/cukcuk/open-orders-scope";
import { OPEN_ORDERS_RPC, type CollectedOrder, type OrderLine, type OpenOrderSyncState, type ReceiptLink } from "@/lib/pos/cukcuk/open-orders-core";
import { loadTableCatalog } from "@/lib/pos/cukcuk/tables-read-server";
import { fetchAllExactPages } from "./daily-sales-summary";
import { buildTableOverview } from "./table-overview";

function validOrders(orders: unknown): orders is CollectedOrder[] {
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

/** Only central read RPC + receipt evidence. No Cron invocation or order transport. */
export async function readTableOverview(now = new Date()) {
  const businessDate = await resolveConfiguredBusinessDate(now);
  const enabled = process.env.POS_OPEN_ORDERS_READ_ENABLED?.trim() === "true";
  const catalog = await loadTableCatalog(now);
  let sync: OpenOrderSyncState | null = null;
  let orders: CollectedOrder[] = [];
  let receipts: ReceiptLink[] = [];
  if (enabled) {
    try {
      const result = await supabaseServer.rpc(OPEN_ORDERS_RPC.read, {
        p_scope: openOrdersScope(), p_business_date: businessDate,
      }).abortSignal(AbortSignal.timeout(15_000));
      if (result.error || !result.data) throw Error("SNAPSHOT_UNAVAILABLE");
      const payload = result.data as { sync: OpenOrderSyncState | null; orders: unknown };
      sync = payload.sync;
      // JSON numeric fields from PostgreSQL can be serialized as numbers or decimal strings.
      const rows: unknown = Array.isArray(payload.orders)
        ? payload.orders.map(order => ({ ...order, totalAmount: typeof order?.totalAmount === "number" ||
          typeof order?.totalAmount === "string" && order.totalAmount.trim() ? Number(order.totalAmount) : NaN, raw: {} })) : null;
      if (!validOrders(rows)) throw Error("SNAPSHOT_INVALID");
      type Row = { id: number; payment_status: number | null; is_canceled: boolean | null; order_id: string | null; business_date: string };
      const evidence = await fetchAllExactPages<Row>((from, to) => supabaseServer.from("pos_sales_receipts")
        .select("id,payment_status,is_canceled,order_id:raw_json->>OrderId,business_date", { count: "exact" })
        .eq("source", "cukcuk").in("business_date", [businessDate, addStoreDays(businessDate, 1)])
        .order("id", { ascending: true }).abortSignal(AbortSignal.timeout(15_000)).range(from, to));
      if (evidence.error || !evidence.data) throw Error("RECEIPTS_UNAVAILABLE");
      receipts = evidence.data.map(row => ({ orderId: row.order_id ?? "", receiptId: row.id, paymentStatus: row.payment_status,
        isCanceled: row.is_canceled, businessDate: row.business_date }));
      orders = rows;
    } catch {
      // Retain the last successful timestamp for the operator, but never certify old rows as current.
      sync = sync ? { ...sync, lastErrorCode: "read_failed" } : null;
    }
  }
  return buildTableOverview({ businessDate, now, enabled, catalog, sync, orders, receipts });
}
