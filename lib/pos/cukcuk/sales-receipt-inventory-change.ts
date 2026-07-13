export type InventoryAffectingSalesLine = {
  refDetailId: string | null;
  parentRefDetailId: string | null;
  itemId: string | null;
  itemCode: string | null;
  quantity: number | string | null;
  refDetailType: number | null;
  inventoryItemType: number | null;
  isOption: boolean | null;
  isExcluded: boolean | null;
  isCanceled: boolean | null;
};

function normalizedNumber(value: number | string | null) {
  if (value === null || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Number(numberValue.toFixed(6)) : null;
}

export function hasInventoryAffectingSalesLineChanged(
  existing: InventoryAffectingSalesLine,
  next: InventoryAffectingSalesLine
) {
  return (
    existing.refDetailId !== next.refDetailId ||
    existing.parentRefDetailId !== next.parentRefDetailId ||
    existing.itemId !== next.itemId ||
    existing.itemCode !== next.itemCode ||
    normalizedNumber(existing.quantity) !== normalizedNumber(next.quantity) ||
    existing.refDetailType !== next.refDetailType ||
    existing.inventoryItemType !== next.inventoryItemType ||
    existing.isOption === true !== (next.isOption === true) ||
    existing.isExcluded === true !== (next.isExcluded === true) ||
    existing.isCanceled === true !== (next.isCanceled === true)
  );
}
