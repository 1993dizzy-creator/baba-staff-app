import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTs, authHarness, nextMock } from './helpers/sales-auth-harness.mjs';
import * as policy from '../lib/sales/table-overview.ts';
import * as core from '../lib/pos/cukcuk/open-orders-core.ts';
import { addStoreDays, calculateStoreBusinessDate } from '../lib/store-settings/business-time-core.ts';
import { input, now, order } from './helpers/table-overview-fixture.mjs';
import { evaluateOpenOrdersCronWindow } from '../lib/pos/cukcuk/open-orders-cron-policy.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';

test('real signed-session gate allows all five roles; unauthenticated/forged/inactive/blocked cannot read snapshots', async () => {
  const old = process.env.BABA_SESSION_SECRET; process.env.BABA_SESSION_SECRET = 'offline-test-only-tables-secret-32-bytes';
  try {
    const checks = [null, 'forged', { is_active: false }, { app_login_enabled: false }, ...['master','owner','manager','leader','staff'].map(role => ({ role }))];
    for (const check of checks) {
      const h = authHarness(); let calls = 0;
      if (check === 'forged') h.setToken('forged');
      else if (check) { h.setActor(check); h.sign(); }
      const api = loadTs('app/api/tables/route.ts', { 'next/server': nextMock, '@/lib/auth/server-auth': h.auth,
        '@/lib/sales/table-overview-server': { readTableOverview: async () => { calls++; return { tables: [] }; } } });
      const response = await api.GET();
      const allowed = check && typeof check === 'object' && 'role' in check;
      assert.equal(response.status, allowed ? 200 : 401, JSON.stringify(check));
      assert.equal(calls, allowed ? 1 : 0); assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    }
  } finally { if (old === undefined) delete process.env.BABA_SESSION_SECRET; else process.env.BABA_SESSION_SECRET = old; }
});

test('catalog transport is OFF by default: no login, network, or invented inventory', async () => {
  const old = process.env.POS_TABLES_READ_ENABLED; delete process.env.POS_TABLES_READ_ENABLED;
  try {
    const read = loadTs('lib/pos/cukcuk/tables-read-server.ts', { 'server-only': {}, '@/lib/sales/table-overview': policy,
      './open-orders-scope': { openOrdersBranchId() { assert.fail('disabled must not even resolve credentials/scope'); } } });
    assert.deepEqual(await read.loadTableCatalog(), { status: 'not_enabled', collectedAt: null, tables: [] });
  } finally { if (old === undefined) delete process.env.POS_TABLES_READ_ENABLED; else process.env.POS_TABLES_READ_ENABLED = old; }
});

test('enabled catalog reader reuses login/header helpers, performs one single-flight GET, and suppresses provider errors', async () => {
  const old = process.env.POS_TABLES_READ_ENABLED, originalFetch = globalThis.fetch;
  process.env.POS_TABLES_READ_ENABLED = 'true';
  try {
    let logins = 0, sends = 0;
    const f = input();
    globalThis.fetch = async (url, init) => {
      sends++; assert.equal(url, 'https://offline.invalid/api/v1/tables/fixture-branch');
      assert.equal(init.method, 'GET'); assert.equal(init.headers.Authorization, 'Bearer offline-only');
      return Response.json({ Code: 200, Success: true, Data: { ListTable: f.catalog.tables.map(t => ({
        MapObjectID: t.id, MapObjectName: t.name, AreaID: t.areaId, AreaName: t.areaName, IsAvailable: t.available,
      })) } });
    };
    const reader = loadTs('lib/pos/cukcuk/tables-read-server.ts', { 'server-only': {}, '@/lib/sales/table-overview': policy,
      './open-orders-scope': { openOrdersBranchId: () => 'fixture-branch' },
      './auth': { loginCukcuk: async () => { logins++; return { accessToken: 'offline-only', companyCode: 'offline' }; } },
      './sales-receipt-sync': { CUKCUK_BASE_URL: 'https://offline.invalid', buildCukcukHeaders: (token, company) => ({ Authorization: 'Bearer '+token, CompanyCode: company }) },
    });
    const [a,b] = await Promise.all([reader.loadTableCatalog(now), reader.loadTableCatalog(now)]);
    assert.equal(a.status, 'ok'); assert.equal(a, b); assert.equal(logins, 1); assert.equal(sends, 1);
    globalThis.fetch = async () => { throw Error('secret-token-must-not-escape'); };
    const failed = await reader.loadTableCatalog(new Date(now.getTime()+6*60_000));
    assert.deepEqual(failed, { status: 'unavailable', collectedAt: null, tables: [] });
  } finally {
    globalThis.fetch = originalFetch;
    if (old === undefined) delete process.env.POS_TABLES_READ_ENABLED; else process.env.POS_TABLES_READ_ENABLED = old;
  }
});

test('server reads only central RPC and receipt evidence, resolves configured 03:00 date, and projects no raw/customer data', async () => {
  const old = process.env.POS_OPEN_ORDERS_READ_ENABLED; process.env.POS_OPEN_ORDERS_READ_ENABLED = 'true';
  try {
    for (const dateTime of ['2026-11-13T02:59:59+07:00', '2026-11-13T03:00:00+07:00']) {
      const at = new Date(dateTime), day = calculateStoreBusinessDate(at), f = input(); const calls = [];
      const service = loadTs('lib/sales/table-overview-server.ts', {
        'server-only': {}, './table-overview': policy,
        '@/lib/store-settings/business-time-adapter': { loadBusinessTimeAdapter: async stamp => { assert.equal(stamp, at); return {databaseBusinessDate:day,snapshot:{cutoff:'03:00'},context:{isOpen:true}}; } },
        '@/lib/store-settings/business-time-core': { addStoreDays }, '@/lib/pos/cukcuk/open-orders-core': core,
        '@/lib/pos/cukcuk/open-orders-cron-policy': {evaluateOpenOrdersCronWindow},
        '@/lib/pos/cukcuk/open-orders-scope': { openOrdersScope: () => 'offline-only' },
        './baba-table-catalog': { babaTableCatalog: () => f.catalog },
        '@/lib/supabase/server': { supabaseServer: { rpc(name, args) { calls.push([name,args]); return {
          abortSignal: async () => ({ data: { sync: f.sync, orders: f.orders.map(o => ({ ...o, raw: { CustomerTel: 'not-returned' } })) }, error: null }),
        }; } } },
        './daily-sales-summary': { fetchAllExactPages: async () => ({ data: [], error: null }) },
      });
      const result = await service.readTableOverview(at);
      assert.equal(result.businessDate, day); assert.equal(calls[0][0], 'pos_open_orders_read'); assert.equal(calls[0][1].p_business_date, day);
      assert.ok(!JSON.stringify(result).includes('CustomerTel')); assert.ok(!JSON.stringify(result).includes('not-returned'));
    }
  } finally { if (old === undefined) delete process.env.POS_OPEN_ORDERS_READ_ENABLED; else process.env.POS_OPEN_ORDERS_READ_ENABLED = old; }
  assert.doesNotMatch(readFileSync('lib/sales/table-overview-server.ts','utf8'), /sync-server|loginCukcuk|runCentral|\.insert\(|\.update\(/);
  assert.doesNotMatch(readFileSync('app/(protected)/tables/page.tsx','utf8'), /requireRole|\/admin\/|supabase/);
});

test('actual static catalog reaches the server response with READ disabled, absent/live orders, stale and failed snapshots; no Tables transport', async () => {
  const oldRead = process.env.POS_OPEN_ORDERS_READ_ENABLED, oldTables = process.env.POS_TABLES_READ_ENABLED;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { assert.fail('offline test must never call the provider'); };
  process.env.POS_TABLES_READ_ENABLED = 'true'; // Must have no effect on this static page read path.
  try {
    const base = input();
    for (const scenario of ['read_disabled','absent','live','stale','incomplete','read_failed']) {
      process.env.POS_OPEN_ORDERS_READ_ENABLED = scenario === 'read_disabled' ? 'false' : 'true';
      let snapshotReads = 0;
      const service = loadTs('lib/sales/table-overview-server.ts', {
        'server-only': {}, './table-overview': policy, './baba-table-catalog': { babaTableCatalog },
        '@/lib/store-settings/business-time-adapter': { loadBusinessTimeAdapter: async () => ({databaseBusinessDate:base.businessDate,snapshot:{cutoff:'03:00'},context:{isOpen:true}}) },
        '@/lib/store-settings/business-time-core': { addStoreDays }, '@/lib/pos/cukcuk/open-orders-core': core,
        '@/lib/pos/cukcuk/open-orders-cron-policy': {evaluateOpenOrdersCronWindow},
        '@/lib/pos/cukcuk/open-orders-scope': { openOrdersScope: () => 'offline-only' },
        '@/lib/supabase/server': { supabaseServer: { rpc() { snapshotReads++; return { abortSignal: async () => ({
          error: scenario === 'read_failed' ? { code:'offline-failure' } : null,
          data: { sync: { ...base.sync,
            lastSuccessAt: scenario === 'stale' ? '2026-11-13T10:00:00Z' : base.sync.lastSuccessAt,
            lastErrorCode: scenario === 'incomplete' ? 'orders_vanished_unconfirmed' : null },
          orders: scenario === 'absent' ? [] : [order('bar1','BAR1'), order('floor1','1')] },
        }) }; } } },
        './daily-sales-summary': { fetchAllExactPages: async () => ({ data:[], error:null }) },
      });
      const result = await service.readTableOverview(now);
      assert.equal(result.tables.length,27,scenario);
      assert.deepEqual(['bar','floor1','floor2'].map(area=>result.tables.filter(t=>t.area===area).length),[11,8,8]);
      assert.equal(result.tables.filter(t=>t.state==='occupied').length,scenario==='live'?2:0,scenario);
      assert.equal(result.summary.free,null); assert.equal(result.summary.reserved,null); assert.equal(result.summary.paid,['absent','live'].includes(scenario)?0:null);
      assert.equal(snapshotReads,scenario==='read_disabled'?0:1);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if(oldRead===undefined)delete process.env.POS_OPEN_ORDERS_READ_ENABLED;else process.env.POS_OPEN_ORDERS_READ_ENABLED=oldRead;
    if(oldTables===undefined)delete process.env.POS_TABLES_READ_ENABLED;else process.env.POS_TABLES_READ_ENABLED=oldTables;
  }
});

test('receipt read selects only projected evidence, uses exact pagination, and never leaks raw/customer data', async()=>{
 const old=process.env.POS_OPEN_ORDERS_READ_ENABLED;process.env.POS_OPEN_ORDERS_READ_ENABLED='true';
 try{
  const base=input({orders:[]});const calls=[];
  const rows=[{id:10,payment_status:3,is_canceled:false,order_id:'receipt-only',business_date:base.businessDate,table_name:'BAR4',ref_date:now.toISOString(),raw_json:{CustomerTel:'private-customer'}}];
  const query={select(columns,options){calls.push(['select',columns,options]);return query;},eq(...args){calls.push(['eq',...args]);return query;},in(...args){calls.push(['in',...args]);return query;},order(){return query;},abortSignal(){return query;},range(from,to){calls.push(['range',from,to]);return Promise.resolve({data:rows,error:null,count:1});}};
  const service=loadTs('lib/sales/table-overview-server.ts',{
   'server-only':{},'./table-overview':policy,'./baba-table-catalog':{babaTableCatalog},
   '@/lib/store-settings/business-time-adapter':{loadBusinessTimeAdapter:async()=>({databaseBusinessDate:base.businessDate,snapshot:{cutoff:'03:00'},context:{isOpen:true}})},
   '@/lib/store-settings/business-time-core':{addStoreDays},'@/lib/pos/cukcuk/open-orders-core':core,
   '@/lib/pos/cukcuk/open-orders-cron-policy':{evaluateOpenOrdersCronWindow},
   '@/lib/pos/cukcuk/open-orders-scope':{openOrdersScope:()=> 'offline'},
   '@/lib/supabase/server':{supabaseServer:{rpc:()=>({abortSignal:async()=>({data:{sync:base.sync,orders:[]},error:null})}),from(table){assert.equal(table,'pos_sales_receipts');return query;}}},
   './daily-sales-summary':{fetchAllExactPages:async makeQuery=>makeQuery(0,999)},
  });
  const result=await service.readTableOverview(now);
  const select=calls.find(c=>c[0]==='select')[1];
  assert.equal(select,'id,payment_status,is_canceled,order_id:raw_json->>OrderId,business_date,table_name:raw_json->>TableName,ref_date');
  assert.ok(calls.some(c=>c[0]==='eq'&&c[1]==='source'&&c[2]==='cukcuk'));
  assert.deepEqual(calls.find(c=>c[0]==='in')[2],[base.businessDate,addStoreDays(base.businessDate,1)]);
  assert.equal(result.summary.paid,1);assert.equal(result.tables.find(t=>t.name==='BAR4').state,'paid');
  assert.doesNotMatch(JSON.stringify(result),/CustomerTel|private-customer|raw_json/);
 }finally{if(old===undefined)delete process.env.POS_OPEN_ORDERS_READ_ENABLED;else process.env.POS_OPEN_ORDERS_READ_ENABLED=old;}
});
