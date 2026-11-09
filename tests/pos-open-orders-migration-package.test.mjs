// Migration approval package for pos_open_orders_v1, exercised on in-memory PGlite only.
// The reviewed draft itself is unchanged since c7e355a2 (its 54 tests are not repeated here).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = 'supabase/migrations/20261109210000_pos_open_orders_v1.sql';
const DRAFT = 'docs/sql/pos-open-orders-v1-draft.sql';
const SHA256 = '570331478253b760be480e7236e854cba43a1acf03c25cb4ce5259e8176f3988';
const sql = (name) => readFileSync(`supabase/pos_open_orders_v1_${name}.sql`, 'utf8');
const migration = readFileSync(MIGRATION, 'utf8');

async function database() {
  const db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;');
  return db;
}
const checks = async (db, name) => (await db.query(sql(name))).rows;
const failing = (rows) => rows.filter((r) => r.pass !== true).map((r) => r.check_name);

test('migration file is byte-identical to the reviewed draft (sha256, 286 lines, LF)', () => {
  const a = readFileSync(DRAFT), b = readFileSync(MIGRATION);
  assert.equal(Buffer.compare(a, b), 0);
  assert.equal(createHash('sha256').update(b).digest('hex'), SHA256);
  assert.equal(b.toString('utf8').split('\n').length - 1, 286);
  assert.equal(b.includes('\r\n'), false);
  // Recorded in the review document as well.
  assert.match(readFileSync('docs/pos-open-orders-v1-migration-review.md', 'utf8'), new RegExp(SHA256));
});

test('migration defines exactly 4 tables, 2 indexes and 8 functions with the reviewed signatures', () => {
  const tables = [...migration.matchAll(/create table (\S+) \(/g)].map((m) => m[1]);
  assert.deepEqual(tables, ['pos_open_orders_private.runs', 'pos_open_orders_private.sync_state', 'pos_open_orders_private.orders', 'pos_open_orders_private.order_lines']);
  assert.equal((migration.match(/create (unique )?index /g) ?? []).length, 2);
  const fns = [...migration.matchAll(/create function (\S+)\(([^)]*)\)\s*\nreturns jsonb language (\w+) (?:(\w+) )?security (definer|invoker) set search_path = '' as/g)]
    .map((m) => [m[1], m[5]]);
  assert.deepEqual(fns, [
    ['pos_open_orders_private.claim_v1', 'definer'], ['pos_open_orders_private.commit_v1', 'definer'],
    ['pos_open_orders_private.fail_v1', 'definer'], ['pos_open_orders_private.read_v1', 'definer'],
    ['public.pos_open_orders_claim', 'invoker'], ['public.pos_open_orders_commit', 'invoker'],
    ['public.pos_open_orders_fail', 'invoker'], ['public.pos_open_orders_read', 'invoker'],
  ]);
  // Nothing outside the new objects is created, altered or dropped.
  const code = migration.replace(/--.*$/gm, '');
  assert.doesNotMatch(code, /\bdrop\b|\btruncate\b/i);
  for (const m of code.matchAll(/\b(delete from|update(?!\s+set\b)|insert into|alter table|alter function)\s+(\S+)/gi)) {
    assert.match(m[2], /^pos_open_orders_private\./, `${m[1]} ${m[2]}`);
  }
});

test('install sequence on PGlite: preflight passes -> apply -> preflight detects install -> postflight all pass -> RPC smoke', async () => {
  const db = await database();
  try {
    assert.deepEqual(failing(await checks(db, 'preflight')), []);
    await db.exec(migration);
    const again = failing(await checks(db, 'preflight'));
    assert.ok(again.includes('schema pos_open_orders_private does not exist'));
    assert.ok(again.includes('no public function named pos_open_orders_*'));
    const post = await checks(db, 'postflight');
    assert.equal(post.length, 16);
    assert.deepEqual(failing(post), []);
    await db.exec(sql('rpc_smoke'));
    // The smoke left nothing behind.
    assert.deepEqual(failing(await checks(db, 'postflight')), []);
    // A broken privilege is caught by the postflight.
    await db.exec(`grant execute on function public.pos_open_orders_read(text, date) to anon`);
    assert.deepEqual(failing(await checks(db, 'postflight')), ['EXECUTE: only service_role on all 8 functions']);
  } finally { await db.close(); }
});

test('cancel before data: drops only the new objects; refuses once any row exists', async () => {
  const db = await database();
  try {
    await db.exec(migration);
    await db.exec(sql('rollback_before_data'));
    assert.deepEqual(failing(await checks(db, 'preflight')), []);

    await db.exec(migration);
    await db.exec('set role service_role');
    const date = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    await db.query('select public.pos_open_orders_claim($1, $2, $3, $4, $5, 0)', [randomUUID(), randomUUID(), `${'a'.repeat(64)}:b1`, 'b1', date]);
    await db.exec('reset role');
    await assert.rejects(db.exec(sql('rollback_before_data')), /already has data/);
    await db.exec('rollback');
    assert.deepEqual(failing(await checks(db, 'postflight')).filter((c) => !c.startsWith('no data yet')), []);
    assert.equal((await db.query('select count(*)::int n from pos_open_orders_private.runs')).rows[0].n, 1);
  } finally { await db.close(); }
});

test('stop after data: suspend blocks the app role without touching rows; resume restores the exact privileges', async () => {
  const db = await database();
  try {
    await db.exec(migration);
    const scope = `${'a'.repeat(64)}:b1`;
    const date = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    await db.exec('set role service_role');
    await db.query('select public.pos_open_orders_claim($1, $2, $3, $4, $5, 0)', [randomUUID(), randomUUID(), scope, 'b1', date]);
    await db.exec('reset role');
    await db.exec(sql('suspend'));
    await db.exec('set role service_role');
    await assert.rejects(db.query('select public.pos_open_orders_read($1, $2)', [scope, date]), /permission denied for function/);
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int n from pos_open_orders_private.runs')).rows[0].n, 1);
    await db.exec(sql('resume'));
    assert.deepEqual(failing(await checks(db, 'postflight')), ['no data yet (all 4 tables empty)']);
    await db.exec('set role service_role');
    assert.equal((await db.query('select public.pos_open_orders_read($1, $2) r', [scope, date])).rows[0].r.sync.lastErrorCode, null);
    await db.exec('reset role');
  } finally { await db.close(); }
});
