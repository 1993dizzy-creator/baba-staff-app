import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/sales/monthly/page.tsx");
const route = read("app/api/admin/sales/monthly/route.ts");

test("monthly sales language changes update the fallback without refetching", () => {
  assert.match(page, /const loadFailedTextRef = useRef\(monthlyText\.loadFailed\);/);
  assert.match(page, /loadFailedTextRef\.current = monthlyText\.loadFailed;/);
  assert.match(page, /result\.error \|\| loadFailedTextRef\.current/);
  assert.match(page, /\[month, pathname, router, sharedBusinessDate\]/);
  assert.doesNotMatch(page, /\[month, monthlyText\.loadFailed, pathname, router, sharedBusinessDate\]/);
});

test("initial server-resolved month is consumed once without an immediate duplicate GET", () => {
  assert.match(page, /resolvedMonthSkipRef\.current = result\.month;\s*setMonth\(result\.month\);/);
  assert.match(
    page,
    /month && resolvedMonthSkipRef\.current === month[\s\S]*?resolvedMonthSkipRef\.current = "";\s*return;/
  );
  assert.match(page, /const controller = new AbortController\(\);[\s\S]*?return \(\) => controller\.abort\(\);/);
  assert.match(page, /function handleMonthChange\(nextMonth: string\) \{\s*setMonth\(nextMonth\);/);
});

test("monthly navigation preserves shared business date and category mutation refresh", () => {
  const change = page.slice(page.indexOf("function handleMonthChange"), page.indexOf("async function handleCategoryGroupUpdate"));
  assert.match(change, /if \(sharedBusinessDate\) params\.set\("businessDate", sharedBusinessDate\);/);
  const update = page.slice(page.indexOf("async function handleCategoryGroupUpdate"), page.indexOf("const summary ="));
  assert.match(update, /method: "POST"/);
  assert.match(update, /await fetchMonthlySales\(\);/);
  assert.match(page, /if \(user\?\.role === "leader"\) \{\s*setActiveDetailTab\("menu"\);/);
});

test("monthly API resolves and validates the month before five parallel reads", () => {
  const getRoute = route.slice(route.indexOf("export async function GET"));
  const resolveIndex = getRoute.indexOf("await resolveAdminSalesMonth(");
  const rangeIndex = getRoute.indexOf("const { fromDate, toDate } = getMonthRange(month);");
  const parallelIndex = getRoute.indexOf("await Promise.all([");
  assert.ok(resolveIndex >= 0 && rangeIndex > resolveIndex && parallelIndex > rangeIndex);
  const parallel = getRoute.slice(parallelIndex, getRoute.indexOf("]);", parallelIndex) + 3);
  assert.equal((parallel.match(/\.from\("pos_sales_receipts"\)/g) ?? []).length, 1);
  assert.equal((parallel.match(/fetchMonthlyLines\(fromDate, toDate\)/g) ?? []).length, 1);
  assert.equal((parallel.match(/fetchProductCategories\(\)/g) ?? []).length, 1);
  assert.equal((parallel.match(/fetchCategoryGroupMappings\(\)/g) ?? []).length, 1);
  assert.equal((parallel.match(/\.from\("pos_sales_receipt_payments"\)/g) ?? []).length, 1);
});

test("parallel reads preserve ranges, failures, pagination, and unchanged aggregation inputs", () => {
  assert.equal((route.match(/\.gte\("business_date", fromDate\)/g) ?? []).length, 3);
  assert.equal((route.match(/\.lte\("business_date", toDate\)/g) ?? []).length, 3);
  assert.match(route, /Failed to fetch monthly sales receipts:/);
  assert.match(route, /Failed to fetch monthly sales lines:/);
  assert.match(route, /Failed to fetch POS product categories:/);
  assert.match(route, /Failed to fetch category group mappings; using uncategorized fallback\./);
  assert.match(route, /Failed to fetch monthly sales payments:/);
  assert.match(route, /\.range\(offset, offset \+ LINE_PAGE_SIZE - 1\)/);
  const response = route.slice(route.indexOf("return NextResponse.json({", route.indexOf("export async function GET")));
  assert.match(response, /summary: buildMonthlySummary\(receiptRows\)/);
  assert.match(response, /taxSummary: buildTaxSummary\(receiptRows, lineRows\)/);
  assert.match(response, /menuSales: buildMenuSales\(/);
  assert.match(response, /days: buildDays\(/);
});
