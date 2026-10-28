// Inventory duplicate policy (unchanged): another item is a duplicate when its Korean or
// Vietnamese name equals ours (accent/case/space-insensitive) and its code is the same.
// The caller excludes the item being edited. matchedFields says which name collided so the
// UI can name the other item instead of a bare "already registered".
// @ts-expect-error Node's direct TypeScript tests require the explicit extension.
import { normalizeInventoryCode, normalizeInventoryName } from "./normalize.ts";

export type DuplicateInventoryItem = {
  id: number;
  item_name: string | null;
  item_name_vi: string | null;
  code: string | null;
  part: string | null;
  category: string | null;
  category_vi: string | null;
  is_active: boolean | null;
};
export type DuplicateMatchedField = "item_name" | "item_name_vi";

export function matchDuplicateInventoryItem(
  candidates: readonly DuplicateInventoryItem[],
  next: { itemName: unknown; itemNameVi: unknown; code: unknown }
): { item: DuplicateInventoryItem; matchedFields: DuplicateMatchedField[] } | null {
  const itemName = normalizeInventoryName(next.itemName);
  const itemNameVi = normalizeInventoryName(next.itemNameVi);
  if (!itemName && !itemNameVi) return null;
  const code = normalizeInventoryCode(next.code);
  for (const item of candidates) {
    if (normalizeInventoryCode(item.code) !== code) continue;
    const matchedFields: DuplicateMatchedField[] = [];
    if (itemName && normalizeInventoryName(item.item_name) === itemName) matchedFields.push("item_name");
    if (itemNameVi && normalizeInventoryName(item.item_name_vi) === itemNameVi) matchedFields.push("item_name_vi");
    if (matchedFields.length) return { item, matchedFields };
  }
  return null;
}

// Alert text for a 409 duplicate: which name collided, and with which item (#id, both names, location).
export function duplicateInventoryItemMessage(params: {
  lang: "ko" | "vi";
  duplicateItem?: Pick<Partial<DuplicateInventoryItem>, "item_name" | "item_name_vi" | "is_active"> & { id: number } | null;
  matchedFields?: readonly DuplicateMatchedField[] | null;
  location: string;
}) {
  const { lang, duplicateItem, location } = params;
  const vi = lang === "vi";
  const fields = params.matchedFields?.length ? params.matchedFields : null;
  const fieldLabel = !fields ? (vi ? "tên mặt hàng" : "품목명")
    : fields.length === 2 ? (vi ? "tên tiếng Hàn và tên tiếng Việt" : "한국어명·베트남어명")
    : fields[0] === "item_name" ? (vi ? "tên tiếng Hàn" : "한국어명") : (vi ? "tên tiếng Việt" : "베트남어명");
  if (!duplicateItem) return vi ? "Sản phẩm này đã được đăng ký." : "해당 상품은 이미 등록되어 있습니다.";
  const names = [duplicateItem.item_name, duplicateItem.item_name_vi].map(name => String(name ?? "").trim()).filter(Boolean).join(" / ") || "-";
  const target = `#${duplicateItem.id} ${names}${location ? ` (${location})` : ""}`;
  if (duplicateItem.is_active === false) {
    return vi
      ? `Mặt hàng trùng ${fieldLabel} đã được đăng ký ở trạng thái không hoạt động.\n${target}\nVui lòng kiểm tra mặt hàng hiện có.`
      : `${fieldLabel}이 같은 품목이 비활성 상태로 등록되어 있습니다.\n${target}\n기존 품목을 확인해주세요.`;
  }
  return vi
    ? `Không thể lưu vì ${fieldLabel} trùng với mặt hàng khác.\n${target}\nVui lòng đặt tên khác hoặc dùng mặt hàng hiện có.`
    : `다른 품목과 ${fieldLabel}이 같아 저장할 수 없습니다.\n${target}\n이름을 구분해 입력하거나 기존 품목을 사용해주세요.`;
}
