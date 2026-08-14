import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/inventory/bootstrap/route.ts");
const page = read("app/(protected)/inventory/page.tsx");
const itemsRoute = read("app/api/inventory/items/route.ts");
const statusRoute = read("app/api/inventory/items/status/route.ts");
const kegRoute = read("app/api/inventory/keg-progress/route.ts");
const itemsHelper = read("lib/inventory/items-server.ts");
const statusHelper = read("lib/inventory/stock-check-status-server.ts");
const kegHelper = read("lib/inventory/keg-progress.ts");

test("bootstrap authenticates once and never calls the existing APIs over HTTP", () => {
  assert.equal((route.match(/getAuthenticatedActor\(\)/g) || []).length, 1);
  assert.doesNotMatch(route, /fetch\s*\(/);
  assert.doesNotMatch(route, /\/api\/inventory\/(?:items|items\/status|keg-progress)/);
  assert.match(route, /fetchInventoryItems\(/);
  assert.match(route, /fetchInventoryStatusByItemId\(/);
  assert.match(route, /fetchKegProgressByItemId\(/);
});

test("bootstrap reads inventory once and shares its item and mapping data", () => {
  assert.equal((route.match(/fetchInventoryItems\(/g) || []).length, 1);
  assert.equal((route.match(/fetchActiveKegTrackingMappings\(/g) || []).length, 1);
  assert.match(route, /const activeItemIds = inventoryItems/);
  assert.match(route, /getInventoryKegCandidateIds\(inventoryItems\)/);
  assert.match(route, /preloadedMappings: activeMappings/);
  assert.match(kegHelper, /preloadedMappings\?: KegTrackingMappingRow\[\]/);
  assert.match(itemsHelper, /select\(INVENTORY_ITEM_SELECT\)/);
});

test("status and Keg enrichment overlap after the inventory dependency", () => {
  const inventoryIndex = route.indexOf("await fetchInventoryItems");
  const statusIndex = route.indexOf("const statusPromise");
  const mappingIndex = route.indexOf("const mappingPromise");
  const joinIndex = route.indexOf("await Promise.all");

  assert.ok(inventoryIndex >= 0 && inventoryIndex < statusIndex);
  assert.ok(statusIndex < joinIndex && mappingIndex < joinIndex);
  assert.match(route, /Promise\.all\(\[statusPromise, mappingPromise, kegPromise\]\)/);
  assert.match(statusHelper, /Promise\.all\(\[/);
});

test("bootstrap returns the established item, status, and Keg contracts", () => {
  assert.match(route, /ok: true,[\s\S]*items: buildInventoryItemsResponse/);
  assert.match(route, /statusMap: inventoryStatusMapToRecord/);
  assert.match(route, /kegProgressMap/);
  assert.match(itemsHelper, /lastStockCheckDate: null/);
  assert.match(itemsHelper, /daysSinceStockCheck: null/);
  assert.match(itemsHelper, /needsStockCheck: false/);
});

test("empty data and enrichment failures follow the existing all-or-error policy", () => {
  assert.match(itemsHelper, /return \(data \|\| \[\]\)/);
  assert.match(statusHelper, /itemIds\.length === 0[\s\S]*new Map/);
  assert.match(kegHelper, /kegCandidateIds\.length === 0[\s\S]*return progressByItemId/);
  assert.match(route, /catch \(error\)[\s\S]*inventory_bootstrap_load_failed/);
  assert.doesNotMatch(route, /Promise\.allSettled/);
});

test("auth failures return before inventory work and existing endpoints remain intact", () => {
  const handler = route.slice(route.indexOf("export async function GET"));
  const authFailureIndex = handler.indexOf("if (!auth.ok)");
  const inventoryIndex = handler.indexOf("fetchInventoryItems");
  assert.ok(authFailureIndex >= 0 && authFailureIndex < inventoryIndex);
  assert.match(itemsRoute, /export async function GET/);
  assert.match(statusRoute, /export async function POST/);
  assert.match(kegRoute, /export async function GET/);
});

test("the inventory page starts only bootstrap, recent, and snapshot on mount", () => {
  const initialEffectMatch = page.match(
    /useEffect\(\(\) => \{\s*void Promise\.all\(\[[\s\S]*?\}\, \[\]\);/
  );
  const initialEffect = initialEffectMatch?.[0] || "";
  assert.match(page, /\/api\/inventory\/bootstrap/);
  assert.doesNotMatch(page, /\/api\/inventory\/items\/status/);
  assert.doesNotMatch(page, /\/api\/inventory\/keg-progress/);
  assert.match(initialEffect, /fetchInventory/);
  assert.match(initialEffect, /fetchRecentLogs/);
  assert.match(initialEffect, /fetchLatestSnapshot/);
});

test("bootstrap exposes stable numeric Server-Timing without response data", () => {
  for (const metric of [
    "auth",
    "items",
    "status",
    "keg",
    "enrich_wall",
    "total",
  ]) {
    assert.match(route, new RegExp(`"${metric}"`));
  }
  assert.match(route, /"Server-Timing": timing\.header\(\)/);
  assert.match(route, /\.toFixed\(1\)/);
});
