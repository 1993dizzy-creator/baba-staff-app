import type { LedgerEntry, LedgerEntryItem } from "./entries";

export type InventoryLedgerFocus = { logId: number; sourceKey: string };

// Reads ?inventoryLogId=&sourceKey= from the ledger entries URL. Both must describe the
// same original receipt; anything else is ignored rather than guessed.
export function parseInventoryLedgerFocus(params: { get(name: string): string | null }): InventoryLedgerFocus | null {
  const raw = params.get("inventoryLogId");
  const logId = raw && /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(logId) || logId < 1) return null;
  const expected = `inventory-log:${logId}`;
  const sourceKey = params.get("sourceKey") ?? expected;
  return sourceKey === expected ? { logId, sourceKey } : null;
}

const itemMatches = (item: LedgerEntryItem, focus: InventoryLedgerFocus) =>
  item.inventoryLogId === focus.logId && (item.sourceKey ?? `inventory-log:${item.inventoryLogId}`) === focus.sourceKey;

// The pending candidate is the actionable row; otherwise the currently posted expense.
export function findInventoryLedgerFocus(entries: readonly LedgerEntry[], focus: InventoryLedgerFocus) {
  const matches = entries.filter(entry => entry.drilldown === "inventory" && entry.items.some(item => itemMatches(item, focus)));
  const entry = matches.find(row => row.status === "pending") ?? matches[0];
  if (!entry) return null;
  const item = entry.items.find(row => itemMatches(row, focus))!;
  return { entry, item, itemKey: String(item.candidateId ?? item.transactionId) };
}
