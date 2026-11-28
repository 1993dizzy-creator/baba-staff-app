// BABA-NOTIFICATION-01B on real PostgreSQL with independent connections (throwaway local cluster
// under .local/, same pinned binaries as the 01-A concurrency test; no env DB URL is read).
// Covers: parallel senders never claim the same delivery (SKIP LOCKED), a claim held by an open
// transaction is skipped not duplicated, racing registrations of one endpoint leave one active
// owner, and concurrent first observations enqueue each device exactly once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';
import { baseSql, testTypesSql, U, payload, MIGRATION_FILE, PUSH_MIGRATION_FILE } from './helpers/notification-fixture.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rpc = async (client, name, args) => (await client.query(
  `select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) r`, args)).rows[0].r;
const KEY = 'B' + 'A'.repeat(86), AUTH = 'C'.repeat(22);
const ep = n => `https://fcm.googleapis.com/fcm/send/race-${n}`;
const exp = () => new Date(Date.now() + 20 * 86400000).toISOString();

test('real PostgreSQL push concurrency: single claim, endpoint ownership race, single enqueue', { timeout: 90000 }, async t => {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const bin = path.resolve(process.env.BABA_RESERVATION_PG_BIN || `.local/pg-tools/node_modules/@embedded-postgres/${platform}-${process.arch}/native/bin`);
  const exe = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
  assert.ok(existsSync(exe('initdb')), 'Install the pinned local-only test binaries (see tests/notifications-concurrency.test.mjs)');
  const root = path.resolve('.local/notification-01b'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'pg-')); const logs = [];
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { TEMP: dir, TMP: dir, HOME: dir, USERPROFILE: dir });
  logs.push(execFileSync(exe('initdb'), ['-D', dir, '--auth=trust', '--username=baba_test', '--locale=C', '--encoding=UTF8'], { env, windowsHide: true, encoding: 'utf8' }));
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(exe('postgres'), ['-D', dir, '-h', '127.0.0.1', '-p', String(port)], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => logs.push(b.toString())); child.stderr.on('data', b => logs.push(b.toString()));
  const config = { host: '127.0.0.1', port, user: 'baba_test', database: 'postgres', connectionTimeoutMillis: 500, statement_timeout: 15000 };
  const clients = []; let admin;
  const connect = async () => { const c = new pg.Client(config); await c.connect(); clients.push(c); await c.query('set role service_role'); return c; };
  try {
    for (let i = 0; i < 100; i++) {
      const candidate = new pg.Client(config);
      try { await candidate.connect(); admin = candidate; break; } catch { await candidate.end().catch(() => {}); await delay(30); }
    }
    assert.ok(admin, logs.join('\n')); clients.push(admin);
    await admin.query(baseSql); await admin.query(readFileSync(MIGRATION_FILE, 'utf8')); await admin.query(testTypesSql);
    await admin.query(readFileSync(PUSH_MIGRATION_FILE, 'utf8'));
    await admin.query(`update notification_private.policies set push_enabled = true where type_code = 'system.test_all'`);
    t.diagnostic((await admin.query('select version() v')).rows[0].v);
    const pool = []; for (let i = 0; i < 6; i++) pool.push(await connect());

    await t.test('racing registrations of one endpoint by different accounts leave exactly one active owner', async () => {
      const users = [U.owner, U.master, U.managerHall, U.leaderBar, U.staffBar, U.staffHall];
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => rpc(pool[i % pool.length], 'notification_push_subscribe_v1',
        [users[i % users.length], 1790000000 + i, exp(), ep('shared'), KEY, AUTH, 'ko', null])));
      assert.ok(results.every(r => r.status === 'ok'), JSON.stringify(results));
      const active = (await admin.query("select count(*)::int n from notification_private.push_subscriptions where endpoint=$1 and status='active'", [ep('shared')])).rows[0].n;
      assert.equal(active, 1);
    });

    await t.test('60 parallel first observations enqueue each device exactly once', async () => {
      for (let i = 0; i < 8; i++) await rpc(admin, 'notification_push_subscribe_v1', [U.staffBar, 1790000100, exp(), ep(`bar-${i}`), KEY, AUTH, 'ko', null]);
      const results = await Promise.all(Array.from({ length: 60 }, (_, i) => rpc(pool[i % pool.length], 'notification_upsert_v1',
        ['system.test_all', 'race:push', JSON.stringify(payload())])));
      const created = results.filter(r => r.status === 'created');
      assert.equal(created.length, 1);
      const n = (await admin.query('select count(*)::int n, count(distinct subscription_id)::int d from notification_private.push_deliveries where notification_id=$1', [created[0].id])).rows[0];
      assert.equal(n.n, n.d); assert.ok(n.n >= 9, 'all active devices of the recipients, once each');
    });

    await t.test('parallel senders claim disjoint sets; a held claim is skipped, never duplicated', async () => {
      const [{ n: total }] = (await admin.query("select count(*)::int n from notification_private.push_deliveries where status='pending'")).rows;
      const a = pool[0], b = pool[1];
      await a.query('begin');
      try {
        const held = await rpc(a, 'notification_push_claim_v1', [null, 3, 120]);
        assert.equal(held.items.length, 3);
        // b runs while a's transaction still holds row locks: SKIP LOCKED gives b other rows only.
        const other = await rpc(b, 'notification_push_claim_v1', [null, 100, 120]);
        const heldIds = new Set(held.items.map(i => i.deliveryId));
        assert.ok(other.items.every(i => !heldIds.has(i.deliveryId)));
        assert.equal(other.items.length, total - 3);
        await a.query('commit');
      } finally { await a.query('rollback').catch(() => {}); }
      // Everything is now "sending": a burst of 12 parallel recovery claims returns nothing.
      const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => rpc(pool[i % pool.length], 'notification_push_claim_v1', [null, 100, 120])));
      assert.ok(burst.every(r => r.items.length === 0));
      // Lease expired for all: 12 parallel claims re-claim each row exactly once.
      await admin.query("update notification_private.push_deliveries set claimed_at = now() - interval '10 minutes' where status='sending'");
      const reclaim = await Promise.all(Array.from({ length: 12 }, (_, i) => rpc(pool[i % pool.length], 'notification_push_claim_v1', [null, 100, 120])));
      const ids = reclaim.flatMap(r => r.items.map(i => i.deliveryId));
      assert.equal(ids.length, total); assert.equal(new Set(ids).size, total);
      // Two reports with the same token race: one wins, the other is stale.
      const item = reclaim.find(r => r.items.length).items[0];
      const reports = await Promise.all([a, b].map(c => rpc(c, 'notification_push_report_v1', [item.deliveryId, item.claimToken, 'accepted', 201, null, null])));
      assert.deepEqual(reports.map(r => r.status).sort(), ['ok', 'stale']);
    });
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    if (child.exitCode === null) {
      execFileSync(exe('pg_ctl'), ['-D', dir, 'stop', '-m', 'fast', '-w'], { env, windowsHide: true, encoding: 'utf8', timeout: 15000 });
    }
    writeFileSync(path.join(root, `${path.basename(dir)}-server.log`), logs.join('\n'));
    rmSync(dir, { recursive: true, force: true });
  }
});
