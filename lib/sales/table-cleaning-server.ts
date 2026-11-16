import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { loadBusinessTimeAdapter } from "@/lib/store-settings/business-time-adapter";
import { openOrdersScope } from "@/lib/pos/cukcuk/open-orders-scope";
import { evaluateOpenOrdersCronWindow } from "@/lib/pos/cukcuk/open-orders-cron-policy";
import type { CollectedOrder, OpenOrderSyncState } from "@/lib/pos/cukcuk/open-orders-core";
import { babaTableCatalog } from "./baba-table-catalog";
import { buildTableOverview } from "./table-overview";
import { validOrders } from "./table-overview-server";
import { detailNumber, type DetailReceiptRow, type TableDetail } from "./table-detail";
import { autoNormalActivation, applyPaymentObservations, type PaymentObservation } from "./table-auto-normal";

export const cleaningFeatureEnabled = () => process.env.BABA_TABLE_CLEANING_ENABLED?.trim() === "true"
  && process.env.POS_OPEN_ORDERS_READ_ENABLED?.trim() === "true";
type Key = { receiptId: number; evidenceKey: string; autoKey?: string };
type Context = { enabled: true; snapshot: { sync: OpenOrderSyncState | null; orders: CollectedOrder[] };
  receipts: (DetailReceiptRow & { version: string })[]; keys: Record<string, Key>; cleanedTableIds: string[];
  manualEnabled?: boolean; serverNow?: string; observations?: Record<string, PaymentObservation>; reviewTableIds?: string[] };

/** Atomic DB read + existing complete v3 policy; DB separately validates the write. */
export async function readCleaningState(now = new Date(), timeoutMs = 15_000) {
  const activation = autoNormalActivation();
  if (!cleaningFeatureEnabled() && !activation) return null;
  const time = await loadBusinessTimeAdapter(now), day = time.databaseBusinessDate, scope = openOrdersScope();
  let result = await supabaseServer.rpc(activation ? "tables_auto_context_v1" : "tables_cleaning_context_v1",
    { p_scope: scope, p_day: day, ...(activation ? { p_activation: activation } : {}) }).abortSignal(AbortSignal.timeout(timeoutMs));
  // Failed/missing/disabled automatic capability must never disable working manual cleaning.
  if (activation && (result.error || result.data?.enabled === false) && cleaningFeatureEnabled()) {
    result = await supabaseServer.rpc("tables_cleaning_context_v1", { p_scope: scope, p_day: day }).abortSignal(AbortSignal.timeout(timeoutMs));
  }
  if (result.error) throw Error("CLEANING_UNAVAILABLE");
  if (result.data?.enabled === false) return null;
  const context = result.data as Context;
  if (!context || !context.enabled || !Array.isArray(context.receipts) || !Array.isArray(context.cleanedTableIds) || !context.keys || !context.snapshot) throw Error("CLEANING_UNAVAILABLE");
  const orders = Array.isArray(context.snapshot.orders) ? context.snapshot.orders.map(o => ({ ...o, raw: {}, totalAmount: detailNumber(o.totalAmount) ?? NaN })) : null;
  if (!validOrders(orders)) throw Error("CLEANING_UNAVAILABLE");
  const sync = context.snapshot.sync;
  if (sync !== null && (!sync || sync.businessDate !== day || ![sync.lastSuccessAt, sync.lastAttemptAt].every(v => v === null || typeof v === "string" && Number.isFinite(Date.parse(v)))
    || !(sync.lastErrorCode === null || typeof sync.lastErrorCode === "string"))) throw Error("CLEANING_UNAVAILABLE");
  if (context.observations && (!context.serverNow || !Number.isFinite(Date.parse(context.serverNow)))) throw Error("CLEANING_UNAVAILABLE");
  const effectiveNow = context.observations ? new Date(context.serverNow!) : now;
  const base = buildTableOverview({ businessDate: day, now: effectiveNow, catalog: babaTableCatalog(), sync, orders,
    receipts: context.receipts.map(r => ({ receiptId: r.id, orderId: r.order_id ?? "", tableName: r.table_name,
      paidAt: r.ref_date, businessDate: r.business_date, paymentStatus: r.payment_status, isCanceled: r.is_canceled })),
    enabled: true, cutoff: time.snapshot.cutoff, collectionExpected: time.context.isOpen && evaluateOpenOrdersCronWindow(now).allowed });
  const overview = structuredClone(base);
  for (const table of overview.tables) if (cleaningFeatureEnabled() && context.manualEnabled !== false
    && table.state === "paid" && context.cleanedTableIds.includes(table.id) && context.keys[table.id]) table.state = "idle";
  if (activation && context.observations) applyPaymentObservations(overview, context.observations, context.keys, context.reviewTableIds);
  if (overview.summary.paid !== null) overview.summary.paid = overview.tables.filter(t => t.state === "paid").length;
  return { scope, day, context, base, overview };
}

export async function decorateCleaningDetail(detail: TableDetail) {
  const state = await readCleaningState();
  if (!state || state.day !== detail.businessDate) return detail;
  const table = state.overview.tables.find(t => t.id === detail.table.id)!;
  const key = state.context.keys[table.id];
  const enabled = cleaningFeatureEnabled() && state.context.manualEnabled !== false && table.state === "paid" && !!key && key.receiptId === detail.latest?.id && detail.merges.length === 0;
  return { ...detail, table, snapshotAt: state.overview.snapshotAt, snapshotStatus: state.overview.snapshotStatus,
    timer: table.paymentObservation ? { enabled: true as const, firstVerifiedAt: table.paymentObservation.firstVerifiedAt,
      expiresAt: table.paymentObservation.expiresAt, expired: table.paymentObservation.expired } : detail.timer,
    cleaning: { enabled, reason: table.state === "occupied" ? "active_orders" as const : table.state === "unknown" ? "snapshot_unhealthy" as const
      : detail.merges.length ? "merge_review" as const : !enabled ? "state_changed" as const : "ready" as const,
      ...(enabled ? { token: { businessDate: state.day, ...key } } : {}) } };
}

export async function confirmTableCleaning(tableId: string, actorId: number, request: { requestId: string; businessDate: string; receiptId: number; evidenceKey: string }) {
  if (!cleaningFeatureEnabled()) throw Error("CLEANING_DISABLED");
  const state = await readCleaningState();
  if (!state) throw Error("CLEANING_DISABLED");
  const table = state.base.tables.find(t => t.id === tableId), key = state.context.keys[tableId];
  if (state.day !== request.businessDate || table?.state !== "paid" || !key || key.receiptId !== request.receiptId || key.evidenceKey !== request.evidenceKey) throw Error("CLEANING_STALE");
  const result = await supabaseServer.rpc("tables_cleaning_confirm_v1", { p_scope: state.scope, p_day: state.day,
    p_table: tableId, p_actor: actorId, p_request: request.requestId, p_receipt: key.receiptId, p_key: key.evidenceKey,
    p_snapshot: state.context.snapshot, p_receipts: state.context.receipts }).abortSignal(AbortSignal.timeout(15_000));
  if (result.error) throw Error(result.error.code === "40001" ? "CLEANING_STALE" : "CLEANING_UNAVAILABLE");
  if (result.data?.saved !== true) throw Error("CLEANING_UNAVAILABLE");
  // Never synthesize idle. A newly collected order can already take precedence here.
  const refreshed = await readCleaningState();
  if (!refreshed) throw Error("CLEANING_UNAVAILABLE");
  return { eventId: result.data.eventId, overview: refreshed.overview };
}
