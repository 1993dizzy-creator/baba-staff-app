import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const shared = read("lib/sales/admin-sales-business-time.ts");
const todayApi = read("app/api/admin/sales/today/route.ts");
const monthlyApi = read("app/api/admin/sales/monthly/route.ts");
const receiptsApi = read("app/api/admin/sales/receipts/route.ts");
const dailyPage = read("app/(protected)/admin/sales/page.tsx");
const monthlyPage = read("app/(protected)/admin/sales/monthly/page.tsx");
const receiptsPage = read("app/(protected)/admin/sales/receipts/page.tsx");

test("today/receipts/monthly APIs resolve their default date through the shared store-settings helper, not their own getBusinessDate() call", () => {
  for (const api of [todayApi, receiptsApi]) {
    assert.match(api, /resolveAdminSalesBusinessDate\(/);
    assert.doesNotMatch(api, /from "@\/lib\/common\/business-time"/);
  }
  assert.match(monthlyApi, /resolveAdminSalesMonth\(/);
  assert.doesNotMatch(monthlyApi, /from "@\/lib\/common\/business-time"/);
});

test("explicit businessDate/month query values pass straight through without a settings lookup", () => {
  assert.match(shared, /if \(explicit\) \{\s*return \{ businessDate: explicit, source: "explicit" \};/);
  assert.match(shared, /if \(explicit\) \{\s*return \{ month: explicit, source: "explicit" \};/);
});

test("a settings lookup failure falls back to the legacy calculation and logs once, not per receipt", () => {
  assert.match(shared, /SALES_ADMIN_STORE_SETTING_LOOKUP_FAILED/);
  assert.match(shared, /return \{ businessDate: getBusinessDate\(\), source: "error_fallback" \};/);
  // Each helper must be invoked exactly once per request, never inside a
  // per-row loop over receipts/lines.
  assert.equal((todayApi.match(/resolveAdminSalesBusinessDate\(/g) ?? []).length, 1);
  assert.equal((receiptsApi.match(/resolveAdminSalesBusinessDate\(/g) ?? []).length, 1);
  assert.equal((receiptsApi.match(/resolveAdminSalesCutoffHour\(/g) ?? []).length, 1);
  assert.equal((monthlyApi.match(/resolveAdminSalesMonth\(/g) ?? []).length, 1);
});

test("business_date column filters are unchanged (Category B: stored value, no independent calculation)", () => {
  assert.match(todayApi, /\.eq\("business_date", businessDate\)/);
  assert.match(receiptsApi, /\.eq\("business_date", businessDate\)/);
  assert.match(monthlyApi, /\.gte\("business_date", fromDate\)/);
  assert.match(monthlyApi, /\.lte\("business_date", toDate\)/);
});

test("manual receipt sale-time bucketing uses the configured cutoff and the shared addStoreDays helper, not a hardcoded 03:00/local duplicate", () => {
  assert.match(receiptsApi, /resolveAdminSalesCutoffHour\(businessDate\)/);
  assert.match(receiptsApi, /from "@\/lib\/store-settings\/business-time-core"/);
  assert.match(receiptsApi, /hour < cutoffHour \? addStoreDays\(businessDate, 1\) : businessDate/);
  assert.doesNotMatch(receiptsApi, /BUSINESS_DAY_END_HOUR/);
  assert.doesNotMatch(receiptsApi, /function addDaysToDateKey/);
});

test("client pages never import the legacy client-side business date calculation", () => {
  for (const page of [dailyPage, monthlyPage, receiptsPage]) {
    assert.doesNotMatch(page, /getBusinessDate/);
    assert.doesNotMatch(page, /from "@\/lib\/common\/business-time"/);
  }
});

test("client pages default to an empty businessDate/month and sync state+URL from the server's resolved value", () => {
  assert.match(dailyPage, /searchParams\.get\("businessDate"\) \|\| ""/);
  assert.match(dailyPage, /if \(!businessDate && result\.businessDate\) \{/);
  assert.match(receiptsPage, /searchParams\.get\("businessDate"\) \|\| ""/);
  assert.match(receiptsPage, /if \(!businessDate && result\.businessDate\) \{/);
  assert.match(monthlyPage, /if \(!month && result\.month\) \{/);
});

test("monthly page never invents a businessDate for the daily/receipts tab links when none was shared", () => {
  assert.match(monthlyPage, /return isValidBusinessDate\(queryBusinessDate\) \? queryBusinessDate : "";/);
  assert.match(monthlyPage, /if \(sharedBusinessDate\) params\.set\("businessDate", sharedBusinessDate\);/);
});

test("month calendar-range math (getMonthRange) stays UTC-anchored and untouched", () => {
  assert.match(monthlyApi, /function getMonthRange\(month: string\) \{/);
  assert.match(monthlyApi, /Date\.UTC\(year, monthNumber, 0\)/);
});
