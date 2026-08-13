import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/inventory/snapshots/page.tsx");
const route = read("app/api/inventory/snapshot/list/route.ts");

test("the initial resolved month skips only its immediate duplicate list request", () => {
  assert.match(page, /const resolvedMonthSkipRef = useRef\(""\);/);
  assert.match(page, /resolvedMonthSkipRef\.current = resolvedMonth;\s*return resolvedMonth;/);
  assert.match(
    page,
    /calendarMonth && resolvedMonthSkipRef\.current === calendarMonth[\s\S]*?resolvedMonthSkipRef\.current = "";\s*return;/
  );
  assert.match(page, /setCalendarMonth\(`\$\{nextYear\}-\$\{nextMonth\}`\);/);
});

test("batch loading is stable across initialized state and protects current month state", () => {
  assert.match(page, /const batchesRequestSequenceRef = useRef\(0\);/);
  assert.match(page, /const requestSequence = \+\+batchesRequestSequenceRef\.current;/);
  assert.match(page, /if \(requestSequence !== batchesRequestSequenceRef\.current\) return;/);
  assert.match(page, /if \(requestSequence === batchesRequestSequenceRef\.current\) \{\s*setLoadingBatches\(false\);/);
  assert.match(page, /return \(\) => \{\s*batchesRequestSequenceRef\.current \+= 1;\s*\};/);
  assert.match(page, /setActiveBusinessDateKey\(\(current\) => current \|\| json\.currentBusinessDate \|\| ""\);/);
  assert.match(page, /\}, \[\]\);/);
});

test("movement and snapshot detail requests remain independently lazy", () => {
  assert.match(page, /if \(viewMode !== "current" \|\| !activeBusinessDateKey\) return;\s*fetchMovementItems\(activeBusinessDateKey\);/);
  assert.match(page, /if \(viewMode !== "snapshot"\) return;[\s\S]*?if \(!selectedBatchId\) return;[\s\S]*?fetchSnapshotItems\(selectedBatchId\);/);
  assert.match(page, /`\/api\/inventory\/snapshot\/\$\{safeBatchId\}`/);
  assert.match(page, /`\/api\/inventory\/items\/\$\{itemId\}\/logs`/);
});

test("snapshot list validates auth and month before protected reads", () => {
  const getRoute = route.slice(route.indexOf("export async function GET"));
  const authIndex = getRoute.indexOf("await getAuthenticatedActor()");
  const invalidIndex = getRoute.indexOf("if (month && !isValidMonthKey(month))");
  const clientIndex = getRoute.indexOf("const supabase = createSupabaseAdmin()");
  assert.ok(authIndex >= 0 && invalidIndex > authIndex && clientIndex > invalidIndex);
});

test("no-month requests use the resolved business month for purchase dates", () => {
  assert.match(route, /businessDatePromise\.then\(\(\{ businessDate \}\) => businessDate\.slice\(0, 7\)\)/);
  assert.match(route, /\.eq\("reason", "purchase"\)[\s\S]*?\.gt\("change_quantity", 0\)[\s\S]*?\.gte\("business_date", fromDate\)[\s\S]*?\.lte\("business_date", toDate\)/);
  assert.match(route, /purchaseDateMap\[String\(row\.business_date\)\] = true;/);
});

test("business date, batches, and dependency-safe purchase logs share one await graph", () => {
  assert.match(route, /const businessDatePromise = resolveInventoryBusinessDate\(\);/);
  assert.match(route, /const batchesPromise = supabase[\s\S]*?\.from\("inventory_snapshot_batches"\)[\s\S]*?\.select\("id, snapshot_date, created_at, note"\)[\s\S]*?\.order\("id", \{ ascending: false \}\);/);
  assert.match(route, /const purchaseLogsPromise = \(month[\s\S]*?Promise\.resolve\(month\)[\s\S]*?: businessDatePromise\.then/);
  assert.match(route, /await Promise\.all\(\[\s*businessDatePromise,\s*batchesPromise,\s*purchaseLogsPromise,\s*\]\)/);
  assert.match(route, /error: "snapshot_batches_query_failed"/);
  assert.match(route, /error: "snapshot_purchase_logs_query_failed"/);
  assert.match(route, /error: "snapshot_batches_fetch_failed"/);
});
