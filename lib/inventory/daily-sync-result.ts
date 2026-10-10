export type InventoryDailySyncTargetResult = {
  purchaseLogId: number;
  correctionLogId: number;
  status: "synced" | "review_required" | "failed";
  code: string;
};
export type InventoryDailySyncResult = {
  itemId: number;
  currentItemName: string | null;
  currentItemNameVi: string | null;
  status: "synced" | "review_required" | "failed";
  code?: string;
  targets: InventoryDailySyncTargetResult[];
};
