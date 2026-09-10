import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node test runner supports TS extensions.
import { inventoryDisplayOverlay, inventoryLogDisplayUpdate, inventoryPurchaseLogCurrentItemSyncUpdate, ledgerSyncNotice } from "../lib/inventory/ledger-sync-contract.ts";

test("display-only helper never mutates purchase economics", () => {
  const log = { new_supplier: "Won Mart", new_purchase_price: 20000, change_quantity: 10 };
  const update = inventoryLogDisplayUpdate({ item_name: "Coca-Cola", item_name_vi: "Cola", category: "Soda", category_vi: "Nuoc", unit: "can", supplier: "OK FOOD", purchase_price: 18000 });
  assert.deepEqual({ ...log, ...update }, { ...log, item_name: "Coca-Cola", item_name_vi: "Cola", category: "Soda", category_vi: "Nuoc", new_category: "Soda", new_category_vi: "Nuoc", unit: "can", new_unit: "can" });
});

test("explicit current-item sync updates purchase log display and economics", () => {
  const log = {
    change_quantity: 3,
    new_purchase_price: 23333,
    new_supplier: "Old supplier",
    purchase_supplier_partner_id: 7,
  };
  const update = inventoryPurchaseLogCurrentItemSyncUpdate({
    item_name: "Set fern",
    item_name_vi: "Set la duong xi kho",
    category: "Decoration",
    category_vi: "Trang tri",
    unit: "Goi",
    purchase_price: 19000,
    supplier: "Shopee",
    supplier_partner_id: 42,
  });

  assert.deepEqual(
    { ...log, ...update },
    {
      change_quantity: 3,
      item_name: "Set fern",
      item_name_vi: "Set la duong xi kho",
      category: "Decoration",
      category_vi: "Trang tri",
      new_category: "Decoration",
      new_category_vi: "Trang tri",
      unit: "Goi",
      new_unit: "Goi",
      new_purchase_price: 19000,
      new_supplier: "Shopee",
      purchase_supplier_partner_id: 42,
    }
  );
  assert.equal(3 * Number(update.new_purchase_price), 57000);
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
