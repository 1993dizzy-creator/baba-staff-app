export type InventoryLanguageRow = {
  id: number;
  item_name: string | null;
  item_name_vi: string | null;
  is_active: boolean | null;
};

export type InventoryMissingLanguage = "ko" | "vi";

export type InventoryLanguageMissingItem = {
  itemId: number;
  currentItemName: string | null;
  currentItemNameVi: string | null;
  missingLanguages: InventoryMissingLanguage[];
};

const isBlank = (value: string | null | undefined) =>
  String(value ?? "").trim() === "";

export function findInventoryLanguageMissingItems(
  inventoryItems: readonly InventoryLanguageRow[]
): InventoryLanguageMissingItem[] {
  return inventoryItems.flatMap((item) => {
    if (item.is_active !== true) return [];

    const missingLanguages: InventoryMissingLanguage[] = [];
    if (isBlank(item.item_name)) missingLanguages.push("ko");
    if (isBlank(item.item_name_vi)) missingLanguages.push("vi");
    if (missingLanguages.length === 0) return [];

    return [{
      itemId: Number(item.id),
      currentItemName: item.item_name,
      currentItemNameVi: item.item_name_vi,
      missingLanguages,
    }];
  });
}
