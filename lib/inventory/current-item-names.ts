// Presentation metadata only. Never replace the stored audit/economic fields.
export type InventoryItemNames = { item_name: string | null; item_name_vi: string | null; updated_at?: string | null };
export type SavedInventoryItemNames = InventoryItemNames & { beforeUpdatedAt?: string | null };
export type InventoryNamedRecord = InventoryItemNames & { item_id?: number | null; currentItemNames?: InventoryItemNames | null };

export function inventoryDisplayName(record: InventoryNamedRecord, lang: "ko" | "vi", savedNames?: SavedInventoryItemNames) {
  // The editor's pre-save DB version avoids relying on the client clock. An
  // older response cannot undo a successful save, but a genuinely newer master
  // response (this edit or a later edit) can replace the temporary saved value.
  const newerMaster = Number.isFinite(Date.parse(savedNames?.beforeUpdatedAt ?? "")) &&
    Date.parse(record.currentItemNames?.updated_at ?? "") > Date.parse(savedNames?.beforeUpdatedAt ?? "");
  const names = record.currentItemNames === null ? record
    : newerMaster ? record.currentItemNames! : savedNames ?? record.currentItemNames ?? record;
  return lang === "vi"
    ? names.item_name_vi || names.item_name || "-"
    : names.item_name || names.item_name_vi || "-";
}

export function isNameOnlyInventoryEdit(before: Record<string, unknown>, payload: Record<string, unknown>) {
  const text = (value: unknown) => String(value ?? "").trim();
  return Object.entries(payload).every(([field, value]) =>
    field === "item_name" || field === "item_name_vi" || field === "updated_at" || text(before[field]) === text(value),
  );
}
