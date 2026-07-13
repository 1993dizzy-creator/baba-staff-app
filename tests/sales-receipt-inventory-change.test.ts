import assert from "node:assert/strict";
import test from "node:test";
import {
  hasInventoryAffectingSalesLineChanged,
  type InventoryAffectingSalesLine,
} from "../lib/pos/cukcuk/sales-receipt-inventory-change";

const line: InventoryAffectingSalesLine = {
  refDetailId: "line-1",
  parentRefDetailId: null,
  itemId: "product-1",
  itemCode: "P1",
  quantity: 1,
  refDetailType: 1,
  inventoryItemType: 1,
  isOption: false,
  isExcluded: false,
  isCanceled: false,
};

test("identical repeated POS data is not an inventory change", () => {
  assert.equal(hasInventoryAffectingSalesLineChanged(line, { ...line }), false);
});

test("numeric formatting alone is not an inventory change", () => {
  assert.equal(
    hasInventoryAffectingSalesLineChanged(line, { ...line, quantity: "1.0" }),
    false
  );
});

test("quantity, option relation and cancellation are inventory changes", () => {
  assert.equal(
    hasInventoryAffectingSalesLineChanged(line, { ...line, quantity: 2 }),
    true
  );
  assert.equal(
    hasInventoryAffectingSalesLineChanged(line, {
      ...line,
      isOption: true,
      parentRefDetailId: "parent-1",
    }),
    true
  );
  assert.equal(
    hasInventoryAffectingSalesLineChanged(line, { ...line, isCanceled: true }),
    true
  );
});
