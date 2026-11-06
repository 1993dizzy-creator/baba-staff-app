// Real saveReceipts/saveLines against an in-memory Supabase mock (no network, no database):
// paging-with-detail (ignoreRawJsonOnlyChanges) skips raw_json-only rewrites; the legacy path is unchanged.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as syncCompare from '../lib/pos/cukcuk/sales-receipt-sync-compare.ts';
import * as inventoryChange from '../lib/pos/cukcuk/sales-receipt-inventory-change.ts';
import * as paymentSnapshot from '../lib/pos/cukcuk/payment-snapshot.ts';
import { buildPosBusinessDaySource } from '../lib/ledger/pos-sales-source.ts';

function load(path, deps) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => { assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name]; }, testModule, testModule.exports);
  return testModule.exports;
}

function harness({ receipts = [], lines = [] }) {
  const writes = [];
  const supabase = {
    from(table) {
      const state = { table, filters: [], payload: null, kind: 'select' };
      const builder = {
        select() { return builder; }, order() { return builder; }, limit() { return builder; }, gt() { return builder; }, returns() { return builder; },
        eq(...a) { state.filters.push(['eq', ...a]); return builder; }, in(...a) { state.filters.push(['in', ...a]); return builder; },
        not() { return builder; }, or(...a) { state.filters.push(['or', ...a]); return builder; },
        update(payload) { state.kind = 'update'; state.payload = payload; return builder; },
        insert(rows) { state.kind = 'insert'; state.payload = rows; return builder; },
        then(resolve, reject) {
          let data = [];
          if (state.kind !== 'select') {
            writes.push(state);
            data = state.kind === 'insert' ? state.payload.map((row, i) => ({ id: 900 + i, ref_id: row.ref_id })) : null;
          } else if (table === 'pos_sales_receipts') {
            const modifiedOnly = state.filters.some(f => f[0] === 'eq' && f[1] === 'is_modified');
            data = modifiedOnly ? receipts.filter(r => r.is_modified) : receipts;
          } else if (table === 'pos_sales_receipt_lines') data = lines;
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
  return { sync, writes };
}

const NEW = { ignoreRawJsonOnlyChanges: true };
const receiptBase = { source: 'cukcuk', branch_id: 'b', branch_code: null, branch_name: null, ref_id: 'ref-1', ref_no: 'R1', business_date: '2026-11-01',
  ref_date: '2026-11-01T12:00:00Z', payment_status: 3, is_canceled: false, total_amount: 100, discount_amount: 0, vat_amount: 0, final_amount: 100,
  receive_amount: 100, return_amount: 0, customer_name: null, table_name: 'A1' };
const storedReceipt = (extra = {}) => ({ ...receiptBase, id: 1, is_modified: false, raw_json: { RefID: 'ref-1', SAInvoiceDetails: [{ a: 1 }] },
  synced_at: '2026-11-01T13:00:00Z', updated_at: '2026-11-01T13:00:00Z', ...extra });
const incomingReceipt = (extra = {}) => ({ ...receiptBase, raw_json: { RefId: 'ref-1', SAInvoiceDetails: [{ a: 1, b: 2 }], ExtraNewKey: 1 },
  synced_at: '2026-11-02T13:00:00Z', updated_at: '2026-11-02T13:00:00Z', ...extra });

const lineBase = { source: 'cukcuk', receipt_id: 1, receipt_ref_id: 'ref-1', ref_detail_id: 'd1', parent_ref_detail_id: null, business_date: '2026-11-01',
  ref_date: '2026-11-01T12:00:00Z', sort_order: 1, item_id: 'i1', item_code: 'C1', item_name: 'Pho', unit_id: null, unit_name: null, quantity: 1,
  unit_price: 100, amount: 100, discount_amount: 0, final_amount: 100, tax_rate: 8, tax_amount: 0, pre_tax_amount: 100, tax_reduction_amount: 0,
  ref_detail_type: 1, inventory_item_type: 1, is_option: false, payment_status: 3, is_canceled: false };
const storedLine = (extra = {}) => ({ ...lineBase, id: 11, is_excluded: false, raw_json: { RefDetailID: 'd1', Quantity: 1 }, synced_at: 'x', updated_at: 'x', ...extra });
const incomingLine = (extra = {}) => ({ ...lineBase, raw_json: { RefDetailID: 'd1', Quantity: 1, NewShapeKey: true }, synced_at: 'y', updated_at: 'y', ...extra });
const updatesOf = (writes, table) => writes.filter(w => w.table === table && w.kind === 'update');

test('receipt: paging-with-detail skips raw_json-only differences; the legacy path still rewrites them', async () => {
  let h = harness({ receipts: [storedReceipt()] });
  const result = await h.sync.saveReceipts([incomingReceipt()], NEW);
  assert.deepEqual([result.updatedCount, result.changedReceiptIds, result.autoEligibleReceiptIds], [0, [], []]);
  assert.equal(h.writes.length, 0, 'no UPDATE, so updated_at is kept');
  h = harness({ receipts: [storedReceipt()] });
  assert.equal((await h.sync.saveReceipts([incomingReceipt()])).updatedCount, 1, 'legacy default unchanged');
});

test('receipt: real amount/status changes and new receipts still save on paging-with-detail', async () => {
  for (const change of [{ final_amount: 120 }, { discount_amount: 5 }, { total_amount: 90 }, { table_name: 'B2' }]) {
    const h = harness({ receipts: [storedReceipt()] });
    assert.equal((await h.sync.saveReceipts([incomingReceipt(change)], NEW)).updatedCount, 1, JSON.stringify(change));
  }
  let h = harness({ receipts: [storedReceipt({ payment_status: 1 })] });
  const status = await h.sync.saveReceipts([incomingReceipt()], NEW);
  assert.deepEqual([status.updatedCount, status.autoEligibleReceiptIds], [1, [1]]);
  assert.equal(updatesOf(h.writes, 'pos_sales_receipts')[0].payload.status_changed_at, '2026-11-02T13:00:00Z');
  h = harness({ receipts: [] });
  assert.equal((await h.sync.saveReceipts([incomingReceipt()], NEW)).createdCount, 1);
  // manual modification protection: a modified receipt is never rewritten
  h = harness({ receipts: [storedReceipt({ is_modified: true })] });
  assert.equal((await h.sync.saveReceipts([incomingReceipt({ final_amount: 999 })], NEW)).updatedCount, 0);
});

test('lines: paging-with-detail skips raw_json-only differences; real quantity/item/amount changes still update and reprocess', async () => {
  let h = harness({ receipts: [storedReceipt()], lines: [storedLine()] });
  let result = await h.sync.saveLines([incomingLine()], NEW);
  assert.deepEqual([result.createdCount, result.updatedCount, result.inventoryChangedReceiptIds], [0, 0, []]);
  assert.equal(updatesOf(h.writes, 'pos_sales_receipt_lines').length, 0);
  h = harness({ receipts: [storedReceipt()], lines: [storedLine()] });
  assert.equal((await h.sync.saveLines([incomingLine()])).updatedCount, 1, 'legacy default unchanged');
  h = harness({ receipts: [storedReceipt()], lines: [storedLine()] });
  result = await h.sync.saveLines([incomingLine({ quantity: 2 })], NEW);
  assert.deepEqual([result.updatedCount, result.inventoryChangedReceiptIds], [1, [1]]);
  for (const change of [{ item_id: 'i2' }, { final_amount: 90 }, { tax_amount: 7 }, { is_canceled: true }]) {
    h = harness({ receipts: [storedReceipt()], lines: [storedLine()] });
    assert.equal((await h.sync.saveLines([incomingLine(change)], NEW)).updatedCount, 1, JSON.stringify(change));
  }
  h = harness({ receipts: [storedReceipt()], lines: [] });
  assert.equal((await h.sync.saveLines([incomingLine()], NEW)).createdCount, 1, 'new lines still inserted');
});

test('ledger sourceFingerprint depends on receipt updated_at, so a skipped raw_json-only UPDATE keeps it stable', () => {
  const receipt = { id: 1, ref_no: 'R1', business_date: '2026-11-01', ref_date: '2026-11-01T12:00:00Z', payment_status: 3, is_canceled: false,
    final_amount: 100, revision: 0, updated_at: '2026-11-01T13:00:00Z' };
  const payment = { id: 5, receipt_id: 1, business_date: '2026-11-01', payment_type: 1, payment_name: 'Tiền mặt', card_name: null, amount: 100 };
  const before = buildPosBusinessDaySource('2026-11-01', [receipt], [payment]).sourceFingerprint;
  assert.equal(buildPosBusinessDaySource('2026-11-01', [{ ...receipt }], [payment]).sourceFingerprint, before);
  assert.notEqual(buildPosBusinessDaySource('2026-11-01', [{ ...receipt, updated_at: '2026-11-02T13:00:00Z' }], [payment]).sourceFingerprint, before,
    'an updated_at-only rewrite would have changed it');
});

test('sync route enables the option only on the paging-with-detail path', () => {
  const route = readFileSync('app/api/pos/cukcuk/sainvoices/sync-to-sales/route.ts', 'utf8');
  assert.match(route, /const saveOptions = \{ ignoreRawJsonOnlyChanges: usePagingWithDetail \};/);
  assert.match(route, /saveReceipts\(receiptRows, saveOptions\)/);
  assert.match(route, /saveLines\(lineRows, saveOptions\)/);
  assert.match(readFileSync('app/api/admin/sales/receipts/[id]/refresh-pos/route.ts', 'utf8'), /saveReceipts\(\[receiptForSave\]\)/);
});
