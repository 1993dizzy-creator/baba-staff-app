import type { TableOverview, TableTile } from "./table-overview.ts";
import { calculateStoreBusinessDate } from "../store-settings/business-time-core.ts";
import { DEFAULT_STALE_AFTER_MS } from "../pos/cukcuk/open-orders-core.ts";
import type { DetailReceipt, TableDetail } from "./table-detail.ts";
import type { PaidOrderUsage } from "./table-paid-usage.ts";

export function verifiedReceiptOrderUsage(receipt: DetailReceipt, snapshotAt: string | null, snapshotStatus: string, businessDate: string) {
  const usage = receipt.orderUsage;
  if (!usage || snapshotStatus !== "ok" || !receipt.validPaid || receipt.canceled || receipt.uncertain || receipt.link !== "direct"
    || receipt.businessDate !== businessDate || usage.snapshotAt !== snapshotAt || usage.receiptId !== receipt.id || usage.referenceAt !== receipt.referenceAt
    || !Number.isSafeInteger(usage.minutes) || usage.minutes < 0) return null;
  const start = Date.parse(usage.startedAt), end = Date.parse(usage.referenceAt);
  return Number.isFinite(start) && Number.isFinite(end) && start <= end && Math.floor((end - start) / 60_000) === usage.minutes ? usage : null;
}

/** Fixed VN local range. Repeat the date only when local calendar dates differ. */
export function receiptOrderTimeRange(usage: PaidOrderUsage, minuteSuffix: string) {
  const parts = (value: string) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value)).map(p => [p.type, p.value]));
  const a = parts(usage.startedAt), b = parts(usage.referenceAt), same = a.year === b.year && a.month === b.month && a.day === b.day;
  return `${a.month}.${a.day} ${a.hour}:${a.minute} ~ ${same ? "" : `${b.month}.${b.day} `}${b.hour}:${b.minute} · ${usage.minutes}${minuteSuffix}`;
}

/** UI only: current-day IDs once, excluding an already displayed standalone card. */
export function tablePaymentHistory(detail: TableDetail | null, standaloneId?: number) {
  const seen = new Set<number>();
  return detail?.current.filter(receipt => {
    if (receipt.businessDate !== detail.businessDate || receipt.id === standaloneId || seen.has(receipt.id)) return false;
    seen.add(receipt.id); return true;
  }) ?? [];
}

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
  const shared = verifiedReceiptOrderUsage(latest, detail.snapshotAt, detail.snapshotStatus, detail.businessDate);
  if (!shared || shared.startedAt !== usage.startedAt || shared.minutes !== usage.minutes) return null;
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
