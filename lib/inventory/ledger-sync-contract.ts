export type LedgerSyncResult = {
  status: "synced" | "pending" | "review_required" | "failed";
  code?: string;
  inventoryLogId?: number;
  transactionId?: number;
  candidateId?: number;
};

export const INVENTORY_DISPLAY_FIELDS = [
  "item_name",
  "item_name_vi",
  "part",
  "category",
  "category_vi",
  "code",
  "unit",
] as const;

export function inventoryDisplayOverlay(original: Record<string, unknown> | null | undefined, overlay: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const result = { ...original };
  for (const field of INVENTORY_DISPLAY_FIELDS) {
    if (overlay && Object.hasOwn(overlay, field)) result[field] = overlay[field];
  }
  return result;
}

export function inventoryLogDisplayUpdate(item: Record<string, unknown>): Record<string, string | number | null> {
  const fields: Record<string, string | number | null> = {};
  for (const key of INVENTORY_DISPLAY_FIELDS) fields[key] = typeof item[key] === "string" ? item[key] : null;
  return {
    ...fields,
    new_part: fields.part,
    new_category: fields.category,
    new_category_vi: fields.category_vi,
    new_code: fields.code,
    new_unit: fields.unit,
  };
}

export function inventoryPurchaseLogCurrentItemSyncUpdate(
  item: Record<string, unknown>
): Record<string, string | number | null> {
  return {
    ...inventoryLogDisplayUpdate(item),
    new_purchase_price:
      typeof item.purchase_price === "number" ? item.purchase_price : null,
    new_supplier: typeof item.supplier === "string" ? item.supplier : null,
    purchase_supplier_partner_id:
      typeof item.supplier_partner_id === "number"
        ? item.supplier_partner_id
        : null,
  };
}

export function ledgerSyncNotice(result: LedgerSyncResult | undefined, vi: boolean): string | null {
  if (!result || result.status === "synced") return null;
  const state = result.status === "pending" ? (vi ? "chờ xác nhận" : "확정 대기")
    : result.status === "review_required" ? (vi ? "cần quản trị viên kiểm tra" : "관리자 확인 필요")
      : (vi ? "đồng bộ thất bại; quản trị viên có thể đồng bộ lại" : "동기화 실패 · 관리자 재동기화 가능");
  return `${vi ? "Đã lưu kho. Sổ kế toán" : "재고 정보는 저장되었습니다. 장부"}: ${state}${result.code ? ` (${result.code})` : ""}`;
}
