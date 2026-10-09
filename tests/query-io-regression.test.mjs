import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function load(path, dependencies = {}) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, testModule, testModule.exports);
  return testModule.exports;
}

function database(tables, { failTable, failAfter = Infinity } = {}) {
  const reads = [], writes = [];
  return {
    reads, writes,
    from(table) {
      let columns = '*', limit = 1000, patch;
      const filters = [], orders = [];
      const query = {
        returns() { return query; },
        select(value) { columns = value; return query; },
        eq(key, value) { filters.push(row => row[key] === value); return query; },
        in(key, values) { filters.push(row => values.includes(row[key])); return query; },
        gt(key, value) { filters.push(row => row[key] > value); return query; },
        lt(key, value) { filters.push(row => row[key] < value); return query; },
        is(key, value) { filters.push(row => row[key] === value); return query; },
        or(value) {
          const match = value.match(/^created_at\.lt\.(.+),and\(created_at\.eq\.(.+),id\.lt\.(\d+)\),created_at\.is\.null$/);
          assert.ok(match, value);
          filters.push(row => row.created_at === null || row.created_at < match[1] || (row.created_at === match[2] && row.id < Number(match[3])));
          return query;
        },
        order(key, options) { orders.push([key, options]); return query; },
        limit(value) { limit = Math.min(1000, value); return query; },
        update(value) { patch = value; return query; },
        async then(resolve, reject) {
          try {
            let rows = (tables[table] || []).filter(row => filters.every(filter => filter(row)));
            if (patch) {
              rows.forEach(row => Object.assign(row, patch));
              writes.push({ table, ids: rows.map(row => row.id), patch });
              return resolve({ data: null, error: null });
            }
            rows.sort((a, b) => {
              for (const [key, options] of orders) {
                if (a[key] === b[key]) continue;
                if (a[key] === null) return options.nullsFirst === false ? 1 : -1;
                if (b[key] === null) return options.nullsFirst === false ? -1 : 1;
                return (a[key] < b[key] ? -1 : 1) * (options.ascending ? 1 : -1);
              }
              return 0;
            });
            rows = rows.slice(0, limit).map(row => columns === '*' ? { ...row } : Object.fromEntries(columns.split(',').map(key => key.trim()).map(key => [key, row[key]])));
            reads.push({ table, columns, count: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows)) });
            if (table === failTable && reads.filter(read => read.table === table).length > failAfter) {
              return resolve({ data: null, error: { message: 'isolated read failure' } });
            }
            return resolve({ data: rows, error: null });
          } catch (error) { return reject(error); }
        },
      };
      return query;
    },
  };
}

function inventory(db, authenticated = true) {
  return load('app/api/inventory/logs/route.ts', {
    'next/server': { NextResponse: { json: (data, options) => Response.json(data, options) } },
    '@/lib/auth/server-auth': { getAuthenticatedActor: async () => authenticated ? { ok: true } : { ok: false, code: 'UNAUTHENTICATED', status: 401 } },
    '@/lib/inventory/reasons': { normalizeInventoryReason: value => value },
    '@/lib/inventory/keg-replacement-summary': {
      fetchPreviousKegSessionSummariesByLogId: async () => new Map(),
      fetchPreviousKegSummariesByLogId: async () => new Map(),
    },
    '@/lib/supabase/server': { supabaseServer: db },
    '@/lib/inventory/log-sync-server': {}, '@/lib/ledger/inventory-projection': {},
    '@/lib/inventory/supplier-partners-server': {}, '@/lib/inventory/price-logs': {},
  });
}

function sales(db) {
  return load('lib/pos/cukcuk/sales-receipt-sync.ts', {
    '@/lib/supabase/server': { supabaseServer: db },
    '@/lib/pos/cukcuk/sales-receipt-inventory-change': load('lib/pos/cukcuk/sales-receipt-inventory-change.ts'),
    '@/lib/pos/cukcuk/sales-receipt-sync-compare': load('lib/pos/cukcuk/sales-receipt-sync-compare.ts'),
    '@/lib/pos/cukcuk/payment-snapshot': load('lib/pos/cukcuk/payment-snapshot.ts'),
  });
}

const logs = (count) => Array.from({ length: count }, (_, i) => ({
  id: i + 1, item_id: i % 3, created_at: i < count - 510 ? '2026-09-02T12:00:00.000001+00:00' : null,
  action: 'update', source: 'quick_save', reason: 'purchase', business_date: i % 2 ? '2026-09-02' : '2026-09-01',
  item_name: i === 0 ? 'old searchable' : 'Chicken', item_name_vi: 'Gà', part: 'food',
  prev_note: 'before', new_note: 'after', prev_quantity: 2, new_quantity: 1,
  unused_payload: 'x'.repeat(1024),
}));

test('inventory full history exceeds 1000, preserves timestamp ties and nullable timestamps without duplicates', async () => {
  const input = logs(1505), db = database({ inventory_logs: input });
  const response = await inventory(db).GET(new Request('http://local/api/inventory/logs?mode=logs'));
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 1505);
  assert.equal(new Set(result.data.map(row => row.id)).size, 1505);
  assert.deepEqual(result.data.map(row => row.id), [...input].sort((a,b) => (a.created_at === b.created_at ? b.id - a.id : a.created_at === null ? 1 : -1)).map(row => row.id));
  assert.equal(db.reads.length, 4);
  assert.equal(db.writes.length, 0);
});

test('inventory page narrows fields, keeps old searchable history and all inventory notes', async () => {
  const input = logs(1505), notes = Array.from({ length: 1005 }, (_, i) => ({ id: i+1, note: 'note' }));
  const db = database({ inventory_logs: input, inventory: notes });
  const result = await (await inventory(db).GET(new Request('http://local/api/inventory/logs?mode=page'))).json();
  assert.equal(result.logsResult.data.length, 1505);
  assert.equal(result.notesResult.data.length, 1005);
  assert.equal(result.logsResult.data.find(row => row.id === 1).item_name, 'old searchable');
  assert.equal(result.logsResult.data.find(row => row.id === 1).prev_note, 'before');
  assert.ok(!('unused_payload' in result.logsResult.data[0]));
  const before = Buffer.byteLength(JSON.stringify(input));
  const after = db.reads.filter(row => row.table === 'inventory_logs').reduce((sum,row) => sum + row.bytes, 0);
  console.log(JSON.stringify({ benchmark: 'inventory same 1505 rows', fullBytes: before, projectedBytes: after, requests: 4 }));
  assert.ok(after < before / 2);
});

test('inventory filters apply on every page and recent route delegates to the shared query', async () => {
  const db = database({ inventory_logs: logs(1505) }), route = inventory(db);
  const result = await (await route.GET(new Request('http://local/api/inventory/logs?mode=logs&businessDate=2026-09-02&reason=purchase&itemId=1'))).json();
  assert.ok(result.data.length > 0);
  assert.ok(result.data.every(row => row.business_date === '2026-09-02' && row.item_id === 1));
  const recent = load('app/api/inventory/logs/recent/route.ts', { '../route': route });
  const actual = await (await recent.GET(new Request('http://local/api/inventory/logs/recent'))).json();
  assert.deepEqual(actual.data.map(row => row.id), [995, 994, 993]);
});

test('unauthenticated inventory reads make no DB requests', async () => {
  const db = database({});
  assert.equal((await inventory(db, false).GET(new Request('http://local/api/inventory/logs?mode=page'))).status, 401);
  assert.equal(db.reads.length, 0);
});

test('later inventory read errors do not publish a silently truncated success', async () => {
  const db = database({ inventory_logs: logs(1505), inventory: [] }, { failTable: 'inventory_logs', failAfter: 1 });
  const result = await (await inventory(db).GET(new Request('http://local/api/inventory/logs?mode=page'))).json();
  assert.equal(result.logsResult.ok, false);
  assert.equal(result.notesResult.ok, true);
});

const lines = (count, receipt = 'receipt') => Array.from({ length: count }, (_, i) => ({
  id: i + 1, source: 'cukcuk', receipt_id: 1, receipt_ref_id: receipt, ref_detail_id: `detail-${i}`,
  parent_ref_detail_id: null, sort_order: i, item_id: 'item', item_code: 'code', item_name: 'Rice',
  quantity: 1, unit_price: 100, final_amount: 100, is_option: false, ref_detail_type: 1,
  is_excluded: false, business_date: i % 2 ? '2026-08-31' : '2026-09-02', raw_json: { payload: 'x'.repeat(4096) },
}));

test('POS existing lookup reads every detail beyond 1000 including old dates and excluded rows', async () => {
  const input = lines(1505); input[1504].is_excluded = true;
  const db = database({ pos_sales_receipt_lines: input });
  const actual = await sales(db).getExistingLines(['receipt', 'receipt']);
  assert.equal(actual.rows.length, 1505);
  assert.equal(actual.byRefDetailKey.size, 1504);
  assert.equal(actual.byRefDetailKey.get('receipt::detail-1499').id, 1500);
  assert.deepEqual(actual.rows.map(row => row.id), input.map(row => row.id));
  assert.equal(db.reads.length, 4);
});

test('POS large IN lists are bounded, deduplicated and complete', async () => {
  const refs = Array.from({ length: 205 }, (_, i) => `r${i}`);
  const input = refs.map((ref, i) => ({ ...lines(1, ref)[0], id: i+1 }));
  const db = database({ pos_sales_receipt_lines: input });
  const actual = await sales(db).getExistingLines([...refs, ...refs]);
  assert.equal(actual.rows.length, 205);
  assert.equal(db.reads.length, 3);
});

test('POS deduction protection includes receipt IDs beyond the 1000-row cap', async () => {
  const deductions = Array.from({ length: 1501 }, (_, i) => ({ id: i+1, receipt_id: i === 1500 ? 2 : 1 }));
  const db = database({ pos_inventory_deductions: deductions, pos_inventory_deduction_receipts: [{ id: 1, receipt_id: 3 }] });
  assert.deepEqual([...await sales(db).getReceiptsWithAppliedDeductions([1,2,3])].sort(), [1,2,3]);
});

test('POS stale re-read omits raw JSON, excludes the right detail exactly once and is idempotent', async () => {
  const input = lines(1505), db = database({ pos_sales_receipt_lines: input });
  const sync = sales(db);
  const params = { rows: input.slice(0,1504), receiptRows: new Map([['receipt', { id: 1, total_amount: 150400 }]]), skippedFallbackReceiptRefIds: new Set() };
  const before = Buffer.byteLength(JSON.stringify(input));
  const actual = await sync.excludeStaleLines(params);
  assert.equal(actual.excludedCount, 1);
  assert.deepEqual(db.writes[0].ids, [1505]);
  assert.equal(input[1504].final_amount, 100);
  assert.equal(input[0].business_date, '2026-09-02');
  const reads = db.reads.filter(row => row.table === 'pos_sales_receipt_lines');
  assert.ok(reads.every(row => !row.columns.includes('raw_json')));
  const after = reads.reduce((sum,row) => sum + row.bytes, 0);
  console.log(JSON.stringify({ benchmark: 'POS fresh stale read same 1505 rows', fullBytes: before, projectedBytes: after, requests: reads.length }));
  assert.ok(after < before / 5);
  assert.equal((await sync.excludeStaleLines(params)).excludedCount, 0);
  assert.equal(db.writes.length, 1);
});

test('POS modified receipt and ambiguous fallback protections remain active', async () => {
  for (const isModified of [true, false]) {
    const input = lines(2); input[1].sort_order = 0;
    const db = database({ pos_sales_receipt_lines: input });
    const actual = await sales(db).excludeStaleLines({ rows: [{ ...input[0], ref_detail_id: 'unknown' }],
      receiptRows: new Map([['receipt', { id: 1, total_amount: 100, is_modified: isModified }]]), skippedFallbackReceiptRefIds: new Set() });
    assert.equal(actual.excludedCount, 0);
    assert.equal(db.writes.length, 0);
  }
});

test('POS later page failure stops stale correction before any update', async () => {
  const input = lines(1505), db = database({ pos_sales_receipt_lines: input }, { failTable: 'pos_sales_receipt_lines', failAfter: 1 });
  await assert.rejects(sales(db).excludeStaleLines({ rows: input.slice(0, 1504), receiptRows: new Map([['receipt', { id: 1, total_amount: 150400 }]]), skippedFallbackReceiptRefIds: new Set() }), /isolated read failure/);
  assert.equal(db.writes.length, 0);
});

test('POS complete lookup repeat leaves VAT, raw payload and amounts unchanged', async () => {
  const input = lines(1000), snapshot = JSON.stringify(input), db = database({ pos_sales_receipt_lines: input });
  const sync = sales(db);
  const first = await sync.getExistingLines(['receipt']);
  const second = await sync.getExistingLines(['receipt']);
  assert.deepEqual(first.rows, second.rows);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(db.writes.length, 0);
});

test('POS actual saveLines repeated above 1000 rows creates no duplicates or updates', async () => {
  const input = lines(1505), snapshot = JSON.stringify(input);
  const db = database({ pos_sales_receipt_lines: input,
    pos_sales_receipts: [{ id: 1, source: 'cukcuk', ref_id: 'receipt', is_modified: false, total_amount: 150500 }],
  });
  const sync = sales(db);
  for (let run = 0; run < 2; run++) {
    const result = await sync.saveLines(input);
    assert.equal(result.createdCount, 0);
    assert.equal(result.updatedCount, 0);
    assert.equal(result.staleExcludedCount, 0);
    assert.deepEqual(result.inventoryChangedReceiptIds, []);
  }
  assert.equal(db.writes.length, 0);
  assert.equal(JSON.stringify(input), snapshot);
});

test('POS saveLines keeps one update per changed line and subsequent reads see committed amounts', async () => {
  const input = lines(2), db = database({ pos_sales_receipt_lines: input,
    pos_sales_receipts: [{ id: 1, source: 'cukcuk', ref_id: 'receipt', is_modified: false, total_amount: 250 }],
  });
  const payload = input.map(row => ({ ...row }));
  payload[0].final_amount = 150;
  const result = await sales(db).saveLines(payload);
  assert.equal(result.updatedCount, 1);
  assert.equal(result.createdCount, 0);
  assert.equal(result.staleExcludedCount, 0);
  assert.deepEqual(db.writes.map(write => write.ids), [[1]]);
  assert.equal(input[0].final_amount, 150);
  assert.equal(db.reads.filter(read => read.table === 'pos_sales_receipt_lines').length, 2);
});

function groupVisibleLogs(logs, lang, search = '', partFilter = 'all', filterType = 'all') {
  const source = readFileSync('app/(protected)/inventory/logs/page.tsx', 'utf8');
  const helpers = source.slice(source.indexOf('const getLogTime'), source.indexOf('export default function'));
  const start = source.indexOf('const { filteredLogs, visibleGroups } = useMemo(() => {');
  const body = source.slice(source.indexOf('{', source.indexOf('useMemo(() =>', start)) + 1,
    source.indexOf('}, [logs, filterType, search, partFilter, lang])', start));
  const code = ts.transpileModule(`${helpers}\nfunction run() { ${body} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function('logs', 'lang', 'search', 'partFilter', 'filterType', `${code}\nreturn run();`)(logs, lang, search, partFilter, filterType);
}

test('actual UI grouping respects KO/VI search, parts, actions, timestamp precision and id ties', () => {
  const input = [
    { id: 100, item_id: 1, code: 'C1', item_name: '닭', item_name_vi: 'Gà', part: 'kitchen', action: 'update', created_at: '2026-09-02T12:00:00.000001Z' },
    { id: 99, item_id: 1, code: 'C1', item_name: '닭', item_name_vi: 'Gà', part: 'kitchen', action: 'update', created_at: '2026-09-02T12:00:00.000002Z' },
    { id: 98, item_id: 1, code: 'C1', item_name: '닭', item_name_vi: 'Gà', part: 'kitchen', action: 'update', created_at: '2026-09-02T12:00:00.000002Z' },
    { id: 101, item_id: 2, item_name: '맥주', item_name_vi: 'Bia', part: 'bar', action: 'create', created_at: '2026-09-02T12:00:01Z' },
  ];
  for (const [lang, keyword] of [['ko','닭'], ['vi','gà']]) {
    const actual = groupVisibleLogs(input, lang, keyword, 'kitchen', 'update');
    assert.deepEqual(actual.filteredLogs.map(row => row.id), [99,98,100]);
    assert.equal(actual.visibleGroups.length, 1);
    assert.equal(actual.visibleGroups[0].latest.id, 99);
    assert.equal(actual.visibleGroups[0].groupKey, 'item-1');
    assert.equal(actual.visibleGroups[0].logs.length, 3);
  }
  assert.equal(groupVisibleLogs(input, 'vi', 'C1').filteredLogs.length, 3);
  assert.equal(groupVisibleLogs(input, 'ko', '', 'bar', 'create').filteredLogs[0].id, 101);
  assert.equal(groupVisibleLogs(input, 'ko', 'absent').filteredLogs.length, 0);
});

test('inventory date and reason filters remain complete beyond a filtered page boundary', async () => {
  const input = logs(1505).map(row => ({ ...row, item_id: 7, created_at: '2026-09-02T12:00:00Z', business_date: '2026-09-02' }));
  const db = database({ inventory_logs: input });
  const result = await (await inventory(db).GET(new Request('http://local/api/inventory/logs?mode=logs&businessDate=2026-09-02&reason=purchase&itemId=7'))).json();
  assert.equal(result.data.length, 1505);
  assert.deepEqual(result.data.map(row => row.id), input.map(row => row.id).reverse());
});
