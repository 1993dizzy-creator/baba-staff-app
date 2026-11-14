// Opt-in native PostgreSQL (17.x, isolated loopback cluster from the existing QA lifecycle) checks for
// 20261114161500 merged-receipt evidence: real separate connections, real relation/advisory locks.
// Run from .local with QA_POSTGRES_BIN naming local PostgreSQL binaries:
//   node --experimental-strip-types --test ../tests/pos-open-orders-merge-native.test.mjs
// No .env loading, hosted credentials, CUKCUK calls or production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeInventoryPostgres } from './helpers/inventory-native-postgres.mjs';
import { installProductionBaseline, applyMerged, MERGED, doc, FUNCTION_HASHES } from './helpers/pos-open-orders-native-fixture.mjs';

const enabled = Boolean(process.env.QA_POSTGRES_BIN);
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
const date = new Date(Date.now() + 7 * 3600_000 - 3 * 3600_000).toISOString().slice(0, 10); // store day (cutoff 03:00, +07)
const branch = 'branch-fixture', scope = `${'a'.repeat(64)}:${branch}`;
const startMs = Math.max(Date.parse(`${date}T03:01:00+07:00`), Date.now() - 3600_000);
const at = s => new Date(startMs + s * 1000).toISOString();
const line = (o, n, item, quantity, price) => ({ detailId: `${o}-l${n}`, parentDetailId: null, additionId: null, itemId: item, itemName: item,
  unitName: null, quantity, price, amount: quantity * price, lineStatus: 2, isOption: false, isOrphanOption: false, isCanceled: false });
const order = (orderId, tableName, s, lines, status = 1) => ({ orderId, orderNo: orderId, status, statusClass: status === 4 ? 'paid_candidate' : 'open',
  orderDate: at(s), businessDate: date, tableName, lines, totalAmount: lines.reduce((sum, l) => sum + l.amount, 0) });
const target = order('order-t', 'BAR8', 1, [line('t', 1, 'item-a', 1, 170000)]);
const memberA = order('order-a', 'BAR9', 2, [line('a', 1, 'item-b', 2, 90000), line('a', 2, 'item-b', 1, 90000), line('a', 3, 'item-c', 1, 30000),
  line('a', 4, 'item-d', 1, 60000), line('a', 5, 'item-e', 1, 150000)]);
const memberB = order('order-b', 'BAR11', 3, [line('b', 1, 'item-f', 1, 60000), line('b', 2, 'item-a', 1, 170000), line('b', 3, 'item-g', 1, 180000)]);
const other = order('order-o', '13', 4, [line('o', 1, 'item-h', 1, 1410000)]);
const details = [['item-a', 2, 170000], ['item-b', 3, 90000], ['item-c', 1, 30000], ['item-d', 1, 60000], ['item-e', 1, 150000], ['item-f', 1, 60000],
  ['item-g', 1, 180000]].map(([ItemID, Quantity, UnitPrice]) => ({ RefDetailType: 1, ItemID, Quantity, UnitPrice, Amount: Quantity * UnitPrice }));
const merged = (member, rid = 501, into = 'order-t') => ({ ...member, closureReceiptId: rid, closureMergedIntoOrderId: into });
const mergePayload = [{ ...target, status: 4, statusClass: 'paid_candidate', tableName: null, lines: null }, merged(memberA), merged(memberB), other];

async function receipt(c, { id = 501, orderId = 'order-t', status = 3, canceled = false, lines = details } = {}) {
  await c.query('insert into public.pos_sales_receipts values($1,$2,$3,$4,$5,$6,$7,0,$8)', [id, 'cukcuk', branch, date, status, canceled,
    lines.reduce((s, d) => s + d.Amount, 0), JSON.stringify({ OrderId: orderId, DiscountAmount: 0, PromotionAmount: 0, PromotionItemsAmount: 0, SAInvoiceDetails: lines })]);
}
async function call(c, name, args) {
  await c.query('set role service_role');
  try { return (await c.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args.map(a => typeof a === 'object' ? JSON.stringify(a) : a))).rows[0].r; }
  finally { await c.query('reset role'); }
}
const claim = async c => {
  const run = randomUUID(), owner = randomUUID();
  const result = await call(c, 'pos_open_orders_claim', [run, owner, scope, branch, date, 0]);
  return { run, owner, result };
};
const commit = (c, { run, owner }, rows) => call(c, 'pos_open_orders_commit', [run, owner, {}, rows]);
const snapshot = async c => (await c.query(`select order_id, status, closure_receipt_id, closure_merged_into_order_id, closure_evidence_hash,
  observed_at from pos_open_orders_private.orders order by order_id`)).rows;
async function waitForLock(observer, pid) {
  for (let i = 0; i < 500; i++) {
    const r = (await observer.query('select wait_event_type, pg_blocking_pids(pid) blockers from pg_stat_activity where pid = $1', [pid])).rows[0];
    if (r?.wait_event_type === 'Lock' && r.blockers.length) return r;
    await delay(10);
  }
  throw Error('expected lock wait not observed');
}
const failedSql = rows => rows.filter(r => r.pass !== true).map(r => `${r.check_name}: ${r.detail ?? ''}`);

test('native PostgreSQL: merge evidence migration, preflight/postflight, concurrency and rollback', { skip: !enabled && 'QA_POSTGRES_BIN not set', timeout: 300000 }, async t => {
  const runtime = await nativeInventoryPostgres({ testContext: t });
  t.diagnostic(runtime.version);
  async function scenario(name, fn, { migrated = true, seeded = true } = {}) {
    await t.test(name, { timeout: 60000 }, async () => {
      const db = new runtime.Database();
      await db.ready;
      await installProductionBaseline(db.client);
      if (migrated) await applyMerged(db.client);
      if (seeded) { const ids = await claim(db.client); await commit(db.client, ids, [target, memberA, memberB, other]); }
      const a = await runtime.connect(db.name), b = await runtime.connect(db.name);
      const pid = async c => (await c.query('select pg_backend_pid() p')).rows[0].p;
      for (const c of [a, b]) await c.query("set statement_timeout = '30s'; set deadlock_timeout = '100ms'");
      try { await fn({ db: db.client, a, b, pid }); }
      finally {
        for (const c of [a, b]) { try { await c.query('rollback'); } catch { /* idle */ } await c.end(); }
        const deadlocks = (await db.client.query('select deadlocks from pg_stat_database where datname = current_database()')).rows[0].deadlocks;
        assert.equal(Number(deadlocks), 0, `${name}: deadlocks`);
        await db.close();
      }
    });
  }

  await scenario('baseline files reproduce the production function hashes; preflight passes; postflight passes after apply and after merge proofs exist', async ({ db }) => {
    const hashes = Object.fromEntries((await db.query(FUNCTION_HASHES)).rows.map(r => [r.sig, r.md5]));
    assert.equal(hashes['pos_open_orders_private.commit_v1(uuid,uuid,jsonb,jsonb)'], 'd4b4af9cf2759c8b422dfdeba058684f');
    assert.equal(hashes['pos_open_orders_private.read_v1(text,date)'], 'ac855dec68eec963eb139ac2132131bc');
    assert.equal(hashes['pos_open_orders_private.commit_snapshot_v1(uuid,uuid,jsonb,jsonb)'], 'bf813f2992eb7e64e4428b13b05be057');
    assert.deepEqual(failedSql((await db.query(doc('preflight'))).rows), []);
    await applyMerged(db);
    t.diagnostic(`after-merge hashes ${JSON.stringify((await db.query(FUNCTION_HASHES)).rows)}`);
    assert.deepEqual(failedSql((await db.query(doc('postflight'))).rows), []);
    const pre = failedSql((await db.query(doc('preflight'))).rows);
    for (const id of ['A2', 'A4', 'A5', 'A6']) assert.ok(pre.some(row => row.startsWith(id)), `preflight ${id} must report the applied state`);
    await receipt(db);
    const ids = await claim(db);
    await commit(db, ids, mergePayload);
    assert.equal((await snapshot(db)).filter(r => r.closure_merged_into_order_id).length, 2);
    // Structural postflight must not fail just because merge proofs now exist.
    assert.deepEqual(failedSql((await db.query(doc('postflight'))).rows), []);
    assert.deepEqual(failedSql((await db.query(doc('functional-check'))).rows), []);
  }, { migrated: false, seeded: true });

  await scenario('migration is atomic: a failure late in the file (simple query, no explicit transaction) leaves nothing applied', async ({ db }) => {
    await db.query('create function pos_open_orders_private.merge_receipt_menu_v1(p jsonb) returns jsonb language sql as $$ select p $$');
    await assert.rejects(db.query(MERGED), /already exists/);
    assert.equal((await db.query("select count(*)::int n from information_schema.columns where column_name in ('closure_merged_into_order_id','closure_evidence_hash')")).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int n from pg_constraint where conname = 'orders_merged_closure_check'")).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int n from pg_proc where proname in ('merge_zero_v1','merge_order_menu_v1')")).rows[0].n, 0);
    const hashes = Object.fromEntries((await db.query(FUNCTION_HASHES)).rows.map(r => [r.sig, r.md5]));
    assert.equal(hashes['pos_open_orders_private.commit_v1(uuid,uuid,jsonb,jsonb)'], 'd4b4af9cf2759c8b422dfdeba058684f');
    // Same failure through the CLI-equivalent transaction also leaves no history row.
    await assert.rejects(applyMerged(db), /already exists/);
    assert.equal((await db.query("select count(*)::int n from supabase_migrations.schema_migrations where version = '20261114161500'")).rows[0].n, 0);
    // Recovery: remove the conflicting object, re-run preflight, apply again.
    await db.query('drop function pos_open_orders_private.merge_receipt_menu_v1(jsonb)');
    assert.deepEqual(failedSql((await db.query(doc('preflight'))).rows), []);
    await applyMerged(db);
    assert.deepEqual(failedSql((await db.query(doc('postflight'))).rows), []);
  }, { migrated: false });

  await scenario('migration vs a running collector commit: lock_timeout 5s aborts the whole migration, collector unaffected', async ({ db, a, b, pid }) => {
    await a.query('begin');
    await a.query('select count(*) from pos_open_orders_private.orders'); // ACCESS SHARE held like an in-flight commit read
    const started = Date.now();
    const applied = settle(applyMerged(b));
    await waitForLock(db, await pid(b));
    const result = await applied;
    const waited = Date.now() - started;
    assert.match(String(result.error?.message), /lock timeout/);
    assert.ok(waited >= 4500 && waited < 9000, `waited ${waited}ms`);
    await a.query('commit');
    assert.equal((await db.query("select count(*)::int n from information_schema.columns where column_name = 'closure_merged_into_order_id'")).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int n from supabase_migrations.schema_migrations where version = '20261114161500'")).rows[0].n, 0);
    assert.deepEqual(failedSql((await db.query(doc('preflight'))).rows), []);
  }, { migrated: false });

  await scenario('SQL Editor-style apply (whole file as one simple query, no explicit begin) still honours lock_timeout and stays atomic', async ({ db, a, b, pid }) => {
    t.diagnostic(`implicit block lock_timeout: ${(await b.query("set local lock_timeout = '5s'; select current_setting('lock_timeout') v"))[1].rows[0].v}`);
    const bPid = await pid(b);
    await a.query('begin');
    await a.query('select count(*) from pos_open_orders_private.orders');
    const started = Date.now();
    const applied = settle(b.query(MERGED));
    await waitForLock(db, bPid);
    const result = await applied;
    const waited = Date.now() - started;
    await a.query('commit');
    t.diagnostic(`simple-query apply: ${result.error?.message ?? 'applied'} after ${waited}ms`);
    assert.match(String(result.error?.message), /lock timeout/);
    assert.ok(waited < 9000, `waited ${waited}ms`);
    assert.equal((await db.query("select count(*)::int n from information_schema.columns where column_name = 'closure_merged_into_order_id'")).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int n from pg_proc where proname = 'merge_zero_v1'")).rows[0].n, 0);
  }, { migrated: false });

  await scenario('1/9: payment status change in flight blocks the merge commit (SHARE lock); the commit decides on committed state', async ({ db, a, b, pid }) => {
    await receipt(db, { status: 1 });
    for (const finish of ['rollback', 'commit']) {
      const ids = await claim(db);
      await a.query('begin');
      await a.query('update public.pos_sales_receipts set payment_status = 3 where id = 501');
      const pending = settle(commit(b, ids, mergePayload));
      await waitForLock(db, await pid(b));
      await a.query(finish);
      const result = await pending;
      if (finish === 'rollback') {
        assert.match(String(result.error?.message), /open_orders_vanished/);
        await db.query("update pos_open_orders_private.runs set status = 'failed' where id = $1", [ids.run]);
      } else assert.equal(result.value?.status, 'committed');
    }
    assert.equal((await snapshot(db)).filter(r => r.closure_merged_into_order_id === 'order-t').length, 2);
  });

  await scenario('2/9: cancel+reissue waits for an in-flight merge commit, then the next run refuses the stale proof', async ({ db, a, b, pid }) => {
    await receipt(db);
    const ids = await claim(db);
    await b.query('begin');
    await commit(b, ids, mergePayload);
    const started = Date.now();
    const writer = settle((async () => {
      await a.query('begin');
      await a.query('update public.pos_sales_receipts set is_canceled = true where id = 501');
      await a.query("insert into public.pos_sales_receipts select 502, source, branch_id, business_date, 3, false, total_amount, 0, raw_json from public.pos_sales_receipts where id = 501");
      await a.query('commit');
    })());
    await waitForLock(db, await pid(a));
    await delay(200);
    await b.query('commit');
    assert.equal((await writer).error, undefined);
    t.diagnostic(`receipt writer waited ${Date.now() - started}ms behind an open merge commit transaction`);
    const before = await snapshot(db);
    const next = await claim(db);
    await assert.rejects(commit(db, next, mergePayload), /open_orders_vanished/);
    assert.deepEqual(await snapshot(db), before);
  });

  await scenario('3/8: two collectors with the same run serialize on the advisory lock; the second gets a replay, a second claim is busy', async ({ db, a, b, pid }) => {
    await receipt(db);
    const ids = await claim(db);
    assert.equal((await claim(db)).result.status, 'busy');
    await a.query('begin');
    const first = await commit(a, ids, mergePayload);
    const second = settle(commit(b, ids, mergePayload));
    await waitForLock(db, await pid(b));
    await a.query('commit');
    assert.equal(first.status, 'committed');
    assert.equal((await second).value?.replay, true);
    const audits = (await db.query("select manifest->'receiptClosures' c from pos_open_orders_private.runs where id = $1", [ids.run])).rows[0].c;
    assert.equal(audits.length, 2);
    const snap = await snapshot(db);
    assert.equal((await commit(db, ids, mergePayload)).replay, true);
    assert.deepEqual(await snapshot(db), snap);
  });

  await scenario('4: the same merge receipt cannot close a different group or serve as single-order proof', async ({ db }) => {
    await receipt(db);
    await commit(db, await claim(db), mergePayload);
    const before = await snapshot(db);
    for (const rows of [
      [mergePayload[0], merged(memberA), memberB, merged(other)],
      [{ ...mergePayload[0], closureReceiptId: 501 }, merged(memberA), merged(memberB), other],
    ]) {
      const ids = await claim(db);
      await assert.rejects(commit(db, ids, rows), /open_orders_vanished/);
      await db.query("update pos_open_orders_private.runs set status = 'failed' where id = $1", [ids.run]);
      assert.deepEqual(await snapshot(db), before);
    }
  });

  await scenario('5: receipt lock_timeout (10s) fails the merge commit cleanly; commits without evidence never touch the receipt lock', async ({ db, a, b }) => {
    await receipt(db);
    await a.query('begin');
    await a.query('update public.pos_sales_receipts set total_amount = total_amount where id = 501'); // ROW EXCLUSIVE held
    const plain = await claim(db);
    const quick = Date.now();
    assert.equal((await commit(b, plain, [target, memberA, memberB, other])).status, 'committed');
    assert.ok(Date.now() - quick < 2000, 'evidence-free commit must not wait for receipts');
    const before = await snapshot(db);
    const ids = await claim(db);
    const started = Date.now();
    const result = await settle(commit(b, ids, mergePayload));
    const waited = Date.now() - started;
    await a.query('rollback');
    assert.match(String(result.error?.message), /open_orders_vanished/);
    assert.ok(waited >= 9500 && waited < 15000, `waited ${waited}ms`);
    assert.deepEqual(await snapshot(db), before);
    assert.equal((await db.query("select status from pos_open_orders_private.runs where id = $1", [ids.run])).rows[0].status, 'collecting');
  });

  await scenario('6/7: lease expiry and writer fence reject merge commits without changes', async ({ db }) => {
    await receipt(db);
    const before = await snapshot(db);
    const ids = await claim(db);
    await assert.rejects(commit(db, { ...ids, owner: randomUUID() }, mergePayload), /open_orders_run_conflict/);
    await db.query("update pos_open_orders_private.runs set lease_until = clock_timestamp() - interval '1 second' where id = $1", [ids.run]);
    await assert.rejects(commit(db, ids, mergePayload), /open_orders_lease_lost/);
    const newer = await claim(db);
    assert.equal(newer.result.status, 'collecting');
    await assert.rejects(commit(db, ids, mergePayload), /open_orders_lease_lost|open_orders_run_conflict/);
    assert.deepEqual(await snapshot(db), before);
  });

  await scenario('10: aborting the transaction after a successful merge commit restores snapshot, audit and success state', async ({ db, b }) => {
    await receipt(db);
    const before = await snapshot(db);
    const sync = (await db.query('select last_success_at, last_success_run_id from pos_open_orders_private.sync_state')).rows;
    const ids = await claim(db);
    await b.query('begin');
    assert.equal((await commit(b, ids, mergePayload)).status, 'committed');
    await b.query('rollback');
    assert.deepEqual(await snapshot(db), before);
    assert.deepEqual((await db.query('select last_success_at, last_success_run_id from pos_open_orders_private.sync_state')).rows, sync);
    assert.equal((await db.query('select status from pos_open_orders_private.runs where id = $1', [ids.run])).rows[0].status, 'collecting');
    assert.equal((await db.query('select count(*)::int n from public.pos_sales_receipts')).rows[0].n, 1);
  });

  await scenario('rollback: refused while a run is collecting; atomic on failure; restores baseline hashes, privileges and contract 2', async ({ db, a }) => {
    await receipt(db);
    await commit(db, await claim(db), mergePayload);
    const lines = (await db.query('select * from pos_open_orders_private.order_lines order by order_id, detail_id')).rows;
    const live = await claim(db);
    await assert.rejects(db.query(doc('rollback')), /open_orders_rollback_blocked_active_run/);
    await db.query('rollback').catch(() => {});
    await db.query("update pos_open_orders_private.runs set status = 'failed' where id = $1", [live.run]);
    // A late failure (dependent view on a dropped column) rolls back the whole script.
    await a.query('create view public.merge_dependency as select closure_evidence_hash from pos_open_orders_private.orders');
    await assert.rejects(db.query(doc('rollback')), /depend/);
    await db.query('rollback').catch(() => {});
    assert.deepEqual(failedSql((await db.query(doc('postflight'))).rows), []);
    assert.equal((await snapshot(db)).filter(r => r.closure_merged_into_order_id).length, 2);
    await a.query('drop view public.merge_dependency');
    await db.query(doc('rollback'));
    const hashes = Object.fromEntries((await db.query(FUNCTION_HASHES)).rows.map(r => [r.sig, r.md5]));
    assert.equal(hashes['pos_open_orders_private.commit_v1(uuid,uuid,jsonb,jsonb)'], 'd4b4af9cf2759c8b422dfdeba058684f');
    assert.equal(hashes['pos_open_orders_private.read_v1(text,date)'], 'ac855dec68eec963eb139ac2132131bc');
    const pre = failedSql((await db.query(doc('preflight'))).rows);
    // Only the history row remains until a separately approved migration repair.
    assert.deepEqual(pre.map(row => row.slice(0, 2)), ['A2']);
    await db.query("delete from supabase_migrations.schema_migrations where version = '20261114161500'"); // emulates `migration repair --status reverted`
    assert.deepEqual(failedSql((await db.query(doc('preflight'))).rows), []);
    assert.deepEqual((await db.query('select * from pos_open_orders_private.order_lines order by order_id, detail_id')).rows, lines);
    const rows = (await db.query('select order_id, status, closure_receipt_id from pos_open_orders_private.orders order by order_id')).rows;
    assert.deepEqual(rows.filter(r => ['order-a', 'order-b'].includes(r.order_id)).map(r => [r.status, r.closure_receipt_id]), [[1, null], [1, null]]);
    // Old guard is back for those orders: a payload omitting them is refused.
    const ids = await claim(db);
    await assert.rejects(commit(db, ids, [mergePayload[0], other]), /open_orders_vanished/);
  });
});
