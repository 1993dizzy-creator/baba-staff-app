import assert from "node:assert/strict";
import test from "node:test";
import {
  MANUAL_EXPENSE_CATEGORY_NAMES,
  manualExpenseCategoryLabel,
  manualExpenseCategoryNameForPartner,
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
