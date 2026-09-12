import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as policy from '../lib/sales/pos-business-day-close-policy.ts';
import * as sources from '../lib/ledger/pos-sales-source.ts';

function load(path, dependencies) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (!(name in dependencies)) throw Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  }, testModule, testModule.exports);
  return testModule.exports;
}

const date = '2026-08-20';
const source = sources.buildPosBusinessDaySource(date, [], []);
function service({ role = 'owner', systemDisabled = false, early = false, monthClosed = false } = {}) {
  const calls = [];
  const supabase = {
    from(table) {
      const filters = {};
      const query = {
        select() { return query; }, order() { return query; }, limit() { return query; },
        eq(key, value) { filters[key] = value; return query; },
        async maybeSingle() {
          calls.push({ table, filters });
          if (table === 'users') return { data: { id: 789, username: 'pos', role: 'master', is_active: true, app_login_enabled: !systemDisabled }, error: null };
          if (table === 'pos_sales_business_day_closures') return { data: { id: 1, revision: 1, source_snapshot: source.sourceSnapshot,
            source_fingerprint: source.sourceFingerprint, close_method: 'manual', closed_by: 1 }, error: null };
          if (table === 'ledger_month_closures') return { data: monthClosed ? { id: 1 } : null, error: null };
          throw Error(`Unexpected table ${table}`);
        },
      };
      return query;
    },
    async rpc(name, args) { calls.push({ name, args }); return { data: { status: 'closed', revision: 1 }, error: null }; },
  };
  const snapshot = { timezone: 'Asia/Ho_Chi_Minh', cutoff: '03:00', isFallback: false, source: 'configured',
    hours: Array.from({ length: 7 }, (_, weekday) => ({ weekday, isClosed: false, openTime: '16:00', closeTime: '01:00' })) };
  const api = load('lib/sales/pos-business-day-close.ts', {
    'server-only': {}, '@/lib/auth/server-auth': { getAuthenticatedActor: async () => ({ ok: true, actor: { id: 55, role } }) },
    '@/lib/supabase/server': { supabaseServer: supabase }, '@/lib/ledger/pos-sales': { loadPosBusinessDaySource: async () => source },
    '@/lib/store-settings/business-time-adapter': {
      loadBusinessTimeAdapter: async () => ({ databaseBusinessDate: early ? date : '2026-08-21' }),
      loadBusinessTimeSnapshotsForDates: async () => new Map([[date, snapshot]]),
    }, './pos-business-day-close-policy': { ...policy, evaluatePosCloseTime: (...args) => early ? { allowed: false } : policy.evaluatePosCloseTime(...args) },
    '@/lib/ledger/pos-sales-source': sources,
  });
  return { api, calls };
}

test('manual close/reclose use the session actor; manager initial close allowed and explicit reclose denied before RPC', async () => {
  for (const role of ['owner', 'master']) {
    const { api, calls } = service({ role });
    assert.equal((await api.closePosBusinessDay(date, { reclose: true, expectedSourceFingerprint: source.sourceFingerprint })).status, 'closed');
    const rpc = calls.find(call => call.name === 'sales_close_business_day_v1');
    assert.equal(rpc.args.p_actor_user_id, 55);
    assert.equal(rpc.args.p_manual_reclose, true);
    assert.equal(rpc.args.p_close_method, 'manual');
    assert.equal(rpc.args.p_source_fingerprint, source.sourceFingerprint);
  }
  const denied = service({ role: 'manager' });
  await assert.rejects(denied.api.closePosBusinessDay(date, { reclose: true }), /POS_CLOSE_FORBIDDEN/);
  assert.equal(denied.calls.length, 0);
  assert.equal((await denied.api.closePosBusinessDay(date)).status, 'closed');
  assert.equal(denied.calls.find(call => call.name).args.p_manual_reclose, false);
  const stale = service();
  await assert.rejects(stale.api.closePosBusinessDay(date, { expectedSourceFingerprint: 'a'.repeat(64) }), /SOURCE_CHANGED_SINCE_REVIEW/);
  assert.ok(!stale.calls.some(call => call.name));
});

test('automatic close looks up pos rather than hardcoding an actor; disabled actor and missing run fail closed', async () => {
  const enabled = service();
  await enabled.api.closePosBusinessDayAutomatically(date, 12);
  assert.deepEqual(enabled.calls.find(call => call.table === 'users').filters, { username: 'pos' });
  const rpc = enabled.calls.find(call => call.name);
  assert.equal(rpc.args.p_actor_user_id, 789);
  assert.equal(rpc.args.p_sync_run_id, 12);
  assert.equal(rpc.args.p_close_method, 'automatic');
  assert.equal(rpc.args.p_manual_reclose, false);
  await assert.rejects(service({ systemDisabled: true }).api.closePosBusinessDayAutomatically(date, 12), /SYSTEM_ACTOR_UNAVAILABLE/);
  await assert.rejects(enabled.api.closePosBusinessDayAutomatically(date, 0), /SUCCESSFUL_SYNC_RUN_REQUIRED/);
});

test('status reads permit manager and expose current/closed fingerprint, drift, deltas and month lock', async () => {
  const { api } = service({ role: 'manager', monthClosed: true });
  const status = await api.getPosBusinessDayCloseStatus(date);
  assert.equal(status.isClosed, true);
  assert.equal(status.drift, false);
  assert.equal(status.totalDelta, 0);
  assert.equal(status.closure.revision, 1);
  assert.equal(status.currentFingerprint, status.closedFingerprint);
  assert.equal(status.canClose, false);
  assert.equal(status.monthClosed, true);
});

test('early manual close is denied without calling the write RPC', async () => {
  const { api, calls } = service({ early: true });
  await assert.rejects(api.closePosBusinessDay(date), /BEFORE_CONFIGURED_CLOSE_TIME/);
  assert.ok(!calls.some(call => call.name));
});

test('existing Ledger API uses v3 snapshots and server authentication without accepting client actor fields', async () => {
  const calls = [];
  const api = load('app/api/admin/ledger/pos-sync/route.ts', {
    '@/lib/ledger/server': { requireLedgerActor: async () => ({ actor: { id: 55 }, response: null }),
      ledgerJson: (body, status = 200) => Response.json(body, { status }) },
    '@/lib/ledger/pos-sales': { validLedgerMonth: value => value === '2026-08', loadPosLedgerSource: async () => ({ days: [source], rows: source.rows, totalsByBucket: {} }),
      loadPosLedgerParity: async () => ({ matches: true }) },
    '@/lib/supabase/server': { supabaseServer: { rpc: async (name, args) => { calls.push({ name, args }); return { data: { status: 'ok', dailyCloseDrift: [] }, error: null }; } } },
  });
  const response = await api.POST(new Request('http://localhost/api/admin/ledger/pos-sync', { method: 'POST', body: JSON.stringify({ month: '2026-08' }) }));
  assert.equal(response.status, 200);
  assert.equal(calls[0].name, 'ledger_sync_pos_sales_v3');
  assert.equal(calls[0].args.p_actor_user_id, 55);
  assert.equal(calls[0].args.p_days[0].sourceFingerprint, source.sourceFingerprint);
  const rejected = await api.POST(new Request('http://localhost/api/admin/ledger/pos-sync', { method: 'POST', body: JSON.stringify({ month: '2026-08', actorUsername: 'owner' }) }));
  assert.equal(rejected.status, 400);
  assert.equal(calls.length, 1);
});

test('paginated month/day source loaders never silently accept truncated PostgREST responses', async () => {
  let receiptPages = 0;
  const receipts = Array.from({ length: 501 }, (_, index) => ({ id: index + 1, ref_no: null, ref_date: null, business_date: date,
    payment_status: 3, is_canceled: false, final_amount: 0, revision: 1, updated_at: null }));
  let incomplete = false;
  const api = load('lib/ledger/pos-sales.ts', {
    'server-only': {}, './pos-sales-source': sources,
    '@/lib/supabase/server': { supabaseServer: {
      from(table) {
        const query = {
          select() { return query; }, gte() { return query; }, lte() { return query; }, order() { return query; },
          async range(from, to) {
            if (table === 'pos_sales_receipt_payments') return { data: [], count: 0, error: null };
            receiptPages++;
            return { data: incomplete && from > 0 ? [] : receipts.slice(from, to + 1), count: 501, error: null };
          },
        };
        return query;
      },
    } },
  });
  const result = await api.loadPosBusinessDaySource(date);
  assert.equal(result.receiptCount, 501);
  assert.equal(receiptPages, 2);
  incomplete = true;
  await assert.rejects(api.loadPosBusinessDaySource(date), /SNAPSHOT_INCOMPLETE/);
});
