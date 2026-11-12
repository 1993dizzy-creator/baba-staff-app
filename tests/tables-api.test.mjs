import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTs, authHarness, nextMock } from './helpers/sales-auth-harness.mjs';
import * as policy from '../lib/sales/table-overview.ts';
import * as core from '../lib/pos/cukcuk/open-orders-core.ts';
import { addStoreDays, calculateStoreBusinessDate } from '../lib/store-settings/business-time-core.ts';
import { input, now } from './helpers/table-overview-fixture.mjs';

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
        '@/lib/store-settings/business-time-adapter': { resolveConfiguredBusinessDate: async stamp => { assert.equal(stamp, at); return day; } },
        '@/lib/store-settings/business-time-core': { addStoreDays }, '@/lib/pos/cukcuk/open-orders-core': core,
        '@/lib/pos/cukcuk/open-orders-scope': { openOrdersScope: () => 'offline-only' },
        '@/lib/pos/cukcuk/tables-read-server': { loadTableCatalog: async () => f.catalog },
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
