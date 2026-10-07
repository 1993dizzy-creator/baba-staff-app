import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as snapshots from '../lib/pos/cukcuk/payment-snapshot.ts';
import * as completeness from '../lib/pos/cukcuk/sales-sync-completeness.ts';
import * as inventoryChange from '../lib/pos/cukcuk/sales-receipt-inventory-change.ts';
import * as syncCompare from '../lib/pos/cukcuk/sales-receipt-sync-compare.ts';
import * as sources from '../lib/ledger/pos-sales-source.ts';
import * as businessTime from '../lib/common/business-time.ts';
import * as adapterCore from '../lib/store-settings/business-time-adapter-core.ts';
import { runManualCloseWorkflow, runPosFinalWorkflow } from '../lib/sales/pos-business-day-final-workflow.ts';
import { salesCloseText } from '../lib/text/sales-close.ts';

function load(path, dependencies) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, testModule, testModule.exports);
  return testModule.exports;
}

const payment = (amount, name = 'khac', type = 9) => ({ Amount: amount, PaymentName: name, PaymentType: type });
const invoice = (ref, amount = 1_000_000, status = 3, payments = [payment(amount)]) => ({
  RefID: ref, RefNo: ref, RefDate: '2026-10-06T18:00:00+07:00', PaymentStatus: status, FinalAmount: amount,
  ...(payments === null ? {} : { SAInvoicePayments: payments }),
});

// All network and database operations are replaced with local in-memory mocks.
// Execute the real sync POST, real savePayments, paginated source loader, refresh
// gate and both close workflows rather than duplicating completeness formulas.
async function harness(invoices, options, work) {
  const { businessDate = '2026-10-06', storedReceipts = [], storedPayments = [], limit = 100, detailFailure = false,
    detailMismatch = false, countUnavailable = false, truncateSourcePages = false, normalizedCanceledRefs = [] } = options;
  const receipts = new Map(storedReceipts.map(row => [row.ref_id, { ...row }]));
  let payments = storedPayments.map(row => ({ ...row }));
  let nextReceiptId = Math.max(0, ...storedReceipts.map(row => row.id)) + 1;
  let nextPaymentId = Math.max(0, ...payments.map(row => row.id)) + 1;
  let run = null;
  let nextRunId = 1;
  const warnings = [], reconciliationSnapshots = [], pages = [];
  const cutoffAt = new Date(Date.parse(businessDate + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10) + 'T03:00:00+07:00';
  const now = new Date(Date.parse(cutoffAt) + 10 * 60000);
  const supabase = {
    from(table) {
      let operation = 'select', values;
      const filters = {};
      const query = {
        insert(data) { operation = 'insert'; values = data; return query; },
        update(data) { operation = 'update'; values = data; return query; },
        select() { return query; }, eq(key, value) { filters[key] = value; return query; },
        gte(key, value) { filters.from = [key, value]; return query; },
        lte(key, value) { filters.to = [key, value]; return query; }, order() { return query; }, limit() { return query; },
        async single() {
          assert.equal(table, 'pos_sales_sync_runs'); assert.equal(operation, 'insert');
          run = { ...values, id: nextRunId++, error_message: null, started_at: new Date(Date.parse(cutoffAt) + 60000).toISOString() };
          return { data: { id: run.id }, error: null };
        },
        async maybeSingle() { assert.equal(table, 'pos_sales_sync_runs'); return { data: run, error: null }; },
        async range(from, to) {
          assert.ok(['pos_sales_receipts', 'pos_sales_receipt_payments'].includes(table));
          pages.push({ table, from, to });
          const rows = (table === 'pos_sales_receipts' ? [...receipts.values()] : payments)
            .filter(row => row.business_date >= filters.from[1] && row.business_date <= filters.to[1]).sort((a, b) => a.id - b.id);
          return { data: rows.slice(from, truncateSourcePages ? from + 1 : to + 1), count: countUnavailable ? null : rows.length, error: null };
        },
        then(resolve, reject) {
          assert.equal(table, 'pos_sales_sync_runs'); assert.equal(operation, 'update');
          Object.assign(run, values, { finished_at: new Date(Date.parse(cutoffAt) + 2 * 60000).toISOString() });
          return Promise.resolve({ error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name, { p_snapshots }) {
      assert.equal(name, 'reconcile_sales_receipt_payments_v1');
      reconciliationSnapshots.push(structuredClone(p_snapshots));
      let createdCount = 0, deletedCount = 0;
      for (const snapshot of p_snapshots) {
        deletedCount += payments.filter(row => row.receipt_ref_id === snapshot.receiptRefId).length;
        payments = payments.filter(row => row.receipt_ref_id !== snapshot.receiptRefId);
        for (const row of snapshot.payments) { payments.push({ ...row, id: nextPaymentId++ }); createdCount++; }
      }
      return { data: { createdCount, updatedCount: 0, deletedCount }, error: null };
    },
  };
  const serverDependency = { '@/lib/supabase/server': { supabaseServer: supabase } };
  const receiptSync = load('lib/pos/cukcuk/sales-receipt-sync.ts', {
    ...serverDependency, '@/lib/pos/cukcuk/payment-snapshot': snapshots,
    '@/lib/pos/cukcuk/sales-receipt-inventory-change': inventoryChange, '@/lib/pos/cukcuk/sales-receipt-sync-compare': syncCompare,
  });
  const sourceApi = load('lib/ledger/pos-sales.ts', {
    ...serverDependency, 'server-only': {}, './pos-sales-source': sources,
  });
  const route = load('app/api/pos/cukcuk/sainvoices/sync-to-sales/route.ts', {
    ...serverDependency, 'next/server': { NextResponse: Response },
    '@/lib/pos/cukcuk/auth': { loginCukcuk: async () => ({ accessToken: 'test-token', companyCode: 'test-company' }) },
    '@/lib/pos/api-guard': { requirePosAdminSecret: () => null }, '@/lib/common/business-time': businessTime,
    '@/lib/store-settings/business-time-adapter-core': adapterCore,
    '@/lib/store-settings/business-time-adapter': {
      loadBusinessTimeSnapshotsForDates: async () => new Map([[businessDate, adapterCore.createFallbackBusinessTimeSnapshot(businessDate)]]),
    },
    '@/lib/pos/cukcuk/sales-sync-completeness': completeness, '@/lib/ledger/pos-sales': sourceApi,
    '@/lib/pos/cukcuk/sales-receipt-sync': {
      ...receiptSync,
      buildReceiptRow(params) {
        const row = receiptSync.buildReceiptRow(params);
        return normalizedCanceledRefs.includes(row.ref_id) ? { ...row, is_canceled: true } : row;
      },
      async saveReceipts(rows) {
        const receiptIdMap = new Map();
        for (const row of rows) {
          const id = receipts.get(row.ref_id)?.id ?? nextReceiptId++;
          receipts.set(row.ref_id, { ...row, id, revision: 1 }); receiptIdMap.set(row.ref_id, id);
        }
        return { receiptIdMap, createdCount: rows.length, updatedCount: 0, statusChangedCount: 0, autoEligibleReceiptIds: [], timing: {} };
      },
      saveLines: async () => ({ createdCount: 0, updatedCount: 0, staleExcludedCount: 0, statusChangedCount: 0, inventoryChangedReceiptIds: [], timing: {} }),
      markReceiptsInventoryDeductionEligible: async () => {},
    },
  });
  const refresh = load('lib/sales/pos-business-day-refresh.ts', { ...serverDependency, 'server-only': {} });
  const originalFetch = globalThis.fetch, originalWarn = console.warn, originalLog = console.log, originalError = console.error;
  const previousSecret = process.env.POS_ADMIN_SECRET;
  process.env.POS_ADMIN_SECRET = 'local-test-secret';
  console.warn = (...args) => warnings.push(args); console.log = () => {}; console.error = () => {};
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/sync-to-sales')) return route.POST(new Request(url, init));
    if (path.endsWith('/paging')) return Response.json({ Success: true, Data: invoices });
    if (detailFailure) return Response.json({ Success: false }, { status: 500 });
    const detail = invoices.find(row => row.RefID === decodeURIComponent(path.split('/').at(-1)));
    assert.ok(detail, 'Unexpected network request');
    return Response.json({ Success: true, Data: detailMismatch ? { ...detail, RefID: 'wrong-ref' } : detail });
  };
  const sync = () => route.POST(new Request('https://local.test/api/pos/cukcuk/sainvoices/sync-to-sales', {
    method: 'POST', body: JSON.stringify({ businessDate, force: true, limit }),
  }));
  const manual = () => runManualCloseWorkflow({ role: 'owner', reclose: false }, {
    eligible: async () => true,
    refresh: () => refresh.forceRefreshPosBusinessDay('https://local.test', businessDate),
    close: async runId => { assert.equal(runId, run.id); return { status: 'closed', source: await sourceApi.loadPosBusinessDaySource(businessDate) }; },
  });
  const final = () => runPosFinalWorkflow({ date: businessDate, cutoffAt, now }, {
    now: () => now, claim: async () => 'test-lease', release: async () => {}, latest: async () => run,
    refresh: () => refresh.forceRefreshPosBusinessDay('https://local.test', businessDate),
    source: () => sourceApi.loadPosBusinessDaySource(businessDate),
    finalize: async (token, finalRun, source, failure) => ({ status: failure ?? 'verified_unchanged', source, run: finalRun }),
  });
  try {
    await work({ sync, manual, final, getRun: () => run, source: () => sourceApi.loadPosBusinessDaySource(businessDate),
      receipts, getPayments: () => payments, warnings, reconciliationSnapshots, pages });
  } finally {
    globalThis.fetch = originalFetch; console.warn = originalWarn; console.log = originalLog; console.error = originalError;
    if (previousSecret === undefined) delete process.env.POS_ADMIN_SECRET; else process.env.POS_ADMIN_SECRET = previousSecret;
  }
}

for (const status of [null, 0, 1, 2, 4, 5]) test(`A: status ${status} without a snapshot does not block either close workflow`, async () => {
  await harness([invoice('paid'), invoice('non-sale', 500_000, status, null)], {}, async h => {
    const data = await (await h.sync()).json();
    assert.equal(data.result.paymentSnapshotUnavailableCount, 0); assert.equal(h.getRun().source_complete, true);
    assert.ok(!h.warnings.some(([code]) => code === '[SALES_SYNC_PAYMENT_SNAPSHOT_UNAVAILABLE]'));
    assert.equal(h.receipts.size, 2); assert.equal((await h.manual()).status, 'closed');
    assert.equal((await h.final()).status, 'verified_unchanged');
  });
});

test('B: paid missing snapshot remains incomplete even when old stored payments reconcile', async () => {
  await harness([invoice('paid', 1_000_000, 3, null)], {
    storedReceipts: [{ id: 1, ref_id: 'paid' }], storedPayments: [{ id: 1, receipt_id: 1, receipt_ref_id: 'paid', business_date: '2026-10-06', payment_type: 9, payment_name: 'khac', card_name: null, amount: 1_000_000 }],
  }, async h => {
    const data = await (await h.sync()).json();
    assert.equal(data.result.paymentSnapshotUnavailableCount, 1); assert.equal(h.getRun().source_complete, false);
    assert.equal(h.reconciliationSnapshots.length, 0); assert.equal(h.getPayments().length, 1);
    await assert.rejects(h.manual(), /POS_CLOSE_SOURCE_INVALID/); assert.equal((await h.final()).status, 'source_invalid');
  });
});

for (const [name, rows, error] of [
  ['C: amount mismatch', [payment(900_000)], /RECONCILIATION_MISMATCH/],
  ['unknown payment bucket', [payment(1_000_000, 'unrecognized', null)], /BUCKET_ALLOCATION_MISMATCH/],
  ['paid empty snapshot', [], /RECONCILIATION_MISMATCH/],
]) test(`${name} still invalidates source and blocks both workflows`, async () => {
  await harness([invoice('paid', 1_000_000, 3, rows)], {}, async h => {
    await h.sync(); assert.equal(h.getRun().source_complete, false); await assert.rejects(h.source(), error);
    await assert.rejects(h.manual(), /POS_CLOSE_SOURCE_INVALID/); assert.equal((await h.final()).status, 'source_invalid');
  });
});

test('D: two canceled CUKCUK receipts plus manual other payment count once with exact October 6 buckets', async () => {
  const date = '2026-10-06', amount = 2_325_600;
  const cancelled = [invoice('2601006748', amount, 4, null), invoice('2601006750', amount, 4, null)];
  const normal = [invoice('cash', 7_465_700, 3, [payment(7_465_700, 'ti\u1ec1n m\u1eb7t', 1)]),
    invoice('transfer', 9_552_600, 3, [payment(9_552_600, 'chuy\u1ec3n kho\u1ea3n', 1)]),
    invoice('card', 4_294_200, 3, [payment(4_294_200, 'Visa', 2)]), invoice('other', 280_000)];
  await harness([...cancelled, ...normal], {
    storedReceipts: [{ id: 100, ref_id: 'manual', ref_no: 'M-261006-003', source: 'manual', business_date: date, ref_date: null, payment_status: 3, is_canceled: false, final_amount: amount, revision: 1, updated_at: null }],
    storedPayments: [{ id: 100, receipt_id: 100, receipt_ref_id: 'manual', business_date: date, payment_type: 9, payment_name: 'khac', card_name: null, amount }],
  }, async h => {
    await h.sync(); assert.equal(h.getRun().source_complete, true); assert.equal(h.receipts.size, 7);
    const source = await h.source();
    assert.equal(source.receiptCount, 5); assert.equal(source.receiptTotal, 23_918_100); assert.equal(source.paymentTotal, 23_918_100);
    assert.deepEqual(source.sourceSnapshot.totalsByBucket, { cash: 7_465_700, transfer: 9_552_600, card: 4_294_200, other: 2_605_600 });
    assert.ok(source.sourceSnapshot.receipts.some(row => row.refNo === 'M-261006-003'));
    assert.ok(!source.sourceSnapshot.receipts.some(row => row.refNo === '2601006748' || row.refNo === '2601006750'));
    assert.equal(h.getPayments().filter(row => row.receipt_ref_id === 'manual').length, 1);
    assert.equal((await h.manual()).source.receiptTotal, source.receiptTotal);
    assert.equal((await h.final()).source.other, 2_605_600);
    assert.ok(h.pages.some(page => page.table === 'pos_sales_receipts'));
    assert.ok(h.pages.some(page => page.table === 'pos_sales_receipt_payments'));
  });
});

test('save set retains canceled empty and non-paid available snapshots; missing snapshots preserve old rows', async () => {
  const storedReceipts = [{ id: 1, ref_id: 'canceled-empty' }, { id: 2, ref_id: 'canceled-missing' }];
  const storedPayments = storedReceipts.map(row => ({ id: row.id, receipt_id: row.id, receipt_ref_id: row.ref_id,
    business_date: '2026-10-06', payment_type: 9, payment_name: 'khac', card_name: null, amount: 999 }));
  await harness([invoice('paid'), invoice('canceled-empty', 999, 4, []), invoice('canceled-missing', 999, 4, null), invoice('unpaid-present', 999, 2)],
    { storedReceipts, storedPayments }, async h => {
      await h.sync(); assert.equal(h.getRun().source_complete, true);
      assert.deepEqual(h.reconciliationSnapshots[0].map(row => [row.receiptRefId, row.payments.length]), [['paid', 1], ['canceled-empty', 0], ['unpaid-present', 1]]);
      assert.ok(!h.getPayments().some(row => row.receipt_ref_id === 'canceled-empty'));
      assert.equal(h.getPayments().filter(row => row.receipt_ref_id === 'canceled-missing').length, 1);
      assert.equal((await h.source()).receiptTotal, 1_000_000);
    });
});

for (const day of ['01', '02', '03', '04', '05']) test(`E: normal October ${day} remains complete and closeable`, async () => {
  const date = '2026-10-' + day;
  await harness([{ ...invoice('paid'), RefDate: date + 'T18:00:00+07:00' }], { businessDate: date }, async h => {
    await h.sync(); assert.equal(h.getRun().source_complete, true); assert.equal((await h.manual()).status, 'closed');
    assert.equal((await h.final()).status, 'verified_unchanged'); assert.equal((await h.source()).receiptTotal, 1_000_000);
  });
});

for (const [name, options] of [ ['limit reached', { limit: 100 }], ['detail failure', { detailFailure: true }],
  ['detail mismatch', { detailMismatch: true }], ['missing source count', { countUnavailable: true }] ]) {
  test(`${name} still blocks closing even when canceled receipts do not require payments`, async () => {
    const invoices = name === 'limit reached' ? Array.from({ length: 100 }, (_, index) => invoice('canceled-' + index, 100, 4, null)) : [invoice('canceled', 100, 4, null)];
    await harness(invoices, options, async h => {
      await h.sync(); assert.equal(h.getRun().source_complete, false); await assert.rejects(h.manual(), /POS_CLOSE_SOURCE_INVALID|POS_CLOSE_SYNC_FAILED/);
      assert.ok(['source_invalid', 'sync_failed'].includes((await h.final()).status));
    });
  });
}

test('paid but explicitly canceled normalized receipt is outside the mandatory payment set', async () => {
  await harness([invoice('paid'), invoice('canceled-paid', 500_000, 3, null)], { normalizedCanceledRefs: ['canceled-paid'] }, async h => {
    const data = await (await h.sync()).json();
    assert.equal(data.result.paymentSnapshotUnavailableCount, 0);
    assert.equal(h.getRun().source_complete, true);
    assert.equal(h.receipts.get('canceled-paid').is_canceled, true);
    assert.equal((await h.source()).receiptTotal, 1_000_000);
    assert.equal((await h.manual()).status, 'closed');
    assert.equal((await h.final()).status, 'verified_unchanged');
  });
});

for (const truncateSourcePages of [false, true]) test('counted source pagination remains strict: truncate=' + truncateSourcePages, async () => {
  const storedReceipts = Array.from({ length: 501 }, (_, index) => ({ id: index + 1, ref_id: 'old-' + index,
    business_date: '2026-10-06', payment_status: 4, is_canceled: true }));
  await harness([invoice('paid')], { storedReceipts, truncateSourcePages }, async h => {
    await h.sync();
    assert.equal(h.getRun().source_complete, !truncateSourcePages);
    assert.ok(h.pages.some(page => page.table === 'pos_sales_receipts' && page.from === 500));
    if (truncateSourcePages) await assert.rejects(h.manual(), /POS_CLOSE_SOURCE_INVALID/);
    else assert.equal((await h.manual()).source.receiptTotal, 1_000_000);
  });
});

test('source-invalid translations describe validation failures including incomplete sync without implying a confirmation button', () => {
  assert.match(salesCloseText.ko.sourceInvalid, /POS 원천 데이터 검증/);
  assert.match(salesCloseText.ko.sourceInvalid, /동기화 누락/);
  assert.match(salesCloseText.vi.sourceInvalid, /dữ liệu nguồn POS/);
  assert.match(salesCloseText.vi.sourceInvalid, /đồng bộ POS/);
});
