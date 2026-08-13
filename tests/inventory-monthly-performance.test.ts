import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/inventory/monthly/page.tsx");
const route = read("app/api/inventory/monthly/route.ts");

test("inventory monthly language changes update the fallback without refetching", () => {
  assert.match(page, /const loadFailedTextRef = useRef\(c\.loadFailed\);/);
  assert.match(page, /loadFailedTextRef\.current = c\.loadFailed;/);
  assert.match(page, /setError\(loadFailedTextRef\.current\)/);
  assert.match(page, /\}, \[selectedMonth\]\);/);
  assert.doesNotMatch(page, /\[selectedMonth, c\.loadFailed\]/);
});

test("initial resolved month skips only its immediate duplicate request", () => {
  assert.match(page, /resolvedMonthSkipRef\.current = json\.month;\s*setSelectedMonth\(json\.month\);/);
  assert.match(
    page,
    /selectedMonth && resolvedMonthSkipRef\.current === selectedMonth[\s\S]*?resolvedMonthSkipRef\.current = "";\s*return;/
  );
  assert.match(page, /onChange=\{\(event\) => setSelectedMonth\(event\.target\.value\)\}/);
});

test("inventory monthly retains its stale request guard", () => {
  assert.match(page, /let ignore = false;/);
  assert.match(page, /if \(!ignore\) \{[\s\S]*?setData\(json\);/);
  assert.match(page, /return \(\) => \{\s*ignore = true;\s*\};/);
  assert.match(page, /finally \{\s*if \(!ignore\) \{\s*setLoading\(false\);/);
});

test("inventory reads begin only after auth and business month resolution", () => {
  const getRoute = route.slice(route.indexOf("export async function GET"));
  const authIndex = getRoute.indexOf("await getAuthenticatedActor()");
  const resolveIndex = getRoute.indexOf("await resolveInventoryBusinessDate()");
  const rangeIndex = getRoute.indexOf("const { monthStart, monthEnd } = getMonthRange(month);");
  const baselineIndex = getRoute.indexOf("const baselineWithItemsPromise");
  assert.ok(authIndex >= 0 && resolveIndex > authIndex && rangeIndex > resolveIndex && baselineIndex > rangeIndex);
});

test("logs and prices run beside dependency-safe snapshot pipelines", () => {
  const getRoute = route.slice(route.indexOf("export async function GET"));
  const finalParallel = getRoute.slice(
    getRoute.indexOf("] = await Promise.all(["),
    getRoute.indexOf("]);", getRoute.indexOf("] = await Promise.all([")) + 3
  );
  assert.match(finalParallel, /baselineWithItemsPromise/);
  assert.match(finalParallel, /latestWithItemsPromise/);
  assert.match(finalParallel, /fetchMonthlyInventoryLogs\(monthStart, toDate\)/);
  assert.match(finalParallel, /\.from\("inventory_price_logs"\)/);
  assert.match(route, /baselineWithItemsPromise[\s\S]*?getSnapshotItems\(batch\?\.id \?\? null\)/);
  assert.match(route, /latestWithItemsPromise[\s\S]*?isCurrentMonth[\s\S]*?getCurrentInventoryItems\(\)/);
  assert.match(route, /\.range\(from, from \+ pageSize - 1\)/);
});

test("snapshot and monthly log projections remain intact", () => {
  assert.match(route, /\.from\("inventory_snapshot_items"\)[\s\S]*?\.eq\("batch_id", batchId\)/);
  assert.match(route, /\.from\("inventory_logs"\)[\s\S]*?\.gte\("business_date", monthStart\)[\s\S]*?\.lte\("business_date", toDate\)/);
  assert.match(route, /\.from\("inventory_price_logs"\)[\s\S]*?\.gte\("business_date", monthStart\)[\s\S]*?\.lte\("business_date", toDate\)/);
  assert.match(route, /const baselineMap = getItemMap\(baselineItems\);/);
  assert.match(route, /const latestMap = getItemMap\(latestItems\);/);
});
