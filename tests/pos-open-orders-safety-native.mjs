// Explicit opt-in native PostgreSQL 17.6 tests. Loopback, disposable databases only.
// Usage: node --experimental-strip-types tests/pos-open-orders-safety-native.mjs --port=55439
// No .env loading, hosted credentials, CUKCUK calls, or SQL rewriting.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { openOrdersRpcErrorCode, INCOMPLETE_SYNC_CODES } from '../lib/pos/cukcuk/open-orders-core.ts';
import { mapOpenOrdersSyncResult } from '../lib/pos/cukcuk/open-orders-cron-policy.ts';

const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1]);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536 && port !== 54322, 'Explicit isolated PostgreSQL port required');
const output = resolve('.local/open-orders-safety-fix');
mkdirSync(output, { recursive: true });
const path = 'supabase/migrations/20261110170329_pos_open_orders_vanished_receipt_evidence.sql';
const bytes = readFileSync(path), migration = bytes.toString('utf8');
const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice('--case='.length);
const base = readFileSync('supabase/migrations/20261109210000_pos_open_orders_v1.sql', 'utf8');
const config = { host: '127.0.0.1', port, user: 'postgres', database: 'postgres' };
const admin = new pg.Client(config);
await admin.connect();
const identity = (await admin.query("select current_setting('server_version_num') version,current_setting('data_directory') path")).rows[0];
assert.equal(identity.version, '170006');
assert.equal(identity.path, '/tmp/baba-open-orders-pg', 'Do not target a shared/hosted database');
await admin.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then
 create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;end if;end $$`);
const fileHash = createHash('sha256').update(bytes).digest('hex');
const report = selected ? JSON.parse(readFileSync(resolve(output, 'green-results.json'), 'utf8'))
  : { postgres: '17.6', host: '127.0.0.1', port, migrationSha256: fileHash, results: [] };
assert.equal(report.migrationSha256, fileHash, 'Cannot reuse evidence for different SQL bytes');
let sequence = Date.now();
const metadata = `select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,p.prosecdef,p.proconfig,p.proacl::text,
 pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='pos_open_orders_private' or(n.nspname='public' and p.proname like 'pos_open_orders_%') order by 1,2,3`;
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
function pending(fn) {
  const started = performance.now();
  return fn().then(value => ({ ok: true, value, ms: performance.now() - started }),
    error => ({ ok: false, error, ms: performance.now() - started }));
}
async function fixture(apply = true) {
  const database = 'baba_orders_safety_' + (++sequence);
  await admin.query('create database ' + database);
  const clients = [];
  async function connect() { const c = new pg.Client({ ...config, database }); await c.connect(); clients.push(c); await c.query("set statement_timeout='20s'"); return c; }
  const c = await connect(), a = await connect(), b = await connect(), observer = await connect();
  await c.query(`create table public.pos_sales_receipts(id bigint primary key,source text,business_date date,payment_status int,is_canceled boolean,raw_json jsonb);
    create table public.ledger_sentinel(id int primary key,amount numeric);insert into public.ledger_sentinel values(1,1234567);`);
  await c.query(base);
  const date = (await c.query("select ((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date::text d")).rows[0].d;
  const scope = 'a'.repeat(64) + ':fixture';
  const order = { orderId: 'order-18', orderNo: '1.18', status: 3, statusClass: 'open', orderDate: date + 'T15:00:00Z',
    businessDate: date, totalAmount: 2410000, lines: [{ detailId: 'line-18', quantity: 1, price: 2410000, amount: 2410000,
      lineStatus: 1, isCanceled: false, isOption: false, isOrphanOption: false }] };
  async function rpc(connection, name, args) {
    await connection.query('set role service_role');
    try { return (await connection.query('select public.' + name + '(' + args.map((_, i) => '$' + (i + 1)).join(',') + ') r', args)).rows[0].r; }
    finally { await connection.query('reset role').catch(() => {}); }
  }
  const claim = async () => {
    const run = randomUUID(), owner = randomUUID();
    await rpc(c, 'pos_open_orders_claim', [run, owner, scope, 'fixture', date, 0]); return { run, owner };
  };
  const commit = (connection, id, rows) => rpc(connection, 'pos_open_orders_commit', [id.run, id.owner, {}, JSON.stringify(rows)]);
  await commit(c, await claim(), [order]);
  await c.query("insert into public.pos_sales_receipts values(18,'cukcuk',$1,3,false,$2)", [date, JSON.stringify({ OrderId: 'order-18' })]);
  const settings = [];
  if (apply) {
    settings.push((await c.query('show lock_timeout')).rows[0].lock_timeout);
    await c.query('begin'); await c.query(migration);
    settings.push((await c.query('show lock_timeout')).rows[0].lock_timeout);
    await c.query('commit'); settings.push((await c.query('show lock_timeout')).rows[0].lock_timeout);
    assert.deepEqual(settings, ['0', '5s', '0']);
  }
  const read = () => rpc(c, 'pos_open_orders_read', [scope, date]);
  const audit = async () => (await c.query("select id,status,manifest from pos_open_orders_private.runs where status='committed' order by id")).rows;
  const before = await read(), beforeAudit = await audit();
  return { database, c, a, b, observer, order, date, scope, claim, commit, read, audit, settings, rpc, before,
    async preserved() { const after = await read(); assert.deepEqual(after.orders, before.orders); assert.equal(after.sync.lastSuccessAt, before.sync.lastSuccessAt); assert.deepEqual(await audit(), beforeAudit); },
    async ledger() { assert.deepEqual((await c.query('select * from public.ledger_sentinel')).rows, [{ id: 1, amount: '1234567' }]); },
    async close() { for (const client of clients) { await client.query('rollback').catch(() => {}); await client.end(); } } };
}
async function check(name, fn) {
  if (selected && !name.includes(selected)) return;
  const previous = report.results.find(result => result.name === name);
  if (previous) { report.previousAttempts ??= []; report.previousAttempts.push(previous); report.results = report.results.filter(result => result.name !== name); }
  const start = performance.now();
  try { const result = await fn(); report.results.push({ name, status: 'PASS', elapsedMs: Math.round(performance.now() - start), ...result }); console.log('PASS', name, JSON.stringify(result)); }
  catch (error) { report.results.push({ name, status: 'FAIL', message: error.message, code: error.code }); process.exitCode = 1; console.log('FAIL', name, error.message); }
  writeFileSync(resolve(output, 'green-results.json'), JSON.stringify(report, null, 2));
}
async function cli(f, tag) {
  const work = resolve(output, tag);
  mkdirSync(resolve(work, 'supabase/migrations'), { recursive: true });
  writeFileSync(resolve(work, 'supabase/migrations', path.split('/').at(-1)), bytes);
  writeFileSync(resolve(work, 'supabase/config.toml'), 'project_id="baba-orders-safety"\n[db]\nmajor_version=17\n');
  const url = 'postgresql://postgres@127.0.0.1:' + port + '/' + f.database;
  assert.ok(url.includes('/baba_orders_safety_'));
  return new Promise(resolveResult => {
    let text = ''; const start = performance.now();
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `npx.cmd --yes supabase migration up --remote=${url} --yes --workdir=${work}`], { windowsHide: true });
    child.stdout.on('data', data => { text += data; }); child.stderr.on('data', data => { text += data; });
    child.on('close', code => { writeFileSync(resolve(output, tag + '.log'), text); resolveResult({ code, text, ms: performance.now() - start }); });
    child.on('error', error => resolveResult({ code: -1, text: error.message }));
  });
}
async function waitDdl(f, relation) {
  for (let i = 0; i < 250; i++) {
    const rows = (await f.observer.query('select pid,mode,granted,pg_blocking_pids(pid) blockers from pg_locks where relation=$1::regclass and mode=$2 and not granted', [relation, 'AccessExclusiveLock'])).rows;
    if (rows.length) return rows[0]; await delay(25);
  }
  assert.fail('Expected actual DDL lock wait');
}
try {
  for (const isolation of ['repeatable read', 'serializable']) {
    await check('reject_receipt_proof_' + isolation, async () => {
      const f = await fixture();
      try {
        const id = await f.claim(); await f.b.query('begin'); await f.b.query('update public.pos_sales_receipts set payment_status=4,is_canceled=true where id=18');
        await f.a.query('begin isolation level ' + isolation);
        const result = await pending(() => f.commit(f.a, id, [{ ...f.order, closureReceiptId: 18 }]));
        assert.equal(result.ok, false); assert.equal(result.error.message, 'open_orders_vanished'); assert.equal(result.error.code, '55000');
        assert.equal(result.error.detail, 'receipt_evidence_requires_read_committed');
        const mapped = openOrdersRpcErrorCode(result.error);
        assert.equal(mapped, 'open_orders_vanished'); assert.equal(INCOMPLETE_SYNC_CODES.has(mapped), true);
        assert.deepEqual(mapOpenOrdersSyncResult({ status: 'failed', code: mapped }), { status: 500, body: { ok: false, outcome: 'failed', code: mapped } });
        await f.a.query('rollback'); await f.b.query('commit'); await f.preserved(); await f.ledger();
        return { isolation, rejectedMs: Math.round(result.ms), sqlstate: result.error.code, detail: result.error.detail, atomic: true, ledgerChanged: false };
      } finally { await f.close(); }
    });
    await check('allow_normal_collection_' + isolation, async () => {
      const f = await fixture();
      try { const id = await f.claim(); await f.a.query('begin isolation level ' + isolation);
        const result = await f.commit(f.a, id, [f.order]); assert.equal(result.status, 'committed'); await f.a.query('commit'); await f.ledger();
        return { isolation, noReceiptProof: true, outcome: result.status, ledgerChanged: false };
      } finally { await f.close(); }
    });
  }
  await check('read_committed_normal_proof_and_lease_guard', async () => {
    const f = await fixture();
    try { let id = await f.claim(); const result = await f.commit(f.a, id, [{ ...f.order, closureReceiptId: 18 }]);
      assert.equal(result.status, 'committed'); assert.equal(Number((await f.read()).orders[0].closureReceiptId), 18);
      id = await f.claim(); await f.c.query("update pos_open_orders_private.runs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [id.run]);
      const expired = await pending(() => f.commit(f.a, id, [f.order])); assert.equal(expired.error.message, 'open_orders_lease_lost'); await f.ledger();
      return { outcome: result.status, migrationLockTimeoutBeforeDuringAfter: f.settings, lease: 'PASS', ledgerChanged: false };
    } finally { await f.close(); }
  });
  for (const middle of [false, true]) await check(middle ? 'cli_middle_ddl_lock_timeout_atomic' : 'cli_first_ddl_lock_timeout_atomic', async () => {
    const f = await fixture(false);
    try {
      if (middle) {
        await f.c.query(`create table public.fixture_ddl_gate(id int);
          create function public.fixture_ddl_wait() returns event_trigger language plpgsql as $$ declare x record;begin
          for x in select * from pg_event_trigger_ddl_commands() loop
            if x.command_tag='CREATE FUNCTION' and x.object_identity like 'pos_open_orders_private.commit_v1(%' then
              lock table public.fixture_ddl_gate in access exclusive mode;
            end if;end loop;end $$;
          create event trigger fixture_ddl_wait on ddl_command_end execute function public.fixture_ddl_wait();`);
      }
      const beforeFunctions = (await f.c.query(metadata)).rows;
      await f.a.query('begin'); await f.a.query('select * from ' + (middle ? 'public.fixture_ddl_gate' : 'pos_open_orders_private.orders'));
      const applying = pending(() => cli(f, middle ? 'cli-middle-timeout' : 'cli-first-timeout'));
      const lock = await waitDdl(f, middle ? 'public.fixture_ddl_gate' : 'pos_open_orders_private.orders');
      const observed = performance.now(); const write = await pending(() => f.b.query('update public.pos_sales_receipts set payment_status=3 where id=18'));
      assert.equal(write.ok, true);
      const released = (async () => {
        while (true) { const waiting = (await f.observer.query('select 1 from pg_locks where pid=$1 and not granted and mode=$2', [lock.pid, 'AccessExclusiveLock'])).rows;
          if (!waiting.length) return performance.now() - observed; await delay(20); }
      })();
      const finished = await applying; assert.equal(finished.ok, true); const result = finished.value;
      assert.notEqual(result.code, 0, result.text); assert.match(result.text, /lock timeout/i);
      const observedWait = await released; assert.ok(observedWait > 4200 && observedWait < 8000);
      await f.a.query('rollback');
      assert.deepEqual((await f.c.query(metadata)).rows, beforeFunctions);
      assert.equal((await f.c.query("select count(*)::int n from information_schema.columns where table_schema='pos_open_orders_private' and table_name='orders' and column_name='closure_receipt_id'")).rows[0].n, 0);
      await f.preserved(); await f.ledger();
      return { phase: middle ? 'after columns/read replacement/rename' : 'first ALTER TABLE', lock, observedWaitMs: Math.round(observedWait), cliTotalMs: Math.round(result.ms), posWriterMs: Math.round(write.ms), atomic: true, ledgerChanged: false };
    } finally { await f.close(); }
  });
  await check('cli_exact_file_success_permissions_and_contract', async () => {
    const f = await fixture(false);
    try {
      const observedBefore = (await f.c.query('select order_id,observed_at::text from pos_open_orders_private.orders')).rows;
      const auditBefore = await f.audit();
      await f.c.query(`create table public.fixture_ddl_settings(setting text);
        create function public.fixture_ddl_setting_probe() returns event_trigger language plpgsql as $$ declare x record;begin
          for x in select * from pg_event_trigger_ddl_commands() loop
            if x.object_identity like 'pos_open_orders_private.%' or x.object_identity like 'public.pos_open_orders_commit(%' then
              insert into public.fixture_ddl_settings values(current_setting('lock_timeout'));
            end if;end loop;end $$;
        create event trigger fixture_ddl_setting_probe on ddl_command_end execute function public.fixture_ddl_setting_probe();`);
      const result = await cli(f, 'cli-success'); assert.equal(result.code, 0, result.text);
      const settings = (await f.c.query('select distinct setting from public.fixture_ddl_settings')).rows;
      assert.deepEqual(settings, [{ setting: '5s' }]); assert.equal((await f.read()).recoveryContractVersion, 2);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const permissions = (await f.c.query("select has_function_privilege($1,'public.pos_open_orders_commit(uuid,uuid,jsonb,jsonb)','EXECUTE') rpc,has_function_privilege($1,'pos_open_orders_private.commit_snapshot_v1(uuid,uuid,jsonb,jsonb)','EXECUTE') helper", [role])).rows[0];
        assert.equal(permissions.rpc, role === 'service_role'); assert.equal(permissions.helper, false);
      }
      const after = await f.read();
      // Read v2 adds evidence metadata; compare every pre-existing field and the
      // underlying observation timestamp, rather than rejecting legitimate additions.
      assert.deepEqual(after.orders.map(order => Object.fromEntries(Object.entries(order).filter(([key]) =>
        !['providerObservedAt', 'closureReceiptId', 'closureConfirmedAt'].includes(key)))), f.before.orders);
      assert.deepEqual((await f.c.query('select order_id,observed_at::text from pos_open_orders_private.orders')).rows, observedBefore);
      assert.deepEqual(await f.audit(), auditBefore);
      assert.equal(after.sync.lastSuccessAt, f.before.sync.lastSuccessAt);
      const id = await f.claim(); await f.commit(f.a, id, [{ ...f.order, closureReceiptId: 18 }]); await f.ledger();
      return { formalFileSha256: report.migrationSha256, appliedMs: Math.round(result.ms), ddlTimeoutObserved: settings[0].setting, publicRpcAndPermissions: 'PASS', ledgerChanged: false };
    } finally { await f.close(); }
  });
} finally {
  await admin.end(); report.pass = report.results.filter(r => r.status === 'PASS').length; report.fail = report.results.filter(r => r.status === 'FAIL').length;
  writeFileSync(resolve(output, 'green-results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ pass: report.pass, fail: report.fail, sha256: report.migrationSha256 }));
}
