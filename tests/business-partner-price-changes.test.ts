import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { buildPartnerPriceChanges } from "../lib/partners/price-changes.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const server = read("lib/partners/server.ts");
const route = read("app/api/admin/partners/[id]/route.ts");

const items = [
  { id: 1, itemName: "Blanc keg", itemNameVi: "Bia Blanc keg" },
  { id: 2, itemName: "Carlsberg", itemNameVi: null },
];
const logs = [
  { id: 5, item_id: 1, new_purchase_price: 1420000, business_date: "2026-08-20", created_at: "2026-08-20T10:00:00Z" },
  { id: 1, item_id: 1, new_purchase_price: 1350000, business_date: "2026-08-01", created_at: "2026-08-01T10:00:00Z" },
  { id: 2, item_id: 1, new_purchase_price: 1350000, business_date: "2026-08-05", created_at: "2026-08-05T10:00:00Z" },
  { id: 4, item_id: 2, new_purchase_price: 900000, business_date: "2026-08-18", created_at: "2026-08-18T10:00:00Z" },
  { id: 3, item_id: 2, new_purchase_price: 1000000, business_date: "2026-08-03", created_at: "2026-08-03T10:00:00Z" },
];

test("purchase prices are compared per linked item, unchanged purchases excluded, newest changes first", () => {
  const changes = buildPartnerPriceChanges(logs, items);
  assert.deepEqual(changes.map(change => change.id), ["1-5", "2-4"]);
  assert.deepEqual(changes[0], {
    id: "1-5", itemId: 1, itemName: "Blanc keg", itemNameVi: "Bia Blanc keg",
    previousPrice: 1350000, newPrice: 1420000, difference: 70000,
    percentage: 70000 / 1350000 * 100, businessDate: "2026-08-20",
  });
  assert.equal(changes[1].difference, -100000);
});

test("unknown/unlinked items are ignored and result is limited", () => {
  const manyLogs = [
    { id: 1, item_id: 1, new_purchase_price: 100, business_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
    ...Array.from({ length: 25 }, (_, index) => ({ id: index + 2, item_id: 1, new_purchase_price: 101 + index, business_date: `2026-02-${String(index + 1).padStart(2, "0")}`, created_at: `2026-02-${String(index + 1).padStart(2, "0")}T00:00:00Z` })),
    { id: 99, item_id: 999, new_purchase_price: 500, business_date: "2026-03-01", created_at: "2026-03-01T00:00:00Z" },
  ];
  assert.equal(buildPartnerPriceChanges(manyLogs, items).length, 20);
  assert.equal(buildPartnerPriceChanges(manyLogs, items).some(change => change.itemId === 999), false);
});

test("detail API uses one bounded purchase-history query for all linked items", () => {
  assert.match(server, /from\("inventory_logs"\)[\s\S]*\.in\("item_id", linkedInventory\.map\(item => item\.id\)\)[\s\S]*\.eq\("reason", "purchase"\)[\s\S]*\.gt\("change_quantity", 0\)[\s\S]*\.limit\(200\)/);
  assert.match(server, /buildPartnerPriceChanges\(data \?\? \[\], linkedInventory, 20\)/);
  assert.match(route, /loadLinkedPartnerInventoryDetail\(id\)/);
  assert.match(route, /\.\.\.inventoryDetail/);
});
