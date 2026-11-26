// BABA-NOTIFICATION-01A on real PostgreSQL with independent connections and observed lock waits.
// No env DB URL is read; the server is a throwaway local cluster under .local/.
// Local binary setup (ignored): npm.cmd --cache .local/npm-cache install --prefix .local/pg-tools --no-audit --no-fund embedded-postgres@18.6.0-beta.19
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';
import { baseSql, migration, testTypesSql, U, payload } from './helpers/notification-fixture.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rpc = async (client, name, args) => (await client.query(
  `select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) r`, args)).rows[0].r;
const upsert = (client, key, extra) => rpc(client, 'notification_upsert_v1', ['system.test_all', key, JSON.stringify(payload(extra))]);

test('real PostgreSQL concurrency: one open event per key, resolve/recur, mark-all boundary, policy revision', { timeout: 90000 }, async t => {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const bin = path.resolve(process.env.BABA_RESERVATION_PG_BIN || `.local/pg-tools/node_modules/@embedded-postgres/${platform}-${process.arch}/native/bin`);
  const exe = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
  assert.ok(existsSync(exe('initdb')), 'Install the pinned local-only test binaries using the command at the top of this file');
  const root = path.resolve('.local/notification-01a'); mkdirSync(root, { recursive: true });
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
  const connect = async () => {
    const c = new pg.Client(config); await c.connect(); clients.push(c);
    await c.query('set role service_role'); return c;
  };
  try {
    for (let i = 0; i < 100; i++) {
      const candidate = new pg.Client(config);
      try { await candidate.connect(); admin = candidate; break; }
      catch { await candidate.end().catch(() => {}); await delay(30); }
    }
    assert.ok(admin, logs.join('\n'));
    clients.push(admin);
    await admin.query(baseSql); await admin.query(migration); await admin.query(testTypesSql);
    t.diagnostic((await admin.query('select version() v')).rows[0].v);
    const pool = []; for (let i = 0; i < 6; i++) pool.push(await connect());
    const a = pool[0], b = pool[1];
    const pidOf = async c => (await c.query('select pg_backend_pid() pid')).rows[0].pid;
    const waitsOnLock = async pid => {
      for (let n = 0; n < 300; n++) {
        const row = (await admin.query('select wait_event_type from pg_stat_activity where pid=$1', [pid])).rows[0];
        if (row?.wait_event_type === 'Lock') return true;
        await delay(10);
      }
      return false;
    };

    await t.test('60 simultaneous first observations over 6 connections create exactly one event', async () => {
      const results = await Promise.all(Array.from({ length: 60 }, (_, i) => upsert(pool[i % pool.length], 'race:1')));
      const created = results.filter(r => r.status === 'created');
      assert.equal(created.length, 1, JSON.stringify(results.map(r => r.status)));
      assert.ok(results.every(r => r.id === created[0].id && ['created', 'observed'].includes(r.status)));
      const rows = (await admin.query("select id, observation_count, recipient_count from notification_private.notifications where dedupe_key='race:1'")).rows;
      assert.equal(rows.length, 1); assert.equal(rows[0].observation_count, 60);
      const recipients = (await admin.query('select count(*)::int n from notification_private.recipients where notification_id=$1', [rows[0].id])).rows[0].n;
      assert.equal(recipients, 10); assert.equal(rows[0].recipient_count, 10);
    });

    await t.test('uncommitted first insert blocks the second connection, which then observes the same event', async () => {
      const bpid = await pidOf(b);
      await a.query('begin'); await b.query('begin');
      try {
        const first = await upsert(a, 'race:2');
        assert.equal(first.status, 'created');
        const waiting = upsert(b, 'race:2'); waiting.catch(() => {});
        assert.ok(await waitsOnLock(bpid), 'second connection waits on the uncommitted unique index entry');
        await a.query('commit');
        const second = await waiting; await b.query('commit');
        assert.deepEqual([second.status, second.id], ['observed', first.id]);
      } finally { await a.query('rollback').catch(() => {}); await b.query('rollback').catch(() => {}); }
      assert.equal((await admin.query("select count(*)::int n from notification_private.notifications where dedupe_key='race:2'")).rows[0].n, 1);
    });

    await t.test('observation racing a resolution waits, then opens a new occurrence (never revives the resolved one)', async () => {
      const original = await upsert(admin, 'race:3');
      const bpid = await pidOf(b);
      await a.query('begin'); await b.query('begin');
      try {
        assert.equal((await rpc(a, 'notification_resolve_v1', ['system.test_all', 'race:3', 'business_resolved', null])).status, 'resolved');
        const waiting = upsert(b, 'race:3'); waiting.catch(() => {});
        assert.ok(await waitsOnLock(bpid));
        await a.query('commit');
        const after = await waiting; await b.query('commit');
        assert.equal(after.status, 'created'); assert.notEqual(after.id, original.id);
      } finally { await a.query('rollback').catch(() => {}); await b.query('rollback').catch(() => {}); }
      const rows = (await admin.query("select id, status from notification_private.notifications where dedupe_key='race:3' order by id")).rows;
      assert.deepEqual(rows.map(r => r.status), ['resolved', 'open']);
    });

    await t.test('mark-all running while a new event is being created leaves the new event unread', async () => {
      await a.query('begin');
      try {
        const pending = await upsert(a, 'race:4');
        assert.equal(pending.status, 'created');
        const marked = await rpc(b, 'notification_mark_all_read_v1', [U.staffBar, 9_000_000_000]);
        assert.equal(marked.status, 'ok');
        await a.query('commit');
      } finally { await a.query('rollback').catch(() => {}); }
      const unread = await rpc(b, 'notification_unread_count_v1', [U.staffBar]);
      assert.equal(unread.unreadCount, 1, 'only the event committed after mark-all is unread');
    });

    await t.test('two owners saving the same policy revision: one wins, the other gets version_conflict, one audit row', async () => {
      const [{ revision }] = (await admin.query("select revision from notification_private.policies where type_code='inventory.pos_deduction_pending'")).rows;
      const body = rules => JSON.stringify({ enabled: true, inAppEnabled: true, rules });
      const bpid = await pidOf(b);
      await a.query('begin'); await b.query('begin');
      try {
        const x = await rpc(a, 'notification_policy_update_v1', [U.owner, 'inventory.pos_deduction_pending', revision, body({ groups: [{ roles: ['manager'] }] })]);
        const waiting = rpc(b, 'notification_policy_update_v1', [U.master, 'inventory.pos_deduction_pending', revision, body({ groups: [{ roles: ['leader'] }] })]);
        waiting.catch(() => {});
        assert.ok(await waitsOnLock(bpid));
        await a.query('commit');
        const y = await waiting; await b.query('commit');
        assert.equal(x.status, 'ok'); assert.equal(y.status, 'version_conflict');
      } finally { await a.query('rollback').catch(() => {}); await b.query('rollback').catch(() => {}); }
      const audit = (await admin.query("select count(*)::int n from notification_private.policy_audit where type_code='inventory.pos_deduction_pending'")).rows[0].n;
      assert.equal(audit, 1);
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
