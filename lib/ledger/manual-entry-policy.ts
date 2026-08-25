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
