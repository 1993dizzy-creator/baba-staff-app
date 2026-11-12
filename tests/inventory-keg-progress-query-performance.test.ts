import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const modulePath = "../lib/inventory/keg-progress-core.ts";
const { calculateKegSalesForSession, getKegLineReferenceTime } = await import(
  modulePath
);

const paidReceipt = (id: number, values: Record<string, unknown> = {}) => ({
  id,
  ref_date: "2026-08-14T11:00:00.000Z",
  synced_at: null,
  updated_at: null,
  payment_status: 3,
  is_canceled: false,
  ...values,
});

const regularLine = (id: number, values: Record<string, unknown> = {}) => ({
  id,
  receipt_id: 1,
  item_id: "regular-id",
  item_code: "REG",
  quantity: 1,
  is_option: false,
  is_excluded: false,
  is_canceled: false,
  payment_status: 3,
  ref_date: "2026-08-14T11:00:00.000Z",
  synced_at: null,
  updated_at: null,
  ...values,
});

test("mapped Keg lines preserve exclusions, fallback order, boundaries, and per-mapping math", () => {
  const receipts = [
    paidReceipt(1),
    paidReceipt(2, { is_canceled: true }),
    paidReceipt(3, { ref_date: null, synced_at: "2026-08-14T11:00:00.000Z" }),
    paidReceipt(4, { ref_date: null, synced_at: null, updated_at: "2026-08-14T11:00:00.000Z" }),
  ];
  const result = calculateKegSalesForSession({
    startedAt: "2026-08-14T10:00:00.000Z",
    mappings: [
      { pos_product_id: 10, quantity_per_pos_unit: 100 },
      { pos_product_id: 11, quantity_per_pos_unit: 1000 },
      { pos_product_id: 12, quantity_per_pos_unit: 50 },
    ],
    products: [
      {
        id: 10,
        pos_item_id: "regular-id",
        item_id: "regular-id",
        item_code: "REG",
        item_name: "Regular glass",
        unit_name: "Cup",
      },
      {
        id: 11,
        pos_item_id: "tower-id",
        item_id: null,
        item_code: "TOWER",
        item_name: "Beer tower",
        unit_name: "Tower",
      },
      {
        id: 12,
        pos_item_id: "other-id",
        item_id: null,
        item_code: "OTHER",
        item_name: null,
        unit_name: null,
      },
    ],
    receipts,
    lines: [
      regularLine(1, { quantity: 2 }),
      regularLine(2, { is_option: true, quantity: 10 }),
      regularLine(3, { is_excluded: true, quantity: 10 }),
      regularLine(4, { is_canceled: true, quantity: 10 }),
      regularLine(5, { payment_status: 2, quantity: 10 }),
      regularLine(6, { receipt_id: 2, quantity: 10 }),
      regularLine(7, {
        ref_date: "2026-08-14T09:00:00.000Z",
        receipt_id: 1,
      }),
      regularLine(8, { ref_date: null, receipt_id: 1 }),
      regularLine(9, {
        ref_date: null,
        receipt_id: 3,
        synced_at: "2026-08-14T11:00:00.000Z",
      }),
      regularLine(10, { ref_date: null, receipt_id: 3, synced_at: null }),
      regularLine(11, {
        ref_date: null,
        receipt_id: 4,
        synced_at: null,
        updated_at: "2026-08-14T11:00:00.000Z",
      }),
      regularLine(12, { ref_date: "2026-08-14T09:59:59.999Z" }),
      regularLine(13, { ref_date: "2026-08-14T10:00:00.000Z" }),
      regularLine(14, { ref_date: "2026-08-14T10:00:00.001Z" }),
      regularLine(15, { receipt_id: 999 }),
      regularLine(16, {
        item_id: "tower-id",
        item_code: "NO-CODE-MATCH",
        quantity: 1,
      }),
      regularLine(17, {
        item_id: "no-id-match",
        item_code: "TOWER",
        quantity: 2,
      }),
      regularLine(18, {
        item_id: "other-id",
        item_code: "OTHER",
        quantity: 3,
      }),
    ],
  });

  assert.deepEqual(result, {
    soldMl: 3950,
    salesBreakdown: {
      totalUnits: 14,
      regularUnits: 8,
      regularSoldMl: 800,
      regularAverageMl: 100,
      towerUnits: 3,
      towerSoldMl: 3000,
      towerAverageMl: 1000,
      otherUnits: 3,
      otherSoldMl: 150,
    },
  });
});

test("the first valid timestamp wins even when a later fallback crosses the session start", () => {
  const receipt = paidReceipt(1, {
    ref_date: "2026-08-14T11:00:00.000Z",
  });
  const line = regularLine(1, {
    ref_date: "2026-08-14T09:00:00.000Z",
    synced_at: "2026-08-14T12:00:00.000Z",
  });
  assert.equal(
    getKegLineReferenceTime(line, receipt),
    Date.parse("2026-08-14T09:00:00.000Z")
  );
});

test("Keg progress selects mapped paid lines before fetching only referenced receipts", () => {
  const source = readFileSync(
    join(process.cwd(), "lib/inventory/keg-progress.ts"),
    "utf8"
  );
  const querySection = source.slice(
    source.indexOf("const lineSelect"),
    source.indexOf("const computeStartedAt")
  );

  assert.equal((querySection.match(/\.from\("pos_sales_receipt_lines"\)/g) || []).length, 1);
  assert.match(querySection, /withBusinessDateLowerBound\(/);
  assert.match(querySection, /\.eq\("payment_status", 3\)\s*\.or\(lineMatchFilter\)/);
  assert.match(querySection, /\.order\("id", \{ ascending: true \}\)\s*\.range\(from, to\)/);
  assert.match(querySection, /await fetchLinePages\(/);

  assert.match(querySection, /chunkArray\(receiptIds, POS_RECEIPT_ID_CHUNK_SIZE\)/);
  assert.match(querySection, /\.from\("pos_sales_receipts"\)[^]*?\.in\("id", receiptIdChunk\)/);
  assert.doesNotMatch(querySection, /lineTimeFilter|missingReceiptIds|timestampLinesStartedAt/);
  assert.doesNotMatch(querySection, /\.in\("receipt_id", receiptIdChunk\)/);
});

test("Keg progress exposes numeric Server-Timing metrics without changing JSON", () => {
  const route = readFileSync(
    join(process.cwd(), "app/api/inventory/keg-progress/route.ts"),
    "utf8"
  );
  const source = readFileSync(
    join(process.cwd(), "lib/inventory/keg-progress.ts"),
    "utf8"
  );
  const metrics = [
    "auth",
    "inventory",
    "mapping",
    "session_product",
    "receipts",
    "receipt_lines",
    "timestamp_lines",
    "line_queries_wall",
    "missing_receipts",
    "compute",
    "total",
  ];

  assert.match(route, /"Server-Timing": timing\.header\(\)/);
  assert.match(route, /return json\(\{ ok: true, progressMap \}\)/);
  assert.doesNotMatch(route, /progressMap[^}]*timing/);
  for (const metric of metrics) {
    assert.match(route + source, new RegExp(`"${metric}"`));
  }
  assert.match(route, /\.toFixed\(1\)/);
});

test("Keg paid-line scan retains the conservative business-date cutoff and receipt ID lookup", async () => {
  const source = readFileSync(join(process.cwd(), "lib/inventory/keg-progress.ts"), "utf8");
  const { ScriptTarget, transpileModule } = await import("typescript");
  const { runInNewContext } = await import("node:vm");
  const fnSource = source.slice(
    source.indexOf("const BUSINESS_DATE_LOWER_BOUND_MARGIN_DAYS"),
    source.indexOf("const withBusinessDateLowerBound")
  ).replace("export const", "const");
  const getLowerBound = runInNewContext(
    transpileModule(`${fnSource}\ngetKegBusinessDateLowerBound;`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
  ) as (value: string) => string | null;
  assert.equal(getLowerBound("2026-10-02T11:51:00+00:00"), "2026-09-30");
  assert.equal(getLowerBound("2026-10-01T17:30:00Z"), "2026-09-29");
  assert.equal(getLowerBound("not-a-date"), null);

  const section = source.slice(source.indexOf("const lineSelect"), source.indexOf("const computeStartedAt"));
  assert.match(section, /withBusinessDateLowerBound\(\s*supabase\.from\("pos_sales_receipt_lines"\)\.select\(lineSelect\),\s*businessDateLowerBound\s*\)/);
  assert.match(section, /\.eq\("payment_status", 3\)\s*\.or\(lineMatchFilter\)/);
  assert.match(section, /\.in\("id", receiptIdChunk\)/);
  assert.doesNotMatch(section, /\.or\(lineTimeFilter\)|\.gte\("ref_date"/);
  // An empty match filter skips the queries but still reaches the calculator.
  assert.match(section, /const lineRows = lineMatchFilter\s*\?/);
  assert.doesNotMatch(source, /if \(!lineMatchFilter\) return progressByItemId;/);
});

// ---------------------------------------------------------------------------
// Behavioural regression: run the real fetchKegProgressByItemId against an
// in-memory PostgREST stand-in and compare with the core calculator applied to
// the FULL tables (no query narrowing). Any narrowing that drops a countable
// line or receipt shows up as a difference.
// ---------------------------------------------------------------------------
type FakeRow = Record<string, unknown>;
type FakeQueryLog = { table: string; filters: string[]; rows: number };

const splitTopLevel = (expr: string) => {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (ch === "\\" && quoted) { current += ch + expr[i + 1]; i += 1; continue; }
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth += 1;
    if (!quoted && ch === ")") depth -= 1;
    if (!quoted && depth === 0 && ch === ",") { parts.push(current); current = ""; continue; }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
};

const compareValues = (a: unknown, b: unknown) => {
  const left = String(a);
  const right = String(b);
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
  return left < right ? -1 : left > right ? 1 : 0;
};

const parseInList = (value: string) =>
  splitTopLevel(value.replace(/^\(/, "").replace(/\)$/, "")).map((item) =>
    item.startsWith('"') ? item.slice(1, -1).replace(/\\(.)/g, "$1") : item
  );

const orCondition = (expr: string) => {
  const conditions = splitTopLevel(expr).map((part) => {
    const [column, op, ...rest] = part.split(".");
    const value = rest.join(".");
    if (op === "in") {
      const allowed = new Set(parseInList(value));
      return (row: FakeRow) => row[column] != null && allowed.has(String(row[column]));
    }
    if (op === "gte") return (row: FakeRow) => row[column] != null && compareValues(row[column], value) >= 0;
    if (op === "eq") return (row: FakeRow) => String(row[column]) === value;
    throw new Error(`unsupported or-op ${op}`);
  });
  return (row: FakeRow) => conditions.some((condition) => condition(row));
};

const createFakeSupabase = (tables: Record<string, FakeRow[]>) => {
  const log: FakeQueryLog[] = [];
  const from = (table: string) => {
    const filters: Array<(row: FakeRow) => boolean> = [];
    const described: string[] = [];
    let orderBy: { column: string; ascending: boolean } | null = null;
    let window: [number, number] | null = null;
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => { described.push(`eq:${column}`); filters.push((row) => row[column] === value); return query; },
      in: (column: string, values: unknown[]) => {
        described.push(`in:${column}`);
        const allowed = new Set(values.map(String));
        filters.push((row) => allowed.has(String(row[column])));
        return query;
      },
      gte: (column: string, value: unknown) => { described.push(`gte:${column}`); filters.push((row) => row[column] != null && compareValues(row[column], value) >= 0); return query; },
      or: (expr: string) => { described.push(`or:${expr.split(".")[0]}`); filters.push(orCondition(expr)); return query; },
      order: (column: string, options: { ascending: boolean }) => { orderBy = { column, ascending: options.ascending }; return query; },
      range: (start: number, end: number) => { window = [start, end]; return query; },
      then: (resolve: (value: { data: FakeRow[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) => {
        let rows = (tables[table] || []).filter((row) => filters.every((filter) => filter(row)));
        if (orderBy) {
          const { column, ascending } = orderBy;
          rows = [...rows].sort((a, b) => {
            if (a[column] == null) return 1;
            if (b[column] == null) return -1;
            const diff = compareValues(a[column], b[column]);
            return ascending ? diff : -diff;
          });
        }
        if (window) rows = rows.slice(window[0], window[1] + 1);
        log.push({ table, filters: described, rows: rows.length });
        return Promise.resolve({ data: rows.map((row) => ({ ...row })), error: null }).then(resolve, reject);
      },
    };
    return query;
  };
  return { client: { from } as never, log };
};

const loadKegProgress = async () => {
  // module.registerHooks exists in the Node 24 runtime but not in the installed @types/node.
  type ResolveNext = (specifier: string, context: unknown) => unknown;
  const { registerHooks } = (await import("node:module")) as unknown as {
    registerHooks: (hooks: { resolve: (specifier: string, context: unknown, nextResolve: ResolveNext) => unknown }) => void;
  };
  const { pathToFileURL } = await import("node:url");
  const { existsSync } = await import("node:fs");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("@/")) {
        const base = join(process.cwd(), specifier.slice(2));
        const file = existsSync(base + ".ts") ? base + ".ts" : base;
        return nextResolve(pathToFileURL(file).href, context);
      }
      return nextResolve(specifier, context);
    },
  });
  const kegProgressPath = "../lib/inventory/keg-progress.ts";
  return (await import(kegProgressPath)) as {
    fetchKegProgressByItemId: (params: Record<string, unknown>) => Promise<Map<number, Record<string, unknown>>>;
  };
};

const buildKegFixture = () => {
  const products = [
    { id: 1, pos_item_id: "pi-1", item_id: "it-1", item_code: "C1", item_name: "Bia tuoi", unit_name: "Ly" },
    { id: 2, pos_item_id: null, item_id: null, item_code: "C2", item_name: "Thap bia", unit_name: "Tháp" },
    { id: 3, pos_item_id: null, item_id: "it-x", item_code: "X", item_name: "Unmapped", unit_name: "Ly" },
  ];
  const mappings = [
    { inventory_item_id: 10, pos_product_id: 1, quantity_per_pos_unit: 330, unit: "ml", is_active: true, target_type: "product" },
    { inventory_item_id: 10, pos_product_id: 2, quantity_per_pos_unit: 2000, unit: "ml", is_active: true, target_type: "product" },
    { inventory_item_id: 11, pos_product_id: 1, quantity_per_pos_unit: 500, unit: "ml", is_active: true, target_type: "product" },
  ];
  const start10 = "2026-08-14T10:00:00.000Z";
  const start11 = "2026-08-10T00:00:00.000Z";
  const sessions = [
    { id: 100, inventory_item_id: 10, started_at: start10, capacity_quantity: 50000, capacity_unit: "ml", status: "active" },
    { id: 101, inventory_item_id: 11, started_at: start11, capacity_quantity: 30000, capacity_unit: "ml", status: "active" },
  ];
  const receipts: FakeRow[] = [];
  const lines: FakeRow[] = [];
  let lineId = 0;
  const receipt = (id: number, businessDate: string, values: FakeRow = {}) => {
    receipts.push({ id, business_date: businessDate, ref_date: "2026-08-14T12:00:00.000Z", synced_at: null, updated_at: null, payment_status: 3, is_canceled: false, ...values });
  };
  const line = (receiptId: number, values: FakeRow = {}) => {
    const parent = receipts.find((row) => row.id === receiptId)!;
    lineId += 1;
    lines.push({ id: lineId, receipt_id: receiptId, business_date: parent.business_date, item_id: "it-1", item_code: "C1", quantity: 1, is_option: false, is_excluded: false, is_canceled: false, payment_status: 3, ref_date: parent.ref_date, synced_at: null, updated_at: null, ...values });
  };
  // Bulk: 620 receipts x 2 lines -> >1000 matching lines (pagination) and >500 receipts (ID chunks).
  for (let id = 1; id <= 620; id += 1) {
    receipt(id, "2026-08-14");
    line(id);
    line(id, { item_id: null, item_code: "C2", quantity: id % 3 === 0 ? 2 : 1 });
  }
  // Unmapped product noise on the same receipts must never be counted.
  for (let id = 1; id <= 50; id += 1) line(id, { item_id: "it-x", item_code: "X" });
  // Status, cancellation and exclusion edges.
  receipt(1001, "2026-08-14"); line(1001, { is_canceled: true }); line(1001, { is_excluded: true }); line(1001, { is_option: true }); line(1001, { payment_status: 1 });
  receipt(1002, "2026-08-14", { is_canceled: true }); line(1002);
  receipt(1003, "2026-08-14", { payment_status: 1 }); line(1003);
  // Boundaries: exactly at the item-10 start counts; 1 ms before does not (for item 10).
  receipt(1004, "2026-08-14", { ref_date: start10 }); line(1004);
  receipt(1005, "2026-08-14", { ref_date: "2026-08-14T09:59:59.999Z" }); line(1005);
  // Fallback order: line ref_date null -> receipt ref_date (before start) wins over a late synced_at.
  receipt(1006, "2026-08-14", { ref_date: "2026-08-14T08:00:00.000Z" }); line(1006, { ref_date: null, synced_at: "2026-08-15T00:00:00.000Z" });
  // Late sync: no ref_date anywhere, synced after start -> counts.
  receipt(1007, "2026-08-14", { ref_date: null, synced_at: "2026-08-14T20:00:00.000Z" }); line(1007, { ref_date: null, synced_at: "2026-08-14T20:00:00.000Z" });
  // Late edit: old business_date inside the 2-day margin, receipt timestamps old, line updated later.
  receipt(1008, "2026-08-08", { ref_date: null, synced_at: null, updated_at: "2026-08-12T00:00:00.000Z" }); line(1008, { ref_date: null, synced_at: null, updated_at: "2026-08-12T00:00:00.000Z" });
  // Match by pos_item_id only.
  receipt(1009, "2026-08-14"); line(1009, { item_id: "pi-1", item_code: null });
  // Old sale (before both sessions, outside the business-date bound).
  receipt(1010, "2026-07-01", { ref_date: "2026-07-01T12:00:00.000Z" }); line(1010);
  // Line pointing to a receipt that does not exist is never counted.
  lineId += 1;
  lines.push({ id: lineId, receipt_id: 9999, business_date: "2026-08-14", item_id: "it-1", item_code: "C1", quantity: 1, is_option: false, is_excluded: false, is_canceled: false, payment_status: 3, ref_date: "2026-08-14T12:00:00.000Z", synced_at: null, updated_at: null });

  return {
    tables: {
      inventory_keg_tracking_mappings: mappings,
      inventory_keg_sessions: sessions,
      pos_products: products,
      pos_sales_receipts: receipts,
      pos_sales_receipt_lines: lines,
    } as Record<string, FakeRow[]>,
    inventoryItems: [{ id: 10, package_content_quantity: 50000 }, { id: 11, package_content_quantity: 30000 }],
    mappings, products, sessions, receipts, lines,
  };
};

test("Keg progress matches the full-table calculator across statuses, boundaries, late sync, exclusions and pagination", async () => {
  const { fetchKegProgressByItemId } = await loadKegProgress();
  const fixture = buildKegFixture();
  const { client, log } = createFakeSupabase(fixture.tables);
  const timings: Record<string, number> = {};
  const progress = await fetchKegProgressByItemId({
    supabase: client,
    inventoryItems: fixture.inventoryItems,
    kegCandidateIds: [10, 11],
    timing: (name: string, duration: number) => { timings[name] = duration; },
  });

  const round = (value: number) => Math.round(value * 1000) / 1000;
  for (const session of fixture.sessions) {
    const expected = calculateKegSalesForSession({
      mappings: fixture.mappings.filter((mapping) => mapping.inventory_item_id === session.inventory_item_id),
      products: fixture.products,
      receipts: fixture.receipts,
      lines: fixture.lines,
      startedAt: session.started_at,
    });
    const actual = progress.get(session.inventory_item_id)!;
    assert.ok(actual, `progress for ${session.inventory_item_id}`);
    assert.equal(actual.soldMl, round(expected.soldMl));
    assert.deepEqual(actual.salesBreakdown, expected.salesBreakdown);
    assert.equal(actual.activeSessionId, session.id);
    assert.equal(actual.capacityMl, session.capacity_quantity);
    const usage = round((round(expected.soldMl) / session.capacity_quantity) * 100);
    assert.equal(actual.usagePercent, usage);
    assert.equal(actual.remainingPercent, round(Math.max(0, 100 - usage)));
    assert.ok(expected.soldMl > 0);
  }
  // Hand-checked anchors: item 10 counts 620 bulk + 1004 + 1007 + 1009 regular lines,
  // and 620 bulk tower lines (206 of them quantity 2); 1005/1006/1008 are before its start.
  const item10 = progress.get(10)!.salesBreakdown as Record<string, number>;
  assert.equal(item10.regularUnits, 623);
  assert.equal(item10.towerUnits, 826);
  // Item 11 started earlier: the late-edited 1008 line counts as well.
  assert.equal((progress.get(11)!.salesBreakdown as Record<string, number>).regularUnits, 626);

  // Query shape: line pages first (bounded, paginated), then receipts by ID only.
  const lineQueries = log.filter((entry) => entry.table === "pos_sales_receipt_lines");
  const receiptQueries = log.filter((entry) => entry.table === "pos_sales_receipts");
  assert.ok(lineQueries.length >= 2, "more than one page of lines");
  for (const entry of lineQueries) assert.deepEqual(entry.filters, ["gte:business_date", "eq:payment_status", "or:item_id"]);
  assert.ok(receiptQueries.length >= 2, "receipt IDs are chunked");
  for (const entry of receiptQueries) assert.deepEqual(entry.filters, ["in:id"]);
  const fetchedReceiptRows = receiptQueries.reduce((sum, entry) => sum + entry.rows, 0);
  assert.equal(fetchedReceiptRows, 620 + 9, "only receipts referenced by fetched lines (orphan id 9999 has no row)");
  for (const metric of ["receipts", "receipt_lines", "line_queries_wall", "compute", "mapping", "session_product"]) {
    assert.equal(typeof timings[metric], "number", metric);
  }
});

test("Keg progress without any POS match key keeps a zero breakdown and skips POS sales queries", async () => {
  const { fetchKegProgressByItemId } = await loadKegProgress();
  const fixture = buildKegFixture();
  fixture.tables.pos_products = [{ id: 1, pos_item_id: null, item_id: null, item_code: null, item_name: "Bia", unit_name: "Ly" }];
  const { client, log } = createFakeSupabase(fixture.tables);
  const progress = await fetchKegProgressByItemId({ supabase: client, inventoryItems: fixture.inventoryItems, kegCandidateIds: [10] });
  const item = progress.get(10)!;
  assert.equal(item.soldMl, 0);
  assert.equal(item.remainingPercent, 100);
  assert.deepEqual(item.salesBreakdown, {
    totalUnits: 0, regularUnits: 0, regularSoldMl: 0, regularAverageMl: null,
    towerUnits: 0, towerSoldMl: 0, towerAverageMl: null, otherUnits: 0, otherSoldMl: 0,
  });
  assert.equal(log.filter((entry) => entry.table.startsWith("pos_sales_")).length, 0);
});
