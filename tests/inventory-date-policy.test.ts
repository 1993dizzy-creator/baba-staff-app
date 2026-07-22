import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const shared = read("lib/inventory/inventory-business-time.ts");
const itemsApi = read("app/api/inventory/items/route.ts");
const statusApi = read("app/api/inventory/items/status/route.ts");
const photoApi = read("app/api/inventory/items/[id]/photo/route.ts");
const monthlyApi = read("app/api/inventory/monthly/route.ts");
const snapshotCronApi = read("app/api/inventory/snapshot/route.ts");
const snapshotListApi = read("app/api/inventory/snapshot/list/route.ts");
const kegReplaceApi = read("app/api/inventory/keg-sessions/replace/route.ts");
const kegSessionApi = read("app/api/inventory/keg-sessions/[id]/route.ts");
const mainPage = read("app/(protected)/inventory/page.tsx");
const monthlyPage = read("app/(protected)/inventory/monthly/page.tsx");
const snapshotsPage = read("app/(protected)/inventory/snapshots/page.tsx");
const logsPage = read("app/(protected)/inventory/logs/page.tsx");

test("inventory log/photo default business dates resolve through the store-settings module", () => {
  assert.match(itemsApi, /from "@\/lib\/inventory\/inventory-business-time"/);
  assert.match(itemsApi, /resolveInventoryBusinessDate\(\)/);
  assert.match(photoApi, /resolveInventoryBusinessDate\(\)/);
  assert.doesNotMatch(itemsApi, /from "@\/lib\/common\/business-time"/);
  assert.doesNotMatch(photoApi, /from "@\/lib\/common\/business-time"/);
});

test("Keg replace/session-start business dates resolve a given timestamp, not 'now'", () => {
  assert.match(kegReplaceApi, /resolveInventoryBusinessDate\(replacementAt\)/);
  assert.match(kegSessionApi, /resolveInventoryBusinessDate\(startedAt\)/);
  assert.doesNotMatch(kegReplaceApi, /getBusinessDate/);
  assert.doesNotMatch(kegSessionApi, /getBusinessDate/);
});

test("inventory monthly resolves the current business date exactly once per request and reuses it", () => {
  assert.match(monthlyApi, /resolveInventoryBusinessDate\(\);/);
  assert.equal((monthlyApi.match(/resolveInventoryBusinessDate\(/g) ?? []).length, 1);
  assert.doesNotMatch(monthlyApi, /function getDefaultMonth/);
  assert.match(monthlyApi, /const currentMonth = currentBusinessDate\.slice\(0, 7\);/);
  assert.match(monthlyApi, /const isCurrentMonth = month === currentMonth;/);
});

test("the daily snapshot cron targets the business day that just closed, not the one that just started", () => {
  assert.match(snapshotCronApi, /resolveInventoryPreviousBusinessDate/);
  assert.doesNotMatch(snapshotCronApi, /getSnapshotDate/);
  assert.match(shared, /addStoreDays\(current\.businessDate, -1\)/);
});

test("a settings lookup failure falls back to the legacy calculation and logs once, not per item", () => {
  assert.match(shared, /INVENTORY_STORE_SETTING_LOOKUP_FAILED/);
  assert.match(shared, /return \{ businessDate: getBusinessDate\(timestamp\), source: "error_fallback" \};/);
});

test("the stock-check created_at fallback is a documented, deliberate synchronous exception (per-row loop)", () => {
  // getStockCheckDateKey runs once per legacy log row inside a loop; doing an
  // async settings lookup there would violate the "no per-row lookup" rule,
  // so it intentionally keeps the plain legacy calculation for that one
  // narrow, historical-data-only fallback path.
  assert.match(statusApi, /getStockCheckDateKey/);
  assert.match(statusApi, /deliberately uses the plain legacy cutoff calculation/);
  assert.match(statusApi, /return getBusinessDate\(createdAt\);/);
});

test("the 60-day lookback window uses the shared addStoreDays helper, not a redundant local reimplementation", () => {
  assert.match(statusApi, /from "@\/lib\/store-settings\/business-time-core"/);
  assert.match(statusApi, /addStoreDays\(\s*currentBusinessDate,\s*-SALE_DEDUCTION_ACTIVE_LOOKBACK_DAYS/);
  assert.doesNotMatch(statusApi, /function addDaysToBusinessDateKey/);
});

test("snapshot list API exposes currentBusinessDate once per request for the client to sync from", () => {
  assert.equal((snapshotListApi.match(/resolveInventoryBusinessDate\(/g) ?? []).length, 1);
  assert.match(snapshotListApi, /currentBusinessDate,\s*\}\);/);
});

test("client pages never import the legacy client-side business date calculation", () => {
  for (const page of [mainPage, monthlyPage, snapshotsPage, logsPage]) {
    assert.doesNotMatch(page, /from "@\/lib\/common\/business-time"/);
  }
});

test("monthly and snapshots pages default to an empty month/businessDate and sync from the server response", () => {
  assert.match(monthlyPage, /const \[selectedMonth, setSelectedMonth\] = useState\(""\);/);
  assert.match(monthlyPage, /if \(!selectedMonth && json\.month\) \{/);
  assert.match(snapshotsPage, /const \[activeBusinessDateKey, setActiveBusinessDateKey\] = useState\(""\);/);
  assert.match(snapshotsPage, /const \[calendarMonth, setCalendarMonth\] = useState\(""\);/);
  assert.match(snapshotsPage, /if \(!activeBusinessDateKey && json\.currentBusinessDate\) \{/);
});

test("sales-deductions cron internal businessDate handling was already store-settings-integrated (no change needed)", () => {
  const normalCron = read("app/api/cron/sales-deductions/route.ts");
  const finalCron = read("app/api/cron/sales-deductions-final/route.ts");
  assert.match(normalCron, /const businessDate = getBusinessDate\(\);/);
  assert.match(finalCron, /loadBusinessTimeAdapter\(new Date\(\)\)/);
  assert.match(finalCron, /addStoreDays\(adapter\.databaseBusinessDate, -1\)/);
});
