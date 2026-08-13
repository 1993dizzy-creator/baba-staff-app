import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(
  "app/(protected)/admin/pos/mappings/page.tsx",
  "utf8"
);
const route = readFileSync("app/api/admin/pos/mappings/route.ts", "utf8");

test("mapping inventory picker skips keg progress and does not reload with status", () => {
  assert.match(page, /\/api\/inventory\/items\?includeKegProgress=false/);
  assert.doesNotMatch(
    page,
    /Promise\.all\(\[loadMappings\(\), loadInventory\(\)\]\)/
  );

  const mappingEffect = page.match(
    /useEffect\(\(\) => \{[\s\S]*?void loadMappings\(\);[\s\S]*?\}, \[actorUsername, loadMappings\]\);/
  );
  const inventoryEffect = page.match(
    /useEffect\(\(\) => \{[\s\S]*?void loadInventory\(\)\.catch[\s\S]*?\}, \[actorUsername, lang, loadInventory\]\);/
  );
  assert.ok(mappingEffect);
  assert.ok(inventoryEffect);
});

test("mapping catalog starts dependent reads without the old serial stages", () => {
  assert.match(route, /const productsPromise = fetchAllProducts\(\);/);
  assert.match(route, /const mappingsPromise = fetchAllMappings\(\);/);
  assert.match(
    route,
    /const kegTrackingMappingsPromise = fetchActiveKegTrackingMappings\(\);/
  );
  assert.match(
    route,
    /const recipesPromise = mappingsPromise\.then\(\(mappings\) =>/
  );
  assert.match(
    route,
    /const orphanedMappingsPromise = Promise\.all\(\[[\s\S]*?productsPromise,[\s\S]*?mappingsPromise,[\s\S]*?\]\)\.then/
  );
  assert.match(
    route,
    /const inventoryByIdPromise = Promise\.all\(\[[\s\S]*?mappingsPromise,[\s\S]*?recipesPromise,[\s\S]*?kegTrackingMappingsPromise,[\s\S]*?\]\)\.then/
  );
});

test("orphan recipe counts reuse loaded recipes and only deductions are queried", () => {
  const deductionHelper = route.slice(
    route.indexOf("async function fetchDeductionReferenceCounts"),
    route.indexOf("function serializeMapping")
  );
  assert.doesNotMatch(deductionHelper, /pos_item_mapping_recipes/);
  assert.match(deductionHelper, /pos_inventory_deductions/);
  assert.match(route, /for \(const recipe of recipes\)/);
  assert.match(route, /if \(!orphanedMappingIds\.has\(mappingId\)\) continue/);
  assert.match(route, /if \(counts\) counts\.recipeCount \+= 1/);
  assert.match(
    route,
    /references\.recipeCount === 0 &&[\s\S]*?references\.deductionCount === 0/
  );
});
