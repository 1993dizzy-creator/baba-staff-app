// /api/cron/pos-open-orders-sync — route behaviour with the REAL cron auth, the REAL
// collector (open-orders-sync-server + core) and fake boundaries only: CUKCUK login,
// global fetch, Supabase RPC and the store-settings business-date RPC.
// No CUKCUK, database or network access.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import nodeCrypto from 'node:crypto';
import ts from 'typescript';

const core = await import('../lib/pos/cukcuk/open-orders-core.ts');
const policy = await import('../lib/pos/cukcuk/open-orders-cron-policy.ts');
const BASE = '686f380394e2e58bc81da6bc20e8fd572223f497';
const SECRET = 'local-cron-test-secret';
const SCOPE = `${'a'.repeat(64)}:b1`;
const ORDER_ID = '00000000-0000-4000-8000-000000000001';
// Explicit "variable not set" marker (passing undefined would pick the default value).
const UNSET = Symbol('unset');

function load(path, deps) {
  const mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)((name) => { if (!(name in deps)) throw Error('Unexpected import ' + name); return deps[name]; }, mod, mod.exports);
  return mod.exports;
}
const cronShared = load('lib/pos/cukcuk/sales-sync-cron-shared.ts', {
  crypto: { ...nodeCrypto, default: nodeCrypto }, 'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
});

// Vietnam wall-clock "YYYY-MM-DDTHH:mm[:ss]" -> Date.
const vn = (local) => new Date(`${local.length === 16 ? local + ':00' : local}+07:00`);
// Store-settings RPC stand-in: cutoff 03:00, the business date the real RPC would return.
const storeBusinessDate = (now) => { const t = new Date(now.getTime() + 7 * 3600_000 - 3 * 3600_000); return t.toISOString().slice(0, 10); };

function harness({ at, enabled = 'true', secret = SECRET, claim = 'collecting', rpcError = {}, login, cukcuk, adapterError } = {}) {
  const calls = [];
  const meta = {};
  const rpc = async (name, args) => {
    calls.push(`rpc:${name}`);
    if (rpcError[name]) return { data: null, error: rpcError[name] };
    if (name === 'pos_open_orders_claim') { meta.claimArgs = args; return { data: { status: claim }, error: null }; }
    if (name === 'pos_open_orders_read') return { data: { sync: null, orders: [] }, error: null };
    if (name === 'pos_open_orders_commit') return { data: { status: 'committed', runId: args.p_run_id, orders: args.p_orders.length, lines: args.p_orders.reduce((s, o) => s + (o.lines?.length ?? 0), 0) }, error: null };
    if (name === 'pos_open_orders_fail') { meta.failCode = args.p_code; return { data: { status: 'failed', code: args.p_code }, error: null }; }
    throw Error('unexpected rpc ' + name);
  };
  const sync = load('lib/pos/cukcuk/open-orders-sync-server.ts', {
    'server-only': {}, 'node:crypto': nodeCrypto,
    '@/lib/pos/cukcuk/auth': { loginCukcuk: async () => { calls.push('login'); if (login) return login(); return { accessToken: 'tok-SECRET-123', companyCode: 'cc' }; } },
    '@/lib/pos/cukcuk/open-orders-scope': { openOrdersBranchId: () => 'b1', openOrdersScope: () => SCOPE },
    '@/lib/pos/cukcuk/sales-receipt-sync': { CUKCUK_BASE_URL: 'https://cukcuk.invalid',
      buildCukcukHeaders: (token, company) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, CompanyCode: company }) },
    '@/lib/supabase/server': { supabaseServer: { rpc } },
    '@/lib/store-settings/business-time-adapter': { loadBusinessTimeAdapter: async (now) => {
      calls.push('business_date_rpc');
      if (adapterError) throw adapterError;
      return { databaseBusinessDate: storeBusinessDate(now), snapshot: { cutoff: '03:00' } };
    } },
    './open-orders-core': core,
  });
  const route = load('app/api/cron/pos-open-orders-sync/route.ts', {
    '@/lib/pos/cukcuk/sales-sync-cron-shared': cronShared,
    '@/lib/pos/cukcuk/open-orders-sync-server': sync,
    '@/lib/pos/cukcuk/open-orders-cron-policy': policy,
  });
  const run = async (headers = { authorization: `Bearer ${SECRET}` }) => {
    const savedEnv = { POS_OPEN_ORDERS_SYNC_ENABLED: process.env.POS_OPEN_ORDERS_SYNC_ENABLED, CRON_SECRET: process.env.CRON_SECRET };
    const saved = { fetch: globalThis.fetch, Date: globalThis.Date, error: console.error };
    const fixed = (at ?? vn('2026-11-09T20:00')).getTime();
    const RealDate = Date;
    globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } };
    if (enabled === UNSET) delete process.env.POS_OPEN_ORDERS_SYNC_ENABLED; else process.env.POS_OPEN_ORDERS_SYNC_ENABLED = enabled;
    if (secret === UNSET) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    globalThis.fetch = async (url, init) => {
      calls.push(`cukcuk:${new URL(url).pathname.replace(/[0-9a-f-]{36}$/, '{id}')}`);
      const reply = cukcuk ? cukcuk(url, init) : { status: 200, json: { Success: true, Code: 200, Total: 0, Data: [] } };
      return new Response(JSON.stringify(reply.json), { status: reply.status });
    };
    try {
      const response = await route.GET(new Request('http://localhost/api/cron/pos-open-orders-sync', { headers }));
      const text = await response.text();
      return { status: response.status, body: JSON.parse(text), text, logged };
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      globalThis.fetch = saved.fetch; globalThis.Date = saved.Date; console.error = saved.error;
    }
  };
  return { calls, meta, run, route };
}
const cukcukCalls = (calls) => calls.filter((c) => c === 'login' || c.startsWith('cukcuk:'));

test('auth missing/wrong/unconfigured: 401/403 and zero collector calls', async () => {
  for (const [headers, secret, status] of [[{}, SECRET, 401], [{ authorization: 'Bearer wrong' }, SECRET, 401], [{ 'x-cron-secret': 'nope' }, SECRET, 401], [{ authorization: `Bearer ${SECRET}` }, UNSET, 403]]) {
    const h = harness({ secret });
    const r = await h.run(headers);
    assert.equal(r.status, status);
    assert.deepEqual(h.calls, []);
  }
  // x-cron-secret is accepted like the other cron routes.
  const ok = harness();
  assert.equal((await ok.run({ 'x-cron-secret': SECRET })).body.outcome, 'committed');
});

test('switch must be exactly "true": anything else skips with zero CUKCUK/DB calls', async () => {
  for (const enabled of [UNSET, '','false', '1', 'TRUE', 'yes', 'on']) {
    const h = harness({ enabled });
    const r = await h.run();
    assert.deepEqual([r.status, r.body], [200, { ok: true, outcome: 'skipped_disabled' }], String(enabled));
    assert.deepEqual(h.calls, []);
  }
});

test('service window boundaries (Asia/Ho_Chi_Minh): start 17:30, last start 02:54:59, 02:55:00 until 17:30 skip', () => {
  const cases = [
    ['2026-11-09T16:00', false], ['2026-11-09T17:00', false], ['2026-11-09T17:29:59', false], ['2026-11-09T17:30', true],
    ['2026-11-09T17:32', true], ['2026-11-09T23:59:59', true],
    ['2026-11-10T00:00', true], ['2026-11-10T02:54', true], ['2026-11-10T02:54:59', true],
    ['2026-11-10T02:55', false], ['2026-11-10T02:55:01', false], ['2026-11-10T02:56', false], ['2026-11-10T02:57', false],
    ['2026-11-10T02:58', false], ['2026-11-10T03:00', false], ['2026-11-10T12:00', false], ['2026-11-10T15:59:59', false],
  ];
  for (const [at, allowed] of cases) assert.equal(policy.evaluateOpenOrdersCronWindow(vn(at)).allowed, allowed, at);
  assert.equal(policy.OPEN_ORDERS_CRON_FIRST_START_MINUTE, 17 * 60 + 30);
  // Millisecond edges: 17:29:59.999 / 17:30:00.000 and 02:54:59.999 / 02:55:00.000.
  assert.equal(policy.evaluateOpenOrdersCronWindow(new Date(vn('2026-11-09T17:30').getTime() - 1)).allowed, false);
  assert.equal(policy.evaluateOpenOrdersCronWindow(vn('2026-11-09T17:30')).allowed, true);
  assert.equal(policy.evaluateOpenOrdersCronWindow(new Date(vn('2026-11-10T02:55').getTime() - 1)).allowed, true);
  assert.equal(policy.evaluateOpenOrdersCronWindow(vn('2026-11-10T02:55')).allowed, false);
  assert.equal(policy.evaluateOpenOrdersCronWindow(vn('2026-11-10T02:54:30')).vietnamTime, '02:54');
  // Budget/lease/maxDuration unchanged; even a claim 2 minutes after the last start ends before 03:00.
  assert.equal(core.OPEN_ORDERS_RUN_BUDGET_MS, 150_000);
  assert.equal(core.OPEN_ORDERS_LEASE_MS, 180_000);
  const lastStartEnd = (policy.OPEN_ORDERS_CRON_LAST_START_MINUTE * 60 + 59) * 1000 + 999;
  assert.ok(lastStartEnd + 120_000 + core.OPEN_ORDERS_LEASE_MS <= 3 * 3600_000, 'claim delay up to 2 min still releases before 03:00');
});

test('route at 17:30 / 00:00 / 02:54:59 runs with the store-settings business date (after 00:00 = previous day); outside skips without calls', async () => {
  for (const [at, date] of [['2026-11-09T17:30', '2026-11-09'], ['2026-11-09T23:59', '2026-11-09'], ['2026-11-10T00:00', '2026-11-09'], ['2026-11-10T02:54', '2026-11-09'], ['2026-11-10T02:54:59', '2026-11-09']]) {
    const h = harness({ at: vn(at) });
    const r = await h.run();
    assert.equal(r.body.outcome, 'committed', at);
    assert.equal(h.meta.claimArgs.p_business_date, date, at);
    assert.ok(h.calls.indexOf('business_date_rpc') < h.calls.indexOf('rpc:pos_open_orders_claim'));
  }
  for (const at of ['2026-11-09T17:02', '2026-11-09T17:27', '2026-11-09T17:29:59', '2026-11-10T02:55', '2026-11-10T02:57', '2026-11-10T03:00', '2026-11-10T15:59']) {
    const h = harness({ at: vn(at) });
    const r = await h.run();
    assert.deepEqual([r.status, r.body.outcome], [200, 'skipped_outside_hours'], at);
    assert.deepEqual(h.calls, []);
  }
});

test('busy / fresh: only the claim RPC runs; no login and no CUKCUK request', async () => {
  for (const [claim, outcome] of [['busy', 'skipped_busy'], ['fresh', 'skipped_fresh']]) {
    const h = harness({ claim });
    const r = await h.run();
    assert.deepEqual([r.status, r.body], [200, { ok: true, outcome }]);
    assert.deepEqual(h.calls, ['business_date_rpc', 'rpc:pos_open_orders_claim']);
    assert.deepEqual(cukcukCalls(h.calls), []);
  }
});

test('committed: one serial page + detail, counts only, no token or order payload in the response', async () => {
  const h = harness({ cukcuk: (url) => new URL(url).pathname.endsWith('/paging')
    ? { status: 200, json: { Success: true, Code: 200, Total: 1, Data: [{ Id: ORDER_ID, No: '1.1', Status: 1, Type: 1, Date: '2026-11-09T19:00:00+07:00', TotalAmount: 30000, CustomerName: 'Nguyen Secret', CustomerTel: '0900000000' }] } }
    : { status: 200, json: { Success: true, Code: 200, Data: { Id: ORDER_ID, No: '1.1', Status: 1, Type: 1, Date: '2026-11-09T19:00:00+07:00', TotalAmount: 30000, TableName: 'BAR10', CustomerName: 'Nguyen Secret', OrderDetails: [{ Id: '00000000-0000-4000-8000-000000000101', ItemId: '00000000-0000-4000-8000-000000000201', ItemName: 'Red Bull', Quantity: 1, Status: 1, Price: 30000, Amount: 30000 }] } } } });
  const r = await h.run();
  assert.deepEqual([r.status, r.body], [200, { ok: true, outcome: 'committed', orders: 1, lines: 1 }]);
  assert.deepEqual(cukcukCalls(h.calls), ['login', 'cukcuk:/api/v1/orders/paging', 'cukcuk:/api/v1/orders/{id}']);
  assert.doesNotMatch(r.text, /tok-SECRET|Nguyen|0900000000|BAR10|Red Bull|0000-4000/);
});

test('failures: monitorable HTTP status + safe code, run recorded as failed, no internal detail leaked', async () => {
  // CUKCUK login failure (upstream) -> 502, fail RPC records the code, no CUKCUK data request.
  let h = harness({ login: () => { throw new Error('CUKCUK login failed token=tok-SECRET-123'); } });
  let r = await h.run();
  assert.deepEqual([r.status, r.body], [502, { ok: false, outcome: 'failed', code: 'provider_token_expired' }]);
  assert.equal(h.meta.failCode, 'provider_token_expired');
  assert.deepEqual(cukcukCalls(h.calls), ['login']);
  assert.doesNotMatch(r.text + r.logged.join(' '), /tok-SECRET/);

  // CUKCUK HTTP error -> 502 provider_http_failure (no retry storm: one page request).
  h = harness({ cukcuk: () => ({ status: 500, json: { Success: false } }) });
  r = await h.run();
  assert.deepEqual([r.status, r.body.code], [502, 'provider_http_failure']);
  assert.equal(h.calls.filter((c) => c.startsWith('cukcuk:')).length, 1);

  // DB guard on commit -> 500 with the DB code (snapshot kept by the SQL).
  h = harness({ rpcError: { pos_open_orders_commit: { message: 'open_orders_vanished', code: 'P0001' } } });
  r = await h.run();
  assert.deepEqual([r.status, r.body.code, h.meta.failCode], [500, 'open_orders_vanished', 'open_orders_vanished']);

  // Claim refused by privileges -> 500, nothing else runs.
  h = harness({ rpcError: { pos_open_orders_claim: { message: 'permission denied for function pos_open_orders_claim', code: '42501' } } });
  r = await h.run();
  assert.deepEqual([r.status, r.body], [500, { ok: false, outcome: 'failed', code: 'open_orders_permission_denied' }]);
  assert.deepEqual(h.calls, ['business_date_rpc', 'rpc:pos_open_orders_claim']);

  // Store-settings RPC failure -> 500 business_time_unavailable, no claim, no CUKCUK.
  h = harness({ adapterError: new Error('Failed to calculate configured business date: internal detail xyz') });
  r = await h.run();
  assert.deepEqual([r.status, r.body], [500, { ok: false, outcome: 'failed', code: 'business_time_unavailable' }]);
  assert.deepEqual(h.calls, ['business_date_rpc']);
  assert.doesNotMatch(r.text + r.logged.join(' '), /internal detail xyz/);

  // Unexpected exception -> generic code only.
  h = harness({ adapterError: new Error('connect ECONNREFUSED postgres://user:pw@host') });
  r = await h.run();
  assert.deepEqual([r.status, r.body.code], [500, 'open_orders_cron_failed']);
  assert.doesNotMatch(r.text + r.logged.join(' '), /postgres:\/\/|pw@/);
});

test('result mapping covers every outcome and rejects unsafe codes', () => {
  const map = policy.mapOpenOrdersSyncResult;
  assert.deepEqual(map({ status: 'committed', orders: 2, lines: 5, runId: 'x' }), { status: 200, body: { ok: true, outcome: 'committed', orders: 2, lines: 5 } });
  assert.equal(map({ status: 'not_enabled' }).body.outcome, 'skipped_disabled');
  assert.deepEqual(map({ status: 'failed', code: 'run_deadline_exceeded' }), { status: 502, body: { ok: false, outcome: 'failed', code: 'run_deadline_exceeded' } });
  assert.equal(map({ status: 'failed', code: 'orders_vanished_unconfirmed' }).status, 502);
  assert.equal(map({ status: 'failed', code: 'open_orders_lease_lost' }).status, 500);
  assert.deepEqual(map({ status: 'failed', code: 'Bad <script> token=abc' }).body.code, 'collection_failed');
  assert.deepEqual(map({ status: 'expired' }), { status: 500, body: { ok: false, outcome: 'failed', code: 'open_orders_unexpected_result' } });
  assert.deepEqual(map(null).body.code, 'open_orders_unexpected_result');
});

test('cron registration: the 11 existing entries are byte-for-byte preserved and exactly one entry is added', () => {
  const before = JSON.parse(execFileSync('git', ['show', `${BASE}:vercel.json`], { encoding: 'utf8' }));
  const after = JSON.parse(readFileSync('vercel.json', 'utf8'));
  assert.equal(before.crons.length, 11);
  assert.equal(after.crons.length, 12);
  assert.deepEqual(after.crons.slice(0, 11), before.crons);
  assert.deepEqual(after.crons[11], { path: '/api/cron/pos-open-orders-sync', schedule: '2-57/5 10-19 * * *' });
  // Everything else in vercel.json is unchanged.
  assert.deepEqual({ ...after, crons: undefined }, { ...before, crons: undefined });
});

test('cron schedule x route window: Vercel fires 17:02–02:57 (+07) every 5 min; only 17:32–02:52 collect', () => {
  // "2-57/5 10-19 * * *" in UTC.
  const fires = [];
  for (let hour = 10; hour <= 19; hour++) for (let minute = 2; minute <= 57; minute += 5) fires.push(new Date(Date.UTC(2026, 10, 9, hour, minute)));
  const vnLabel = (d) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(11, 16);
  assert.equal(vnLabel(fires[0]), '17:02');
  assert.equal(vnLabel(fires.at(-1)), '02:57');
  const allowed = fires.filter((d) => policy.evaluateOpenOrdersCronWindow(d).allowed).map(vnLabel);
  assert.equal(allowed[0], '17:32');
  assert.equal(allowed.at(-1), '02:52');
  assert.equal(allowed.length, 6 + 8 * 12 + 11);
  assert.deepEqual(fires.map(vnLabel).filter((t) => !allowed.includes(t)), ['17:02', '17:07', '17:12', '17:17', '17:22', '17:27', '02:57']);
});

test('static: route config, reuse only, no own lock, sales/close code untouched', () => {
  const src = readFileSync('app/api/cron/pos-open-orders-sync/route.ts', 'utf8');
  assert.match(src, /export const runtime = "nodejs";/);
  assert.match(src, /export const dynamic = "force-dynamic";/);
  assert.match(src, /export const maxDuration = 180;/);
  const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['@/lib/pos/cukcuk/sales-sync-cron-shared', '@/lib/pos/cukcuk/open-orders-sync-server', '@/lib/pos/cukcuk/open-orders-cron-policy']);
  assert.doesNotMatch(src, /pos_open_orders_|advisory|lease_until|fetch\(|loginCukcuk|supabase/);
  assert.ok(src.indexOf('authorizeCron(req)') < src.indexOf('openOrdersSyncEnabled()'));
  assert.ok(src.indexOf('openOrdersSyncEnabled()') < src.indexOf('evaluateOpenOrdersCronWindow(now)'));
  assert.ok(src.indexOf('evaluateOpenOrdersCronWindow(now)') < src.indexOf('runCentralOpenOrderSync(now)'));
  assert.equal(policy.OPEN_ORDERS_CRON_LAST_START_MINUTE, 2 * 60 + 54);
  assert.match(src, /17:30–02:54:59/);
  assert.match(src, /"2-57\/5 10-19 \* \* \*"/);
  // Paid sales, close and sync code paths unchanged from the base commit.
  const touched = execFileSync('git', ['diff', '--name-only', BASE, '--', 'lib/sales', 'app/api/admin/sales', 'app/api/cron/sales-close-final',
    'app/api/cron/sales-sync', 'app/api/cron/sales-sync-final', 'lib/ledger', 'lib/pos/cukcuk/sales-receipt-sync.ts', 'lib/pos/cukcuk/sales-sync-cron-shared.ts',
    'lib/pos/cukcuk/open-orders-core.ts', 'lib/pos/cukcuk/open-orders-sync-server.ts'], { encoding: 'utf8' }).trim();
  assert.equal(touched, '');
});
