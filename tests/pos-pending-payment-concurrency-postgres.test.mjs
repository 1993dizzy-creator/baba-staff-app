// Native PostgreSQL only (disposable local cluster, loopback, no .env). Proves the
// close hold and the admin pending resolution serialize on the existing locks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import pg from 'pg';
import { initializePosFinalDatabase, daySource } from './helpers/pos-business-day-final-fixture.mjs';
import { installPendingPaymentMigration, addPendingReceipt } from './helpers/pos-pending-payment-fixture.mjs';

const run = promisify(execFile), wait = ms => new Promise(r => setTimeout(r, ms));
const binDir = [process.env.QA_POSTGRES_BIN, '.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/native/bin',
  '.tmp/production-preflight/node_modules/@embedded-postgres/windows-x64/native/bin'].filter(Boolean)
  .find(dir => existsSync(resolve(dir, process.platform === 'win32' ? 'postgres.exe' : 'postgres')));
const exe = name => resolve(binDir, process.platform === 'win32' ? name + '.exe' : name);
const RESOLVE = 'select admin_resolve_pending_sales_receipt_v1($1,$2,$3,$4,$5,$6,$7,$8) r';
const CLOSE = 'select sales_close_business_day_v1($1,$2,$3::jsonb,$4::jsonb,3,\'manual\',false,null) r';
const closeArgs = s => [s.businessDate, s.sourceFingerprint, JSON.stringify(s.sourceSnapshot), JSON.stringify(s.rows)];
const resolveArgs = (requestId, method = 'transfer') => [9, 0, requestId, 'manager', 'paid', method, null, 'Transfer #77 confirmed'];

async function waitingOn(observer, pid) {
  for (let i = 0; i < 100; i++) {
    if ((await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock') return true;
    await wait(20);
  }
  return false;
}

test('pending close hold and admin resolution serialize on native PostgreSQL', { skip: !binDir && 'no local PostgreSQL binaries (set QA_POSTGRES_BIN)', timeout: 180000 }, async t => {
  const out = resolve('.qa-review/pos-pending-payment'); await mkdir(out, { recursive: true });
  const dir = resolve(out, 'pg-' + Date.now());
  await run(exe('initdb'), ['-D', dir, '--encoding=UTF8', '--locale=C', '-U', 'postgres', '-A', 'trust'], { windowsHide: true, timeout: 60000 });
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
  const server = spawn(exe('postgres'), ['-D', dir, '-h', '127.0.0.1', '-p', String(port), '-c', 'fsync=off'], { windowsHide: true, stdio: 'ignore' });
  const clients = []; let n = 0;
  const connect = async database => {
    const c = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database, connectionTimeoutMillis: 1000 });
    await c.connect(); clients.push(c);
    await c.query("set statement_timeout='20s'; set lock_timeout='10s'; set timezone='UTC'"); return c;
  };
  t.after(async () => {
    for (const c of clients) await c.end().catch(() => {});
    server.kill(); await wait(500); await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  let root;
  for (let i = 0; i < 100 && !root; i++) { try { root = await connect('postgres'); } catch { await wait(100); } }
  assert.ok(root, 'local PostgreSQL did not start');
  await root.query('create role anon; create role authenticated; create role service_role;');

  async function fresh() {
    const name = 'pending_' + (++n); await root.query('create database ' + name);
    const [setup, a, b] = [await connect(name), await connect(name), await connect(name)];
    const db = { exec: s => setup.query(s.replace('create role anon; create role authenticated; create role service_role;', '')), query: (...x) => setup.query(...x) };
    const { date } = await initializePosFinalDatabase(db);
    await installPendingPaymentMigration(db);
    await addPendingReceipt(db, date);
    return { db, setup, a, b, date };
  }

  await t.test('a close started while a resolution is uncommitted waits, then cannot close on a stale source', async () => {
    const { db, a, b, date } = await fresh();
    const stale = await daySource(db, date);
    await a.query('begin');
    assert.equal((await a.query(RESOLVE, resolveArgs(randomUUID()))).rows[0].r.paymentStatus, 3);
    const pid = (await b.query('select pg_backend_pid() p')).rows[0].p;
    const closing = b.query(CLOSE, closeArgs(stale)).then(r => r.rows[0].r, e => e);
    assert.equal(await waitingOn(db, pid), true);
    await a.query('commit');
    const result = await closing;
    // The receipt is no longer pending, but the reviewed fingerprint is stale: the existing source guard refuses.
    assert.ok(result instanceof Error, 'stale close must not succeed');
    assert.equal(Number((await db.query('select count(*) n from pos_sales_business_day_closures')).rows[0].n), 0);
    assert.equal((await b.query(CLOSE, closeArgs(await daySource(db, date)))).rows[0].r.status, 'closed');
  });

  await t.test('a resolution started while a close holds the share lock waits for the close transaction', async () => {
    const { db, a, b, date } = await fresh();
    await b.query('begin');
    assert.equal((await b.query(CLOSE, closeArgs(await daySource(db, date)))).rows[0].r.status, 'pending_payment');
    const pid = (await a.query('select pg_backend_pid() p')).rows[0].p;
    const resolving = a.query(RESOLVE, resolveArgs(randomUUID())).then(r => r.rows[0].r);
    assert.equal(await waitingOn(db, pid), true);
    await b.query('commit');
    assert.equal((await resolving).paymentStatus, 3);
    assert.equal(Number((await db.query('select count(*) n from pos_sales_business_day_closures')).rows[0].n), 0);
  });

  await t.test('double click (same request id) and two admins (different ids) produce exactly one change', async () => {
    const { db, a, b } = await fresh();
    const requestId = randomUUID();
    await a.query('begin');
    const first = (await a.query(RESOLVE, resolveArgs(requestId))).rows[0].r;
    const replay = b.query(RESOLVE, resolveArgs(requestId)).then(r => r.rows[0].r);
    await wait(100);
    await a.query('commit');
    assert.deepEqual(await replay, first);
    await assert.rejects(b.query(RESOLVE, resolveArgs(randomUUID(), 'cash')), /receipt_not_pending|receipt_invalid_cash_received/);
    await assert.rejects(b.query(RESOLVE, resolveArgs(randomUUID())), /receipt_not_pending/);
    assert.equal(Number((await db.query('select count(*) n from pos_sales_receipt_modifications')).rows[0].n), 1);
    assert.equal(Number((await db.query("select count(*) n from pos_sales_receipt_payments where receipt_id=9 and source='manual'")).rows[0].n), 1);
  });
});
