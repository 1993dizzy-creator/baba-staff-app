export type LatestStockCheckRow = {
  item_id: number | string | null;
  last_stock_check_date: string | null;
};

export type InventoryStatus = {
  lastStockCheckDate: string | null;
  daysSinceStockCheck: number | null;
  needsStockCheck: boolean;
};

export const STOCK_CHECK_STALE_DAYS = 7;

const getBusinessDateTime = (dateKey: string) =>
  new Date(`${dateKey}T12:00:00+07:00`).getTime();

export const getDaysBetweenBusinessDates = (
  fromDateKey: string,
  toDateKey: string
) => {
  const fromTime = getBusinessDateTime(fromDateKey);
  const toTime = getBusinessDateTime(toDateKey);

  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return null;

  return Math.max(0, Math.floor((toTime - fromTime) / 86_400_000));
};

export function buildInventoryStatusByItemId(params: {
  itemIds: number[];
  currentBusinessDate: string;
  saleDeductionActiveItemIds: Set<number>;
  latestStockChecks: LatestStockCheckRow[];
}) {
  const statusByItemId = new Map<number, InventoryStatus>();

  params.itemIds.forEach((itemId) => {
    statusByItemId.set(itemId, {
      lastStockCheckDate: null,
      daysSinceStockCheck: null,
      needsStockCheck: true,
    });
  });

  for (const row of params.latestStockChecks) {
    const itemId = Number(row.item_id);
    if (!statusByItemId.has(itemId) || !row.last_stock_check_date) continue;

    const lastStockCheckDate = String(row.last_stock_check_date);
    const daysSinceStockCheck = getDaysBetweenBusinessDates(
      lastStockCheckDate,
      params.currentBusinessDate
    );
    const hasRecentSaleDeduction =
      params.saleDeductionActiveItemIds.has(itemId);

    statusByItemId.set(itemId, {
      lastStockCheckDate,
      daysSinceStockCheck,
      needsStockCheck:
        !hasRecentSaleDeduction &&
        (daysSinceStockCheck === null ||
          daysSinceStockCheck >= STOCK_CHECK_STALE_DAYS),
    });
  }

  params.saleDeductionActiveItemIds.forEach((itemId) => {
    const existing = statusByItemId.get(itemId);
    if (!existing) return;

    statusByItemId.set(itemId, {
      ...existing,
      needsStockCheck: false,
    });
  });

  return statusByItemId;
}
