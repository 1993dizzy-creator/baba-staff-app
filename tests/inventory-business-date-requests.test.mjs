import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

// Local I/O only. No .env files or production connections.
function harness({ before = false, delay = 0, failDate = false, invalidDate = false } = {}) {
  const calls = [], errors = [];
  let authorized = true;
  const pause = () => new Promise(done => setTimeout(done, delay));
  const db = {
    async rpc(name, args) {
      calls.push({ name, args }); await pause();
      if (name === 'store_business_date_for_timestamp_v1') {
        if (failDate) return { data: null, error: { message: 'date unavailable' } };
        const date = new Date(new Date(args.p_timestamp).getTime() + 4 * 3600_000).toISOString().slice(0, 10);
        return { data: invalidDate ? null : date, error: null };
      }
      assert.equal(name, 'store_get_settings_overview_v1');
      return { data: { current: null }, error: null };
    },
    from(name) {
      const query = {
        select() { return query; }, order() { return query; }, eq() { return query; },
        gt() { return query; }, gte() { return query; }, lte() { return query; },
        async then(done) { calls.push({ name }); await pause(); return done({ data: [], error: null }); },
      };
      return query;
    },
  };
  const cache = new Map();
  function load(file) {
    file = resolve(file);
    if (cache.has(file)) return cache.get(file);
    let source = readFileSync(file, 'utf8');
    if (before && file.endsWith('inventory-business-time.ts')) {
      // Reproduce the original call using the actual full adapter.
      source = source.replace('import { resolveConfiguredBusinessDate }', 'import { loadBusinessTimeAdapter }')
        .replace('const businessDate = await resolveConfiguredBusinessDate(timestamp ?? new Date());',
          'const adapter = await loadBusinessTimeAdapter(timestamp ?? new Date()); const businessDate = adapter.databaseBusinessDate;');
    }
    const loadedModule = { exports: {} };
    cache.set(file, loadedModule.exports);
    const code = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    new Function('require', 'module', 'exports', 'console', code)(name => {
      if (name === 'server-only') return {};
      if (name === '@/lib/supabase/server') return { supabaseServer: db };
      if (name === '@supabase/supabase-js') return { createClient: () => db };
      if (name === 'next/server') return { NextResponse: { json: Response.json } };
      if (name === '@/lib/auth/server-auth') return { getAuthenticatedActor: async () => {
        calls.push({ name: 'users' }); await pause();
        return authorized ? { ok: true, actor: { role: 'owner' } } : { ok: false, status: 403, code: 'FORBIDDEN' };
      } };
      if (name.startsWith('@/')) return load(`${name.slice(2)}.ts`);
      if (name.startsWith('.')) return load(resolve(dirname(file), name));
      throw new Error(`Unexpected dependency ${name}`);
    }, loadedModule, loadedModule.exports, { ...console, error: (...args) => errors.push(args) });
    return loadedModule.exports;
  }
  return { calls, errors, load, deny: () => { authorized = false; } };
}

test('date-only lookup: 2 to 1 requests, same cutoff and month/year boundaries', async () => {
  for (const [timestamp, expected] of [
    ['2026-10-22T02:59:59+07:00', '2026-10-21'],
    ['2026-10-22T03:00:00+07:00', '2026-10-22'],
    ['2026-10-22T03:00:01+07:00', '2026-10-22'],
    ['2026-08-01T01:00:00+07:00', '2026-07-31'],
    ['2027-01-01T02:00:00+07:00', '2026-12-31'],
  ]) {
    const old = harness({ before: true }), next = harness();
    const a = await old.load('lib/inventory/inventory-business-time.ts').resolveInventoryBusinessDate(new Date(timestamp));
    const b = await next.load('lib/inventory/inventory-business-time.ts').resolveInventoryBusinessDate(new Date(timestamp));
    assert.deepEqual(b, a); assert.equal(b.businessDate, expected);
    assert.equal(old.calls.length, 2); assert.equal(next.calls.length, 1);
    assert.deepEqual(next.calls[0], old.calls[0]);
  }
});

test('RPC errors and invalid responses preserve fallback and error log', async () => {
  for (const options of [{ failDate: true }, { invalidDate: true }]) {
    const h = harness(options);
    const result = await h.load('lib/inventory/inventory-business-time.ts')
      .resolveInventoryBusinessDate(new Date('2026-10-22T02:59:59+07:00'));
    assert.deepEqual(result, { businessDate: '2026-10-21', source: 'error_fallback' });
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0][0], '[INVENTORY_STORE_SETTING_LOOKUP_FAILED]');
  }
});

test('fresh reads across cutoff, explicit month and previous-day behavior', async () => {
  const h = harness(), api = h.load('lib/inventory/inventory-business-time.ts');
  assert.deepEqual(await api.resolveInventoryMonth('2026-09'), { month: '2026-09', source: 'explicit' });
  assert.equal(h.calls.length, 0);
  await api.resolveInventoryBusinessDate(new Date('2026-10-22T02:59:59+07:00'));
  assert.equal((await api.resolveInventoryBusinessDate(new Date('2026-10-22T03:00:00+07:00'))).businessDate, '2026-10-22');
  assert.equal(h.calls.length, 2);
  const previous = await api.resolveInventoryPreviousBusinessDate();
  const today = await api.resolveInventoryBusinessDate();
  const expected = new Date(new Date(`${today.businessDate}T12:00:00Z`).getTime() - 86400_000).toISOString().slice(0, 10);
  assert.equal(previous.businessDate, expected);
});

test('snapshot list GET: identical response, 5 to 4 requests, fresh authorization', async t => {
  const names = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const saved = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => {
    if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i];
  }));
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://local.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-placeholder';
  const results = [];
  for (const before of [true, false]) {
    const h = harness({ before, delay: 20 });
    const route = h.load('app/api/inventory/snapshot/list/route.ts');
    const times = [];
    let body;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const response = await route.GET(new Request('http://local/api/inventory/snapshot/list'));
      body = await response.json(); times.push(performance.now() - start);
      assert.equal(response.status, 200);
    }
    assert.equal(h.calls.length, (before ? 5 : 4) * 5);
    assert.equal(h.calls.filter(call => call.name === 'users').length, 5);
    assert.equal(h.calls.filter(call => call.name === 'store_get_settings_overview_v1').length, before ? 5 : 0);
    results.push(body);
    t.diagnostic(`${before ? 'before' : 'after'}: ${h.calls.length / 5} requests/GET; median ${times.sort((a,b) => a-b)[2].toFixed(1)}ms (20ms simulated I/O; not production latency)`);
    h.deny(); const count = h.calls.length;
    assert.equal((await route.GET(new Request('http://local/api/inventory/snapshot/list'))).status, 403);
    assert.equal(h.calls.length - count, 1);
  }
  assert.deepEqual(results[1], results[0]);
});
