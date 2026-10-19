export type InventoryDailySyncTargetResult = {
  purchaseLogId: number;
  correctionLogId: number;
  status: "synced" | "review_required" | "failed";
  code: string;
  // Ledger location of the original receipt: business month, its source key and,
  // when the projection returned them, the pending candidate or posted transaction.
  ledgerMonth?: string;
  sourceKey?: string;
  candidateId?: number | null;
  transactionId?: number | null;
};
export type InventoryDailySyncResult = {
  itemId: number;
  currentItemName: string | null;
  currentItemNameVi: string | null;
  status: "synced" | "review_required" | "failed";
  code?: string;
  targets: InventoryDailySyncTargetResult[];
};

export const inventoryPurchaseSourceKey = (purchaseLogId: number) => `inventory-log:${purchaseLogId}`;

// Deep link opening the exact Ledger entry of one original receipt.
export function inventoryLedgerEntryHref(target: Pick<InventoryDailySyncTargetResult, "purchaseLogId" | "ledgerMonth" | "sourceKey">, businessDate: string) {
  const month = /^\d{4}-\d{2}$/.test(target.ledgerMonth ?? "") ? target.ledgerMonth! : businessDate.slice(0, 7);
  const params = new URLSearchParams({
    month,
    inventoryLogId: String(target.purchaseLogId),
    sourceKey: target.sourceKey || inventoryPurchaseSourceKey(target.purchaseLogId),
  });
  return `/admin/ledger/entries?${params.toString()}`;
}
