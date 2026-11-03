import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { findInventoryLanguageMissingItems, type InventoryLanguageRow } from "../lib/inventory/language-missing.ts";
const read = (path: string) => readFileSync(path, "utf8");
const page = read("app/(protected)/inventory/snapshots/page.tsx");
const languageInventory = (overrides: Partial<InventoryLanguageRow> = {}): InventoryLanguageRow => ({id:604,item_name:"설거지 행주",item_name_vi:"Khăn lau bát",is_active:true,...overrides});

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

test("filling a missing master name removes the language alert without historical name sync", () => {
  const beforeEdit = languageInventory({ item_name: "", item_name_vi: "Khăn lau bát" });
  const afterEdit = languageInventory({ item_name: "설거지 행주", item_name_vi: "Khăn lau bát" });

  assert.equal(findInventoryLanguageMissingItems([beforeEdit]).length, 1);
  assert.equal(findInventoryLanguageMissingItems([afterEdit]).length, 0);
});

test("language alert is separate, hidden at zero, labels gaps, falls back by UI language and opens shared item editor", () => {
  assert.match(page, /\{languageMissingItems\.length > 0 && \(/);
  assert.match(page, /data-testid="inventory-language-missing-banner"/);
  assert.match(page, /한글명 미설정/);
  assert.match(page, /베트남어명 미설정/);
  assert.match(page, /currentItemNameVi \|\| item\.currentItemName/);
  assert.match(page, /currentItemName \|\| item\.currentItemNameVi/);
  assert.match(page, /품목 수정/);
  assert.match(page, /openInventoryItemEdit\(item.itemId, item.missingLanguages\[0\]\)/);
  assert.doesNotMatch(page, /setLanguageDrafts|saveMissingLanguages/);
  assert.match(page, /setEditingItemId\(itemId\)/);
});

test("date selection immediately clears dated content and shows a scoped loading result", () => {
  assert.match(page, /const beginDateContentTransition = \(nextViewMode: "current" \| "snapshot"\)/);
  assert.match(page, /setSnapshotItems\(\[\]\);[\s\S]*setMovementItems\(\[\]\);/);
  assert.match(page, /beginDateContentTransition\("snapshot"\);[\s\S]*setSelectedBatchId\(nextBatchId\)/);
  assert.match(page, /beginDateContentTransition\("current"\);[\s\S]*setSelectedBatchId\(null\)/);
  assert.match(page, /testId="snapshot-date-content-loading"/);
});

test("date loading card uses a compact accessible CSS-only spinner", () => {
  const component = read("components/inventory/InventoryLoadingCard.tsx");
  const css = read("components/inventory/InventoryLoadingCard.module.css");
  assert.match(component, /role="status"/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /aria-hidden="true"/);
  assert.match(css, /width: 19px/);
  assert.match(css, /height: 19px/);
  assert.match(css, /@keyframes inventory-loading-spin/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /animation: none/);
});

test("snapshot and movement requests ignore stale success, failure and finally paths", () => {
  const snapshotBlock = page.slice(page.indexOf("const fetchSnapshotItems"), page.indexOf("const fetchLanguageMissingItems"));
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

test("date transitions retain global language warnings while language lookup stays independent of dates", () => {
  const transitionBlock = page.slice(page.indexOf("const beginDateContentTransition"), page.indexOf("useEffect(() =>", page.indexOf("const beginDateContentTransition")));
  const languageBlock = page.slice(page.indexOf("const fetchLanguageMissingItems"), page.indexOf("const fetchItemLogs"));
  assert.doesNotMatch(transitionBlock, /setLanguageMissingItems\(\[\]\)/);
  assert.doesNotMatch(languageBlock, /setLanguageMissingItems\(\[\]\)/);
  assert.match(page, /setLanguageMissingItems\(json\.languageMissingItems \|\| \[\]\)/);
  assert.match(page, /const isDateContentLoading = dateContentTransitioning && dateRequestsLoading/);
});

test("part filter row wraps instead of overflowing narrow screens (VI 📦 Khác at 360/390px)", () => {
  const row = page.slice(page.indexOf('data-testid="snapshot-part-filter"'), page.indexOf("{c.all}"));
  assert.match(row, /display: "flex",\s*flexWrap: "wrap",\s*gap: 6,/);
  assert.doesNotMatch(row, /gridTemplateColumns: "repeat\(5, 1fr\)"/);
  assert.match(row, /flex: "1 0 auto",/);
  assert.match(page, /return \{\s*flex: "1 0 auto",\s*padding: "8px 10px",/);
  // Every part keeps its button.
  for (const part of ["kitchen", "hall", "bar", "etc"]) assert.match(page, new RegExp(`\{ value: "${part}", label: c\.${part} \}`));
});

test("retired sync has no banner, state, month request or write-capable dependencies", () => {
  assert.doesNotMatch(page, /MonthlyNameSyncPanel|monthlySyncReloadKey|refreshSyncedBusinessDate|nameSyncLoading|dailySyncItems|monthlySyncItems|snapshot-name-sync-banner/);
  assert.match(page, /fetchLanguageMissingItems/);
  assert.match(page, /window\.addEventListener\("focus", handleWindowFocus\)/);
  const languageRead = page.slice(page.indexOf("const fetchLanguageMissingItems"), page.indexOf("const fetchItemLogs"));
  assert.doesNotMatch(languageRead, /businessDate|month=|method: "POST"/);
  const loading = page.slice(page.indexOf("const dateRequestsLoading"), page.indexOf("const beginDateContentTransition"));
  assert.doesNotMatch(loading, /language/i);
});
