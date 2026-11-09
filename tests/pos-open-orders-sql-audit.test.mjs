// Independent SQL audit fixes for pos_open_orders_v1 (NULL owner token, NULL payload,
// lease judged at real time). Each case runs on the fixed SQL and, as proof that the
// test detects the defect, on the pre-fix SQL from af600ba4. PGlite only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const FIXED = readFileSync('docs/sql/pos-open-orders-v1-draft.sql', 'utf8');
const BEFORE = execFileSync('git', ['show', 'af600ba4:docs/sql/pos-open-orders-v1-draft.sql'], { encoding: 'utf8' });
const BRANCH = 'b1';
const SCOPE = `${'a'.repeat(64)}:${BRANCH}`;
const DATE = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

async function database(source) {
  const db = new PGlite();
  await db.exec('create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;');
  await db.exec(source);
  return db;
}
async function rpc(db, name, args) {
  await db.exec('set role service_role');
  try {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
    return (await db.query(`select public.${name}(${placeholders}) as r`, args)).rows[0].r;
  } finally { await db.exec('reset role'); }
}
const claim = async (db) => {
  const run = randomUUID(), owner = randomUUID();
  assert.equal((await rpc(db, 'pos_open_orders_claim', [run, owner, SCOPE, BRANCH, DATE, 0])).status, 'collecting');
  return { run, owner };
};
const line = (id) => ({ detailId: `d${id}`, parentDetailId: null, additionId: null, itemId: `i${id}`, itemName: `Item ${id}`, unitName: 'Lon',
  quantity: 1, price: 1000, amount: 1000, lineStatus: 1, isOption: false, isOrphanOption: false, isCanceled: false });
// Finished orders only (no open/unknown), so the vanished guard cannot mask a NULL payload.
const order = (id, extra = {}) => ({ orderId: `o${id}`, orderNo: `1.${id}`, status: 4, statusClass: 'paid_candidate', orderDate: new Date().toISOString(),
  businessDate: DATE, totalAmount: 1000, tableName: 'BAR10', lines: [line(id)], ...extra });
const snapshot = async (db) => ({
  orders: (await db.query('select order_id from pos_open_orders_private.orders order by 1')).rows.map((r) => r.order_id),
  lines: (await db.query('select count(*)::int n from pos_open_orders_private.order_lines')).rows[0].n,
  sync: (await db.query('select last_success_at, last_success_run_id, last_error_code from pos_open_orders_private.sync_state')).rows[0],
});
async function seeded(source) {
  const db = await database(source);
  const a = await claim(db);
  await rpc(db, 'pos_open_orders_commit', [a.run, a.owner, '{}', JSON.stringify([order(1), order(2)])]);
  return db;
}

test('NULL owner token: commit and fail are refused (pre-fix SQL accepted both)', async () => {
  for (const [source, fixed] of [[FIXED, true], [BEFORE, false]]) {
    const db = await seeded(source);
    try {
      const before = await snapshot(db);
      const b = await claim(db);
      const commit = rpc(db, 'pos_open_orders_commit', [b.run, null, '{}', JSON.stringify([order(3)])]);
      if (fixed) {
        await assert.rejects(commit, /open_orders_run_conflict/);
        await assert.rejects(rpc(db, 'pos_open_orders_fail', [b.run, null, 'x']), /open_orders_run_conflict/);
        await assert.rejects(rpc(db, 'pos_open_orders_commit', [null, null, '{}', '[]']), /open_orders_run_conflict/);
        assert.deepEqual(await snapshot(db), before);
        // The real owner can still finish the run.
        assert.equal((await rpc(db, 'pos_open_orders_commit', [b.run, b.owner, '{}', JSON.stringify([order(1), order(2)])])).status, 'committed');
      } else {
        assert.equal((await commit).status, 'committed', 'pre-fix SQL let a NULL token commit');
      }
    } finally { await db.close(); }
  }
  // fail with NULL token on the pre-fix SQL
  const db = await seeded(BEFORE);
  try {
    const c = await claim(db);
    assert.equal((await rpc(db, 'pos_open_orders_fail', [c.run, null, 'x'])).status, 'failed', 'pre-fix SQL let a NULL token fail a run');
  } finally { await db.close(); }
});

test('wrong owner token is still refused for commit and fail', async () => {
  const db = await seeded(FIXED);
  try {
    const before = await snapshot(db);
    const b = await claim(db);
    await assert.rejects(rpc(db, 'pos_open_orders_commit', [b.run, randomUUID(), '{}', '[]']), /open_orders_run_conflict/);
    await assert.rejects(rpc(db, 'pos_open_orders_fail', [b.run, randomUUID(), 'x']), /open_orders_run_conflict/);
    assert.deepEqual(await snapshot(db), before);
  } finally { await db.close(); }
});

test('NULL p_orders / NULL p_manifest: refused, orders, lines and success time unchanged (pre-fix SQL wiped the snapshot)', async () => {
  for (const [source, fixed] of [[FIXED, true], [BEFORE, false]]) {
    const db = await seeded(source);
    try {
      const before = await snapshot(db);
      assert.deepEqual([before.orders, before.lines], [['o1', 'o2'], 2]);
      const b = await claim(db);
      if (fixed) {
        await assert.rejects(rpc(db, 'pos_open_orders_commit', [b.run, b.owner, '{}', null]), /open_orders_payload_invalid/);
        await assert.rejects(rpc(db, 'pos_open_orders_commit', [b.run, b.owner, null, JSON.stringify([order(1), order(2)])]), /open_orders_payload_invalid/);
        // JSON null and wrong JSON types stay refused too.
        await assert.rejects(rpc(db, 'pos_open_orders_commit', [b.run, b.owner, '{}', 'null']), /open_orders_payload_invalid/);
        await assert.rejects(rpc(db, 'pos_open_orders_commit', [b.run, b.owner, '[]', '[]']), /open_orders_payload_invalid/);
        assert.deepEqual(await snapshot(db), before);
        assert.equal((await db.query('select status from pos_open_orders_private.runs where id = $1', [b.run])).rows[0].status, 'collecting');
      } else {
        const r = await rpc(db, 'pos_open_orders_commit', [b.run, b.owner, '{}', null]);
        assert.equal(r.status, 'committed', 'pre-fix SQL accepted NULL p_orders');
        const after = await snapshot(db);
        assert.deepEqual([after.orders, after.lines], [[], 0], 'pre-fix SQL deleted the snapshot');
        assert.notEqual(after.sync.last_success_run_id, before.sync.last_success_run_id, 'pre-fix SQL marked the NULL run as the last success');
      }
    } finally { await db.close(); }
  }
});

test('lease expiring after the lock is taken (here: during a slow store) fails the commit and rolls everything back', async () => {
  for (const [source, fixed] of [[FIXED, true], [BEFORE, false]]) {
    const db = await seeded(source);
    try {
      const before = await snapshot(db);
      const b = await claim(db);
      // Test-only delay: every stored order takes 150ms (stands in for lock wait / slow storage).
      await db.exec(`create function pg_temp.slow() returns trigger language plpgsql as $$ begin perform pg_sleep(0.15); return new; end $$;
        create trigger slow_store before insert on pos_open_orders_private.orders for each row execute function pg_temp.slow();`);
      // Valid when the commit starts, expired before it can finish storing 3 orders (~450ms).
      await db.query(`update pos_open_orders_private.runs set lease_until = clock_timestamp() + interval '200 milliseconds' where id = $1`, [b.run]);
      const commit = rpc(db, 'pos_open_orders_commit', [b.run, b.owner, '{}', JSON.stringify([order(1), order(2), order(3)])]);
      if (fixed) {
        await assert.rejects(commit, /open_orders_lease_lost/);
        assert.deepEqual(await snapshot(db), before);
        assert.equal((await db.query('select status from pos_open_orders_private.runs where id = $1', [b.run])).rows[0].status, 'collecting');
      } else {
        assert.equal((await commit).status, 'committed', 'pre-fix SQL committed after its lease had expired');
      }
    } finally { await db.close(); }
  }
});

test('finish and success times are the real completion time; lease is measured after the lock', async () => {
  const body = FIXED.slice(FIXED.indexOf('create function pos_open_orders_private.commit_v1'), FIXED.indexOf('create function pos_open_orders_private.fail_v1'));
  const declare = body.slice(body.indexOf('declare'), body.indexOf('begin'));
  assert.doesNotMatch(declare, /clock_timestamp\(\)/);
  const lock = body.indexOf('pg_advisory_xact_lock'), forUpdate = body.indexOf('for update');
  const measure = body.indexOf('v_now := clock_timestamp();'), check = body.indexOf('r.lease_until <= v_now');
  assert.ok(lock > 0 && lock < forUpdate && forUpdate < measure && measure < check);
  const store = body.indexOf('for v_order in'), done = body.indexOf('v_done := clock_timestamp();');
  assert.ok(store < done && done < body.indexOf('r.lease_until <= v_done') && body.indexOf('r.lease_until <= v_done') < body.indexOf("set status = 'committed'"));
  assert.match(body, /finished_at = v_done/);
  assert.match(body, /last_success_at = v_done/);
  assert.doesNotMatch(body.replace(/--.*$/gm, ''), /\s<>\s*p_owner_token/);
  const fail = FIXED.slice(FIXED.indexOf('create function pos_open_orders_private.fail_v1'), FIXED.indexOf('create function pos_open_orders_private.read_v1'));
  assert.match(fail, /if p_run_id is null or p_owner_token is null then raise exception 'open_orders_run_conflict'/);
  assert.match(fail, /r\.owner_token is distinct from p_owner_token/);

  // Timestamps written by a successful commit are not earlier than the real completion.
  const db = await database(FIXED);
  try {
    const a = await claim(db);
    const before = (await db.query('select clock_timestamp() t')).rows[0].t;
    await rpc(db, 'pos_open_orders_commit', [a.run, a.owner, '{}', JSON.stringify([order(1)])]);
    const run = (await db.query('select finished_at from pos_open_orders_private.runs where id = $1', [a.run])).rows[0];
    const sync = (await snapshot(db)).sync;
    assert.ok(run.finished_at >= before && sync.last_success_at.getTime() === run.finished_at.getTime());
  } finally { await db.close(); }
});
