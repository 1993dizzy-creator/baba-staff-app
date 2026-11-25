import type { TableDetail } from "./table-detail.ts";
import type { TableOverview } from "./table-overview.ts";

const failureCodes = {
  detail: "TABLE_DETAIL_UNAVAILABLE", context: "TABLE_DETAIL_CONTEXT_UNAVAILABLE",
  snapshot: "TABLE_DETAIL_SNAPSHOT_UNAVAILABLE", receipts: "TABLE_DETAIL_RECEIPTS_UNAVAILABLE",
  lines: "TABLE_DETAIL_LINES_UNAVAILABLE", timeout: "TABLE_DETAIL_TIMEOUT",
  response: "TABLE_DETAIL_RESPONSE_INVALID", stale: "TABLE_DETAIL_RESPONSE_STALE",
} as const;
export type DetailFailure = { stage: keyof typeof failureCodes; code: string; status?: number };
/** Only fixed diagnostics cross the API/DOM boundary; never forward an exception message. */
export function detailFailure(stage: unknown = "detail", status?: number): DetailFailure {
  const safe = typeof stage === "string" && Object.hasOwn(failureCodes, stage) ? stage as DetailFailure["stage"] : "detail";
  return { stage: safe, code: failureCodes[safe], ...(status !== undefined ? { status } : {}) };
}
export type TableDetailResult = { key: string; detail: TableDetail | null; failed: boolean; pending?: boolean; failure?: DetailFailure };

/** Collection timestamps are freshness evidence, not a reason to re-download menus/history. */
export function tableDetailEvidenceKey(overview: TableOverview | null, id?: string) {
  const table = overview?.tables.find(t => t.id === id);
  if (!overview || !table) return null;
  return JSON.stringify([overview.businessDate, overview.beforeOpening, overview.catalogStatus, overview.snapshotStatus,
    table.id, table.state, table.lastPaidAt, table.paymentObservation, table.detailEvidence,
    table.orders.map(order => ({ id: order.id, number: order.number, tableName: order.tableName,
      startedAt: order.startedAt, amount: order.amount, verifiedOpen: order.verifiedOpen,
      detailsNeedReview: order.detailsNeedReview, quarantinedAt: order.quarantinedAt ?? null, lines: order.lines })).sort((a, b) => a.id.localeCompare(b.id))]);
}

/** Keep same-day history mounted while refreshing. Current orders/status use the
 * newest overview until a current, compatible detail response is available.
 */
export function selectTableDetail(result: TableDetailResult | null, overview: TableOverview | null, id?: string) {
  const detail = id && result?.detail?.table.id === id && result.detail.businessDate === overview?.businessDate ? result.detail : null;
  const base = overview?.tables.find(t => t.id === id) ?? null;
  const newOrder = base?.orders.some(o => o.verifiedOpen && !detail?.table.orders.some(old => old.id === o.id && Date.parse(old.startedAt) === Date.parse(o.startedAt)));
  const basePaid = base?.lastPaidAt ? Date.parse(base.lastPaidAt) : null, detailPaid = detail?.table.lastPaidAt ? Date.parse(detail.table.lastPaidAt) : null;
  const ahead = !!detail && overview?.snapshotStatus === "ok" && detail.snapshotStatus === "ok"
    && Date.parse(detail.snapshotAt ?? "") > Date.parse(overview.snapshotAt ?? "") && !newOrder
    && !(basePaid !== null && (detailPaid === null || basePaid > detailPaid));
  const paymentChanged = !!detail && !!base && overview?.snapshotStatus === "ok" && !ahead
    && (basePaid !== detailPaid || base.detailEvidence !== detail.table.detailEvidence);
  const current = !!detail && !!overview && result?.key === tableDetailEvidenceKey(overview, id) && !result.failed && !result.pending
    && overview.snapshotStatus === "ok" && !newOrder && !paymentChanged
    && detail.table.state === base?.state
    && !(Date.parse(detail.snapshotAt ?? "") < Date.parse(overview.snapshotAt ?? ""));
  return { detail, tile: current || ahead ? detail!.table : base, fresh: current && detail.snapshotStatus === "ok"
      && detail.snapshotAt === overview?.snapshotAt, paymentChanged,
    snapshotAt: current || ahead ? detail!.snapshotAt : overview?.snapshotAt ?? null,
    snapshotStatus: current || ahead ? detail!.snapshotStatus : overview?.snapshotStatus };
}

/** Retained facts are historical on a failed list read; never leave green tiles,
 * live amounts/counts or an actionable cleaning token looking current.
 */
export function unavailableTableOverview(overview: TableOverview): TableOverview {
  return { ...overview, snapshotStatus: "unavailable",
    collection: overview.collection ? { ...overview.collection, health: "read_failed", normalWaiting: false } : undefined,
    tables: overview.tables.map(table => ({ ...table, state: "unknown", paymentPending: false, orders: table.orders.map(order => ({ ...order, verifiedOpen: false })) })),
    unlinked: overview.unlinked.map(order => ({ ...order, verifiedOpen: false })),
    summary: { ...overview.summary, occupied: null, occupiedConfirmed: null, occupiedPartial: false, paid: null, paidCumulative: null,
      unknown: overview.tables.length, paidCumulativeEvidence: { ...overview.summary.paidCumulativeEvidence, count: null, status: "unavailable", reason: "snapshot_unhealthy" } } };
}

/** Same validity as a central collection (10 minutes): older facts never look current. */
export const OVERVIEW_HOLD_MAX_SNAPSHOT_AGE_MS = 10 * 60 * 1000;
/** The last overview the server built from a successful read, and the browser time it arrived. */
export type OverviewHold = { overview: TableOverview; receivedAt: number };
/** The server answered, but its own snapshot/receipt read failed (HTTP 200, every table unknown). */
export const overviewReadFailed = (overview: TableOverview | null | undefined) => overview?.collection?.health === "read_failed";

/**
 * Board after a refresh failure (transport error, non-OK response, or a server "read_failed"
 * overview). The last good overview is kept exactly as it was (its own unknown tiles included)
 * only while its central snapshot is still inside the 10-minute collection validity, measured as
 * the snapshot age the server reported plus browser time elapsed since it arrived, and only for
 * the same business date. Otherwise the existing unavailable projection (every table unknown).
 * `delayed` marks a held board: it is display-only and never authorizes cleaning.
 */
export function heldTableOverview(last: OverviewHold | null, now: number, incoming?: TableOverview | null) {
  if (!last) return { overview: incoming ?? null, delayed: null };
  if (incoming && incoming.businessDate !== last.overview.businessDate) return { overview: incoming, delayed: null };
  const snapshot = Date.parse(last.overview.snapshotAt ?? ""), served = Date.parse(last.overview.serverNow);
  const elapsed = now - last.receivedAt, age = served - snapshot + elapsed;
  const valid = last.overview.snapshotStatus === "ok" && !overviewReadFailed(last.overview) && Number.isFinite(age)
    && elapsed >= 0 && served >= snapshot && age < OVERVIEW_HOLD_MAX_SNAPSHOT_AGE_MS;
  if (!valid) return { overview: unavailableTableOverview(last.overview), delayed: null };
  return { overview: last.overview,
    delayed: { lastSuccessAt: last.overview.serverNow, expiresInMs: OVERVIEW_HOLD_MAX_SNAPSHOT_AGE_MS - age } };
}
