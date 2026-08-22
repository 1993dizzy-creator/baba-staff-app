// @ts-expect-error Node's type-stripping test runner needs the explicit extension.
import { CATEGORY_OPTIONS_BY_PART, resolveInventoryCategoryOption } from "./categories.ts";

export const INVENTORY_CATEGORY_GROUPS = {
  alcohol: { key: "alcohol", ko: "주류", vi: "Đồ uống có cồn" },
  beverage: { key: "beverage", ko: "음료", vi: "Đồ uống" },
  food: { key: "food", ko: "식자재", vi: "Thực phẩm" },
  supplies: { key: "supplies", ko: "소모품", vi: "Vật tư tiêu hao" },
  other: { key: "other", ko: "기타", vi: "Khác" },
} as const;

export type InventoryCategoryGroupKey = keyof typeof INVENTORY_CATEGORY_GROUPS;
export type InventoryCategoryGroup = (typeof INVENTORY_CATEGORY_GROUPS)[InventoryCategoryGroupKey];

export const INVENTORY_CATEGORY_GROUP_ORDER: readonly InventoryCategoryGroupKey[] = [
  "alcohol",
  "beverage",
  "food",
  "supplies",
  "other",
];

const CATEGORY_GROUP_BY_CANONICAL_OPTION: Record<string, InventoryCategoryGroupKey> = {
  "kitchen:채소": "food",
  "kitchen:허브": "food",
  "kitchen:과일": "food",
  "kitchen:버섯": "food",
  "kitchen:육류": "food",
  "kitchen:해산물": "food",
  "kitchen:가공식품": "food",
  "kitchen:건어물": "food",
  "kitchen:유제품": "food",
  "kitchen:치즈": "food",
  "kitchen:소스": "food",
  "kitchen:조미료": "food",
  "kitchen:면류": "food",
  "kitchen:튀김류": "food",
  "kitchen:스낵": "food",
  "kitchen:견과류": "food",
  "kitchen:기름": "food",
  "kitchen:절임": "food",
  "kitchen:식자재": "food",
  "kitchen:기타": "other",
  "bar:위스키": "alcohol",
  "bar:진": "alcohol",
  "bar:럼": "alcohol",
  "bar:보드카": "alcohol",
  "bar:데킬라": "alcohol",
  "bar:와인": "alcohol",
  "bar:코냑": "alcohol",
  "bar:리큐르": "alcohol",
  "bar:시럽": "beverage",
  "bar:음료": "beverage",
  "bar:비터": "alcohol",
  "bar:베르무트": "alcohol",
  "bar:기타": "other",
  "hall:맥주": "alcohol",
  "hall:생맥주": "alcohol",
  "hall:병맥주": "alcohol",
  "hall:수제맥주": "alcohol",
  "hall:소주": "alcohol",
  "hall:음료": "beverage",
  "hall:기타": "other",
  "etc:기타": "other",
};

function normalizePart(part?: string | null) {
  return (part ?? "").trim().toLocaleLowerCase();
}

export function getInventoryCategoryGroup(
  part?: string | null,
  category?: string | null,
  categoryVi?: string | null,
): InventoryCategoryGroup {
  const option = resolveInventoryCategoryOption(part, category, categoryVi);
  if (!option) return INVENTORY_CATEGORY_GROUPS.other;
  const key = CATEGORY_GROUP_BY_CANONICAL_OPTION[`${normalizePart(part)}:${option.ko}`] ?? "other";
  return INVENTORY_CATEGORY_GROUPS[key];
}

export function getDominantInventoryCategoryGroup(
  items: ReadonlyArray<{ part?: string | null; category?: string | null; categoryVi?: string | null }>,
): InventoryCategoryGroup | null {
  if (items.length === 0) return null;
  const counts = new Map<InventoryCategoryGroupKey, number>();
  for (const item of items) {
    const key = getInventoryCategoryGroup(item.part, item.category, item.categoryVi).key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let dominant = INVENTORY_CATEGORY_GROUP_ORDER[0];
  let highest = -1;
  for (const key of INVENTORY_CATEGORY_GROUP_ORDER) {
    const count = counts.get(key) ?? 0;
    if (count > highest) {
      dominant = key;
      highest = count;
    }
  }
  return INVENTORY_CATEGORY_GROUPS[dominant];
}

export function listUnmappedDefaultInventoryCategories() {
  return Object.entries(CATEGORY_OPTIONS_BY_PART).flatMap(([part, options]) =>
    options
      .filter(option => !CATEGORY_GROUP_BY_CANONICAL_OPTION[`${part}:${option.ko}`])
      .map(option => `${part}:${option.ko}`),
  );
}

export function formatInventoryItemCount(total: number, active: number, lang: "ko" | "vi") {
  const inactive = Math.max(0, total - active);
  if (lang === "vi") return inactive > 0 ? `${total} mặt hàng · ngừng ${inactive}` : `${total} mặt hàng`;
  return inactive > 0 ? `품목 ${total} · 비활성 ${inactive}` : `품목 ${total}`;
}
