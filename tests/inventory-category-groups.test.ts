import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
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
  // Only these bulk category loaders promise no per-item queries. Price-history
  // pagination elsewhere in the file is a separate, bounded read.
  const ast = ts.createSourceFile("server.ts", server, ts.ScriptTarget.Latest, true);
  for (const name of ["loadPartnerData", "loadSupplierAliases"]) {
    const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(fn && ts.isFunctionDeclaration(fn) && fn.body, name);
    let loops = 0;
    function visit(node: ts.Node) {
      if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node)) {
        loops++;
        assert.doesNotMatch(node.getText(ast), /await|supabaseServer/);
      }
      ts.forEachChild(node, visit);
    }
    visit(fn);
    assert.ok(loops > 0, `${name} must actually group the bulk result`);
  }
});

test("partner list search is removed and the add form sits once at the top of 거래처 설정", () => {
  const panel = read("components/partners/PartnerSettingsPanel.tsx");
  const candidateRow = panel.slice(panel.indexOf("function CandidateRow"), panel.indexOf("export default function PartnerSettingsPanel"));
  const partnerRow = panel.slice(panel.indexOf("function PartnerRow"), panel.indexOf("function CandidateRow"));
  assert.doesNotMatch(panel, /placeholder=.*검색|setQuery|supplierName\.toLowerCase/);
  assert.equal((panel.match(/<PartnerForm /g) ?? []).length, 1);
  assert.ok(panel.indexOf("labels.add}") < panel.indexOf("<PartnerSubtypeManager "));
  assert.match(candidateRow, /alias\.dominantInventoryGroup \? <span className={styles\.groupBadge}/);
  assert.doesNotMatch(partnerRow, /dominantInventoryGroup/);
});
