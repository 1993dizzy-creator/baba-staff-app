export const MANUAL_EXPENSE_CATEGORY_NAMES = [
  "직원 식대",
  "전기료",
  "수도료",
  "가스비",
  "인터넷·통신비",
  "청소·위생비",
  "배송·운송비",
  "수리·유지보수",
  "설비·비품",
  "운영 소모품",
  "인쇄·홍보비",
  "직원 주거비",
  "세금",
  "보험",
  "복리후생",
  "회계·세무",
  "결제·은행 수수료",
  "인테리어",
  "기타 비용",
] as const;

const manualExpenseCategoryOrder = new Map<string, number>(
  MANUAL_EXPENSE_CATEGORY_NAMES.map((name, index) => [name, index])
);

export function isManualExpenseCategory(category: { kind: string; name: string }) {
  return category.kind === "expense" && manualExpenseCategoryOrder.has(category.name);
}

export function manualExpenseCategorySort(a: { name: string }, b: { name: string }) {
  return (manualExpenseCategoryOrder.get(a.name) ?? Number.MAX_SAFE_INTEGER)
    - (manualExpenseCategoryOrder.get(b.name) ?? Number.MAX_SAFE_INTEGER);
}

// Inventory edits use purchase categories and relevant operating costs, never
// automatic inventory subcategories or payroll/financial expense categories.
export const INVENTORY_MANUAL_CATEGORY_NAMES = [
  "식자재 매입", "주류 매입", "음료·BAR 재료", "소모품·잡화", "기타 재고매입",
  ...MANUAL_EXPENSE_CATEGORY_NAMES.filter((name) => [
    "가스비", "청소·위생비", "배송·운송비", "수리·유지보수", "설비·비품",
    "운영 소모품", "인쇄·홍보비", "인테리어", "기타 비용",
  ].includes(name)),
] as const;

export function isInventoryManualCategory(category: { kind: string; name: string }) {
  return category.kind === "expense" && INVENTORY_MANUAL_CATEGORY_NAMES.some((name) => name === category.name);
}

export function inventoryManualCategoryOptions<T extends { id: number; kind: string; name: string }>(
  categories: readonly T[],
  currentCategoryId: string | number | null,
) {
  const options = categories.filter(isInventoryManualCategory);
  const current = categories.find((category) => String(category.id) === String(currentCategoryId));
  // Preserve only this transaction's existing value, even when it is internal.
  return current && !options.some((category) => category.id === current.id)
    ? [current, ...options]
    : options;
}

export const MANUAL_INCOME_CATEGORY_NAMES = [
  "영업수입",
  "기타 수입",
  "예금이자",
] as const;

const manualIncomeCategoryOrder = new Map<string, number>(
  MANUAL_INCOME_CATEGORY_NAMES.map((name, index) => [name, index]),
);

export function isManualIncomeCategory(category: { kind: string; name: string }) {
  return category.kind === "income" && manualIncomeCategoryOrder.has(category.name);
}

export function manualIncomeCategorySort(a: { name: string }, b: { name: string }) {
  return (manualIncomeCategoryOrder.get(a.name) ?? Number.MAX_SAFE_INTEGER)
    - (manualIncomeCategoryOrder.get(b.name) ?? Number.MAX_SAFE_INTEGER);
}

export const MANUAL_ENTRY_PARTNER_GROUP_ORDER = [
  "alcohol",
  "food",
  "beverage",
  "consumable",
  "equipment",
  "service",
  "rent",
  "other",
] as const;

export type ManualEntryPartnerGroup = (typeof MANUAL_ENTRY_PARTNER_GROUP_ORDER)[number];

const MANUAL_ENTRY_PARTNER_GROUP_LABELS: Record<ManualEntryPartnerGroup, { ko: string; vi: string }> = {
  alcohol: { ko: "주류", vi: "Rượu" },
  food: { ko: "식자재", vi: "Thực phẩm" },
  beverage: { ko: "음료", vi: "Đồ uống" },
  consumable: { ko: "소모품", vi: "Vật tư tiêu hao" },
  equipment: { ko: "장비", vi: "Thiết bị" },
  service: { ko: "서비스", vi: "Dịch vụ" },
  rent: { ko: "임대", vi: "Cho thuê" },
  other: { ko: "기타", vi: "Khác" },
};

function manualEntryPartnerGroup(partnerType: string | null | undefined): ManualEntryPartnerGroup {
  const normalized = partnerType?.trim().toLowerCase();
  return MANUAL_ENTRY_PARTNER_GROUP_ORDER.includes(normalized as ManualEntryPartnerGroup)
    ? normalized as ManualEntryPartnerGroup
    : "other";
}

export function partnerTypeDisplayLabel(
  partnerType: string | null | undefined,
  lang: "ko" | "vi",
) {
  return MANUAL_ENTRY_PARTNER_GROUP_LABELS[manualEntryPartnerGroup(partnerType)][lang];
}

export function groupManualEntryPartners<T extends { name: string; partnerType: string | null; isActive: boolean }>(
  partners: readonly T[],
  lang: "ko" | "vi",
) {
  return MANUAL_ENTRY_PARTNER_GROUP_ORDER.flatMap((group) => {
    const grouped = partners
      .filter((partner) => partner.isActive && manualEntryPartnerGroup(partner.partnerType) === group)
      .sort((a, b) => a.name.localeCompare(b.name, lang === "vi" ? "vi" : "ko", { sensitivity: "base" }));
    return grouped.length === 0 ? [] : [{
      group,
      label: MANUAL_ENTRY_PARTNER_GROUP_LABELS[group][lang],
      partners: grouped,
    }];
  });
}

export type ManualExpensePartnerType =
  | "food"
  | "alcohol"
  | "beverage"
  | "consumable"
  | "equipment"
  | "rent"
  | "service"
  | "other";

const PARTNER_TYPE_CATEGORY: Partial<Record<ManualExpensePartnerType, string>> = {
  food: "식자재 매입",
  alcohol: "주류 매입",
  beverage: "음료·BAR 재료",
  consumable: "소모품·잡화",
  equipment: "설비·비품",
  rent: "임대료",
};

const SERVICE_SUBTYPE_CATEGORY: Record<string, string> = {
  maintenance: "수리·유지보수",
  delivery: "배송·운송비",
  professional_service: "기타 비용",
  service_other: "기타 비용",
};

const OTHER_SUBTYPE_CATEGORY: Record<string, string> = {
  gas: "가스비",
  printing: "인쇄·홍보비",
  market_purchase: "기타 비용",
  miscellaneous: "기타 비용",
  other_misc: "기타 비용",
};

export function manualExpenseCategoryNameForPartner(
  partnerType: string | null | undefined,
  partnerSubtypeCode: string | null | undefined,
) {
  if (!partnerType) return null;
  const normalizedType = partnerType.trim().toLowerCase() as ManualExpensePartnerType;
  const direct = PARTNER_TYPE_CATEGORY[normalizedType];
  if (direct) return direct;
  const subtype = partnerSubtypeCode?.trim().toLowerCase() ?? "";
  if (normalizedType === "service") return SERVICE_SUBTYPE_CATEGORY[subtype] ?? "기타 비용";
  if (normalizedType === "other") return OTHER_SUBTYPE_CATEGORY[subtype] ?? "기타 비용";
  return null;
}

const MANUAL_EXPENSE_CATEGORY_DISPLAY: Record<string, { emoji: string; vi: string }> = {
  "식자재 매입": { emoji: "🥬", vi: "Mua nguyên liệu thực phẩm" },
  "주류 매입": { emoji: "🍷", vi: "Mua đồ uống có cồn" },
  "음료·BAR 재료": { emoji: "🥤", vi: "Đồ uống & nguyên liệu BAR" },
  "소모품·잡화": { emoji: "🧻", vi: "Vật tư tiêu hao & tạp hóa" },
  "임대료": { emoji: "🏢", vi: "Tiền thuê" },
  "직원 식대": { emoji: "🍱", vi: "Chi phí ăn uống nhân viên" },
  "전기료": { emoji: "⚡", vi: "Tiền điện" },
  "수도료": { emoji: "💧", vi: "Tiền nước" },
  "가스비": { emoji: "🔥", vi: "Tiền gas" },
  "인터넷·통신비": { emoji: "📡", vi: "Internet & viễn thông" },
  "청소·위생비": { emoji: "🧹", vi: "Vệ sinh & làm sạch" },
  "배송·운송비": { emoji: "🚚", vi: "Giao hàng & vận chuyển" },
  "수리·유지보수": { emoji: "🔧", vi: "Sửa chữa & bảo trì" },
  "설비·비품": { emoji: "🪑", vi: "Thiết bị & vật dụng" },
  "운영 소모품": { emoji: "🧴", vi: "Vật tư tiêu hao vận hành" },
  "인쇄·홍보비": { emoji: "🖨️", vi: "In ấn & quảng bá" },
  "직원 주거비": { emoji: "🏠", vi: "Chi phí nhà ở nhân viên" },
  "세금": { emoji: "🧾", vi: "Thuế" },
  "보험": { emoji: "🛡️", vi: "Bảo hiểm" },
  "복리후생": { emoji: "🎉", vi: "Phúc lợi nhân viên" },
  "회계·세무": { emoji: "🧮", vi: "Kế toán & thuế" },
  "결제·은행 수수료": { emoji: "🏦", vi: "Phí thanh toán & ngân hàng" },
  "인테리어": { emoji: "🛠️", vi: "Nội thất" },
  "기타 비용": { emoji: "📦", vi: "Chi phí khác" },
};

export function manualExpenseCategoryEmoji(name: string) {
  return MANUAL_EXPENSE_CATEGORY_DISPLAY[name]?.emoji ?? null;
}

export function manualExpenseCategoryLabel(name: string, lang: "ko" | "vi") {
  const display = MANUAL_EXPENSE_CATEGORY_DISPLAY[name];
  if (!display) return name;
  return `${display.emoji} ${lang === "vi" ? display.vi : name}`;
}

// Special manual actions appear in the expense category selector but are NOT
// ledger_categories rows and never go through the generic manual expense POST.
// A payroll advance is a salary prepayment (payroll_payment + payroll advance
// adjustment), not a new P&L expense.
export const PAYROLL_ADVANCE_MANUAL_ACTION = "__payroll_advance__";

export const MANUAL_EXPENSE_SPECIAL_ACTIONS = [
  { value: PAYROLL_ADVANCE_MANUAL_ACTION, emoji: "👥", ko: "가불", vi: "Ứng lương" },
] as const;

export function isPayrollAdvanceManualAction(value: unknown) {
  return value === PAYROLL_ADVANCE_MANUAL_ACTION;
}

export function manualExpenseSpecialActionLabel(action: (typeof MANUAL_EXPENSE_SPECIAL_ACTIONS)[number], lang: "ko" | "vi") {
  return `${action.emoji} ${lang === "vi" ? action.vi : action.ko}`;
}

export function payrollAdvanceDefaultMemo(employeeName: string) {
  return `${employeeName.trim()} 급여 가불`;
}
