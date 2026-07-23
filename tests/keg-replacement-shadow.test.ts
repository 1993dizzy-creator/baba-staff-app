import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const modulePath = "../lib/inventory/keg-replacement-summary.ts";
const {
  buildKegLineMatchFilter,
  buildKegSalesBreakdown,
  fetchAllKegReceiptLinePages,
} = await import(modulePath);

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("receipt-line pagination collects more than 1,288 rows and deduplicates ids", async () => {
  const rows = Array.from({ length: 1288 }, (_, index) => ({
    id: index + 1,
    receipt_id: 1,
    item_id: "regular",
    item_code: null,
    quantity: 1,
    is_option: false,
    is_excluded: false,
    is_canceled: false,
    payment_status: 3,
    ref_date: "2026-07-10T00:00:00.000Z",
    synced_at: null,
    updated_at: null,
  }));
  const ranges: Array<[number, number]> = [];
  const result = await fetchAllKegReceiptLinePages(async (
    from: number,
    to: number
  ) => {
    ranges.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  }, 500);

  assert.equal(result.length, 1288);
  assert.deepEqual(ranges, [
    [0, 499],
    [500, 999],
    [1000, 1499],
  ]);
});

test("L1 fixture reports all regular and tower sales using sold ml averages", () => {
  const unrelatedLines = Array.from({ length: 1200 }, (_, index) => ({
    id: 10_000 + index,
    receipt_id: 1,
    item_id: `unrelated-${index}`,
    item_code: `UNRELATED-${index}`,
    quantity: 99,
    is_option: false,
    is_excluded: false,
    is_canceled: false,
    payment_status: 3,
    ref_date: "2026-07-10T00:00:00.000Z",
    synced_at: null,
    updated_at: null,
  }));
  const breakdown = buildKegSalesBreakdown({
    mappings: [
      { pos_product_id: 10, quantity_per_pos_unit: 330 },
      { pos_product_id: 11, quantity_per_pos_unit: 3000 },
    ],
    products: [
      {
        id: 10,
        pos_item_id: "regular",
        item_id: null,
        item_code: "REG",
        item_name: "Carlsberg glass",
        unit_name: "Cup",
      },
      {
        id: 11,
        pos_item_id: "tower",
        item_id: null,
        item_code: "TOWER",
        item_name: "Carlsberg tower",
        unit_name: "Tháp",
      },
    ],
    receipts: [
      {
        id: 1,
        ref_date: "2026-07-10T00:00:00.000Z",
        synced_at: null,
        updated_at: null,
        payment_status: 3,
        is_canceled: false,
      },
    ],
    lines: [
      {
        id: 101,
        receipt_id: 1,
        item_id: "regular",
        item_code: "REG",
        quantity: 67,
        is_option: false,
        is_excluded: false,
        is_canceled: false,
        payment_status: 3,
        ref_date: "2026-07-10T00:00:00.000Z",
        synced_at: null,
        updated_at: null,
      },
      ...unrelatedLines,
      {
        id: 102,
        receipt_id: 1,
        item_id: "tower",
        item_code: "TOWER",
        quantity: 3,
        is_option: false,
        is_excluded: false,
        is_canceled: false,
        payment_status: 3,
        ref_date: "2026-07-10T00:00:00.000Z",
        synced_at: null,
        updated_at: null,
      },
    ],
    startedAt: "2026-07-07T14:14:00.000Z",
    endedAt: "2026-07-22T15:31:00.000Z",
    capacityMl: 20_000,
  });

  assert.equal(breakdown.regularUnits, 67);
  assert.equal(breakdown.towerUnits, 3);
  assert.equal(breakdown.regularSoldMl, 22_110);
  assert.equal(breakdown.towerSoldMl, 9_000);
  assert.equal(breakdown.expectedTotalMl, 31_110);
  assert.equal(breakdown.regularAverageMl, 330);
  assert.equal(breakdown.towerAverageMl, 3_000);
  assert.equal(Math.max(20_000 - 31_110, 0), 0);
  assert.equal(Math.max(31_110 - 20_000, 0), 11_110);
});

test("line query filter contains only mapped non-empty product keys", () => {
  const filter = buildKegLineMatchFilter([
    {
      id: 10,
      pos_item_id: "L1",
      item_id: "L5",
      item_code: "CARLSBERG",
      item_name: "Carlsberg",
      unit_name: "Cup",
    },
    {
      id: 11,
      pos_item_id: "",
      item_id: null,
      item_code: "TOWER",
      item_name: "Tower",
      unit_name: "Tháp",
    },
  ]);
  assert.match(filter, /item_id\.in\.\("L1","L5"\)/);
  assert.match(filter, /item_code\.in\.\("CARLSBERG","TOWER"\)/);
  assert.doesNotMatch(filter, /unrelated|null|""/i);

  const helper = read("lib/inventory/keg-replacement-summary.ts");
  assert.match(helper, /\.or\(lineMatchFilter\)/);
});

test("matching the same line by item id and item code counts it once", () => {
  const breakdown = buildKegSalesBreakdown({
    mappings: [{ pos_product_id: 10, quantity_per_pos_unit: 330 }],
    products: [{
      id: 10,
      pos_item_id: "same",
      item_id: "same",
      item_code: "SAME",
      item_name: "Glass",
      unit_name: "Cup",
    }],
    receipts: [{
      id: 1,
      ref_date: "2026-07-10T00:00:00.000Z",
      synced_at: null,
      updated_at: null,
      payment_status: 3,
      is_canceled: false,
    }],
    lines: [{
      id: 1,
      receipt_id: 1,
      item_id: "same",
      item_code: "SAME",
      quantity: 1,
      is_option: false,
      is_excluded: false,
      is_canceled: false,
      payment_status: 3,
      ref_date: "2026-07-10T00:00:00.000Z",
      synced_at: null,
      updated_at: null,
    }],
    startedAt: "2026-07-09T00:00:00.000Z",
    endedAt: "2026-07-11T00:00:00.000Z",
    capacityMl: 20_000,
  });
  assert.equal(breakdown.regularUnits, 1);
  assert.equal(breakdown.regularSoldMl, 330);
});

test("dry-run and log routes enforce session auth without writes", () => {
  const replaceRoute = read("app/api/inventory/keg-sessions/replace/route.ts");
  const logsRoute = read("app/api/inventory/logs/route.ts");
  const itemLogsRoute = read("app/api/inventory/items/[id]/logs/route.ts");
  const recentLogsRoute = read("app/api/inventory/logs/recent/route.ts");

  assert.ok(
    replaceRoute.indexOf("getAuthenticatedActor()") <
      replaceRoute.indexOf("req.json()")
  );
  assert.match(replaceRoute, /const dryRun = body\?\.dryRun === true/);
  assert.match(replaceRoute, /actorUsername: auth\.actor\.username/);
  assert.match(replaceRoute, /writesPerformed: false/);
  const dryRunBlock = replaceRoute.slice(
    replaceRoute.indexOf("if (dryRun)"),
    replaceRoute.indexOf(
      'const { data, error } = await supabaseServer.rpc("replace_inventory_keg"'
    )
  );
  assert.match(dryRunBlock, /return NextResponse\.json/);
  assert.doesNotMatch(
    dryRunBlock,
    /\.update\(|\.insert\(|\.delete\(|replace_inventory_keg/
  );
  assert.match(replaceRoute, /supabaseServer\.rpc\(\s*"calculate_inventory_keg_sales"/);
  assert.match(replaceRoute, /supabaseServer\.rpc\("replace_inventory_keg"/);
  assert.doesNotMatch(replaceRoute, /body\?\.actorUsername/);

  for (const route of [logsRoute, itemLogsRoute, recentLogsRoute]) {
    assert.match(route, /getAuthenticatedActor\(\)/);
    assert.match(route, /status: auth\.status/);
  }
  assert.match(logsRoute, /requireRole\(\["master"\]\)/);
  assert.doesNotMatch(logsRoute, /actorUsername|getActor/);
});

test("migration centralizes DB calculation and preserves server-only grants", () => {
  const migration = read(
    "supabase/migrations/202607230003_unify_keg_sales_calculation.sql"
  ).toLowerCase();
  const calculateStart = migration.indexOf(
    "create or replace function public.calculate_inventory_keg_sales"
  );
  const replaceStart = migration.indexOf(
    "create or replace function public.replace_inventory_keg"
  );
  const calculateSql = migration.slice(calculateStart, replaceStart);
  const replaceSql = migration.slice(replaceStart);

  for (const required of [
    "mapping.is_active = true",
    "mapping.target_type = 'product'",
    "line.item_id = product.pos_item_id",
    "line.item_id = product.item_id",
    "line.item_code = product.item_code",
    "coalesce(line.is_option, false) = false",
    "coalesce(line.is_excluded, false) = false",
    "coalesce(line.is_canceled, false) = false",
    "coalesce(receipt.is_canceled, false) = false",
    "line.payment_status = 3",
    "receipt.payment_status = 3",
    "partition by line.id",
    "match_rank = 1",
    "p_started_at",
    "p_ended_at",
  ]) {
    assert.ok(calculateSql.includes(required), required);
  }
  assert.doesNotMatch(calculateSql, /\b(update|insert|delete|truncate)\b/);
  assert.match(
    replaceSql,
    /v_sales := public\.calculate_inventory_keg_sales\(/
  );
  assert.doesNotMatch(
    replaceSql,
    /sum\(coalesce\(line\.quantity/
  );
  assert.match(
    migration,
    /from public, anon, authenticated/
  );
  assert.equal((migration.match(/to service_role, postgres/g) || []).length, 3);
  assert.doesNotMatch(migration, /from\s+(service_role|postgres)/);
});
