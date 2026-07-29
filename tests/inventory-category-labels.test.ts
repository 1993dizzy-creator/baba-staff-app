import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { CATEGORY_OPTIONS_BY_PART, getInventoryCategoryLabel, resolveInventoryCategoryOption } from "../lib/inventory/categories.ts";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

test("BAR and hall expose the standard beverage translation", () => {
  assert.ok(CATEGORY_OPTIONS_BY_PART.bar.some((option) => option.ko === "음료" && option.vi === "Đồ uống"));
  assert.ok(CATEGORY_OPTIONS_BY_PART.hall.some((option) => option.ko === "음료" && option.vi === "Đồ uống"));
});

test("known categories resolve from either language with normalized matching", () => {
  assert.deepEqual(resolveInventoryCategoryOption("bar", " 음료 ", null), { ko: "음료", vi: "Đồ uống" });
  assert.deepEqual(resolveInventoryCategoryOption(" BAR ", null, " đồ UỐNG "), { ko: "음료", vi: "Đồ uống" });
});

test("known BAR beverages override incorrect or missing translations", () => {
  assert.equal(getInventoryCategoryLabel("bar", "음료", "음료", "vi"), "Đồ uống");
  assert.equal(getInventoryCategoryLabel("bar", "음료", "", "vi"), "Đồ uống");
  assert.equal(getInventoryCategoryLabel("bar", "음료", "Đồ uống", "ko"), "음료");
});

test("custom category language fallback remains unchanged", () => {
  assert.equal(getInventoryCategoryLabel("bar", "직접분류", "Phân loại riêng", "vi"), "Phân loại riêng");
  assert.equal(getInventoryCategoryLabel("bar", "직접분류", "", "vi"), "직접분류");
  assert.equal(getInventoryCategoryLabel("bar", "", "Phân loại riêng", "ko"), "Phân loại riêng");
});

test("inventory edit uses standard pairs without cross-language fallback", () => {
  const page = read("app/(protected)/inventory/page.tsx");
  assert.match(page, /setCategoryKo\(selected\.ko\)/);
  assert.match(page, /setCategoryVi\(selected\.vi\)/);
  assert.match(page, /setCategoryKo\(matchedCategory\?\.ko \|\| item\.category \|\| ""\)/);
  assert.match(page, /setCategoryVi\(matchedCategory\?\.vi \|\| item\.category_vi \|\| ""\)/);
  assert.doesNotMatch(page, /setCategoryVi\(item\.category_vi \|\| item\.category/);
  assert.doesNotMatch(page, /setCategoryKo\(item\.category \|\| item\.category_vi/);
});

test("data-fix SQL is narrow and does not touch logs or unrelated inventory fields", () => {
  const sql = read("supabase/verification/20260730_fix_bar_beverage_category_vi.sql");
  assert.match(sql, /where part = 'bar'[\s\S]*category = '음료'/);
  assert.match(sql, /set category_vi = 'Đồ uống'/);
  assert.doesNotMatch(sql, /inventory_logs|quantity|item_name\s*=/);
});
