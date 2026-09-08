import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node test runner supports TS extensions.
import { inventoryDisplayOverlay, inventoryLogDisplayUpdate, ledgerSyncNotice } from "../lib/inventory/ledger-sync-contract.ts";

test("daily sync copies display metadata but never historical purchase economics", () => {
  const log = { new_supplier: "Won Mart", new_purchase_price: 20000, change_quantity: 10 };
  const update = inventoryLogDisplayUpdate({ item_name: "Coca-Cola", item_name_vi: "Cola", category: "Soda", category_vi: "Nuoc", unit: "can", supplier: "OK FOOD", purchase_price: 18000 });
  assert.deepEqual({ ...log, ...update }, { ...log, item_name: "Coca-Cola", item_name_vi: "Cola", category: "Soda", category_vi: "Nuoc", new_category: "Soda", new_category_vi: "Nuoc", unit: "can", new_unit: "can" });
});

test("display overlay cannot replace purchase economics even when drift includes them", () => {
  const original = { item_name: "Coca", purchase_price: 20000, supplier: "Won Mart", category_id: 8, purchase_amount: 200000 };
  const result = inventoryDisplayOverlay(original, { item_name: "Coca-Cola", item_name_vi: "Cola", category: "Soda", unit: "can", purchase_price: 18000, supplier: "OK FOOD", category_id: 99, purchase_amount: 90000 });
  assert.equal(result.item_name, "Coca-Cola");
  assert.equal(result.purchase_price, 20000);
  assert.equal(result.purchase_amount, 200000);
  assert.equal(result.category_id, 8);
  assert.equal(result.supplier, "Won Mart");
  assert.equal(original.item_name, "Coca");
});

test("post-commit failures and pending review are visible without claiming Inventory failed", () => {
  for (const status of ["pending", "review_required", "failed"] as const) {
    assert.match(ledgerSyncNotice({ status, code: "MONTH_CLOSED" }, false)!, /재고.*저장/);
  }
  assert.equal(ledgerSyncNotice({ status: "synced" }, false), null);
});
