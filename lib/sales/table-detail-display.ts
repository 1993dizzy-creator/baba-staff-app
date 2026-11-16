import type { TableOverview, TableTile } from "./table-overview.ts";
import { calculateStoreBusinessDate } from "../store-settings/business-time-core.ts";
import { DEFAULT_STALE_AFTER_MS } from "../pos/cukcuk/open-orders-core.ts";
import type { TableDetail } from "./table-detail.ts";

/** Existing server-verified receipt reference only, never a new payment clock. */
export function verifiedPaidReferenceTime(table: TableTile, snapshotAt: string | null, serverNow: string, snapshotStatus: string, businessDate: string) {
  if (table.state !== "paid" || snapshotStatus !== "ok" || !table.lastPaidAt || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(table.lastPaidAt)) return null;
  const paid = Date.parse(table.lastPaidAt), snapshot = Date.parse(snapshotAt ?? ""), now = Date.parse(serverNow);
  return [paid, snapshot, now].every(Number.isFinite) && paid <= now && snapshot <= now
    && calculateStoreBusinessDate(new Date(paid)) === businessDate ? table.lastPaidAt : null;
}

/** Reject stale detail evidence after a cleaning/context refresh. Fixed at ref_date. */
export function paidOrderElapsedMinutes(detail: TableDetail | null | undefined) {
  const usage = detail?.paidUsage, latest = detail?.latest;
  if (!usage || !latest || detail?.table.state !== "paid" || detail.snapshotStatus !== "ok"
    || detail.table.orders.some(o => o.verifiedOpen) || !latest.validPaid || latest.canceled || latest.uncertain || latest.link !== "direct"
    || latest.businessDate !== detail.businessDate || usage.snapshotAt !== detail.snapshotAt || usage.receiptId !== latest.id
    || usage.referenceAt !== latest.referenceAt || usage.referenceAt !== detail.table.lastPaidAt
    || !Number.isSafeInteger(usage.minutes) || usage.minutes < 0) return null;
  return usage.minutes;
}

/** Display only: earliest verified current order start, not customer seating time. */
export function verifiedOrderStart(table: TableTile, snapshotAt: string | null, serverNow: string, snapshotStatus: string, businessDate: string) {
  if (table.state !== "occupied" || snapshotStatus !== "ok") return null;
  const current = table.orders.filter(o => o.verifiedOpen), end = Date.parse(serverNow), snapshot = Date.parse(snapshotAt ?? "");
  if (!current.length || !Number.isFinite(end) || !Number.isFinite(snapshot) || snapshot > end) return null;
  for (const o of current) {
    const start = Date.parse(o.startedAt), observed = Date.parse(o.collectedAt ?? "");
    if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(o.startedAt) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(o.collectedAt ?? "") || !Number.isFinite(start) || !Number.isFinite(observed)
      || start > observed || observed > snapshot || end - observed > DEFAULT_STALE_AFTER_MS
      || calculateStoreBusinessDate(o.startedAt) !== businessDate) return null;
  }
  return current.reduce((first, o) => Date.parse(o.startedAt) < Date.parse(first.startedAt) ? o : first).startedAt;
}

/** A delayed save/poll response must not overwrite a newer server snapshot. */
export function preferLatestOverview(current: TableOverview | null, incoming: TableOverview): TableOverview | null {
  if (!Number.isFinite(Date.parse(incoming.serverNow))) return current;
  return !current || Date.parse(incoming.serverNow) >= Date.parse(current.serverNow) ? incoming : current;
}

export function detailTableName(table: TableTile, lang: "ko" | "vi") {
  return ["floor1", "floor2"].includes(table.area) && /^\d+$/.test(table.name)
    ? `${lang === "ko" ? "테이블" : "Bàn"} ${table.name}` : table.name;
}

/** Elapsed since earliest verified ORDER, never physical seating. Use the server clock. */
export function orderElapsedMinutes(table: TableTile, snapshotAt: string | null, serverNow: string, snapshotStatus: string) {
  if (table.state !== "occupied" || snapshotStatus !== "ok") return null;
  const current = table.orders.filter(o => o.verifiedOpen), end = Date.parse(serverNow), snapshot = Date.parse(snapshotAt ?? "");
  if (!current.length || !Number.isFinite(end) || !Number.isFinite(snapshot) || snapshot > end) return null;
  const starts = current.map(o => Date.parse(o.startedAt));
  if (starts.some(start => !Number.isFinite(start) || start > snapshot || start > end)) return null;
  return Math.floor((end - Math.min(...starts)) / 60_000);
}
