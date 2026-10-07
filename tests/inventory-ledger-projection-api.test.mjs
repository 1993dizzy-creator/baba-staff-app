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
  const logSyncServer = load('lib/inventory/log-sync-server.ts', {
    'server-only': {},
    '@/lib/inventory/ledger-sync-contract': contract,
  });
  const projection = load('lib/ledger/inventory-projection.ts', {
    'server-only': {}, '@/lib/supabase/server': { supabaseServer: supabase },
  });
  const route = load('app/api/inventory/logs/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
    '@/lib/auth/server-auth': { getAuthenticatedActor: async () => ({ ok: true, actor: { id: 7, username: 'staff', role: 'staff' } }) },
    '@/lib/inventory/reasons': load('lib/inventory/reasons.ts'),
    '@/lib/inventory/keg-replacement-summary': {},
    '@/lib/supabase/server': { supabaseServer: supabase },
    '@/lib/inventory/log-sync-server': logSyncServer,
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

function itemSetup({correctionFailure=false,role='staff',duplicateItems=[],rootLogs=[],businessDate='2026-09-01',startingQuantity=10,closedMonths=[],candidate=null,transaction=null,payable=null,payableAllocations=[]}={}) {
  const calls = [], logs = [];
  const item = { id: 1, item_name: 'Coca', item_name_vi: 'Cola', quantity: startingQuantity, purchase_price: 20000, supplier: 'Won Mart', supplier_partner_id: 10, unit: 'can', part: 'bar' };
  const supabase = {
    from(table) {
      let patch, insert, single = false, max = Infinity;
      const filters = [];
      const orders = [];
      const query = {
        select() { return query; },
        eq(field,value) { filters.push(item => item[field] === value); return query; },
        neq(field,value) { filters.push(item => item[field] !== value); return query; },
        gt(field,value) { filters.push(item => item[field] > value); return query; },
        lte(field,value) { filters.push(item => item[field] <= value); return query; },
        is(field,value) { filters.push(item => item[field] === value); return query; },
        order(field,{ascending=true}={}) { orders.push([field,ascending]); return query; },
        limit(value) { max=value; return query; },
        single() { single = true; return query; }, maybeSingle() { single = true; return query; },
        insert(value) { insert = value; return query; }, update(value) { patch = value; return query; },
        then(resolve) {
          let data;
          if (table === 'inventory') {
            if (patch || insert) { Object.assign(item, patch ?? insert[0]); calls.push('inventory-commit'); }
            data = single ? { ...item } : duplicateItems.filter(candidate => filters.every(filter => filter(candidate)));
          } else if (table === 'inventory_logs' && insert) {
            data = { id: 100 + logs.length, ...insert[0] };
            logs.push(data); calls.push('source-commit');
          } else if (table === 'inventory_logs') {
            data = [...rootLogs,...logs].filter(row => filters.every(filter => filter(row)))
              .sort((a,b) => { for(const [field,ascending] of orders) { const result=String(a[field]).localeCompare(String(b[field])); if(result)return ascending?result:-result; } return 0; }).slice(0,max);
          } else if (['ledger_month_closures','ledger_candidates','ledger_transactions','ledger_payables','ledger_payable_allocations'].includes(table)) {
            const sourceRows = table === 'ledger_month_closures' ? closedMonths.map(month => ({month,status:'closed'})) : table === 'ledger_candidates' ? (candidate ? [candidate] : []) : table === 'ledger_transactions' ? (transaction ? [transaction] : []) : table === 'ledger_payables' ? (payable ? [payable] : []) : payableAllocations;
            const filtered = sourceRows.filter(row => filters.every(filter => filter(row)));
            data = single ? filtered[0] ?? null : filtered.slice(0,max);
          } else throw new Error(`Unexpected table ${table}`);
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
    async rpc(name, args) {
      if(name==='inventory_apply_purchase_correction_v1') {
        assert.equal(args.p_purchase_log_id,rootLogs.length ? rootLogs.at(-1).id : 99);assert.equal(args.p_expected_quantity,startingQuantity);
        assert.equal(args.p_actor_user_id,7);calls.push('atomic-correction');
        if(correctionFailure)return {data:{status:'invalid_purchase_reference'},error:null};
        const change_quantity=Number(args.p_payload.quantity)-Number(item.quantity);
        Object.assign(item,args.p_payload);logs.push({id:100+logs.length,correction_of_inventory_log_id:args.p_purchase_log_id,change_quantity,reason:'purchase'});
        return {data:{status:'ok',inventory:{...item},inventoryLogId:100},error:null};
      }
      assert.equal(name, 'ledger_project_inventory_purchase_log_v1');
      assert.equal(args.p_inventory_log_id, logs.at(-1).id);
      assert.equal(args.p_request_actor_user_id, 7);
      assert.ok(calls.includes('atomic-correction') || calls.indexOf('inventory-commit') < calls.indexOf('source-commit'));
      calls.push('ledger-projection');
      return { error: { code: 'LEDGER_TEST_UNAVAILABLE' }, data: null };
    },
  };
  const projection = load('lib/ledger/inventory-projection.ts', { 'server-only': {}, '@/lib/supabase/server': { supabaseServer: supabase } });
  const route = load('app/api/inventory/items/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
    '@supabase/supabase-js': { createClient: () => supabase },
    '@/lib/auth/server-auth': { getAuthenticatedActor: async () => ({ ok: true, actor: { id: 7, username: role, name: role, role } }) },
    '@/lib/inventory/number': load('lib/inventory/number.ts'),
    '@/lib/inventory/keg-progress': {}, '@/lib/inventory/items-server': {},
    '@/lib/inventory/normalize': load('lib/inventory/normalize.ts'),
    '@/lib/inventory/inventory-business-time': { resolveInventoryBusinessDate: async () => ({ businessDate }) },
    '@/lib/inventory/purchase-correction-policy': load('lib/inventory/purchase-correction-policy.ts'),
    '@/lib/inventory/price-logs': { insertInventoryPriceLog: async () => { calls.push('price-history'); } },
    '@/lib/ledger/inventory-projection': projection,
    '@/lib/inventory/supplier-partners-server': { resolveInventorySupplier: async ({payload}) => ({ supplier: payload.supplier ?? 'Won Mart', supplier_partner_id: payload.supplierPartnerId ?? 10 }), applyResolvedInventorySupplier: (payload, supplier) => ({ ...payload, ...supplier }) },
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

const createPayload = overrides => ({
  item_name: '새 품목', item_name_vi: 'Mat hang moi', code: 'PC', quantity: 10,
  unit: 'can', part: 'bar', purchase_price: 20000, ...overrides,
});

test('POST duplicate policy matches either Korean or Vietnamese name only when the normalized code also matches',async()=>{
  const cases = [
    {
      existing: {id:2,item_name:'로쿠 진',item_name_vi:'Roku gin cu',code:'PC',is_active:true},
      payload: createPayload({item_name:'로쿠 진',item_name_vi:'Roku gin moi',code:'pc'}),
    },
    {
      existing: {id:3,item_name:'다른 이름',item_name_vi:'Nước ép nho',code:'Y1',is_active:true},
      payload: createPayload({item_name:'새 이름',item_name_vi:'nuoc ep nho',code:'Y1'}),
    },
    {
      existing: {id:4,item_name:'빈 코드 품목',item_name_vi:'Ma trong',code:null,is_active:true},
      payload: createPayload({item_name:'빈 코드 품목',item_name_vi:'Khac',code:''}),
    },
  ];

  for(const {existing,payload} of cases) {
    const state=itemSetup({duplicateItems:[existing]});
    const response=await state.invoke('POST',{registrationType:'existing_stock',payload});
    const body=await response.json();
    assert.equal(response.status,409);assert.equal(body.error,'inventory_item_duplicate_name_code');
    assert.equal(body.duplicateItem.id,existing.id);assert.equal(body.duplicateItem.is_active,existing.is_active);
    assert.equal(state.calls.length,0);
  }
});

test('POST allows the same Korean or Vietnamese name when the code differs',async()=>{
  for(const [existing,payload] of [
    [{id:2,item_name:'로쿠 진',item_name_vi:'Roku gin',code:'PC',is_active:true},createPayload({item_name:'로쿠 진',code:'Y1'})],
    [{id:3,item_name:'다른 이름',item_name_vi:'Nước ép nho',code:'PC',is_active:true},createPayload({item_name_vi:'nuoc ep nho',code:'Z6'})],
  ]) {
    const state=itemSetup({duplicateItems:[existing]});
    const response=await state.invoke('POST',{registrationType:'existing_stock',payload});
    assert.equal(response.status,200);assert.ok(state.calls.includes('inventory-commit'));
  }
});

test('POST blocks an inactive exact duplicate and returns its inactive status',async()=>{
  const inactive={id:5,item_name:'병합 품목',item_name_vi:'Mat hang gop',code:'PC',is_active:false};
  const state=itemSetup({duplicateItems:[inactive]});
  const response=await state.invoke('POST',{registrationType:'existing_stock',payload:createPayload({item_name:'병합 품목',code:'PC'})});
  const body=await response.json();
  assert.equal(response.status,409);assert.equal(body.error,'inventory_item_duplicate_name_code');assert.equal(body.duplicateItem.is_active,false);
});

test('PATCH ignores inactive legacy duplicates but blocks a different active exact duplicate',async()=>{
  const payload={item_name:'정리된 품목',code:'PC',quantity:10};
  const inactiveState=itemSetup({duplicateItems:[{id:2,item_name:'정리된 품목',item_name_vi:'',code:'PC',is_active:false}]});
  const allowed=await inactiveState.invoke('PATCH',{id:1,source:'edit_form',reason:'other',payload});
  assert.equal(allowed.status,200);assert.equal(inactiveState.item.item_name,'정리된 품목');

  const activeState=itemSetup({duplicateItems:[{id:3,item_name:'정리된 품목',item_name_vi:'',code:'PC',is_active:true}]});
  const blocked=await activeState.invoke('PATCH',{id:1,source:'edit_form',reason:'other',payload});
  assert.equal(blocked.status,409);assert.equal((await blocked.json()).error,'inventory_item_duplicate_name_code');
  assert.equal(activeState.item.item_name,'Coca');assert.equal(activeState.calls.length,0);
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

test('ordinary edit-form purchase increases or asks for an explicit correction root',async()=>{
  const increased=itemSetup();
  const success=await increased.invoke('PATCH',{id:1,source:'edit_form',reason:'purchase',payload:{quantity:11}});
  assert.equal(success.status,200);assert.equal(increased.item.quantity,11);assert.equal(increased.logs[0].reason,'purchase');

  for(const quantity of [10,9]) {
    const state=itemSetup();
    const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'purchase',payload:{quantity}});
    assert.equal(response.status,quantity===10?400:409);assert.equal((await response.json()).error,quantity===10?'inventory_purchase_quantity_must_increase':'purchase_correction_root_not_found');
    assert.equal(state.item.quantity,10);assert.equal(state.logs.length,0);
  }
});

test('ordinary edit-form stock check, service, and other reasons keep their existing behavior',async()=>{
  for(const [reason,quantity] of [['stock_check',10],['service',9],['other',11]]) {
    const state=itemSetup();
    const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason,payload:{quantity}});
    assert.equal(response.status,200);assert.equal(state.item.quantity,quantity);assert.equal(state.logs[0].reason,reason);
  }
});

test('owner and master can keep using the emergency purchase-correction flow',async()=>{
  for(const role of ['owner','master']) {
    const state=itemSetup({role});
    const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'purchase',correction_of_inventory_log_id:99,expectedQuantity:10,payload:{quantity:6}});
    assert.equal(response.status,200);assert.equal(state.item.quantity,6);assert.equal(state.logs[0].correction_of_inventory_log_id,99);
    assert.equal((await response.json()).ledgerSync.status,'failed');assert.deepEqual(state.calls,['atomic-correction','ledger-projection']);
  }
});

test('manager, leader, and staff cannot call the emergency purchase-correction flow',async()=>{
  for(const role of ['manager','leader','staff']) {
    const state=itemSetup({role});
    const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'purchase',correction_of_inventory_log_id:99,expectedQuantity:10,payload:{quantity:6}});
    assert.equal(response.status,403);assert.equal((await response.json()).error,'inventory_purchase_correction_forbidden');
    assert.equal(state.item.quantity,10);assert.equal(state.logs.length,0);assert.equal(state.calls.length,0);
  }
});

test('invalid explicit purchase reference or missing expected quantity never falls back to an ordinary Inventory update',async()=>{
  const failed=itemSetup({correctionFailure:true,role:'owner'});
  const response=await failed.invoke('PATCH',{id:1,reason:'purchase',correction_of_inventory_log_id:99,expectedQuantity:10,payload:{quantity:6}});
  assert.equal(response.status,400);assert.equal(failed.item.quantity,10);assert.equal(failed.logs.length,0);
  const state=itemSetup({role:'owner'});assert.equal((await state.invoke('PATCH',{id:1,reason:'purchase',correction_of_inventory_log_id:99,payload:{quantity:6}})).status,400);
  assert.equal(state.item.quantity,10);assert.equal(state.calls.length,0);
});

const correctionPolicy = load('lib/inventory/purchase-correction-policy.ts');
const root = (id, quantity, created_at, business_date='2026-09-01') => ({
  id, item_id: 1, business_date, created_at, reason: 'purchase', change_quantity: quantity,
  correction_of_inventory_log_id: null, unit: 'can', new_supplier: 'Won Mart',
  purchase_supplier_partner_id: 10, new_purchase_price: 20000,
});

test('same-day +72 then -12 uses the correction RPC and retains a 60-unit family', async () => {
  const state=itemSetup({role:'staff',rootLogs:[root(99,72,'2026-09-01T08:00:00Z')],startingQuantity:72});
  const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'stock_check',payload:{quantity:60,unit:'can',purchase_price:20000}});
  assert.equal(response.status,200);
  assert.deepEqual(state.calls,['atomic-correction','ledger-projection']);
  assert.equal(state.logs[0].correction_of_inventory_log_id,99);
  assert.equal(72+state.logs[0].change_quantity,60);
});

test('same-day positive quantity correction uses the same purchase family', async () => {
  const state=itemSetup({rootLogs:[root(99,10,'2026-09-01T08:00:00Z')]});
  const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'other',payload:{quantity:13,unit:'can',purchase_price:20000}});
  assert.equal(response.status,200);
  assert.equal(state.logs[0].correction_of_inventory_log_id,99);
  assert.equal(state.logs[0].change_quantity,3);
});

test('two same-day receipts link the edit to the latest prior root', async () => {
  const state=itemSetup({rootLogs:[root(98,10,'2026-09-01T10:00:00Z'),root(99,20,'2026-09-01T14:00:00Z')],startingQuantity:30});
  const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'stock_check',payload:{quantity:27,unit:'can',purchase_price:20000}});
  assert.equal(response.status,200);
  assert.equal(state.logs[0].correction_of_inventory_log_id,99);
});

test('later receipt never changes the root chosen for an earlier edit; timestamps tie by descending ID', () => {
  const early=root(98,10,'2026-09-01T10:00:00Z');
  const late=root(99,20,'2026-09-01T14:00:00Z');
  assert.equal(correctionPolicy.nearestPriorPurchaseRoot([late,early],1,'2026-09-01','2026-09-01T11:00:00Z')?.id,98);
  assert.equal(correctionPolicy.nearestPriorPurchaseRoot([late,early],1,'2026-09-01','2026-09-01T15:00:00Z')?.id,99);
  assert.equal(correctionPolicy.nearestPriorPurchaseRoot([root(100,20,early.created_at),early],1,'2026-09-01','2026-09-01T11:00:00Z')?.id,100);
});

test('previous-day purchase does not auto-correct a current-day edit', async () => {
  const state=itemSetup({rootLogs:[root(99,10,'2026-08-31T10:00:00Z','2026-08-31')]});
  const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'stock_check',payload:{quantity:8,unit:'can'}});
  assert.equal(response.status,200);
  assert.equal(state.logs[0].correction_of_inventory_log_id,undefined);
  assert.equal(state.calls.includes('atomic-correction'),false);
});

test('correction below zero is refused before a write', async () => {
  const state=itemSetup({rootLogs:[root(99,5,'2026-09-01T10:00:00Z')]});
  const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'stock_check',payload:{quantity:4,unit:'can',purchase_price:20000}});
  assert.equal(response.status,409);
  assert.equal(state.logs.length,0);
  assert.equal(state.item.quantity,10);
});

test('metadata-only edit still uses the ordinary same-day sync log contract', async () => {
  const state=itemSetup({rootLogs:[root(99,10,'2026-09-01T10:00:00Z')]});
  const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'other',payload:{quantity:10,item_name:'Cola new',purchase_price:21000}});
  assert.equal(response.status,200);
  assert.equal(state.logs[0].change_quantity,0);
  assert.equal(state.calls.includes('atomic-correction'),false);
  assert.equal(state.logs[0].source,'edit_form');
});

test('Ledger review card hides raw projection codes and log IDs in operator text', () => {
  const page=readFileSync('app/(protected)/admin/ledger/entries/page.tsx','utf8');
  assert.match(page,/className=\{styles\.projectionWarning\}/);
  assert.match(page,/issue\.code === "PURCHASE_CORRECTION_REFERENCE_REQUIRED"/);
  assert.doesNotMatch(page,/#\{issue\.inventoryLogId\}/);
  assert.doesNotMatch(page,/\{issue\.code\}/);
});

test('successful automatic corrections are excluded from the warning query', () => {
  const loader=readFileSync('lib/ledger/inventory-display.ts','utf8');
  assert.match(loader,/\.in\("status", \["failed", "review_required"\]\)/);
  assert.doesNotMatch(loader,/\.in\("status", \["synced"/);
});

test('unit and supplier mismatch cannot silently become an automatic correction', async () => {
  for (const payload of [{quantity:8,unit:'kg',purchase_price:20000},{quantity:8,unit:'can',purchase_price:20000,supplier:'Other',supplierPartnerId:11}]) {
    const state=itemSetup({rootLogs:[root(99,10,'2026-09-01T10:00:00Z')]});
    const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'stock_check',payload});
    assert.equal(response.status,409);
    assert.equal(state.logs.length,0);
  }
});

test('closed purchase month blocks automatic correction before the RPC', async () => {
  const state=itemSetup({rootLogs:[root(99,10,'2026-09-01T10:00:00Z')],closedMonths:['2026-09-01']});
  const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'stock_check',payload:{quantity:8,unit:'can',purchase_price:20000}});
  assert.equal(response.status,409);
  assert.equal(state.calls.includes('atomic-correction'),false);
});

test('manual Ledger amount override blocks automatic correction', async () => {
  const state=itemSetup({rootLogs:[root(99,10,'2026-09-01T10:00:00Z')],
    candidate:{source_type:'inventory_purchase_log',source_key:'inventory-log:99',status:'confirmed',proposed_amount:200000,resolved_transaction_id:3},
    transaction:{id:3,amount:190000,business_date:'2026-09-01',recognition_month:'2026-09-01'}});
  const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'stock_check',payload:{quantity:8,unit:'can',purchase_price:20000}});
  assert.equal(response.status,409);
  assert.equal(state.calls.includes('atomic-correction'),false);
});

test('a later explicit purchase stays independent after an earlier same-day correction', async () => {
  const state=itemSetup({rootLogs:[root(99,10,'2026-09-01T10:00:00Z')]});
  const correction=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'stock_check',payload:{quantity:8,unit:'can',purchase_price:20000}});
  assert.equal(correction.status,200);
  const purchase=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'purchase',payload:{quantity:28,unit:'can',purchase_price:20000}});
  assert.equal(purchase.status,200);
  assert.equal(state.logs[0].correction_of_inventory_log_id,99);
  assert.equal(state.logs[1].correction_of_inventory_log_id,undefined);
  assert.equal(state.logs[1].reason,'purchase');
  assert.equal(state.logs[1].change_quantity,20);
});

test('an allocated payable prevents automatic purchase correction', async () => {
  const state=itemSetup({rootLogs:[root(99,10,'2026-09-01T10:00:00Z')],
    candidate:{source_type:'inventory_purchase_log',source_key:'inventory-log:99',status:'confirmed',proposed_amount:200000,resolved_transaction_id:3},
    transaction:{id:3,amount:200000,business_date:'2026-09-01',recognition_month:'2026-09-01',status:'confirmed',type:'expense',source_type:'inventory_purchase_candidate'},
    payable:{id:5,expense_transaction_id:3,status:'unpaid'},payableAllocations:[{payable_id:5,allocated_amount:20000}]});
  const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'stock_check',payload:{quantity:8,unit:'can',purchase_price:20000}});
  assert.equal(response.status,409);
  assert.equal(state.calls.includes('atomic-correction'),false);
});

test('cross-day purchase reduction requires confirmation, then uses the explicit atomic RPC',async()=>{
 const state=itemSetup({rootLogs:[root(99,1.42,'2026-08-31T10:00:00Z','2026-08-31')],startingQuantity:1.42});
 const body={id:1,source:'edit_form',reason:'purchase',payload:{quantity:1.32,unit:'can',purchase_price:20000}};
 const first=await state.invoke('PATCH',body);assert.equal(first.status,409);
 const preview=await first.json();assert.equal(preview.error,'purchase_correction_selection_required');assert.equal(preview.recommended,true);
 assert.equal(state.logs.length,0);assert.equal(state.item.quantity,1.42);
 const selected=await state.invoke('PATCH',{...body,selectedPurchaseRootId:99,expectedQuantity:1.42});
 assert.equal(selected.status,200);assert.equal(state.logs.length,1);assert.equal(state.logs[0].correction_of_inventory_log_id,99);
 assert.deepEqual(state.calls,['atomic-correction','ledger-projection']);
});
test('multiple cross-day roots require explicit selection and never mutate on preview',async()=>{
 const state=itemSetup({rootLogs:[root(98,10,'2026-08-30T10:00:00Z','2026-08-30'),root(99,10,'2026-08-31T10:00:00Z','2026-08-31')]});
 const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'purchase',payload:{quantity:8,unit:'can'}});
 const body=await response.json();assert.equal(response.status,409);assert.equal(body.candidates.length,2);assert.equal(body.recommended,false);
 assert.equal(state.logs.length,0);assert.equal(state.item.quantity,10);
});
test('missing or incompatible prior roots cannot create unlinked negative purchase logs',async()=>{
 for(const roots of [[],[root(99,10,'2026-08-31T10:00:00Z','2026-08-31')]]){
 const state=itemSetup({rootLogs:roots});const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'purchase',payload:{quantity:8,unit:'kg'}});
 assert.equal(response.status,409);assert.equal((await response.json()).error,'purchase_correction_root_not_found');assert.equal(state.logs.length,0);
 }
});
test('selected root is revalidated for identity, closed months, quantity bounds and stale stock',async()=>{
 const baseRoot=root(99,10,'2026-08-31T10:00:00Z','2026-08-31');
 for(const options of [{rootLogs:[baseRoot],closedMonths:['2026-08-01']},{rootLogs:[{...baseRoot,unit:'kg'}]},{rootLogs:[{...baseRoot,change_quantity:1}]},{rootLogs:[baseRoot]}]){
 const state=itemSetup(options);const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason:'purchase',selectedPurchaseRootId:99,expectedQuantity:9,payload:{quantity:8,unit:'can'}});
 assert.equal(response.status,409);assert.equal(state.logs.length,0);assert.equal(state.item.quantity,10);
 }
});

test('quick-save purchase reduction cannot write an unlinked negative purchase',async()=>{
 const state=itemSetup();const response=await state.invoke('PATCH',{id:1,mode:'quick-save',reason:'purchase',expectedQuantity:10,payload:{quantity:8}});
 assert.equal(response.status,400);assert.equal(state.logs.length,0);assert.equal(state.item.quantity,10);
});
test('cross-day stock_check and other do not infer purchase intent',async()=>{
 for(const reason of ['stock_check','other']){
 const state=itemSetup({rootLogs:[root(99,10,'2026-08-31T10:00:00Z','2026-08-31')]});
 const response=await state.invoke('PATCH',{id:1,source:'edit_form',reason,payload:{quantity:8,unit:'can',purchase_price:20000}});
 assert.equal(response.status,200);assert.equal(state.logs[0].reason,reason);
 assert.equal(state.logs[0].correction_of_inventory_log_id,undefined);assert.equal(state.calls.includes('atomic-correction'),false);
 }
});
