import type { TableDetail } from "./table-detail.ts";
import type { TableOverview } from "./table-overview.ts";

export type TableDetailResult = { key: string; detail: TableDetail | null; failed: boolean; pending?: boolean };

/** Collection timestamps are freshness evidence, not a reason to re-download menus/history. */
export function tableDetailEvidenceKey(overview: TableOverview | null, id?: string) {
  const table = overview?.tables.find(t => t.id === id);
  if (!overview || !table) return null;
  return JSON.stringify([overview.businessDate, overview.beforeOpening, overview.catalogStatus, overview.snapshotStatus,
    table.id, table.state, table.lastPaidAt, table.paymentObservation, table.detailEvidence,
    table.orders.map(order => ({ id: order.id, number: order.number, tableName: order.tableName,
      startedAt: order.startedAt, amount: order.amount, verifiedOpen: order.verifiedOpen,
      detailsNeedReview: order.detailsNeedReview, lines: order.lines })).sort((a, b) => a.id.localeCompare(b.id))]);
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
    tables: overview.tables.map(table => ({ ...table, state: "unknown", orders: table.orders.map(order => ({ ...order, verifiedOpen: false })) })),
    unlinked: overview.unlinked.map(order => ({ ...order, verifiedOpen: false })),
    summary: { ...overview.summary, occupied: null, occupiedConfirmed: null, occupiedPartial: false, paid: null, paidCumulative: null,
      unknown: overview.tables.length, paidCumulativeEvidence: { ...overview.summary.paidCumulativeEvidence, count: null, status: "unavailable", reason: "snapshot_unhealthy" } } };
}
