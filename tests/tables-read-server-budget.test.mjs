// BABA-TABLE-FINAL: server read path of /api/tables with a stubbed DB client. A timed-out context
// read is never repeated by the manual context or the snapshot fallback; other failures keep the
// existing fallback; every failed stage logs one fixed line. Same transpile/stub loader pattern as
// tests/employee-level-history-api.test.mjs. Synthetic values only (no credentials or real data).
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runInThisContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const external = createRequire(import.meta.url);
const day = '2026-11-25', scope = 'a'.repeat(64) + ':branch-fixture';

function fixture(answers) {
  const calls = [], logs = [], cache = new Map();
  const builder = name => ({ abortSignal: async signal => { assert.ok(signal instanceof AbortSignal); calls.push(name);
    const answer = answers[name]; if (!answer) throw Error('unexpected rpc ' + name); return answer; } });
  const db = { rpc: (name) => builder(name) };
  const stubs = new Map([
    ['@/lib/supabase/server', { supabaseServer: db }],
    ['@/lib/store-settings/business-time-adapter', { loadBusinessTimeAdapter: async () => ({ databaseBusinessDate: day,
      snapshot: load('lib/store-settings/business-time-adapter-core.ts').createFallbackBusinessTimeSnapshot(day) }) }],
    ['@/lib/pos/cukcuk/open-orders-scope', { openOrdersScope: () => scope, openOrdersBranchId: () => 'branch-fixture' }],
    ['./daily-sales-summary', { fetchAllExactPages: async () => { calls.push('receipts'); return answers.receipts ?? { data: [], error: null }; } }],
  ]);
  function load(file) {
    const path = resolve(file);
    if (cache.has(path)) return cache.get(path).exports;
    const loaded = { exports: {} }; cache.set(path, loaded);
    const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = name => {
      if (stubs.has(name)) return stubs.get(name);
      if (name === 'server-only') return {};
      if (name.startsWith('.') || name.startsWith('@/')) {
        let child = name.startsWith('@/') ? resolve(name.slice(2)) : resolve(dirname(path), name);
        if (!existsSync(child)) child += '.ts';
        return load(child);
      }
      return external(name);
    };
    runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: path })(localRequire, loaded, loaded.exports);
    return loaded.exports;
  }
  const original = console.error;
  const run = async () => {
    console.error = (...args) => logs.push(args);
    try { return await load('lib/sales/table-overview-server.ts').readTableOverview(new Date(`${day}T13:30:00Z`)); }
    finally { console.error = original; }
  };
  return { calls, logs, run };
}
const flags = { POS_OPEN_ORDERS_READ_ENABLED: 'true', BABA_TABLE_CLEANING_ENABLED: 'true', BABA_TABLE_AUTO_NORMAL_ENABLED: 'true',
  BABA_TABLE_AUTO_NORMAL_ACTIVATION: '00000000-0000-4000-8000-000000000abc' };
async function withFlags(fn) {
  const previous = Object.fromEntries(Object.keys(flags).map(k => [k, process.env[k]]));
  Object.assign(process.env, flags);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
const entries = logs => logs.map(([tag, body]) => [tag, JSON.parse(body).stage, JSON.parse(body).code]);
const snapshot = { data: { sync: { businessDate: day, lastSuccessAt: `${day}T13:27:20Z`, lastAttemptAt: `${day}T13:27:20Z`, lastErrorCode: null }, orders: [] }, error: null };

test('auto context statement timeout: no manual-context retry and no snapshot fallback; read_failed board; one log line', () => withFlags(async () => {
  const f = fixture({ tables_auto_context_v1: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } } });
  const overview = await f.run();
  assert.deepEqual(f.calls, ['tables_auto_context_v1']);
  assert.equal(overview.collection.health, 'read_failed');
  assert.ok(overview.tables.every(t => t.state === 'unknown'));
  assert.deepEqual(entries(f.logs), [['[TABLES_READ_FAILED]', 'auto_context', '57014']]);
  assert.doesNotMatch(JSON.stringify(f.logs), /canceling|statement/);
}));

test('auto context missing/disabled (not a timeout): the existing manual-context fallback, then the snapshot fallback', () => withFlags(async () => {
  const f = fixture({ tables_auto_context_v1: { data: null, error: { code: '42883', message: 'function does not exist' } },
    tables_cleaning_context_v1: { data: null, error: { code: 'PGRST003', message: 'Timed out acquiring connection from connection pool.' } },
    pos_open_orders_read: snapshot });
  const overview = await f.run();
  // Manual context timed out (pool): the snapshot fallback is not started either.
  assert.deepEqual(f.calls, ['tables_auto_context_v1', 'tables_cleaning_context_v1']);
  assert.equal(overview.collection.health, 'read_failed');
  assert.deepEqual(entries(f.logs).map(e => e.slice(1)), [['auto_context', '42883'], ['cleaning_context', 'PGRST003']]);
}));

test('a non-timeout context failure keeps the original snapshot fallback; snapshot and receipt failures name their stage', () => withFlags(async () => {
  let f = fixture({ tables_auto_context_v1: { data: null, error: { code: '42883' } }, tables_cleaning_context_v1: { data: null, error: { code: '42501' } },
    pos_open_orders_read: snapshot });
  let overview = await f.run();
  assert.deepEqual(f.calls, ['tables_auto_context_v1', 'tables_cleaning_context_v1', 'pos_open_orders_read', 'receipts']);
  assert.notEqual(overview.collection.health, 'read_failed');
  f = fixture({ tables_auto_context_v1: { data: null, error: { code: '42883' } }, tables_cleaning_context_v1: { data: null, error: { code: '42501' } },
    pos_open_orders_read: { data: null, error: { code: '57014' } } });
  overview = await f.run();
  assert.equal(overview.collection.health, 'read_failed');
  assert.deepEqual(entries(f.logs).map(e => e[1]), ['auto_context', 'cleaning_context', 'snapshot']);
  f = fixture({ tables_auto_context_v1: { data: null, error: { code: '42883' } }, tables_cleaning_context_v1: { data: null, error: { code: '42501' } },
    pos_open_orders_read: snapshot, receipts: { data: null, error: { code: '57014', message: 'x' } } });
  overview = await f.run();
  assert.equal(overview.collection.health, 'read_failed');
  assert.deepEqual(entries(f.logs).at(-1).slice(1), ['receipts', '57014']);
}));
