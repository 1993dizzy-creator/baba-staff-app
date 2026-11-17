import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { loadBusinessTimeAdapter } from "@/lib/store-settings/business-time-adapter";
import { addStoreDays } from "@/lib/store-settings/business-time-core";
import { openOrdersScope } from "@/lib/pos/cukcuk/open-orders-scope";
import { OPEN_ORDERS_RPC, type CollectedOrder, type OpenOrderSyncState } from "@/lib/pos/cukcuk/open-orders-core";
import { babaTableCatalog } from "./baba-table-catalog";
import { fetchAllExactPages } from "./daily-sales-summary";
import { validOrders } from "./table-overview-server";
import { buildTableOverview } from "./table-overview";
import { detailNumber, projectTableDetail, type DetailReceiptRow } from "./table-detail";

const readFailure = (detailStage: "context" | "snapshot" | "receipts" | "lines") =>
  Object.assign(Error(`DETAIL_${detailStage.toUpperCase()}_UNAVAILABLE`), { detailStage });

/** Separate read path: a history failure must not invalidate the overview snapshot. */
export async function readTableDetail(tableId: string, now = new Date()) {
  const catalog = babaTableCatalog();
  if (!catalog.tables.some(t => t.id === tableId)) return null;
  if (process.env.POS_OPEN_ORDERS_READ_ENABLED?.trim() !== "true") throw Error("DETAIL_READ_DISABLED");
  const time = await loadBusinessTimeAdapter(now).catch(() => { throw readFailure("context"); }), businessDate = time.databaseBusinessDate;
  const historyFrom = businessDate;
  const response = await Promise.resolve(supabaseServer.rpc(OPEN_ORDERS_RPC.read, { p_scope: openOrdersScope(), p_business_date: businessDate })
    .abortSignal(AbortSignal.timeout(15_000))).catch(() => { throw readFailure("snapshot"); });
  if (response.error || !response.data) throw readFailure("snapshot");
  const payload = response.data as { sync: OpenOrderSyncState | null; orders: CollectedOrder[] };
  const orders: unknown = Array.isArray(payload.orders) ? payload.orders.map(o => ({ ...o, raw: {},
    totalAmount: detailNumber(o.totalAmount) ?? NaN })) : null;
  if (!validOrders(orders) || payload.sync !== null && (!payload.sync || payload.sync.businessDate !== businessDate
    || ![payload.sync.lastSuccessAt, payload.sync.lastAttemptAt].every(v => v === null || typeof v === "string" && Number.isFinite(Date.parse(v)))
    || !(payload.sync.lastErrorCode === null || typeof payload.sync.lastErrorCode === "string"))) throw readFailure("snapshot");
  const evidence = await fetchAllExactPages<DetailReceiptRow>((from, to) => supabaseServer.from("pos_sales_receipts")
    .select("id,ref_no,final_amount,payment_status,is_canceled,business_date,ref_date,status_changed_at,order_id:raw_json->>OrderId,table_name:raw_json->>TableName", { count: "exact" })
    .eq("source", "cukcuk").gte("business_date", historyFrom).lte("business_date", addStoreDays(businessDate, 1))
    .order("id", { ascending: true }).abortSignal(AbortSignal.timeout(15_000)).range(from, to)).catch(() => { throw readFailure("receipts"); });
  if (evidence.error || !evidence.data) throw readFailure("receipts");
  const overview = buildTableOverview({ businessDate, now, catalog, sync: payload.sync, orders,
    receipts: evidence.data.map(r => ({ receiptId: r.id, orderId: r.order_id ?? "", tableName: r.table_name,
      paidAt: r.ref_date, businessDate: r.business_date, paymentStatus: r.payment_status, isCanceled: r.is_canceled })),
    enabled: true, cutoff: time.snapshot.cutoff, businessTime: time.snapshot,
    receiptVersions: Object.fromEntries(evidence.data.map(r => [r.id, JSON.stringify([r.final_amount, r.ref_no, r.status_changed_at])])) });
  const detail = projectTableDetail({ table: overview.tables.find(t => t.id === tableId)!, catalog: catalog.tables,
    overview, orders, receipts: evidence.data, now, historyFrom, cutoff: time.snapshot.cutoff });
  const relevant = detail.current;
  if (relevant.length) {
    type Line = { id: number; receipt_id: number; item_name: string | null; quantity: number | string | null; final_amount: number | string | null; is_canceled: boolean | null };
    const lines = await fetchAllExactPages<Line>((from, to) => supabaseServer.from("pos_sales_receipt_lines")
      .select("id,receipt_id,item_name,quantity,final_amount,is_canceled", { count: "exact" }).eq("source", "cukcuk")
      .in("receipt_id", relevant.map(r => r.id)).order("id", { ascending: true }).abortSignal(AbortSignal.timeout(15_000)).range(from, to)).catch(() => { throw readFailure("lines"); });
    if (lines.error || !lines.data) throw readFailure("lines");
    for (const receipt of relevant) receipt.lines = lines.data.filter(l => l.receipt_id === receipt.id).map(l => ({
      id: l.id, name: l.item_name ?? "—", quantity: detailNumber(l.quantity), amount: detailNumber(l.final_amount), canceled: l.is_canceled === true,
    }));
  }
  if (process.env.BABA_TABLE_CLEANING_ENABLED?.trim() === "true" || process.env.BABA_TABLE_AUTO_NORMAL_ENABLED?.trim() === "true") {
    try {
      const { decorateCleaningDetail } = await import("./table-cleaning-server");
      return await decorateCleaningDetail(detail);
    } catch { /* History still works; cleaning stays disabled on any capability/read failure. */ }
  }
  return detail;
}
