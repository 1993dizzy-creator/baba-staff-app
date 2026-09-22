import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/sales/monthly/page.tsx");
const route = read("app/api/admin/sales/monthly/route.ts");
const migration = read("supabase/migrations/20260922130901_add_pos_sales_receipt_lines_business_date_id_index.sql");

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
  assert.match(route, /const lineRows = lines;/);
  const response = route.slice(route.indexOf("return NextResponse.json({", route.indexOf("export async function GET")));
  assert.match(response, /summary: buildMonthlySummary\(receiptRows\)/);
  assert.match(response, /taxSummary: buildTaxSummary\(receiptRows, lineRows\)/);
  assert.match(response, /menuSales: buildMenuSales\(\s*receiptRows,\s*lineRows,\s*productCategories,\s*categoryGroupMappings\s*\)/);
  assert.match(response, /days: buildDays\(\{\s*month,\s*receipts: receiptRows,\s*lines: lineRows,\s*payments: paymentRows,\s*\}\)/);
});

test("monthly lines use business date and id ordering with the matching btree index", () => {
  const fetchLines = route.slice(
    route.indexOf("async function fetchMonthlyLines"),
    route.indexOf("async function fetchProductCategories")
  );
  assert.match(fetchLines, /\.gte\("business_date", fromDate\)\s*\.lte\("business_date", toDate\)\s*\.order\("business_date", \{ ascending: true \}\)\s*\.order\("id", \{ ascending: true \}\)\s*\.range\(offset, offset \+ LINE_PAGE_SIZE - 1\)/);
  assert.match(fetchLines, /offset \+= LINE_PAGE_SIZE/);
  assert.match(fetchLines, /if \(page\.length < LINE_PAGE_SIZE\) break;/);
  assert.match(fetchLines, /raw_json/);
  assert.match(migration, /create index pos_sales_receipt_lines_business_date_id_idx\s+on public\.pos_sales_receipt_lines using btree \(business_date asc, id asc\);/i);
});

test("monthly line pagination returns every row once across equal-date page boundaries", async () => {
  type Line = { id: number; business_date: string };
  const rows: Line[] = Array.from({ length: 2005 }, (_, index) => ({
    id: 2005 - index,
    business_date: `2026-05-${String((index % 3) + 1).padStart(2, "0")}`,
  }));
  rows.push({ id: 2006, business_date: "2026-04-30" });
  rows.push({ id: 2007, business_date: "2026-06-01" });
  const ranges: Array<[number, number]> = [];
  const orders: Array<Array<[string, boolean]>> = [];

  const supabaseServer = {
    from(table: string) {
      assert.equal(table, "pos_sales_receipt_lines");
      let fromDate = "";
      let toDate = "";
      const orderBy: Array<[string, boolean]> = [];
      return {
        select(columns: string) {
          assert.match(columns, /raw_json/);
          return this;
        },
        gte(column: string, value: string) {
          assert.equal(column, "business_date");
          fromDate = value;
          return this;
        },
        lte(column: string, value: string) {
          assert.equal(column, "business_date");
          toDate = value;
          return this;
        },
        order(column: string, options: { ascending: boolean }) {
          orderBy.push([column, options.ascending]);
          return this;
        },
        range(start: number, end: number) {
          ranges.push([start, end]);
          orders.push([...orderBy]);
          const data = rows
            .filter((row) => row.business_date >= fromDate && row.business_date <= toDate)
            .sort((a, b) => {
              for (const [column, ascending] of orderBy) {
                const left = a[column as keyof Line];
                const right = b[column as keyof Line];
                if (left !== right) return (left < right ? -1 : 1) * (ascending ? 1 : -1);
              }
              return 0;
            })
            .slice(start, end + 1);
          return Promise.resolve({ data, error: null });
        },
      };
    },
  };
  const fetchLinesSource = route.slice(
    route.indexOf("async function fetchMonthlyLines"),
    route.indexOf("async function fetchProductCategories")
  );
  const executable = transpileModule(
    `const LINE_PAGE_SIZE = 1000;\n${fetchLinesSource}\nfetchMonthlyLines;`,
    { compilerOptions: { target: ScriptTarget.ES2022 } }
  ).outputText;
  const fetchMonthlyLines = runInNewContext(executable, { supabaseServer }) as (
    fromDate: string,
    toDate: string
  ) => Promise<Line[]>;

  const result = await fetchMonthlyLines("2026-05-01", "2026-05-31");
  const expected = rows
    .filter((row) => row.business_date.startsWith("2026-05-"))
    .sort((a, b) => a.business_date.localeCompare(b.business_date) || a.id - b.id);
  assert.deepEqual(Array.from(result, (line) => line.id), expected.map((line) => line.id));
  assert.equal(new Set(Array.from(result, (line) => line.id)).size, 2005);
  assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.deepEqual(orders, Array.from({ length: 3 }, () => [
    ["business_date", true],
    ["id", true],
  ]));
});
