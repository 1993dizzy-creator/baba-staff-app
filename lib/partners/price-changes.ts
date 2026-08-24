export type PartnerPriceChange = {
  id: string;
  itemId: number;
  itemName: string | null;
  itemNameVi: string | null;
  previousPrice: number;
  newPrice: number;
  difference: number;
  percentage: number | null;
  businessDate: string;
};

type LinkedItem = { id: number; itemName: string | null; itemNameVi: string | null };
type PurchaseLog = {
  id: number;
  item_id: number | string;
  new_purchase_price: number | string | null;
  business_date: string | null;
  created_at: string | null;
};

const finiteNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function buildPartnerPriceChanges(logs: readonly PurchaseLog[], items: readonly LinkedItem[], limit = 20): PartnerPriceChange[] {
  const itemById = new Map(items.map(item => [item.id, item]));
  const previousByItem = new Map<number, number>();
  const changes: PartnerPriceChange[] = [];

  const chronological = [...logs].sort((a, b) =>
    (a.business_date ?? "").localeCompare(b.business_date ?? "")
    || (a.created_at ?? "").localeCompare(b.created_at ?? "")
    || a.id - b.id
  );

  for (const log of chronological) {
    const itemId = finiteNumber(log.item_id);
    const newPrice = finiteNumber(log.new_purchase_price);
    if (itemId === null || newPrice === null || !log.business_date) continue;
    const item = itemById.get(itemId);
    if (!item) continue;
    const previousPrice = previousByItem.get(itemId);
    previousByItem.set(itemId, newPrice);
    if (previousPrice === undefined || previousPrice === newPrice) continue;
    const difference = newPrice - previousPrice;
    changes.push({
      id: `${itemId}-${log.id}`,
      itemId,
      itemName: item.itemName,
      itemNameVi: item.itemNameVi,
      previousPrice,
      newPrice,
      difference,
      percentage: previousPrice === 0 ? null : Math.abs(difference / previousPrice) * 100,
      businessDate: log.business_date,
    });
  }

  return changes.reverse().slice(0, limit);
}
