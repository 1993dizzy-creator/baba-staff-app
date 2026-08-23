import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { CATEGORY_OPTIONS_BY_PART } from "../lib/inventory/categories.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { formatInventoryItemCount, getDominantInventoryCategoryGroup, getInventoryCategoryGroup, listUnmappedDefaultInventoryCategories } from "../lib/inventory/category-groups.ts";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

test("every canonical inventory category has an explicit group mapping", () => {
  assert.deepEqual(listUnmappedDefaultInventoryCategories(), []);
  assert.equal(Object.values(CATEGORY_OPTIONS_BY_PART).flat().length, 41);
});

test("custom categories fall back to other and KO/VI resolve identically", () => {
  assert.equal(getInventoryCategoryGroup("bar", "직접분류", "Phân loại riêng").key, "other");
  assert.equal(getInventoryCategoryGroup("bar", "위스키", null).key, "alcohol");
  assert.equal(getInventoryCategoryGroup("bar", null, "Whisky").key, "alcohol");
});

test("no active inventory has no dominant group while unknown active inventory is other", () => {
  assert.equal(getDominantInventoryCategoryGroup([]), null);
  assert.equal(getDominantInventoryCategoryGroup([
    { part: "kitchen", category: "직접분류", categoryVi: "Phân loại riêng" },
  ])?.key, "other");
});

test("dominant group combines detailed categories and resolves ties by fixed order", () => {
  assert.equal(getDominantInventoryCategoryGroup([
    { part: "bar", category: "위스키" },
    { part: "bar", category: "진" },
    { part: "bar", category: "음료" },
  ])?.key, "alcohol");
  assert.equal(getDominantInventoryCategoryGroup([
    { part: "kitchen", category: "채소" },
    { part: "bar", category: "위스키" },
  ])?.key, "alcohol");
});

test("inventory item count wording only mentions inactive items when present", () => {
  assert.equal(formatInventoryItemCount(7, 7, "ko"), "품목 7");
  assert.equal(formatInventoryItemCount(10, 7, "ko"), "품목 10 · 비활성 3");
  assert.equal(formatInventoryItemCount(7, 7, "vi"), "7 mặt hàng");
});

test("partner and candidate groups use active inventory from existing non-N+1 reads", () => {
  const server = read("lib/partners/server.ts");
  assert.match(server, /from\("inventory"\)\.select\("supplier_partner_id,is_active,part,category,category_vi"\)/);
  assert.match(server, /from\("inventory"\)\.select\("supplier,is_active,part,category,category_vi"\)/);
  assert.match(server, /if \(row\.is_active !== false\) \{[\s\S]*activeItems\.push/);
  assert.match(server, /dominantInventoryGroup: getDominantInventoryCategoryGroup/);
  assert.doesNotMatch(server, /for \([^)]*\)[\s\S]{0,200}await supabaseServer/);
});

test("partner list search is removed and add form lives on registration", () => {
  const registration = read("app/(protected)/admin/partners/page.tsx");
  const info = read("app/(protected)/admin/partners/info/page.tsx");
  assert.doesNotMatch(registration, /placeholder=.*검색|setQuery|supplierName\.toLowerCase/);
  assert.doesNotMatch(info, /setQuery|placeholder=.*검색/);
  assert.match(registration, /<PartnerForm/);
  assert.doesNotMatch(info, /<PartnerForm/);
  assert.match(registration, /dominantInventoryGroup/);
  assert.doesNotMatch(info, /dominantInventoryGroup/);
  assert.match(registration, /alias\.dominantInventoryGroup \? <span className={styles\.groupBadge}/);
  assert.doesNotMatch(info, /partner\.dominantInventoryGroup \? <span className={styles\.groupBadge}/);
});
