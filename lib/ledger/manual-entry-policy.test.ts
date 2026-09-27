import assert from "node:assert/strict";
import test from "node:test";
import {
  groupManualEntryPartners,
  MANUAL_EXPENSE_CATEGORY_NAMES,
  MANUAL_INCOME_CATEGORY_NAMES,
  isManualIncomeCategory,
  manualExpenseCategoryLabel,
  manualExpenseCategoryNameForPartner,
  manualIncomeCategorySort,
  partnerTypeDisplayLabel,
} from "./manual-entry-policy.ts";

test("partner type and subtype resolve to the authoritative manual expense category", () => {
  const cases: Array<[string, string | null, string]> = [
    ["food", null, "식자재 매입"],
    ["alcohol", null, "주류 매입"],
    ["beverage", null, "음료·BAR 재료"],
    ["consumable", null, "소모품·잡화"],
    ["equipment", null, "설비·비품"],
    ["service", "maintenance", "수리·유지보수"],
    ["service", "delivery", "배송·운송비"],
    ["other", "gas", "가스비"],
    ["other", "printing", "인쇄·홍보비"],
    ["other", null, "기타 비용"],
  ];
  for (const [type, subtype, expected] of cases) {
    assert.equal(manualExpenseCategoryNameForPartner(type, subtype), expected);
  }
  assert.equal(manualExpenseCategoryNameForPartner("service", "professional_service"), "기타 비용");
  assert.equal(manualExpenseCategoryNameForPartner("other", "market_purchase"), "기타 비용");
  assert.equal(manualExpenseCategoryNameForPartner("unknown", null), null);
});

test("partner-only category labels do not expand the no-partner dropdown policy", () => {
  for (const name of ["식자재 매입", "주류 매입", "음료·BAR 재료", "소모품·잡화", "임대료"]) {
    assert.equal(MANUAL_EXPENSE_CATEGORY_NAMES.includes(name as never), false);
    assert.notEqual(manualExpenseCategoryLabel(name, "vi"), name);
  }
});

test("manual entry partners use fixed group order, sorted names, inactive filtering, and other fallback", () => {
  const partners = [
    { id: 1, name: "Zulu", partnerType: "alcohol", isActive: true },
    { id: 2, name: "Alpha", partnerType: "alcohol", isActive: true },
    { id: 3, name: "Food", partnerType: "food", isActive: true },
    { id: 4, name: "Drink", partnerType: "beverage", isActive: true },
    { id: 5, name: "Supply", partnerType: "consumable", isActive: true },
    { id: 6, name: "Gear", partnerType: "equipment", isActive: true },
    { id: 7, name: "Repair", partnerType: "service", isActive: true },
    { id: 8, name: "Rent", partnerType: "rent", isActive: true },
    { id: 9, name: "Unknown", partnerType: "unexpected", isActive: true },
    { id: 10, name: "Other", partnerType: "other", isActive: true },
    { id: 11, name: "Inactive", partnerType: "food", isActive: false },
  ];
  const groups = groupManualEntryPartners(partners, "ko");
  assert.deepEqual(groups.map((group) => group.group), [
    "alcohol", "food", "beverage", "consumable", "equipment", "service", "rent", "other",
  ]);
  assert.deepEqual(groups[0].partners.map((partner) => partner.name), ["Alpha", "Zulu"]);
  assert.deepEqual(groups.at(-1)?.partners.map((partner) => partner.name), ["Other", "Unknown"]);
  assert.equal(groups.some((group) => group.partners.some((partner) => partner.name === "Inactive")), false);
  assert.equal(partnerTypeDisplayLabel("alcohol", "ko"), "주류");
  assert.equal(partnerTypeDisplayLabel("alcohol", "vi"), "Rượu");
  assert.equal(partnerTypeDisplayLabel("unknown", "ko"), "기타");
  assert.equal(partnerTypeDisplayLabel(null, "vi"), "Khác");
});

test("manual income categories expose only the fixed non-POS order", () => {
  const categories = [
    { kind: "income", name: "POS 매출" },
    { kind: "income", name: "예금이자" },
    { kind: "income", name: "기타 수입" },
    { kind: "income", name: "영업수입" },
    { kind: "income", name: "임의 수입" },
    { kind: "expense", name: "기타 수입" },
  ];
  assert.deepEqual(MANUAL_INCOME_CATEGORY_NAMES, ["영업수입", "기타 수입", "예금이자"]);
  assert.deepEqual(
    categories.filter(isManualIncomeCategory).sort(manualIncomeCategorySort).map((category) => category.name),
    ["영업수입", "기타 수입", "예금이자"],
  );
});
