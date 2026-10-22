// Real saveReceipts against an in-memory Supabase mock (no network, no database).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as syncCompare from '../lib/pos/cukcuk/sales-receipt-sync-compare.ts';
import * as inventoryChange from '../lib/pos/cukcuk/sales-receipt-inventory-change.ts';
import * as paymentSnapshot from '../lib/pos/cukcuk/payment-snapshot.ts';

function load(path, deps) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => { assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name]; }, testModule, testModule.exports);
  return testModule.exports;
}

function harness(existing, resolvedReceiptIds = []) {
  const updates = [];
  const supabase = {
    from(table) {
      const state = { table, filters: [], payload: null, kind: 'select' };
      const builder = {
        select() { return builder; }, eq(...a) { state.filters.push(['eq', ...a]); return builder; },
        in(...a) { state.filters.push(['in', ...a]); return builder; }, not(...a) { state.filters.push(['not', ...a]); return builder; },
        or(...a) { state.filters.push(['or', ...a]); return builder; },
        update(payload) { state.kind = 'update'; state.payload = payload; return builder; },
        insert(rows) { state.kind = 'insert'; state.payload = rows; return builder; },
        then(resolve, reject) {
          let data = null;
          if (state.kind === 'update') updates.push(state);
          else if (state.kind === 'insert') data = state.payload.map((row, index) => ({ id: 900 + index, ref_id: row.ref_id }));
          else if (table === 'pos_sales_receipts') data = existing;
          else if (table === 'pos_sales_receipt_modifications') {
            const ids = state.filters.find(f => f[0] === 'in')[2];
            data = resolvedReceiptIds.filter(id => ids.includes(id)).map(receipt_id => ({ receipt_id }));
          }
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  const sync = load('lib/pos/cukcuk/sales-receipt-sync.ts', {
    '@/lib/supabase/server': { supabaseServer: supabase },
    '@/lib/pos/cukcuk/sales-receipt-inventory-change': inventoryChange,
    '@/lib/pos/cukcuk/sales-receipt-sync-compare': syncCompare,
    '@/lib/pos/cukcuk/payment-snapshot': paymentSnapshot,
  });
  return { sync, updates };
}

const base = { source: 'cukcuk', branch_id: null, branch_code: null, branch_name: null, ref_no: 'R', business_date: '2026-10-20',
  ref_date: '2026-10-20T14:00:00Z', total_amount: 100, discount_amount: 0, vat_amount: 0, final_amount: 100, receive_amount: 100,
  return_amount: 0, customer_name: null, table_name: 'A1', raw_json: { a: 1 }, synced_at: '2026-10-20T15:00:00Z', updated_at: '2026-10-20T15:00:00Z' };
const stored = (id, extra) => ({ ...base, id, ref_id: 'ref-' + id, payment_status: 1, is_canceled: false, is_modified: false, ...extra });
const incoming = (id, extra) => ({ ...base, ref_id: 'ref-' + id, payment_status: 1, is_canceled: false,
  synced_at: '2026-10-20T15:05:00Z', updated_at: '2026-10-20T15:05:00Z', ...extra });

test('repeat sync with the same status never writes status_changed_at (identical row: no update at all)', async () => {
  const { sync, updates } = harness([stored(1), stored(2)]);
  await sync.saveReceipts([incoming(1), incoming(2, { table_name: 'B2' })]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.table_name, 'B2');
  assert.ok(!('status_changed_at' in updates[0].payload));
});

test('a real status change records status_changed_at = sync time, only while the receipt is unmodified', async () => {
  const { sync, updates } = harness([stored(1)]);
  await sync.saveReceipts([incoming(1, { payment_status: 3 })]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.status_changed_at, '2026-10-20T15:05:00Z');
  assert.ok(updates[0].filters.some(f => f[0] === 'or' && f[1] === 'is_modified.is.null,is_modified.eq.false'));
});

test('stale CUKCUK pending never reverts an admin resolution; other modified status changes still flow', async () => {
  const { sync, updates } = harness([stored(1, { payment_status: 3, is_modified: true }), stored(2, { payment_status: 3, is_modified: true })], [1]);
  await sync.saveReceipts([incoming(1), incoming(2, { payment_status: 4, is_canceled: true })]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].filters.find(f => f[0] === 'eq' && f[1] === 'id')[2], 2);
  assert.deepEqual([updates[0].payload.payment_status, updates[0].payload.is_canceled, updates[0].payload.status_changed_at], [4, true, '2026-10-20T15:05:00Z']);
});

test('new receipts are inserted without status_changed_at (ref_date stays the pending start)', async () => {
  const { sync, updates } = harness([]);
  const result = await sync.saveReceipts([incoming(7)]);
  assert.equal(result.createdCount, 1);
  assert.equal(updates.length, 0);
});

test('hold dates: recorded 03:05 holds plus the previous business day while it is unclosed and still pending', async () => {
  const run = async ({ checks, previousPending, closed }) => {
    const calls = [];
    const supabase = { from(table) {
      const state = { table, filters: [], head: false };
      const builder = {
        select(_c, options) { state.head = options?.head === true; return builder; },
        eq(...a) { state.filters.push(a); return builder; }, is() { return builder; }, not() { return builder; },
        in(...a) { state.filters.push(a); return builder; }, order() { return builder; }, limit() { return builder; },
        then(resolve, reject) {
          calls.push(state);
          const result = table === 'pos_sales_business_day_close_checks' ? { data: checks.map(business_date => ({ business_date })), error: null }
            : table === 'pos_sales_receipts' ? { count: previousPending, error: null }
            : { data: closed.map(business_date => ({ business_date })), error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return builder;
    } };
    const helper = load('lib/sales/pos-pending-payment.ts', {
      'server-only': {}, '@/lib/supabase/server': { supabaseServer: supabase },
      '@/lib/store-settings/business-time-core': { addStoreDays: (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10) },
      './pos-pending-payment-policy': await import('../lib/sales/pos-pending-payment-policy.ts'),
    });
    return { date: await helper.findOldestPendingCloseHoldDate('2026-10-21'), calls };
  };
  // 03:00-03:05 (or a manual close held before midnight): no record yet, yesterday still pending.
  const held = await run({ checks: [], previousPending: 2, closed: [] });
  assert.equal(held.date, '2026-10-20');
  // Same rule as sales_close_business_day_v1: only CUKCUK receipts hold the close.
  assert.ok(held.calls.find(c => c.table === 'pos_sales_receipts').filters.some(f => f[0] === 'source' && f[1] === 'cukcuk'));
  // Yesterday has no pending receipts left (resolved, not closed yet, no record): normal date.
  assert.equal((await run({ checks: [], previousPending: 0, closed: [] })).date, null);
  // Oldest recorded hold wins; closed dates are released.
  assert.equal((await run({ checks: ['2026-10-18', '2026-10-17'], previousPending: 1, closed: ['2026-10-17'] })).date, '2026-10-18');
  assert.equal((await run({ checks: [], previousPending: 3, closed: ['2026-10-20'] })).date, null);
});
