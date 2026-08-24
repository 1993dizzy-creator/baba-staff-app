import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { buildPartnerPriceChanges } from "../lib/partners/price-changes.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const server = read("lib/partners/server.ts");
const route = read("app/api/admin/partners/[id]/route.ts");
const priceChangesRoute = read("app/api/admin/partners/[id]/price-changes/route.ts");
const detailPage = read("app/(protected)/admin/partners/[id]/page.tsx");

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

test("same, rising, and falling purchase prices produce the expected changes", () => {
  const history = [100, 100, 100, 120, 90].map((price, index) => ({
    id: index + 1, item_id: 1, new_purchase_price: price,
    business_date: `2026-01-0${index + 1}`, created_at: `2026-01-0${index + 1}T00:00:00Z`,
  }));
  const changes = buildPartnerPriceChanges(history, items);
  assert.deepEqual(changes.map(change => [change.difference, change.percentage]), [[-30, 25], [20, 20]]);
});

test("business date, created time, and id deterministically order interleaved item histories", () => {
  const history = [
    { id: 3, item_id: 1, new_purchase_price: 130, business_date: "2026-01-01", created_at: "2026-01-01T01:00:00Z" },
    { id: 2, item_id: 1, new_purchase_price: 120, business_date: "2026-01-01", created_at: "2026-01-01T01:00:00Z" },
    { id: 1, item_id: 1, new_purchase_price: 100, business_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
    { id: 4, item_id: 2, new_purchase_price: 200, business_date: "2026-01-01", created_at: "2026-01-01T00:30:00Z" },
    { id: 5, item_id: 2, new_purchase_price: 180, business_date: "2026-01-02", created_at: "2026-01-02T00:00:00Z" },
  ];
  assert.deepEqual(buildPartnerPriceChanges(history, items).map(change => change.id), ["2-5", "1-3", "1-2"]);
});

test("Ok Mart pattern keeps all changes across 80 items and 343 mostly unchanged purchases", () => {
  const manyItems = Array.from({ length: 80 }, (_, index) => ({ id: index + 1, itemName: `Item ${index + 1}`, itemNameVi: null }));
  const baselines = manyItems.map(item => ({
    id: item.id, item_id: item.id, new_purchase_price: 100,
    business_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z",
  }));
  const actualChanges = manyItems.slice(0, 18).map((item, index) => ({
    id: 81 + index, item_id: item.id, new_purchase_price: 120,
    business_date: "2026-01-02", created_at: `2026-01-02T00:00:${String(index).padStart(2, "0")}Z`,
  }));
  const unchangedRepeats = Array.from({ length: 245 }, (_, index) => {
    const itemId = (index % 80) + 1;
    return {
      id: 99 + index, item_id: itemId, new_purchase_price: itemId <= 18 ? 120 : 100,
      business_date: "2026-02-01", created_at: `2026-02-01T00:${String(index % 60).padStart(2, "0")}:${String(Math.floor(index / 60)).padStart(2, "0")}Z`,
    };
  });
  const history = [...baselines, ...actualChanges, ...unchangedRepeats];
  assert.equal(history.length, 343);
  assert.equal(buildPartnerPriceChanges(history, manyItems).length, 18);
  assert.equal(buildPartnerPriceChanges(history.slice(-200), manyItems).length < 18, true);
});

test("price history is paged to completion before the exact newest 20 changes are calculated", () => {
  assert.match(server, /for \(let page = 0; page < PRICE_HISTORY_MAX_PAGES; page \+= 1\)/);
  assert.match(server, /\.range\(from, from \+ PRICE_HISTORY_PAGE_SIZE - 1\)/);
  assert.match(server, /if \(\(data\?\.length \?\? 0\) < PRICE_HISTORY_PAGE_SIZE\)[\s\S]*buildPartnerPriceChanges\(logs, linkedInventory, 20\)/);
  assert.doesNotMatch(server, /\.limit\(200\)/);
});

test("price changes are lazy-loaded through a separate endpoint and cached for the page session", () => {
  assert.doesNotMatch(route, /priceChanges|inventory_logs|loadLinkedPartnerPriceChanges/);
  assert.match(route, /loadLinkedPartnerInventory\(id\)/);
  assert.match(priceChangesRoute, /loadLinkedPartnerPriceChanges\(id\)/);
  assert.match(detailPage, /fetch\(`\/api\/admin\/partners\/\$\{params\.id\}\/price-changes`/);
  assert.match(detailPage, /priceChangesStatus === "loading" \|\| priceChangesStatus === "loaded"/);
  assert.match(detailPage, /priceChangesStatus === "error"[\s\S]*role="alert"/);
  const initialLoad = detailPage.slice(detailPage.indexOf("const load = useCallback"), detailPage.indexOf("async function openPriceChanges"));
  assert.doesNotMatch(initialLoad, /priceChanges|inventory_logs/);
});

test("detail loader scopes partner, mapping, and inventory queries to one partner", () => {
  assert.match(route, /loadPartnerDetailData\(id\)/);
  assert.match(server, /business_partner_ledger_parties"\)[\s\S]*\.eq\("business_partner_id", partnerId\)\.maybeSingle\(\)/);
  assert.match(server, /inventory"\)[\s\S]*\.eq\("supplier_partner_id", partnerId\)/);
});
