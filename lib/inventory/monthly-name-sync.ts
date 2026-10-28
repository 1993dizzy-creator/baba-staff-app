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

export type MonthlySyncTargetKey = { businessDate: string; itemId: number };
export const MONTHLY_SYNC_MAX_TARGETS = 300;
const monthlySyncKey = (target: MonthlySyncTargetKey) => `${target.businessDate}:${target.itemId}`;

// The 일괄 동기화 request: the (businessDate, itemId) rows the user saw, each inside the
// month's sync range, de-duplicated. null when anything is malformed (nothing is synced).
export function parseMonthlySyncTargets(month: unknown, targets: unknown): MonthlySyncTargetKey[] | null {
  if (!isInventoryNameSyncMonth(month) || !Array.isArray(targets) || targets.length === 0 || targets.length > MONTHLY_SYNC_MAX_TARGETS) return null;
  const range = inventoryNameSyncMonthRange(month);
  if (!range) return null;
  const seen = new Set<string>();
  const parsed: MonthlySyncTargetKey[] = [];
  for (const target of targets) {
    const businessDate = (target as { businessDate?: unknown } | null)?.businessDate;
    const itemId = Number((target as { itemId?: unknown } | null)?.itemId);
    if (typeof businessDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || businessDate < range.start || businessDate >= range.endExclusive
      || Number.isNaN(Date.parse(`${businessDate}T00:00:00Z`)) || new Date(`${businessDate}T00:00:00Z`).toISOString().slice(0, 10) !== businessDate
      || !Number.isSafeInteger(itemId) || itemId < 1) return null;
    const key = monthlySyncKey({ businessDate, itemId });
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({ businessDate, itemId });
  }
  return parsed;
}

// Requested rows that still need a sync by a fresh read of the month; the rest are skipped
// (already synced, or no longer pending) and are never run again.
export function selectMonthlySyncPlans(
  month: string,
  logs: readonly InventoryDailySyncLogRow[],
  inventoryItems: readonly CurrentInventoryDailySyncRow[],
  targets: readonly MonthlySyncTargetKey[]
) {
  const pending = new Map(findMonthlyInventoryNameSyncItems(month, logs, inventoryItems).map(item => [monthlySyncKey(item), item]));
  const plans: MonthlyInventoryNameSyncItem[] = [];
  const skipped: MonthlySyncTargetKey[] = [];
  for (const target of targets) {
    const plan = pending.get(monthlySyncKey(target));
    if (plan) plans.push(plan); else skipped.push(target);
  }
  // Oldest business date first, whatever order the request listed.
  plans.sort((left, right) => left.businessDate.localeCompare(right.businessDate) || left.itemId - right.itemId);
  return { plans, skipped };
}
