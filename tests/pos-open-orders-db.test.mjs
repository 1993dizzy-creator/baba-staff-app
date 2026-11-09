// Applies the NOT-APPLIED draft (docs/sql/pos-open-orders-v1-draft.sql) to an in-memory
// PGlite database. No production database or POS credentials are used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const DRAFT = readFileSync('docs/sql/pos-open-orders-v1-draft.sql', 'utf8');
const BRANCH = 'c39228ba-a452-4cf9-bf34-424ffb151fb8';
const SCOPE = `${'a'.repeat(64)}:${BRANCH}`;
// Claims accept only the live business date range, so test dates follow the clock.
const vnDate = (offsetDays = 0) => new Date(Date.now() + 7 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
const DATE = vnDate(0);
const NEXT_DATE = vnDate(1);

async function database() {
  const db = new PGlite();
  // Supabase-like roles: service_role bypasses RLS but has no table grants here.
  await db.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;');
  await db.exec(DRAFT);
  return db;
}
async function asRole(db, role, fn) {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
// Every RPC goes through the public SECURITY INVOKER wrapper as service_role (the
// server's real path); direct fixture manipulation below runs as the superuser.
async function call(db, name, args, role = 'service_role') {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
  return asRole(db, role, async () => (await db.query(`select public.${name}(${placeholders}) as result`, args)).rows[0].result);
}
const claim = (db, runId, owner, date = DATE, minInterval = 60) => call(db, 'pos_open_orders_claim', [runId, owner, SCOPE, BRANCH, date, minInterval]);
const lineOf = (id, extra = {}) => ({ detailId: `d${id}`, parentDetailId: null, additionId: null, itemId: `i${id}`, itemName: `Item ${id}`,
  unitName: 'Lon', quantity: 1, price: 30000, amount: 30000, lineStatus: 1, isOption: false, isOrphanOption: false, isCanceled: false, ...extra });
const orderOf = (id, extra = {}) => ({ orderId: `o${id}`, orderNo: `1.${id}`, status: 1, statusClass: 'open', orderDate: '2026-11-09T13:00:00.000Z',
  businessDate: DATE, totalAmount: 30000, tableName: '+bar10', lines: [lineOf(id)], ...extra });
async function runOnce(db, orders, date = DATE) {
  const runId = randomUUID(), owner = randomUUID();
  const claimed = await claim(db, runId, owner, date, 0);
  assert.equal(claimed.status, 'collecting');
  return { runId, owner, result: await call(db, 'pos_open_orders_commit', [runId, owner, { total: orders.length }, JSON.stringify(orders)]) };
}
const read = async (db, date = DATE) => call(db, 'pos_open_orders_read', [SCOPE, date]);

test('single-run lock: an overlapping claim is busy; a fresh success throttles further CUKCUK calls', async () => {
  const db = await database();
  try {
    const first = { runId: randomUUID(), owner: randomUUID() };
    assert.equal((await claim(db, first.runId, first.owner)).status, 'collecting');
    assert.equal((await claim(db, randomUUID(), randomUUID())).status, 'busy');
    // Idempotent replay of the same run id.
    assert.equal((await claim(db, first.runId, first.owner)).status, 'collecting');
    await assert.rejects(claim(db, first.runId, randomUUID()), /open_orders_run_conflict/);
    await call(db, 'pos_open_orders_commit', [first.runId, first.owner, {}, JSON.stringify([orderOf(1)])]);
    const throttled = await claim(db, randomUUID(), randomUUID(), DATE, 60);
    assert.equal(throttled.status, 'fresh');
    // The throttle is per business date: the next date may still collect.
    assert.equal((await claim(db, randomUUID(), randomUUID(), NEXT_DATE, 60)).status, 'collecting');
  } finally { await db.close(); }
});

test('commit replaces the snapshot: quantity change, cancellation and payment transitions follow the latest run', async () => {
  const db = await database();
  try {
    await runOnce(db, [orderOf(1), orderOf(2), orderOf(3, { lines: [lineOf(3), lineOf(30, { parentDetailId: 'd3', isOption: true, amount: 5000 })] })]);
    let snapshot = await read(db);
    assert.equal(snapshot.orders.length, 3);
    assert.deepEqual(snapshot.orders[2].lines.map((l) => [l.detailId, l.isOption]), [['d3', false], ['d30', true]]);
    // Next run: order 1 quantity 3, order 2 canceled (unknown status), order 3 now Status 4 without lines.
    const { result } = await runOnce(db, [
      orderOf(1, { totalAmount: 90000, lines: [lineOf(1, { quantity: 3, amount: 90000 })] }),
      orderOf(2, { status: 2, statusClass: 'unknown', lines: [] }),
      orderOf(3, { status: 4, statusClass: 'paid_candidate', lines: null }),
    ]);
    assert.deepEqual([result.status, result.orders, result.lines], ['committed', 3, 1]);
    snapshot = await read(db);
    assert.deepEqual(snapshot.orders.map((o) => [o.orderId, o.statusClass, Number(o.totalAmount)]), [['o1', 'open', 90000], ['o2', 'unknown', 30000], ['o3', 'paid_candidate', 30000]]);
    assert.equal(Number(snapshot.orders[0].lines[0].quantity), 3);
    assert.equal(snapshot.orders[2].lines, null);
    assert.equal((await db.query('select count(*)::int n from pos_open_orders_private.order_lines')).rows[0].n, 1);
  } finally { await db.close(); }
});

test('failure keeps the last good snapshot and its old success time; lease loss and bad payloads are rejected', async () => {
  const db = await database();
  try {
    await runOnce(db, [orderOf(1)]);
    const before = await read(db);
    const runId = randomUUID(), owner = randomUUID();
    await claim(db, runId, owner, DATE, 0);
    assert.deepEqual(await call(db, 'pos_open_orders_fail', [runId, owner, 'provider_timeout']), { status: 'failed', code: 'provider_timeout' });
    const after = await read(db);
    assert.equal(after.orders.length, 1);
    assert.equal(after.sync.lastSuccessAt, before.sync.lastSuccessAt);
    assert.equal(after.sync.lastErrorCode, 'provider_timeout');
    assert.equal(after.sync.consecutiveFailures, 1);
    // Unsafe codes are normalized, never stored verbatim.
    const r2 = randomUUID(), o2 = randomUUID();
    await claim(db, r2, o2, DATE, 0);
    assert.equal((await call(db, 'pos_open_orders_fail', [r2, o2, "x'; drop table"])).code, 'collection_failed');

    const r3 = randomUUID(), o3 = randomUUID();
    await claim(db, r3, o3, DATE, 0);
    await assert.rejects(call(db, 'pos_open_orders_commit', [r3, o3, {}, JSON.stringify([orderOf(1, { businessDate: NEXT_DATE })])]), /open_orders_payload_invalid/);
    await assert.rejects(call(db, 'pos_open_orders_commit', [r3, o3, {}, JSON.stringify([orderOf(1), orderOf(1)])]), /open_orders_payload_invalid/);
    await db.query(`update pos_open_orders_private.runs set lease_until = now() - interval '1 second' where id = $1`, [r3]);
    await assert.rejects(call(db, 'pos_open_orders_commit', [r3, o3, {}, '[]']), /open_orders_lease_lost/);
    // Recovery: the expired lease does not block the next run.
    assert.equal((await claim(db, randomUUID(), randomUUID(), DATE, 0)).status, 'collecting');
    assert.equal((await db.query(`select status, failure_code from pos_open_orders_private.runs where id = $1`, [r3])).rows[0].failure_code, 'lease_expired');
    assert.equal((await read(db)).orders.length, 1);
  } finally { await db.close(); }
});

test('empty list guard: unfinished orders cannot vanish into a false 0; finished orders may reach a real 0', async () => {
  const db = await database();
  try {
    await runOnce(db, [orderOf(1), orderOf(2, { status: 4, statusClass: 'paid_candidate', lines: null })]);
    // CUKCUK returns an empty (or partial) list while o1 was open: rejected, snapshot and success time kept.
    const before = await read(db);
    for (const payload of [[], [orderOf(2, { status: 4, statusClass: 'paid_candidate', lines: null })]]) {
      const runId = randomUUID(), owner = randomUUID();
      await claim(db, runId, owner, DATE, 0);
      await assert.rejects(call(db, 'pos_open_orders_commit', [runId, owner, {}, JSON.stringify(payload)]), /open_orders_vanished/);
      await call(db, 'pos_open_orders_fail', [runId, owner, 'open_orders_vanished']);
    }
    const kept = await read(db);
    assert.deepEqual(kept.orders.map((o) => o.orderId), ['o1', 'o2']);
    assert.equal(kept.sync.lastSuccessAt, before.sync.lastSuccessAt);
    assert.equal(kept.sync.lastErrorCode, 'open_orders_vanished');
    // o1 confirmed finished (Status 4): commit succeeds and the open count becomes a real 0.
    await runOnce(db, [orderOf(1, { status: 4, statusClass: 'paid_candidate', lines: null }), orderOf(2, { status: 4, statusClass: 'paid_candidate', lines: null })]);
    const done = await read(db);
    assert.deepEqual(done.orders.map((o) => o.statusClass), ['paid_candidate', 'paid_candidate']);
    assert.equal(done.sync.lastErrorCode, null);
    // Once nothing is unfinished, finished orders may age out of the list: an empty list commits.
    assert.equal((await runOnce(db, [])).result.status, 'committed');
    assert.equal((await read(db)).orders.length, 0);
  } finally { await db.close(); }
});

test('late writer isolation: after its 3-minute lease expires, the old collector cannot commit, fail or reuse tokens', async () => {
  const db = await database();
  try {
    const a = { runId: randomUUID(), owner: randomUUID() };
    assert.equal((await claim(db, a.runId, a.owner, DATE, 0)).status, 'collecting');
    // A stalls past its lease; B claims (expiring A) and commits the current snapshot.
    await db.query(`update pos_open_orders_private.runs set lease_until = clock_timestamp() - interval '1 second' where id = $1`, [a.runId]);
    const b = await runOnce(db, [orderOf(2)]);
    assert.equal(b.result.status, 'committed');
    const afterB = await read(db);

    // A wakes up late: commit, fail and claim-replay all stay harmless.
    await assert.rejects(call(db, 'pos_open_orders_commit', [a.runId, a.owner, {}, JSON.stringify([orderOf(1)])]), /open_orders_lease_lost/);
    assert.deepEqual(await call(db, 'pos_open_orders_fail', [a.runId, a.owner, 'provider_timeout']), { status: 'ignored' });
    assert.equal((await claim(db, a.runId, a.owner, DATE, 0)).status, 'expired');
    // A cannot borrow B's run with its own token, nor B's token on A's run.
    await assert.rejects(call(db, 'pos_open_orders_commit', [b.runId, a.owner, {}, '[]']), /open_orders_run_conflict/);
    await assert.rejects(call(db, 'pos_open_orders_fail', [b.runId, a.owner, 'x']), /open_orders_run_conflict/);
    await assert.rejects(call(db, 'pos_open_orders_commit', [a.runId, b.owner, {}, '[]']), /open_orders_run_conflict/);
    // B's committed run replays as committed and cannot be failed afterwards.
    assert.equal((await call(db, 'pos_open_orders_commit', [b.runId, b.owner, {}, JSON.stringify([orderOf(9)])])).replay, true);
    assert.deepEqual(await call(db, 'pos_open_orders_fail', [b.runId, b.owner, 'late']), { status: 'ignored' });

    const final = await read(db);
    assert.deepEqual(final.orders.map((o) => o.orderId), ['o2']);
    assert.equal(final.sync.lastSuccessAt, afterB.sync.lastSuccessAt);
    assert.equal(final.sync.lastErrorCode, null);
    assert.equal(final.sync.consecutiveFailures, 0);
    const runs = (await db.query('select id, status, failure_code from pos_open_orders_private.runs order by started_at')).rows;
    assert.deepEqual(runs.map((r) => [r.id, r.status, r.failure_code]), [[a.runId, 'expired', 'lease_expired'], [b.runId, 'committed', null]]);
  } finally { await db.close(); }
});

test('claims only accept the live business date range; retention removes snapshots older than 7 days', async () => {
  const db = await database();
  try {
    for (const date of [vnDate(-2), vnDate(2), '2099-01-01']) {
      await assert.rejects(claim(db, randomUUID(), randomUUID(), date, 0), /open_orders_business_date_out_of_range/);
    }
    assert.equal((await claim(db, randomUUID(), randomUUID(), vnDate(-1), 0)).status, 'collecting');
    await db.exec(`update pos_open_orders_private.runs set status = 'failed'`);
    // An old snapshot (written directly, as if from 8 days ago) and a 6-day-old one.
    const oldRun = randomUUID();
    for (const [date, id] of [[vnDate(-8), 'old'], [vnDate(-6), 'recent']]) {
      await db.query(`insert into pos_open_orders_private.orders(scope,business_date,order_id,status,status_class,order_date,total_amount,has_lines,run_id,observed_at)
        values ($1,$2,$3,1,'open',now(),1000,false,$4,now())`, [SCOPE, date, id, oldRun]);
    }
    await runOnce(db, [orderOf(2)], DATE);
    assert.equal((await read(db, vnDate(-8))).orders.length, 0);
    assert.equal((await read(db, vnDate(-6))).orders.length, 1);
    assert.equal((await read(db, DATE)).orders.length, 1);
  } finally { await db.close(); }
});

const WRAPPERS = [
  ['pos_open_orders_claim', 'uuid, uuid, text, text, date, integer'],
  ['pos_open_orders_commit', 'uuid, uuid, jsonb, jsonb'],
  ['pos_open_orders_fail', 'uuid, uuid, text'],
  ['pos_open_orders_read', 'text, date'],
];
const INTERNAL = [
  ['claim_v1', 'uuid, uuid, text, text, date, integer'],
  ['commit_v1', 'uuid, uuid, jsonb, jsonb'],
  ['fail_v1', 'uuid, uuid, text'],
  ['read_v1', 'text, date'],
];
const TABLES = ['runs', 'sync_state', 'orders', 'order_lines'];

test('service_role runs claim/commit/fail/read through the public wrappers; anon/authenticated are refused everywhere', async () => {
  const db = await database();
  try {
    // Full cycle as service_role through the wrappers.
    const runId = randomUUID(), owner = randomUUID();
    assert.equal((await claim(db, runId, owner, DATE, 0)).status, 'collecting');
    assert.equal((await call(db, 'pos_open_orders_commit', [runId, owner, {}, JSON.stringify([orderOf(1)])])).status, 'committed');
    const r2 = randomUUID(), o2 = randomUUID();
    await claim(db, r2, o2, DATE, 0);
    assert.equal((await call(db, 'pos_open_orders_fail', [r2, o2, 'provider_timeout'])).status, 'failed');
    assert.equal((await read(db)).orders.length, 1);
    // Error codes raised inside the private functions reach the caller unchanged.
    await assert.rejects(call(db, 'pos_open_orders_claim', [randomUUID(), randomUUID(), 'bad-scope', BRANCH, DATE, 0]), /open_orders_scope_invalid/);
    await assert.rejects(call(db, 'pos_open_orders_claim', [randomUUID(), randomUUID(), `${'a'.repeat(64)}:other-branch`, BRANCH, DATE, 0]), /open_orders_scope_invalid/);

    for (const role of ['anon', 'authenticated']) {
      await asRole(db, role, async () => {
        for (const [name] of WRAPPERS) {
          const args = name === 'pos_open_orders_read' ? [SCOPE, DATE] : name === 'pos_open_orders_fail' ? [runId, owner, 'x']
            : name === 'pos_open_orders_commit' ? [runId, owner, '{}', '[]'] : [randomUUID(), randomUUID(), SCOPE, BRANCH, DATE, 0];
          const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
          await assert.rejects(db.query(`select public.${name}(${placeholders})`, args), /permission denied for function/);
        }
        await assert.rejects(db.query('select pos_open_orders_private.read_v1($1, $2)', [SCOPE, DATE]), /permission denied for schema/);
        for (const table of TABLES) await assert.rejects(db.query(`select * from pos_open_orders_private.${table}`), /permission denied for schema/);
      });
    }
  } finally { await db.close(); }
});

test('service_role cannot touch private tables directly, even with BYPASSRLS; only the functions can', async () => {
  const db = await database();
  try {
    await runOnce(db, [orderOf(1)]);
    await asRole(db, 'service_role', async () => {
      for (const table of TABLES) {
        await assert.rejects(db.query(`select * from pos_open_orders_private.${table}`), /permission denied for table/);
        await assert.rejects(db.query(`delete from pos_open_orders_private.${table}`), /permission denied for table/);
        await assert.rejects(db.query(`update pos_open_orders_private.${table} set scope = scope`), /permission denied for table/);
      }
      await assert.rejects(db.query(`insert into pos_open_orders_private.sync_state(scope, branch_id) values ('x', 'y')`), /permission denied for table/);
      // The internal function is callable (that is what the wrapper uses), the tables are not.
      assert.equal((await db.query('select pos_open_orders_private.read_v1($1, $2) r', [SCOPE, DATE])).rows[0].r.orders.length, 1);
    });
  } finally { await db.close(); }
});

test('catalog: invoker wrappers, definer internals with empty search_path owned by postgres, minimal grants', async () => {
  const db = await database();
  try {
    const proc = async (schema, name, args) => (await db.query(
      `select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner, p.provolatile
         from pg_proc p where p.oid = $1::regprocedure`, [`${schema}.${name}(${args})`])).rows[0];
    for (const [name, args] of WRAPPERS) {
      const p = await proc('public', name, args);
      assert.equal(p.prosecdef, false, `${name} must be SECURITY INVOKER`);
      assert.deepEqual(p.proconfig, ['search_path=""']);
    }
    for (const [name, args] of INTERNAL) {
      const p = await proc('pos_open_orders_private', name, args);
      assert.equal(p.prosecdef, true, `${name} must be SECURITY DEFINER`);
      assert.deepEqual(p.proconfig, ['search_path=""']);
      assert.equal(p.owner, 'postgres');
    }
    assert.equal((await proc('public', 'pos_open_orders_read', 'text, date')).provolatile, 's');
    const priv = async (sql, params) => (await db.query(sql, params)).rows[0].ok;
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const expected = role === 'service_role';
      for (const [name, args] of WRAPPERS) {
        assert.equal(await priv(`select has_function_privilege($1, $2, 'execute') ok`, [role, `public.${name}(${args})`]), expected, `${role} ${name}`);
      }
      for (const [name, args] of INTERNAL) {
        assert.equal(await priv(`select has_function_privilege($1, $2, 'execute') ok`, [role, `pos_open_orders_private.${name}(${args})`]), expected, `${role} ${name}`);
      }
      assert.equal(await priv(`select has_schema_privilege($1, 'pos_open_orders_private', 'usage') ok`, [role]), expected);
      assert.equal(await priv(`select has_schema_privilege($1, 'pos_open_orders_private', 'create') ok`, [role]), false);
      for (const table of TABLES) {
        for (const mode of ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) {
          assert.equal(await priv(`select has_table_privilege($1, $2, $3) ok`, [role, `pos_open_orders_private.${table}`, mode]), false, `${role} ${mode} ${table}`);
        }
      }
    }
    // PUBLIC holds nothing on the wrappers or internals.
    const publicAcl = (await db.query(`select count(*)::int n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.proname in ('pos_open_orders_claim','pos_open_orders_commit','pos_open_orders_fail','pos_open_orders_read','claim_v1','commit_v1','fail_v1','read_v1')
        and a.grantee = 0`)).rows[0].n;
    assert.equal(publicAcl, 0);
    for (const table of TABLES) {
      assert.equal((await db.query(`select relrowsecurity ok from pg_class where oid = $1::regclass`, [`pos_open_orders_private.${table}`])).rows[0].ok, true);
    }
  } finally { await db.close(); }
});

test('draft stays separate from paid sales, ledger and inventory', () => {
  const code = DRAFT.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /pos_sales_receipts|ledger_|inventory|pos_sales_business_day_closures/);
  assert.match(DRAFT, /^-- DRAFT — NOT APPLIED/);
});
