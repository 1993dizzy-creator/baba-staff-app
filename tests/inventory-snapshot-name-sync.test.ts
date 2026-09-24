import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  INVENTORY_SNAPSHOT_NAME_SYNC_START_DATE,
  canRunInventorySnapshotNameSync,
  findInventoryLogNameSyncItems,
  isInventorySnapshotNameSyncEligible,
  planInventoryLogNameUpdates,
  type CurrentInventoryDailySyncRow,
  type InventoryDailySyncLogRow,
} from "../lib/inventory/snapshot-name-sync.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/inventory/snapshot/name-sync/route.ts");
const page = read("app/(protected)/inventory/snapshots/page.tsx");
const contract = read("lib/inventory/ledger-sync-contract.ts");

const log = (overrides: Partial<InventoryDailySyncLogRow> = {}): InventoryDailySyncLogRow => ({
  id: 101,
  item_id: 603,
  business_date: "2026-09-23",
  created_at: "2026-09-23T09:00:00Z",
  reason: "purchase",
  change_quantity: 1,
  prev_quantity: 0,
  new_quantity: 1,
  item_name: "지퍼백",
  item_name_vi: "Túi zip to",
  part: "kitchen",
  category: "소모품",
  category_vi: "Vật tư",
  code: "Z1",
  unit: "Kg",
  new_purchase_price: 75000,
  new_supplier: "Chợ",
  purchase_supplier_partner_id: 7,
  ...overrides,
});

const correction = (overrides: Partial<InventoryDailySyncLogRow> = {}) => log({
  id: 102,
  created_at: "2026-09-23T09:20:00Z",
  reason: "other",
  change_quantity: 0,
  prev_quantity: 1,
  new_quantity: 1,
  item_name: "대형 지퍼백",
  new_purchase_price: 80000,
  new_supplier: "Hà Giang",
  purchase_supplier_partner_id: 8,
  ...overrides,
});

const inventory = (overrides: Partial<CurrentInventoryDailySyncRow> = {}): CurrentInventoryDailySyncRow => ({
  id: 603,
  item_name: "대형 지퍼백",
  item_name_vi: "Túi zip to",
  part: "kitchen",
  category: "소모품",
  category_vi: "Vật tư",
  code: "Z1",
  unit: "Kg",
  purchase_price: 80000,
  supplier: "Hà Giang",
  supplier_partner_id: 8,
  quantity: 1,
  is_active: true,
  ...overrides,
});

const detect = (logs: InventoryDailySyncLogRow[], current = inventory()) =>
  findInventoryLogNameSyncItems("2026-09-23", logs, [current]);

test("the single cutoff constant protects every business date before 2026-09-23", () => {
  assert.equal(INVENTORY_SNAPSHOT_NAME_SYNC_START_DATE, "2026-09-23");
  assert.equal(isInventorySnapshotNameSyncEligible("2026-09-22"), false);
  assert.equal(isInventorySnapshotNameSyncEligible("2026-09-23"), true);
  assert.deepEqual(findInventoryLogNameSyncItems("2026-09-22", [log({ business_date: "2026-09-22" })], [inventory()]), []);
  assert.equal((route.match(/2026-09-23/g) || []).length, 0);
});

test("same-day actual purchase followed by a zero-quantity name correction is detected", () => {
  const items = detect([log({ item_name: "" }), correction()]);
  assert.equal(items.length, 1);
  assert.ok(items[0].issues.includes("missing_ko"));
  assert.deepEqual(items[0].logIds, [101]);
});

test("category and unit changes are detected from the linked correction", () => {
  const items = detect([
    log({ category: "옛 분류", category_vi: "Cu", unit: "Gói" }),
    correction({ category: "새 분류", new_category: "새 분류", category_vi: "Mới", new_category_vi: "Mới", unit: "Kg", new_unit: "Kg" }),
  ], inventory({ category: "새 분류", category_vi: "Mới", unit: "Kg" }));
  assert.ok(items[0].issues.includes("category_changed"));
  assert.ok(items[0].issues.includes("category_vi_changed"));
  assert.ok(items[0].issues.includes("unit_changed"));
});

test("75,000₫ / Chợ becomes one corrected 80,000₫ / Hà Giang purchase target", () => {
  const items = detect([log(), correction()]);
  assert.equal(items.length, 1);
  assert.equal(items[0].targets.length, 1);
  assert.equal(items[0].targets[0].purchaseLogId, 101);
  assert.deepEqual(
    items[0].changes.filter((change) => ["purchase_price", "supplier"].includes(change.field)),
    [
      { field: "purchase_price", from: 75000, to: 80000 },
      { field: "supplier", from: "Chợ", to: "Hà Giang" },
    ]
  );
  assert.ok(items[0].issues.includes("purchase_price_changed"));
  assert.ok(items[0].issues.includes("supplier_changed"));
});

test("a zero-quantity correction is never treated as a new purchase", () => {
  const items = detect([log(), correction()]);
  assert.deepEqual(items[0].logIds, [101]);
  assert.equal(items[0].targets[0].correctionLogId, 102);
});

test("two positive purchase logs remain independent without automatic merging", () => {
  assert.deepEqual(detect([
    log(),
    log({ id: 103, created_at: "2026-09-23T20:00:00Z", change_quantity: 2, new_quantity: 3, new_purchase_price: 80000, new_supplier: "Hà Giang" }),
  ]), []);
});

test("a correction is linked only to the nearest previous purchase before a later purchase", () => {
  const items = detect([
    log(),
    correction(),
    log({ id: 103, created_at: "2026-09-23T20:00:00Z", change_quantity: 2, new_quantity: 3, item_name: "대형 지퍼백", new_purchase_price: 90000, new_supplier: "New Shop", purchase_supplier_partner_id: 9 }),
  ], inventory({ purchase_price: 90000, supplier: "New Shop", supplier_partner_id: 9, quantity: 3 }));
  assert.deepEqual(items[0].logIds, [101]);
  assert.equal(items[0].targets[0].syncItem.purchase_price, 80000);
  assert.equal(items[0].targets[0].syncItem.supplier, "Hà Giang");
});

test("inactive items, other dates and days without an actual purchase are excluded", () => {
  assert.deepEqual(detect([log(), correction()], inventory({ is_active: false })), []);
  assert.deepEqual(detect([log({ business_date: "2026-09-24" }), correction({ business_date: "2026-09-24" })]), []);
  assert.deepEqual(detect([correction()]), []);
});

test("quantity discrepancies are review-only and never part of the sync payload", () => {
  const items = detect([log(), correction({ prev_quantity: 1, new_quantity: 2 })]);
  assert.equal(items[0].quantityReviewRequired, true);
  assert.ok(items[0].issues.includes("quantity_review_required"));
  assert.equal("quantity" in items[0].targets[0].syncItem, false);
  assert.equal("change_quantity" in items[0].targets[0].syncItem, false);
});

test("sync_item planning is scoped to the selected business date and item", () => {
  const plans = planInventoryLogNameUpdates("2026-09-23", [
    log(), correction(),
    log({ id: 201, item_id: 604 }), correction({ id: 202, item_id: 604 }),
    log({ id: 301, business_date: "2026-09-24" }),
  ], [inventory(), inventory({ id: 604 })], 603);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].itemId, 603);
  assert.equal(plans[0].businessDate, "2026-09-23");
  assert.deepEqual(plans[0].logIds, [101]);
});

test("part and code are included in shared display metadata but not Ledger economics", () => {
  assert.match(contract, /"part"[\s\S]*"code"/);
  assert.match(contract, /new_part: fields\.part/);
  assert.match(contract, /new_code: fields\.code/);
});

test("the API reuses shared log sync and existing Ledger projection with partial results", () => {
  assert.match(route, /syncInventoryLogRowsFromItem/);
  assert.match(route, /projectInventoryPurchaseLogs\(\[target\.purchaseLogId\], actorUserId\)/);
  assert.match(route, /status: "review_required"/);
  assert.match(route, /status: "failed"/);
  assert.match(route, /syncedCount:[\s\S]*reviewRequiredCount:[\s\S]*failedCount:/);
  assert.doesNotMatch(route, /\.from\("ledger/);
});

test("snapshot sync updates metadata/economics and recomputes total without changing quantities", () => {
  const block = route.slice(route.indexOf("async function syncSnapshotItem"), route.indexOf("async function runItemSync"));
  for (const field of ["item_name", "item_name_vi", "part", "category", "category_vi", "code", "unit", "purchase_price", "supplier", "total_purchase_price"]) {
    assert.match(block, new RegExp(`${field}:`));
  }
  assert.match(block, /quantity \* price/);
  assert.doesNotMatch(block, /\bquantity:\s/);
  assert.doesNotMatch(block, /prev_quantity:\s/);
  assert.doesNotMatch(block, /change_quantity:\s/);
});

test("snapshot absence is a successful no-op and pre-cutoff POST is rejected", () => {
  assert.match(route, /if \(batchId === null\) return 0/);
  const post = route.slice(route.indexOf("export async function POST"));
  assert.match(post, /inventory_snapshot_name_sync_before_start_date/);
  assert.match(post, /status: 400/);
});

test("only owner/master can POST while GET keeps authenticated snapshot access", () => {
  assert.equal(canRunInventorySnapshotNameSync("owner"), true);
  assert.equal(canRunInventorySnapshotNameSync("master"), true);
  for (const role of ["manager", "leader", "staff"]) assert.equal(canRunInventorySnapshotNameSync(role), false);
  assert.match(route, /inventory_snapshot_name_sync_forbidden/);
  assert.match(route, /status: 403/);
});

test("current view banner, focus refresh and post-sync movement reload remain wired", () => {
  assert.match(page, /당일 입고정보 동기화 필요/);
  assert.match(page, /Cần đồng bộ thông tin nhập hàng hôm nay/);
  assert.match(page, /const nameSyncBusinessDate = viewMode === "snapshot"[\s\S]*: activeBusinessDateKey/);
  assert.match(page, /window\.addEventListener\("focus", handleWindowFocus\)/);
  assert.match(page, /fetchMovementItems\(businessDate\),\s*fetchNameSyncIssues\(businessDate\)/);
  assert.match(page, /전체 동기화/);
  assert.match(page, /수량 변경은 별도 입고보정 필요/);
});
