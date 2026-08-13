import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/sales/page.tsx");
const route = read("app/api/admin/sales/today/route.ts");

test("daily sales language changes update the fallback without refetching", () => {
  assert.match(page, /const loadFailedTextRef = useRef\(dailyText\.loadFailed\);/);
  assert.match(page, /loadFailedTextRef\.current = dailyText\.loadFailed;/);
  assert.match(page, /result\.error \|\| loadFailedTextRef\.current/);
  assert.match(page, /\[businessDate, pathname, router\]/);
  assert.doesNotMatch(page, /\[businessDate, dailyText\.loadFailed, pathname, router\]/);
});

test("initial server-resolved business date does not immediately refetch itself", () => {
  assert.match(page, /resolvedBusinessDateSkipRef\.current = result\.businessDate;\s*setBusinessDate\(result\.businessDate\);/);
  assert.match(
    page,
    /businessDate &&\s*resolvedBusinessDateSkipRef\.current === businessDate[\s\S]*?resolvedBusinessDateSkipRef\.current = "";\s*return;/
  );
  assert.match(page, /const controller = new AbortController\(\);[\s\S]*?return \(\) => controller\.abort\(\);/);
  assert.match(page, /function handleBusinessDateChange\(value: string\) \{\s*setBusinessDate\(value\);/);
});

test("sales sync still refreshes the daily result", () => {
  const sync = page.slice(page.indexOf("async function handleSyncSales"), page.indexOf("const summary ="));
  assert.match(sync, /await fetchSalesToday\(\);/);
});

test("today route resolves the business date before starting three parallel reads", () => {
  const resolveIndex = route.indexOf("await resolveAdminSalesBusinessDate(");
  const parallelIndex = route.indexOf("await Promise.all([");
  assert.ok(resolveIndex >= 0 && parallelIndex > resolveIndex);
  const parallel = route.slice(parallelIndex, route.indexOf("]);", parallelIndex) + 3);
  assert.equal((parallel.match(/\.from\("pos_sales_receipts"\)/g) ?? []).length, 1);
  assert.equal((parallel.match(/\.from\("pos_sales_receipt_lines"\)/g) ?? []).length, 1);
  assert.equal((parallel.match(/\.from\("pos_sales_receipt_payments"\)/g) ?? []).length, 1);
  assert.equal((parallel.match(/\.eq\("business_date", businessDate\)/g) ?? []).length, 3);
});

test("parallel reads preserve table-specific failures and feed the unchanged calculations", () => {
  assert.match(route, /Failed to fetch sales receipts:/);
  assert.match(route, /Failed to fetch sales lines:/);
  assert.match(route, /Failed to fetch sales payments:/);
  const calculations = route.slice(route.indexOf("const receiptRows"));
  assert.match(calculations, /paymentSummary: buildPaymentSummary\(paidPaymentRows\)/);
  assert.match(calculations, /taxSummary: buildTaxSummary\(receiptRows, lineRows\)/);
  assert.match(calculations, /hourlySales: buildHourlySales\(receiptRows\)/);
  assert.match(calculations, /topItems: buildTopItems\(lineRows, paidReceiptIds\)/);
});
