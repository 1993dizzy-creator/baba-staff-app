// Monthly view of the 일자별재고 입고정보 동기화 items: the same per-day detection
// (findInventoryLogNameSyncItems) run over every business date of one month. Read only;
// each item keeps its real businessDate so syncing still goes through the daily API.
import {
  INVENTORY_SNAPSHOT_NAME_SYNC_START_DATE,
  findInventoryLogNameSyncItems,
  type CurrentInventoryDailySyncRow,
  type InventoryDailySyncLogRow,
  type InventorySnapshotNameSyncItem,
// @ts-expect-error Node's direct TypeScript tests require the explicit extension.
} from "./snapshot-name-sync.ts";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export type MonthlyInventoryNameSyncItem = InventorySnapshotNameSyncItem & { businessDate: string };

export const isInventoryNameSyncMonth = (value: unknown): value is string =>
  typeof value === "string" && MONTH.test(value);

// [start, endExclusive) business dates of the month, clipped to the sync start date;
// null when the whole month is before it.
export function inventoryNameSyncMonthRange(month: string) {
  if (!isInventoryNameSyncMonth(month)) return null;
  const [year, monthNumber] = month.split("-").map(Number);
  const next = monthNumber === 12 ? `${year + 1}-01` : `${year}-${String(monthNumber + 1).padStart(2, "0")}`;
  const endExclusive = `${next}-01`;
  const start = `${month}-01` < INVENTORY_SNAPSHOT_NAME_SYNC_START_DATE ? INVENTORY_SNAPSHOT_NAME_SYNC_START_DATE : `${month}-01`;
  return start < endExclusive ? { start, endExclusive } : null;
}

export function findMonthlyInventoryNameSyncItems(
  month: string,
  logs: readonly InventoryDailySyncLogRow[],
  inventoryItems: readonly CurrentInventoryDailySyncRow[]
): MonthlyInventoryNameSyncItem[] {
  const range = inventoryNameSyncMonthRange(month);
  if (!range) return [];
  const logsByDate = new Map<string, InventoryDailySyncLogRow[]>();
  const logIds = new Set<number>();
  for (const log of logs) {
    // A log repeated across pages must not count its purchase twice.
    if (logIds.has(Number(log.id))) continue;
    logIds.add(Number(log.id));
    const date = log.business_date;
    if (!date || date < range.start || date >= range.endExclusive) continue;
    const dayLogs = logsByDate.get(date) ?? [];
    dayLogs.push(log);
    logsByDate.set(date, dayLogs);
  }
  const seen = new Set<string>();
  return [...logsByDate.keys()].sort().flatMap(businessDate =>
    (findInventoryLogNameSyncItems(businessDate, logsByDate.get(businessDate)!, inventoryItems) as InventorySnapshotNameSyncItem[]).flatMap(item => {
      // One row per business date and item, even if the same log page arrives twice.
      const key = `${businessDate}:${item.itemId}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ ...item, businessDate }];
    }));
}
