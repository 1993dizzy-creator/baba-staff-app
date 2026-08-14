import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const businessTimeModulePath = "../lib/common/business-time.ts";
const statusCoreModulePath = "../lib/inventory/stock-check-status-core.ts";
const { getBusinessDate } = await import(businessTimeModulePath);
const { buildInventoryStatusByItemId, getDaysBetweenBusinessDates } =
  await import(statusCoreModulePath);

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608140001_add_inventory_latest_stock_checks_rpc.sql",
    import.meta.url
  ),
  "utf8"
);

const vietnamParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

const sqlFallbackModel = (value: string) => {
  const parts = new Map(
    vietnamParts.formatToParts(new Date(value)).map((part) => [
      part.type,
      part.value,
    ])
  );
  const shifted = new Date(
    Date.UTC(
      Number(parts.get("year")),
      Number(parts.get("month")) - 1,
      Number(parts.get("day")),
      Number(parts.get("hour")) - 3,
      Number(parts.get("minute")),
      Number(parts.get("second"))
    )
  );
  return shifted.toISOString().slice(0, 10);
};

test("SQL legacy fallback matches the existing Vietnam 03:00 cutoff", () => {
  const fixtures = [
    ["2026-08-14T19:59:00Z", "2026-08-14"],
    ["2026-08-14T20:00:00Z", "2026-08-15"],
    ["2026-08-14T20:01:00Z", "2026-08-15"],
    ["2026-08-14T18:30:00Z", "2026-08-14"],
    ["2026-01-01T19:59:00Z", "2026-01-01"],
  ] as const;

  for (const [timestamp, expected] of fixtures) {
    assert.equal(sqlFallbackModel(timestamp), expected);
    assert.equal(getBusinessDate(new Date(timestamp)), expected);
  }

  assert.match(migration, /at time zone 'Asia\/Ho_Chi_Minh'/);
  assert.match(migration, /- interval '3 hours'/);
});

test("RPC aggregates one latest date per item and preserves legacy fallback", () => {
  assert.match(migration, /max\s*\([\s\S]*coalesce\s*\(/);
  assert.match(migration, /logs\.business_date/);
  assert.match(migration, /logs\.created_at/);
  assert.match(migration, /group by logs\.item_id/);
  assert.match(migration, /logs\.reason = 'stock_check'/);
  assert.doesNotMatch(migration, /create\s+index/i);
});

test("business-date and legacy candidates share the same latest-date ordering", () => {
  const rows = [
    { itemId: 1, businessDate: "2026-08-10", createdAt: null },
    {
      itemId: 1,
      businessDate: null,
      createdAt: "2026-08-11T19:59:00Z",
    },
    {
      itemId: 1,
      businessDate: null,
      createdAt: "2026-08-11T20:00:00Z",
    },
    { itemId: 2, businessDate: "2026-08-09", createdAt: null },
  ];
  const latestByItemId = new Map<number, string>();

  for (const row of rows) {
    const candidate = row.businessDate || sqlFallbackModel(row.createdAt!);
    const current = latestByItemId.get(row.itemId);
    if (!current || candidate > current) {
      latestByItemId.set(row.itemId, candidate);
    }
  }

  assert.equal(latestByItemId.get(1), "2026-08-12");
  assert.equal(latestByItemId.get(2), "2026-08-09");
  assert.equal(latestByItemId.has(3), false);
});

test("RPC is read-only, invoker-scoped, and executable only by service_role", () => {
  assert.match(migration, /language sql[\s\S]*stable[\s\S]*security invoker/);
  assert.match(migration, /set search_path = pg_catalog, public/);
  assert.match(migration, /revoke all[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute[\s\S]*to service_role/);
  assert.doesNotMatch(migration, /\b(insert|update|delete|truncate)\b/i);
});

test("status calculation covers missing, recent, stale, and future dates", () => {
  const statuses = buildInventoryStatusByItemId({
    itemIds: [1, 2, 3, 4, 5, 6],
    currentBusinessDate: "2026-08-14",
    saleDeductionActiveItemIds: new Set([1, 6]),
    latestStockChecks: [
      { item_id: 1, last_stock_check_date: "2026-08-01" },
      { item_id: 2, last_stock_check_date: "2026-08-08" },
      { item_id: 3, last_stock_check_date: "2026-08-07" },
      { item_id: 4, last_stock_check_date: "2026-08-06" },
      { item_id: 5, last_stock_check_date: "2026-08-15" },
    ],
  });

  assert.deepEqual(statuses.get(1), {
    lastStockCheckDate: "2026-08-01",
    daysSinceStockCheck: 13,
    needsStockCheck: false,
  });
  assert.equal(statuses.get(2)?.daysSinceStockCheck, 6);
  assert.equal(statuses.get(2)?.needsStockCheck, false);
  assert.equal(statuses.get(3)?.daysSinceStockCheck, 7);
  assert.equal(statuses.get(3)?.needsStockCheck, true);
  assert.equal(statuses.get(4)?.daysSinceStockCheck, 8);
  assert.equal(statuses.get(4)?.needsStockCheck, true);
  assert.equal(statuses.get(5)?.daysSinceStockCheck, 0);
  assert.equal(statuses.get(5)?.needsStockCheck, false);
  assert.deepEqual(statuses.get(6), {
    lastStockCheckDate: null,
    daysSinceStockCheck: null,
    needsStockCheck: false,
  });
});

test("invalid dates preserve the existing defensive status behavior", () => {
  assert.equal(getDaysBetweenBusinessDates("invalid", "2026-08-14"), null);

  const status = buildInventoryStatusByItemId({
    itemIds: [1],
    currentBusinessDate: "2026-08-14",
    saleDeductionActiveItemIds: new Set(),
    latestStockChecks: [
      { item_id: 1, last_stock_check_date: "invalid" },
    ],
  }).get(1);

  assert.deepEqual(status, {
    lastStockCheckDate: "invalid",
    daysSinceStockCheck: null,
    needsStockCheck: true,
  });
});

test("the status route uses one RPC and runs independent reads in parallel", () => {
  const route = readFileSync(
    new URL("../app/api/inventory/items/status/route.ts", import.meta.url),
    "utf8"
  );
  const helper = readFileSync(
    new URL("../lib/inventory/stock-check-status-server.ts", import.meta.url),
    "utf8"
  );

  assert.match(route, /fetchInventoryStatusByItemId/);
  assert.match(helper, /rpc\("inventory_latest_stock_checks_v1"/);
  assert.match(
    helper,
    /Promise\.all\(\[\s*fetchRecentSaleDeductionItemIds[\s\S]*fetchLatestStockChecks/
  );
  assert.doesNotMatch(helper, /\.eq\("reason", "stock_check"\)/);
  assert.doesNotMatch(helper, /select\("item_id, business_date, created_at"\)/);
});
