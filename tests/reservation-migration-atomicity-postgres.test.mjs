// Local-only PostgreSQL 17.6 + actual Supabase CLI 3.1.0. No project credentials are inherited.
// npm.cmd --cache .local/npm-cache install --prefix .local/pg17-tools --no-audit --no-fund --save-exact @embedded-postgres/windows-x64@17.6.0-beta.15
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';
import { BABA_TABLES } from '../lib/sales/baba-table-catalog.ts';

const migration1 = '20261114120000_create_reservation_inbox_foundation.sql';
const migration2 = '20261114120001_reservation_phase1_hardening.sql';
const m1 = readFileSync(`supabase/migrations/${migration1}`, 'utf8');
const m2 = readFileSync(process.env.BABA_RESERVATION_MIGRATION_2_FILE || `supabase/migrations/${migration2}`, 'utf8');
const oldM2 = execFileSync('git', ['show', `b2efd8dcfeba928979308044d5bd1008046f4b9c:supabase/migrations/${migration2}`], { encoding: 'utf8', windowsHide: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('PostgreSQL 17.6 / CLI 3.1.0: reservation migration atomicity and unchanged contracts', { timeout: 120000 }, async t => {
  const bin = path.resolve('.local/pg17-tools/node_modules/@embedded-postgres/windows-x64/native/bin');
  const cli = path.resolve('.local/npm-cache/_npx/a2642d082f752488/node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const root = path.resolve('.local/reservation-migration-atomicity');
  mkdirSync(root, { recursive: true });
  const run = mkdtempSync(path.join(root, 'pg17-'));
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { TEMP: run, TMP: run, HOME: run, USERPROFILE: run, SUPABASE_TELEMETRY_DISABLED: '1' });
  assert.equal(execFileSync(cli, ['--version'], { env, encoding: 'utf8', windowsHide: true }).trim(), '3.1.0');
  execFileSync(path.join(bin, 'initdb.exe'), ['-D', path.join(run, 'data'), '--auth=trust', '--username=baba_test', '--locale=C', '--encoding=UTF8'], { env, windowsHide: true, stdio: 'pipe' });
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const logs = [], evidence = [], clients = [];
  const server = spawn(path.join(bin, 'postgres.exe'), ['-D', path.join(run, 'data'), '-h', '127.0.0.1', '-p', String(port), '-c', 'log_statement=all'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => logs.push(b.toString()));
  server.stderr.on('data', b => logs.push(b.toString()));
  const connect = async database => {
    const c = new pg.Client({ host: '127.0.0.1', port, user: 'baba_test', database, connectionTimeoutMillis: 1000 });
    c.on('error', () => {});
    await c.connect(); clients.push(c); return c;
  };
  let admin;
  try {
    for (let i = 0; i < 100; i++) {
      try { admin = await connect('postgres'); break; } catch { await delay(40); }
    }
    assert.ok(admin, logs.join('\n'));
    assert.equal((await admin.query('show server_version_num')).rows[0].server_version_num, '170006');
    t.diagnostic((await admin.query('select version() v')).rows[0].v);
    await admin.query('create role anon;create role authenticated;create role service_role');
    const fresh = async name => {
      assert.match(name, /^[a-z_]+$/);
      await admin.query(`create database ${name}`);
      const c = await connect(name);
      await c.query("create schema extensions;create table public.users(id bigint primary key,role text,is_active boolean,app_login_enabled boolean);insert into public.users values (1,'owner',true,true),(2,'master',true,true),(3,'manager',true,true),(4,'leader',true,true),(5,'staff',true,true)");
      return c;
    };
    const apply = async (name, sql, label) => {
      const wd = path.join(run, label);
      mkdirSync(path.join(wd, 'supabase/migrations'), { recursive: true });
      writeFileSync(path.join(wd, 'supabase/migrations', migration1), m1);
      if (sql !== null) writeFileSync(path.join(wd, 'supabase/migrations', migration2), sql);
      const url = new URL(`postgresql://baba_test@127.0.0.1:${port}/${name}?sslmode=disable`);
      assert.equal(url.hostname, '127.0.0.1'); // --yes can only ever target this newly created loopback cluster.
      const args = ['migration', 'up', `--remote=${url}`, '--workdir', wd, '--yes'];
      const started = Date.now();
      return new Promise((resolve, reject) => {
        const child = spawn(cli, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
        const timer = setTimeout(() => child.kill(), 25000);
        child.on('error', reject);
        child.on('close', code => {
          clearTimeout(timer);
          output = output.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[ISOLATED_LOOPBACK_URL]');
          writeFileSync(path.join(run, label + '.log'), output);
          const result = { label, code, elapsedMs: Date.now() - started, output };
          evidence.push(result); resolve(result);
        });
      });
    };
    const history = async c => (await c.query('select version from supabase_migrations.schema_migrations order by version')).rows.map(x => x.version);
    const snapshot = async c => (await c.query(`select jsonb_build_object(
      'relations',(select jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'acl',c.relacl::text) order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='reservation_private' and c.relkind in ('r','S')),
      'schemaAcl',(select nspacl::text from pg_namespace where nspname='reservation_private'),
      'policies',(select jsonb_agg(row_to_json(p) order by p.tablename,p.policyname) from pg_policies p where schemaname='reservation_private'),
      'functions',(select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'definition',pg_get_functiondef(p.oid),'acl',p.proacl::text) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='reservation_private' or (n.nspname='public' and p.proname like 'reservation_%')),
      'constraints',(select jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid)) order by c.conrelid::regclass::text,c.conname) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='reservation_private'),
      'indexes',(select jsonb_agg(jsonb_build_object('name',indexname,'definition',indexdef) order by indexname) from pg_indexes where schemaname='reservation_private'),
      'triggers',(select jsonb_agg(jsonb_build_object('table',g.tgrelid::regclass::text,'name',g.tgname,'definition',pg_get_triggerdef(g.oid)) order by g.tgname) from pg_trigger g join pg_class c on c.oid=g.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='reservation_private' and not g.tgisinternal),
      'columns',(select jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull) order by c.relname,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='reservation_private' and c.relkind='r' and a.attnum>0 and not a.attisdropped)
    ) as contract`)).rows[0].contract;
    const failed = async (name, sql, pattern, setup) => {
      const c = await fresh(name);
      assert.equal((await apply(name, null, name + '_base')).code, 0);
      if (setup) await setup(c);
      const before = await snapshot(c);
      const result = await apply(name, sql, name);
      assert.equal(result.code, 1, result.output); assert.match(result.output, pattern);
      assert.deepEqual(await history(c), ['20261114120000']);
      assert.deepEqual(await snapshot(c), before, 'all M2 tables/functions/ACL/indexes/triggers/columns must roll back');
      return c;
    };

    await t.test('normal CLI apply preserves all prior RPC, RLS, ACL, index, trigger and 27 UUID contracts', async () => {
      const c = await fresh('normal'), control = await fresh('control');
      const result = await apply('normal', m2, 'normal'); assert.equal(result.code, 0, result.output);
      await control.query(m1); await control.query(oldM2);
      const actual = await snapshot(c);
      assert.deepEqual(actual, await snapshot(control));
      assert.equal(actual.relations.filter(x => x.kind === 'r').length, 5);
      assert.ok(actual.relations.filter(x => x.kind === 'r').every(x => x.rls));
      assert.equal(actual.functions.filter(x => !x.signature.startsWith('reservation_private.')).length, 13);
      const ids = (await c.query('select id from reservation_private.table_catalog order by id')).rows.map(x => x.id);
      assert.deepEqual(ids, BABA_TABLES.map(x => x.MapObjectID).sort());
      assert.equal(ids.length, 27); assert.deepEqual(await history(c), ['20261114120000', '20261114120001']);
      assert.equal((await c.query('show lock_timeout')).rows[0].lock_timeout, '0');
      writeFileSync(path.join(run, 'contracts.json'), JSON.stringify(actual, null, 2));
    });
    await t.test('middle SQL failure rolls back every M2 change', async () => {
      const sql = m2.replace('alter table reservation_private.reservations\n', "raise exception 'synthetic_middle_failure';\nalter table reservation_private.reservations\n");
      assert.notEqual(sql, m2); await failed('middle_failure', sql, /synthetic_middle_failure/);
    });
    await t.test('last SQL failure rolls back every M2 change', async () => {
      const sql = m2.replace('end $reservation_hardening$;', "raise exception 'synthetic_last_failure';\nend $reservation_hardening$;");
      assert.notEqual(sql, m2); await failed('last_failure', sql, /synthetic_last_failure/);
    });
    await t.test('history INSERT failure rolls back every M2 change', async () => {
      await failed('history_failure', m2, /reject_migration_two|23514/, c => c.query("alter table supabase_migrations.schema_migrations add constraint reject_migration_two check(version <> '20261114120001')"));
    });
    await t.test('ACCESS EXCLUSIVE waits, times out at five seconds, rolls back and releases locks', async () => {
      const c = await fresh('lock_failure'); assert.equal((await apply('lock_failure', null, 'lock_base')).code, 0);
      const before = await snapshot(c); await c.query('begin;select 1 from reservation_private.inbox');
      let waiting = false, started;
      const applying = apply('lock_failure', m2, 'lock_failure'); let settled = false;
      applying.finally(() => settled = true);
      while (!settled) {
        const rows = (await admin.query("select 1 from pg_stat_activity where datname='lock_failure' and wait_event_type='Lock'")).rows;
        if (rows.length) { waiting = true; started ??= Date.now(); }
        await delay(20);
      }
      const result = await applying; const waitedMs = Date.now() - started;
      await c.query('rollback'); assert.ok(waiting); assert.match(result.output, /55P03|lock timeout/);
      assert.equal(result.code, 1); assert.ok(waitedMs >= 4500 && waitedMs < 8500, String(waitedMs));
      assert.deepEqual(await snapshot(c), before); assert.deepEqual(await history(c), ['20261114120000']);
      await c.query('begin;lock table reservation_private.inbox in access exclusive mode nowait;rollback');
      evidence.push({ label: 'observed_lock_wait', waitedMs });
    });
    await t.test('one Inbox row aborts migration without changing the row or contracts', async () => {
      let expected;
      const c = await failed('data_guard', m2, /reservation_phase1_data_requires_owner_review|55000/, async c => {
        await c.query("insert into reservation_private.inbox(dedupe_key,status,event_name,chat_type,group_fp,message_fp,payload_sha256,business_date,message_text) values('synthetic','received','message.text.received','GROUP',repeat('a',16),repeat('b',16),repeat('a',64),current_date,'synthetic only')");
        expected = (await c.query('select to_jsonb(i) row from reservation_private.inbox i')).rows;
      });
      assert.deepEqual((await c.query('select to_jsonb(i) row from reservation_private.inbox i')).rows, expected);
    });
    await t.test('old explicit COMMIT reproduces orphaned schema change after history failure on 17.6', async () => {
      const c = await fresh('old_defect'); assert.equal((await apply('old_defect', null, 'old_defect_base')).code, 0);
      await c.query("alter table supabase_migrations.schema_migrations add constraint reject_migration_two check(version <> '20261114120001')");
      const result = await apply('old_defect', oldM2, 'old_defect'); assert.equal(result.code, 1);
      assert.deepEqual(await history(c), ['20261114120000']);
      assert.equal((await c.query("select to_regclass('reservation_private.table_catalog') is not null as exists")).rows[0].exists, true);
    });
    writeFileSync(path.join(run, 'evidence.json'), JSON.stringify({ postgres: '17.6', cli: '3.1.0', migration2File: process.env.BABA_RESERVATION_MIGRATION_2_FILE || `supabase/migrations/${migration2}`, scenarios: evidence }, null, 2));
    t.diagnostic(`Evidence: ${run}`);
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    if (server.exitCode === null) spawnSync(path.join(bin, 'pg_ctl.exe'), ['-D', path.join(run, 'data'), 'stop', '-m', 'fast', '-w'], { env, windowsHide: true, stdio: 'pipe' });
    writeFileSync(path.join(run, 'postgres.log'), logs.join('\n'));
  }
});
