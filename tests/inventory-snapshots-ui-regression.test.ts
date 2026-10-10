import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node strip-types uses explicit TypeScript extensions.
import { projectDailyEffectivePurchases } from "../lib/inventory/daily-effective-purchases.ts";
// @ts-expect-error Node strip-types uses explicit TypeScript extensions.
import { findInventoryLanguageMissingItems } from "../lib/inventory/language-missing.ts";
const root = { id: 12407, item_id: 613, reason: "purchase", change_quantity: 2, correction_of_inventory_log_id: null, new_purchase_price: 30000, is_active: false };
test("linked cancellation on a later date removes #12407 without touching audit facts", () => {
 const correction = { id: 12883, reason: "purchase", change_quantity: -2, correction_of_inventory_log_id: 12407, business_date: "2026-10-10" };
 const before = JSON.stringify([root, correction]);
 assert.deepEqual(projectDailyEffectivePurchases([root], [correction]), []);
 assert.equal(JSON.stringify([root, correction]), before);
});
test("inactive historical purchase stays visible and unlinked negative receipt does not cancel it", () => {
 assert.deepEqual(projectDailyEffectivePurchases([root], []), [root]);
 const other = { ...root, id: 12883, change_quantity: -2 };
 assert.equal(projectDailyEffectivePurchases([root, other], []).length, 2);
});
test("partial cancellation uses latest economic metadata without multiplying roots", () => {
 const correction = { ...root, id: 12883, change_quantity: -1, correction_of_inventory_log_id: 12407, new_purchase_price: 35000, new_supplier: "Supplier B" };
 const result = projectDailyEffectivePurchases([root, correction], [correction]);
 assert.equal(result.length, 1); assert.equal(result[0].change_quantity, 1); assert.equal(result[0].new_purchase_price, 35000);
 assert.equal(root.new_purchase_price, 30000);
});
test("language warnings carry registration time and disappear once both languages are set", () => {
 const item = { id: 1, item_name: "Oil", item_name_vi: "", is_active: true, created_at: "2026-10-03T03:00:00Z" };
 assert.equal(findInventoryLanguageMissingItems([item])[0].registeredAt, item.created_at);
 assert.deepEqual(findInventoryLanguageMissingItems([{ ...item, item_name_vi: "Dau" }]), []);
});
