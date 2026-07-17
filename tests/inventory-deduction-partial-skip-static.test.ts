import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

test("missing mappings and incomplete recipes remain non-blocking line skips", () => {
  const preview = source("lib/sales/inventory-deduction-preview.ts");
  const recipePolicy = source(
    "lib/sales/inventory-deduction-recipe-policy.ts"
  );

  assert.match(preview, /blocksReceipt: false/);
  assert.match(
    preview,
    /lines\.filter\(\(line\) => line\.blocksReceipt\)/
  );
  assert.match(recipePolicy, /return false/);
});

test("hard mapping integrity failures still block the whole receipt", () => {
  const preview = source("lib/sales/inventory-deduction-preview.ts");
  assert.match(preview, /blocksReceipt: true/);
  assert.match(preview, /Direct mapping/);
  assert.match(preview, /Combo mapping/);
});

test("modified receipt reprocessing uses the same hard-blocking line policy", () => {
  const reprocess = source("lib/sales/inventory-deduction-reprocess.ts");
  assert.match(reprocess, /line\.blocksReceipt !== true/);
});

test("receipt option display requires a resolvable explicit parent", () => {
  const page = source("app/(protected)/admin/sales/receipts/page.tsx");
  assert.match(page, /line\.parentRefDetailId &&/);
  assert.match(
    page,
    /receiptLineRefDetailIds\.has\(line\.parentRefDetailId\)/
  );
  assert.doesNotMatch(page, /line\.refDetailType !== 1/);
});
