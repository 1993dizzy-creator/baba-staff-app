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
import {
  findInventoryLanguageMissingItems,
  type InventoryLanguageRow,
} from "../lib/inventory/language-missing.ts";

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

const languageInventory = (overrides: Partial<InventoryLanguageRow> = {}): InventoryLanguageRow => ({
  id: 604,
  item_name: "설거지 행주",
  item_name_vi: "Khăn lau bát",
  is_active: true,
  ...overrides,
});

test("active inventory language gaps are detected independently from daily logs", () => {
  const items = findInventoryLanguageMissingItems([
    languageInventory({ id: 1, item_name: null }),
    languageInventory({ id: 2, item_name_vi: "" }),
    languageInventory({ id: 3 }),
    languageInventory({ id: 4, item_name: "   ", item_name_vi: "\t" }),
    languageInventory({ id: 5, item_name: null, is_active: false }),
  ]);

  assert.deepEqual(items.map((item) => ({ itemId: item.itemId, missing: item.missingLanguages })), [
    { itemId: 1, missing: ["ko"] },
    { itemId: 2, missing: ["vi"] },
    { itemId: 4, missing: ["ko", "vi"] },
  ]);
});

test("language gaps remain detectable without today's purchase and after the snapshot date changes", () => {
  const oldPurchaseOnlyItem = languageInventory({ item_name: "", item_name_vi: "Khăn lau bát" });
  const firstSelection = findInventoryLanguageMissingItems([oldPurchaseOnlyItem]);
  const secondSelection = findInventoryLanguageMissingItems([oldPurchaseOnlyItem]);

  assert.deepEqual(firstSelection, secondSelection);
  assert.deepEqual(firstSelection[0].missingLanguages, ["ko"]);
});

test("filling a missing master name removes the language alert and preserves daily empty-to-name sync", () => {
  const beforeEdit = languageInventory({ item_name: "", item_name_vi: "Khăn lau bát" });
  const afterEdit = languageInventory({ item_name: "설거지 행주", item_name_vi: "Khăn lau bát" });

  assert.equal(findInventoryLanguageMissingItems([beforeEdit]).length, 1);
  assert.equal(findInventoryLanguageMissingItems([afterEdit]).length, 0);

  const dailyItems = findInventoryLogNameSyncItems("2026-09-23", [
    log({ item_id: 604, item_name: "", item_name_vi: "Khăn lau bát" }),
    correction({ item_id: 604, item_name: "설거지 행주", item_name_vi: "Khăn lau bát" }),
  ], [inventory({ id: 604, item_name: "설거지 행주", item_name_vi: "Khăn lau bát" })]);
  assert.equal(dailyItems.length, 1);
  assert.ok(dailyItems[0].issues.includes("missing_ko"));
  assert.deepEqual(dailyItems[0].changes.find((change) => change.field === "item_name"), {
    field: "item_name",
    from: "",
    to: "설거지 행주",
  });
});

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

test("GET separates all-active language gaps from business-date daily sync items", () => {
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.match(route, /loadActiveInventoryLanguageRows[\s\S]*\.eq\("is_active", true\)/);
  assert.match(get, /languageMissingItems: findInventoryLanguageMissingItems/);
  assert.match(get, /dailySyncItems: findInventoryLogNameSyncItems/);
  assert.doesNotMatch(
    route.slice(route.indexOf("async function loadActiveInventoryLanguageRows"), route.indexOf("async function loadOptionalSnapshotBatchId")),
    /businessDate|business_date/
  );
});

test("language alert is separate, hidden at zero, labels gaps, falls back by UI language and opens existing edit route", () => {
  assert.match(page, /\{languageMissingItems\.length > 0 && \(/);
  assert.match(page, /data-testid="inventory-language-missing-banner"/);
  assert.match(page, /한글명 미설정/);
  assert.match(page, /베트남어명 미설정/);
  assert.match(page, /currentItemNameVi \|\| item\.currentItemName/);
  assert.match(page, /currentItemName \|\| item\.currentItemNameVi/);
  assert.match(page, /품목 수정/);
  assert.match(page, /openInventoryItemEdit\(item\.itemId\)/);
  assert.match(page, /router\.push\(`\/inventory\?itemId=\$\{itemId\}&mode=edit`\)/);
});

test("current view banner, focus refresh and post-sync movement reload remain wired", () => {
  assert.match(page, /당일 입고정보 동기화 필요/);
  assert.match(page, /Cần đồng bộ thông tin nhập hàng hôm nay/);
  assert.match(page, /const nameSyncBusinessDate = viewMode === "snapshot"[\s\S]*: activeBusinessDateKey/);
  assert.match(page, /window\.addEventListener\("focus", handleWindowFocus\)/);
  assert.match(page, /setLanguageMissingItems\(json\.languageMissingItems \|\| \[\]\)/);
  assert.match(page, /fetchMovementItems\(businessDate\),\s*fetchNameSyncIssues\(businessDate\)/);
  assert.match(page, /전체 동기화/);
  assert.match(page, /수량 변경은 별도 입고보정 필요/);
});

test("daily sync cards keep every field on one compact overflow-safe row", () => {
  const dailyBanner = page.slice(
    page.indexOf('data-testid="snapshot-name-sync-banner"'),
    page.indexOf("{nameSyncBusinessDate && nameSyncItems.length === 0 && nameSyncError")
  );
  assert.match(page, /from: formatNameSyncValue\(change, change\.from\)/);
  assert.match(page, /to: formatNameSyncValue\(change, change\.to\)/);
  assert.match(dailyBanner, /title=\{`\$\{change\.label\}  \$\{change\.from\} → \$\{change\.to\}`\}/);
  assert.match(dailyBanner, /whiteSpace: "nowrap"/);
  assert.match(dailyBanner, /textOverflow: "ellipsis"/);
  assert.doesNotMatch(dailyBanner, /<br \/>/);
  assert.match(page, /if \(change\.field === "purchase_price"\) return `\$\{Number\(value\)\.toLocaleString\(\)\} ₫`/);
});

test("daily sync actions distinguish one-item, multi-item, active, processing and disabled states", () => {
  assert.match(page, /nameSyncCanRun && nameSyncItems\.length > 1/);
  assert.match(page, /background: isProcessing[\s\S]*: isDisabled \? "#f3f4f6" : "#2563eb"/);
  assert.match(page, /color: isDisabled && !isProcessing \? "#6b7280" : "#fff"/);
  assert.match(page, /isProcessing \? nameSyncT\.processing : nameSyncT\.syncOne/);
});

test("language warning and daily work banners retain distinct visual semantics", () => {
  const languageBanner = page.slice(
    page.indexOf('data-testid="inventory-language-missing-banner"'),
    page.indexOf('data-testid="snapshot-name-sync-banner"')
  );
  const dailyBanner = page.slice(page.indexOf('data-testid="snapshot-name-sync-banner"'));
  assert.match(languageBanner, /⚠/);
  assert.match(languageBanner, /#fff7ed/);
  assert.match(dailyBanner, /↻/);
  assert.match(dailyBanner, /#eff6ff/);
});

test("date selection immediately clears dated content and shows a scoped loading result", () => {
  assert.match(page, /const beginDateContentTransition = \(nextViewMode: "current" \| "snapshot"\)/);
  assert.match(page, /setSnapshotItems\(\[\]\);[\s\S]*setMovementItems\(\[\]\);[\s\S]*setNameSyncItems\(\[\]\)/);
  assert.match(page, /beginDateContentTransition\("snapshot"\);[\s\S]*setSelectedBatchId\(nextBatchId\)/);
  assert.match(page, /beginDateContentTransition\("current"\);[\s\S]*setSelectedBatchId\(null\)/);
  assert.match(page, /data-testid="snapshot-date-content-loading"/);
  assert.match(page, /\{isDateContentLoading \? \([\s\S]*\{nameSyncBusinessDate && nameSyncItems\.length > 0/);
});

test("date loading card uses a compact accessible CSS-only spinner", () => {
  const loadingCard = page.slice(
    page.indexOf('data-testid="snapshot-date-content-loading"'),
    page.indexOf("{nameSyncBusinessDate && nameSyncItems.length > 0")
  );
  assert.match(loadingCard, /snapshot-date-loading-spinner/);
  assert.match(loadingCard, /width: 19px/);
  assert.match(loadingCard, /height: 19px/);
  assert.match(loadingCard, /display: "inline-flex"/);
  assert.match(loadingCard, /alignItems: "center"/);
  assert.match(loadingCard, /\{c\.loading\}/);
  assert.match(loadingCard, /@keyframes snapshot-date-loading-spin/);
  assert.match(loadingCard, /transform: rotate\(360deg\)/);
  assert.match(loadingCard, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(loadingCard, /animation: none/);
});

test("snapshot and movement requests ignore stale success, failure and finally paths", () => {
  const snapshotBlock = page.slice(page.indexOf("const fetchSnapshotItems"), page.indexOf("const fetchNameSyncIssues"));
  const movementBlock = page.slice(page.indexOf("const fetchMovementItems"), page.indexOf("const changeLogReason"));
  for (const [block, refName] of [
    [snapshotBlock, "snapshotItemsRequestSequenceRef"],
    [movementBlock, "movementItemsRequestSequenceRef"],
  ] as const) {
    assert.match(block, new RegExp(`const requestSequence = \\+\\+${refName}\\.current`));
    assert.match(block, new RegExp(`requestSequence !== ${refName}\\.current`));
    assert.ok((block.match(new RegExp(`requestSequence === ${refName}\\.current`, "g")) || []).length >= 3);
  }
});

test("date transitions retain global language warnings while daily sync stays date-gated", () => {
  const transitionBlock = page.slice(page.indexOf("const beginDateContentTransition"), page.indexOf("useEffect(() =>", page.indexOf("const beginDateContentTransition")));
  const nameSyncBlock = page.slice(page.indexOf("const fetchNameSyncIssues"), page.indexOf("const syncSnapshotNames"));
  assert.doesNotMatch(transitionBlock, /setLanguageMissingItems\(\[\]\)/);
  assert.doesNotMatch(nameSyncBlock, /setLanguageMissingItems\(\[\]\)/);
  assert.match(page, /setLanguageMissingItems\(json\.languageMissingItems \|\| \[\]\)/);
  assert.match(page, /const isDateContentLoading = dateContentTransitioning && dateRequestsLoading/);
});
