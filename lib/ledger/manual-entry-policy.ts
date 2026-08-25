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
  "보험·복리후생",
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

const MANUAL_EXPENSE_CATEGORY_DISPLAY: Record<string, { emoji: string; vi: string }> = {
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
  "보험·복리후생": { emoji: "🛡️", vi: "Bảo hiểm & phúc lợi" },
  "회계·세무": { emoji: "🧮", vi: "Kế toán & thuế" },
  "결제·은행 수수료": { emoji: "🏦", vi: "Phí thanh toán & ngân hàng" },
  "인테리어": { emoji: "🛠️", vi: "Nội thất" },
  "기타 비용": { emoji: "📦", vi: "Chi phí khác" },
};

export function manualExpenseCategoryLabel(name: string, lang: "ko" | "vi") {
  const display = MANUAL_EXPENSE_CATEGORY_DISPLAY[name];
  if (!display) return name;
  return `${display.emoji} ${lang === "vi" ? display.vi : name}`;
}
