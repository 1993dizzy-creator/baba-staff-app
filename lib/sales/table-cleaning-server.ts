import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { loadBusinessTimeAdapter } from "@/lib/store-settings/business-time-adapter";
import { openOrdersScope } from "@/lib/pos/cukcuk/open-orders-scope";
import type { CollectedOrder, OpenOrderSyncState } from "@/lib/pos/cukcuk/open-orders-core";
import { babaTableCatalog } from "./baba-table-catalog";
import { buildTableOverview } from "./table-overview";
import { validOrders } from "./table-overview-server";
import { detailNumber, mergeSettled, type DetailReceiptRow, type TableDetail } from "./table-detail";
import { projectReceiptOrderUsage } from "./table-paid-usage";
import { autoNormalActivation, applyPaymentObservations, type PaymentObservation } from "./table-auto-normal";
import { logTablesReadFailure, tablesReadBudget, tablesReadTimedOut, type TablesReadBudget } from "./table-read-diagnostics";

export const cleaningFeatureEnabled = () => process.env.BABA_TABLE_CLEANING_ENABLED?.trim() === "true"
  && process.env.POS_OPEN_ORDERS_READ_ENABLED?.trim() === "true";
type Key = { receiptId: number; evidenceKey: string; autoKey?: string };
const cleaningError = (code: string, stage: string) => Object.assign(new Error(code), { stage });
type Context = { enabled: true; snapshot: { sync: OpenOrderSyncState | null; orders: CollectedOrder[] };
  receipts: (DetailReceiptRow & { version: string })[]; keys: Record<string, Key>; cleanedTableIds: string[];
  manualEnabled?: boolean; serverNow?: string; observations?: Record<string, PaymentObservation>; reviewTableIds?: string[] };

/** A failed context read: which stage, and whether it was a timeout (never retried by the same path). */
export const cleaningReadError = (stage: "auto_context" | "cleaning_context", code: string) =>
  Object.assign(Error("CLEANING_UNAVAILABLE"), { stage, code, timedOut: tablesReadTimedOut(code) });

/** Atomic DB read + existing complete v3 policy; DB separately validates the write.
 * timeoutMs is the whole budget of this read (both context RPCs together), not per call. */
export async function readCleaningState(now = new Date(), timeoutMs = 15_000, budget: TablesReadBudget = tablesReadBudget(timeoutMs),
  loadBusinessTime?: () => ReturnType<typeof loadBusinessTimeAdapter>) {
  const activation = autoNormalActivation();
  if (!cleaningFeatureEnabled() && !activation) return null;
  // Only the overview supplies its same-request/same-timestamp settings. Detail,
  // observer and cleaning pre/post-save reads still resolve a fresh context each time.
  const time = await (loadBusinessTime ? loadBusinessTime() : loadBusinessTimeAdapter(now)), day = time.databaseBusinessDate, scope = openOrdersScope();
  let stage: "auto_context" | "cleaning_context" = activation ? "auto_context" : "cleaning_context";
  let started = Date.now();
  let result = await Promise.resolve(supabaseServer.rpc(activation ? "tables_auto_context_v1" : "tables_cleaning_context_v1",
    { p_scope: scope, p_day: day, ...(activation ? { p_activation: activation } : {}) }).abortSignal(budget.signal()))
    .catch(error => { throw cleaningReadError(stage, logTablesReadFailure(stage, error, started)); });
  // Failed/missing/disabled automatic capability must never disable working manual cleaning.
  // A timeout is not retried with the manual context: it reads the same snapshot and would fail late.
  if (activation && (result.error || result.data?.enabled === false) && cleaningFeatureEnabled()) {
    if (result.error) {
      const code = logTablesReadFailure("auto_context", result.error, started);
      if (tablesReadTimedOut(code) || !budget.allows()) throw cleaningReadError("auto_context", code);
    }
    stage = "cleaning_context"; started = Date.now();
    result = await Promise.resolve(supabaseServer.rpc("tables_cleaning_context_v1", { p_scope: scope, p_day: day }).abortSignal(budget.signal()))
      .catch(error => { throw cleaningReadError(stage, logTablesReadFailure(stage, error, started)); });
  }
  if (result.error) throw cleaningReadError(stage, logTablesReadFailure(stage, result.error, started));
  if (result.data?.enabled === false) return null;
  const context = result.data as Context;
  if (!context || !context.enabled || !Array.isArray(context.receipts) || !Array.isArray(context.cleanedTableIds) || !context.keys || !context.snapshot) {
    throw cleaningReadError(stage, logTablesReadFailure(stage, Error("CONTEXT_INVALID"), started));
  }
  const orders = Array.isArray(context.snapshot.orders) ? context.snapshot.orders.map(o => ({ ...o, raw: {}, totalAmount: detailNumber(o.totalAmount) ?? NaN })) : null;
  if (!validOrders(orders)) throw cleaningReadError(stage, logTablesReadFailure(stage, Error("SNAPSHOT_INVALID"), started));
  const sync = context.snapshot.sync;
  if (sync !== null && (!sync || sync.businessDate !== day || ![sync.lastSuccessAt, sync.lastAttemptAt].every(v => v === null || typeof v === "string" && Number.isFinite(Date.parse(v)))
    || !(sync.lastErrorCode === null || typeof sync.lastErrorCode === "string"))) throw Error("CLEANING_UNAVAILABLE");
  if (context.observations && (!context.serverNow || !Number.isFinite(Date.parse(context.serverNow)))) throw Error("CLEANING_UNAVAILABLE");
  const effectiveNow = context.observations ? new Date(context.serverNow!) : now;
  const base = buildTableOverview({ businessDate: day, now: effectiveNow, catalog: babaTableCatalog(), sync, orders,
    receipts: context.receipts.map(r => ({ receiptId: r.id, orderId: r.order_id ?? "", tableName: r.table_name,
      paidAt: r.ref_date, businessDate: r.business_date, paymentStatus: r.payment_status, isCanceled: r.is_canceled })),
    enabled: true, cutoff: time.snapshot.cutoff, businessTime: time.snapshot,
    receiptVersions: Object.fromEntries(context.receipts.map(r => [r.id, JSON.stringify([r.final_amount, r.ref_no, r.status_changed_at, r.version])])) });
  const overview = structuredClone(base);
  for (const table of overview.tables) if (cleaningFeatureEnabled() && context.manualEnabled !== false
    && table.state === "paid" && context.cleanedTableIds.includes(table.id) && context.keys[table.id]) { table.state = "idle"; delete table.merge; }
  if (activation && context.observations) applyPaymentObservations(overview, context.observations, context.keys, context.reviewTableIds);
  if (overview.summary.paid !== null) overview.summary.paid = overview.tables.filter(t => t.state === "paid").length;
  return { scope, day, context, base, overview };
}

export async function decorateCleaningDetail(detail: TableDetail) {
  const state = await readCleaningState();
  if (!state || state.day !== detail.businessDate) return detail;
  const table = state.overview.tables.find(t => t.id === detail.table.id)!;
  const key = state.context.keys[table.id];
  const enabled = cleaningFeatureEnabled() && state.context.manualEnabled !== false && table.state === "paid" && !!key && key.receiptId === detail.latest?.id && detail.merges.every(mergeSettled);
  // Rebind display-only timing to the already-read atomic context. A newer
  // snapshot must not silently drop otherwise valid order/receipt duration.
  const current = detail.current.map(receipt => ({ ...receipt, orderUsage: projectReceiptOrderUsage({
    overview: state.overview, orders: state.context.snapshot.orders, receipts: state.context.receipts,
    receipt, now: new Date(state.overview.serverNow),
  }) }));
  const latest = detail.latest ? current.find(r => r.id === detail.latest!.id) ?? { ...detail.latest, orderUsage: null } : null;
  const usage = latest?.orderUsage;
  return { ...detail, table, snapshotAt: state.overview.snapshotAt, snapshotStatus: state.overview.snapshotStatus,
    collection: state.overview.collection,
    current, latest,
    paidUsage: usage && table.state === "paid" && state.overview.snapshotStatus === "ok"
      && key?.receiptId === usage.receiptId && table.lastPaidAt === usage.referenceAt ? usage : null,
    timer: table.paymentObservation ? { enabled: true as const, firstVerifiedAt: table.paymentObservation.firstVerifiedAt,
      expiresAt: table.paymentObservation.expiresAt, expired: table.paymentObservation.expired } : detail.timer,
    cleaning: { enabled, reason: table.state === "occupied" ? "active_orders" as const : table.state === "unknown" ? "snapshot_unhealthy" as const
      : !detail.merges.every(mergeSettled) ? "merge_review" as const : !enabled ? "state_changed" as const : "ready" as const,
      ...(enabled ? { token: { businessDate: state.day, ...key } } : {}) } };
}

export async function confirmTableCleaning(tableId: string, actorId: number, request: { requestId: string; businessDate: string; receiptId: number; evidenceKey: string }) {
  if (!cleaningFeatureEnabled()) throw cleaningError("CLEANING_DISABLED", "feature");
  let state;
  try { state = await readCleaningState(); } catch { throw cleaningError("CLEANING_UNAVAILABLE", "context"); }
  if (!state) throw cleaningError("CLEANING_DISABLED", "feature");
  const table = state.base.tables.find(t => t.id === tableId), key = state.context.keys[tableId];
  if (state.day !== request.businessDate || table?.state !== "paid" || !key || key.receiptId !== request.receiptId || key.evidenceKey !== request.evidenceKey) throw cleaningError("CLEANING_STALE", "evidence");
  let result;
  try { result = await supabaseServer.rpc("tables_cleaning_confirm_v1", { p_scope: state.scope, p_day: state.day,
    p_table: tableId, p_actor: actorId, p_request: request.requestId, p_receipt: key.receiptId, p_key: key.evidenceKey,
    p_snapshot: state.context.snapshot, p_receipts: state.context.receipts }).abortSignal(AbortSignal.timeout(15_000));
  } catch { throw cleaningError("CLEANING_UNAVAILABLE", "confirm_rpc"); }
  if (result.error) throw cleaningError(result.error.code === "40001" ? "CLEANING_STALE" : "CLEANING_UNAVAILABLE", "confirm_rpc");
  if (result.data?.saved !== true) throw cleaningError("CLEANING_UNAVAILABLE", "confirm_rpc");
  // Never synthesize idle. A newly collected order can already take precedence here.
  try {
    const refreshed = await readCleaningState();
    if (refreshed) return { saved: true as const, eventId: result.data.eventId, overview: refreshed.overview };
  } catch { /* The write was confirmed. Never misreport it as a failed save. */ }
  return { saved: true as const, eventId: result.data.eventId, overview: null, refreshRequired: true as const };
}
