import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function load(path, dependencies = {}) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, testModule, testModule.exports);
  return testModule.exports;
}

function setup({ ledgerFailure = false, logId = 100, latestLogId = logId, reason = 'purchase', businessDate = '2026-09-10', purchasePrice = 23333 } = {}) {
  const calls = [];
  const projectedAmounts = [];
  const log = { id: logId, item_id: 1, item_name: 'Coca', reason, source: 'create', change_quantity: 3, business_date: businessDate, new_supplier: 'Old supplier', new_purchase_price: purchasePrice, purchase_supplier_partner_id: 7 };
  const item = { item_name: 'Coca-Cola', item_name_vi: 'Cola moi', category: 'Soda', category_vi: 'Nuoc', unit: 'can', supplier: 'Shopee', purchase_price: 19000, supplier_partner_id: 42 };
  const supabase = {
    from(table) {
      let patch, single = false;
      const query = {
        select() { return query; }, eq() { return query; }, in() { return query; }, gt() { return query; }, order() { return query; }, limit() { return query; },
        maybeSingle() { single = true; return query; },
        update(value) { patch = value; return query; },
        then(resolve) {
          let data;
          if (table === 'inventory_logs') {
            if (patch) { Object.assign(log, patch); calls.push('source-commit'); }
            data = single ? { id: latestLogId } : [{ ...log }];
          } else if (table === 'inventory') {
            if (patch) { Object.assign(item, patch); calls.push('master-update'); }
            data = single ? { ...item } : null;
          } else throw new Error(`Unexpected table ${table}`);
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
    async rpc(name, args) {
      assert.equal(name, 'ledger_project_inventory_purchase_log_v1');
      assert.deepEqual(args, { p_inventory_log_id: log.id, p_request_actor_user_id: 7 });
      assert.ok(calls.includes('source-commit'));
      calls.push('ledger-projection');
      projectedAmounts.push(log.change_quantity * log.new_purchase_price);
      if (ledgerFailure) throw { code: 'NETWORK_TEST_FAILURE' };
      return { data: { status: 'synced' }, error: null };
    },
  };
  const contract = load('lib/inventory/ledger-sync-contract.ts');
  const projection = load('lib/ledger/inventory-projection.ts', {
    'server-only': {}, '@/lib/supabase/server': { supabaseServer: supabase },
  });
  const route = load('app/api/inventory/logs/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
    '@/lib/auth/server-auth': { getAuthenticatedActor: async () => ({ ok: true, actor: { id: 7, username: 'staff', role: 'staff' } }) },
    '@/lib/inventory/reasons': load('lib/inventory/reasons.ts'),
    '@/lib/inventory/keg-replacement-summary': {},
    '@/lib/supabase/server': { supabaseServer: supabase },
    '@/lib/inventory/ledger-sync-contract': contract,
    '@/lib/ledger/inventory-projection': projection,
    '@/lib/inventory/supplier-partners-server': { resolveInventorySupplier: async ({ payload }) => ({ supplier: payload.supplier, supplier_partner_id: 11 }) },
    '@/lib/inventory/price-logs': { insertInventoryPriceLog: async () => { calls.push('price-history'); } },
  });
  return { log, item, calls, projectedAmounts, patch: body => route.PATCH(new Request('http://test/api/inventory/logs', { method: 'PATCH', body: JSON.stringify(body) })) };
}

test('explicit purchase sync updates current economics and reports Ledger failure separately', async () => {
  const state = setup({ ledgerFailure: true, logId: 200, latestLogId: 200 });
  const response = await state.patch({ id: 200, logIds: [200], businessDate: '2026-09-10', syncCurrentItem: true });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.item_name, 'Coca-Cola');
  assert.equal(body.data.change_quantity, 3);
  assert.equal(body.data.new_supplier, 'Shopee');
  assert.equal(body.data.new_purchase_price, 19000);
  assert.equal(body.data.purchase_supplier_partner_id, 42);
  assert.equal(body.ledgerSync.status, 'failed');
  assert.equal(body.ledgerSync.code, 'NETWORK_TEST_FAILURE');
  assert.deepEqual(state.projectedAmounts, [57000]);
  assert.deepEqual(state.calls, ['source-commit', 'ledger-projection']);
});

test('explicit sync on an older purchase keeps its economics and Ledger amount', async () => {
  const state = setup({ logId: 100, latestLogId: 200, businessDate: '2026-08-10', purchasePrice: 20000 });
  const response = await state.patch({ id: 100, logIds: [100], businessDate: '2026-08-10', syncCurrentItem: true });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.item_name, 'Coca-Cola');
  assert.equal(body.data.new_supplier, 'Old supplier');
  assert.equal(body.data.new_purchase_price, 20000);
  assert.equal(body.data.purchase_supplier_partner_id, 7);
  assert.deepEqual(state.projectedAmounts, [60000]);
  assert.deepEqual(state.calls, ['source-commit', 'ledger-projection']);
});

test('explicit current-item sync keeps non-purchase economics unchanged', async () => {
  const state = setup({ reason: 'stock_check' });
  const response = await state.patch({ id: 100, logIds: [100], businessDate: '2026-09-10', syncCurrentItem: true });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.item_name, 'Coca-Cola');
  assert.equal(body.data.new_supplier, 'Old supplier');
  assert.equal(body.data.new_purchase_price, 23333);
  assert.equal(body.data.purchase_supplier_partner_id, 7);
  assert.equal(body.ledgerSync.status, 'synced');
  assert.deepEqual(state.calls, ['source-commit']);
});

test('explicit historical price/supplier correction does not overwrite a newer purchase master', async () => {
  const state = setup({ latestLogId: 101 });
  const response = await state.patch({ id: 100, new_purchase_price: 21000, new_supplier: 'Corrected supplier' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.new_purchase_price, 21000);
  assert.equal(body.data.purchase_supplier_partner_id, 11);
  assert.equal(body.ledgerSync.status, 'synced');
  assert.equal(state.item.purchase_price, 19000);
  assert.equal(state.item.supplier, 'Shopee');
});

test('latest purchase correction updates supplier binding and price history before projection', async () => {
  const state = setup({ latestLogId: 100 });
  const response = await state.patch({ id: 100, new_purchase_price: 21000, new_supplier: 'Corrected supplier' });
  assert.equal(response.status, 200);
  assert.equal(state.item.purchase_price, 21000);
  assert.equal(state.item.supplier_partner_id, 11);
  assert.deepEqual(state.calls, ['source-commit', 'master-update', 'price-history', 'ledger-projection']);
});

function itemSetup() {
  const calls = [], logs = [];
  const item = { id: 1, item_name: 'Coca', item_name_vi: 'Cola', quantity: 10, purchase_price: 20000, supplier: 'Won Mart', supplier_partner_id: 10, part: 'bar' };
  const supabase = {
    from(table) {
      let patch, insert, single = false;
      const query = {
        select() { return query; }, eq() { return query; }, neq() { return query; },
        single() { single = true; return query; }, maybeSingle() { single = true; return query; },
        insert(value) { insert = value; return query; }, update(value) { patch = value; return query; },
        then(resolve) {
          let data;
          if (table === 'inventory') {
            if (patch || insert) { Object.assign(item, patch ?? insert[0]); calls.push('inventory-commit'); }
            data = single ? { ...item } : [];
          } else if (table === 'inventory_logs' && insert) {
            data = { id: 100 + logs.length, ...insert[0] };
            logs.push(data); calls.push('source-commit');
          } else throw new Error(`Unexpected table ${table}`);
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
    async rpc(name, args) {
      assert.equal(name, 'ledger_project_inventory_purchase_log_v1');
      assert.equal(args.p_inventory_log_id, logs.at(-1).id);
      assert.equal(args.p_request_actor_user_id, 7);
      assert.ok(calls.indexOf('inventory-commit') < calls.indexOf('source-commit'));
      calls.push('ledger-projection');
      return { error: { code: 'LEDGER_TEST_UNAVAILABLE' }, data: null };
    },
  };
  const projection = load('lib/ledger/inventory-projection.ts', { 'server-only': {}, '@/lib/supabase/server': { supabaseServer: supabase } });
  const route = load('app/api/inventory/items/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
    '@supabase/supabase-js': { createClient: () => supabase },
    '@/lib/auth/server-auth': { getAuthenticatedActor: async () => ({ ok: true, actor: { id: 7, username: 'staff', name: 'Staff', role: 'staff' } }) },
    '@/lib/inventory/number': load('lib/inventory/number.ts'),
    '@/lib/inventory/keg-progress': {}, '@/lib/inventory/items-server': {},
    '@/lib/inventory/normalize': load('lib/inventory/normalize.ts'),
    '@/lib/inventory/inventory-business-time': { resolveInventoryBusinessDate: async () => ({ businessDate: '2026-09-01' }) },
    '@/lib/inventory/price-logs': { insertInventoryPriceLog: async () => { calls.push('price-history'); } },
    '@/lib/ledger/inventory-projection': projection,
    '@/lib/inventory/supplier-partners-server': { resolveInventorySupplier: async () => ({ supplier: 'Won Mart', supplier_partner_id: 10 }), applyResolvedInventorySupplier: (payload, supplier) => ({ ...payload, ...supplier }) },
    '@/lib/inventory/reasons': load('lib/inventory/reasons.ts'),
    '@/lib/inventory/parts': load('lib/inventory/parts.ts'),
  });
  return { item, calls, logs, invoke: (method, body) => route[method](new Request('http://test/api/inventory/items', { method, body: JSON.stringify(body) })) };
}

test('new_purchase POST commits inventory and source before a separately reported Ledger failure', async () => {
  const state = itemSetup();
  const response = await state.invoke('POST', { registrationType: 'new_purchase', payload: { item_name: 'Coca', item_name_vi: 'Cola', quantity: 10, part: 'bar', purchase_price: 20000 } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true); assert.equal(body.data.quantity, 10);
  assert.equal(body.ledgerSync.status, 'failed');
  assert.equal(state.logs[0].source_actor_user_id, 7);
  assert.equal(state.logs[0].purchase_supplier_partner_id, 10);
  assert.deepEqual(state.calls, ['inventory-commit', 'source-commit', 'price-history', 'ledger-projection']);
});

test('existing_stock POST never projects a purchase expense', async () => {
  const state = itemSetup();
  const response = await state.invoke('POST', { registrationType: 'existing_stock', payload: { item_name: 'Coca', item_name_vi: 'Cola', quantity: 10, part: 'bar', purchase_price: 20000 } });
  assert.equal(response.status, 200);
  assert.equal(state.logs[0].reason, 'stock_check');
  assert.equal((await response.json()).ledgerSync, undefined);
  assert.ok(!state.calls.includes('ledger-projection'));
});

test('additional quick-save purchases get independent source IDs and preserve mode on Ledger failure', async () => {
  const state = itemSetup();
  for (const quantity of [15, 20]) {
    const response = await state.invoke('PATCH', { id: 1, mode: 'quick-save', expectedQuantity: quantity - 5, reason: 'purchase', payload: { quantity, purchase_price: 21000 } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true); assert.equal(body.mode, 'quick-save'); assert.equal(body.ledgerSync.status, 'failed');
  }
  assert.deepEqual(state.logs.map(log => log.id), [100, 101]);
  assert.deepEqual(state.logs.map(log => log.change_quantity), [5, 5]);
  const before = state.logs.length;
  const retry = await state.invoke('PATCH', { id: 1, mode: 'quick-save', expectedQuantity: 15, reason: 'purchase', payload: { quantity: 20 } });
  assert.equal(retry.status, 409); assert.equal(state.logs.length, before);
});
