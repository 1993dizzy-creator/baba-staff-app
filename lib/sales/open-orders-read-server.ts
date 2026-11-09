import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { openOrdersScope } from "@/lib/pos/cukcuk/open-orders-scope";
import {
  OPEN_ORDERS_RPC,
  openOrdersRpcErrorCode,
  buildOpenOrderKpi,
  classifyOrdersForBusinessDate,
  type CollectedOrder,
  type OpenOrderKpi,
  type OpenOrderSyncState,
  type ReceiptLink,
} from "@/lib/pos/cukcuk/open-orders-core";
import { addStoreDays } from "@/lib/store-settings/business-time-core";
import { resolveConfiguredBusinessDate } from "@/lib/store-settings/business-time-adapter";
import { fetchAllExactPages } from "@/lib/sales/daily-sales-summary";

// Reads the central snapshot only. Never imports or calls the CUKCUK transport.
export function openOrdersReadEnabled() {
  return process.env.POS_OPEN_ORDERS_READ_ENABLED?.trim() === "true";
}

type ReadPayload = { sync: (OpenOrderSyncState & { consecutiveFailures?: number }) | null; orders: CollectedOrder[] };

type ReceiptLinkRow = { id: number; payment_status: number | null; is_canceled: boolean | null; order_id: string | null };

/** Receipts of the day and the next day: an order paid after the cutoff lands on the next business date. */
async function loadReceiptLinks(businessDate: string): Promise<ReceiptLink[]> {
  const { data, error } = await fetchAllExactPages<ReceiptLinkRow>((from, to) =>
    supabaseServer
      .from("pos_sales_receipts")
      .select("id, payment_status, is_canceled, order_id:raw_json->>OrderId", { count: "exact" })
      .in("business_date", [businessDate, addStoreDays(businessDate, 1)])
      .order("id", { ascending: true })
      .range(from, to)
  );
  if (error || !data) throw new Error("OPEN_ORDERS_RECEIPT_LINKS_UNAVAILABLE");
  return data.map((row) => ({ orderId: row.order_id ?? "", receiptId: row.id, paymentStatus: row.payment_status, isCanceled: row.is_canceled }));
}

export async function loadOpenOrderKpi(input: {
  businessDate: string;
  isClosed: boolean;
  paid: { amount: number; receiptCount: number };
  now?: Date;
}): Promise<OpenOrderKpi> {
  const now = input.now ?? new Date();
  const base = { businessDate: input.businessDate, isClosed: input.isClosed, paid: input.paid, now };
  if (!openOrdersReadEnabled()) {
    return buildOpenOrderKpi({ ...base, enabled: false, isLiveBusinessDay: false, sync: null, classified: null });
  }
  let sync: OpenOrderSyncState | null = null;
  try {
    const currentBusinessDate = await resolveConfiguredBusinessDate(now);
    const isLiveBusinessDay = currentBusinessDate === input.businessDate;
    if (!isLiveBusinessDay || input.isClosed) {
      return buildOpenOrderKpi({ ...base, enabled: true, isLiveBusinessDay, sync: null, classified: null });
    }
    // Public SECURITY INVOKER wrapper, executable by service_role only.
    const { data, error } = await supabaseServer.rpc(OPEN_ORDERS_RPC.read, {
      p_scope: openOrdersScope(),
      p_business_date: input.businessDate,
    });
    if (error) throw new Error(openOrdersRpcErrorCode(error));
    if (!data) throw new Error("OPEN_ORDERS_SNAPSHOT_UNAVAILABLE");
    const payload = data as ReadPayload;
    sync = payload.sync;
    const orders = (payload.orders ?? []).map((order) => ({ ...order, totalAmount: Number(order.totalAmount), raw: {} }));
    const classified = classifyOrdersForBusinessDate(orders, await loadReceiptLinks(input.businessDate), input.businessDate);
    return buildOpenOrderKpi({ ...base, enabled: true, isLiveBusinessDay, sync: payload.sync, classified });
  } catch (error) {
    console.error("[OPEN_ORDERS_READ_FAILED]", error instanceof Error ? error.message : "unknown");
    // Unavailable, not zero: the page keeps paid KPIs and shows the last good time if any.
    // classified=null forces "unavailable" while still reporting the last good time when known.
    return buildOpenOrderKpi({ ...base, enabled: true, isLiveBusinessDay: true, sync, classified: null });
  }
}
