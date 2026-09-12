// Opt-in native PostgreSQL concurrency check. Loopback only, disposable DB,
// no .env loading and no production credentials/URLs.
import assert from 'node:assert/strict';
import pg from 'pg';
import { initializePosCloseDatabase, closeMigration, daySource, closeDay, syncDays, ledgerState, addCardSettlement } from './helpers/pos-business-day-close-fixture.mjs';

const port = Number(process.env.POS_CLOSE_TEST_PG_PORT);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, 'Set POS_CLOSE_TEST_PG_PORT to a disposable loopback PostgreSQL');
const config = { host: '127.0.0.1', port, user: 'postgres', database: 'postgres', connectionTimeoutMillis: 3000 };
const admin = new pg.Client(config);
const clients = [];
const databaseName = `pos_day_close_test_${Date.now()}`;
let databaseCreated = false;
const report = { firstCloseRaces: 0, recloseRaces: 0, syncRecloseRaces: 0, monthCloseRace: false, sourceWriteRace: false, cardSettlementRace: false, lockWaits: 0, legacyRpcUnchanged: false, migrationRollback: false, sqlContractAudit: false };
try {
  await admin.connect();
  const version = Number((await admin.query('show server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 170000, 'PostgreSQL 17+ required');
  await admin.query(`create database ${databaseName} template template0 encoding 'UTF8'`);
  databaseCreated = true;
  for (let index = 0; index < 3; index++) {
    const client = new pg.Client({ ...config, database: databaseName });
    await client.connect();
    await client.query("set statement_timeout='10s'; set deadlock_timeout='100ms'; set timezone='UTC'");
    clients.push(client);
  }
  const [setup, a, b] = clients;
  const definitions = async () => (await setup.query(`select proname, pg_get_functiondef(oid) definition, proacl, proowner, prosecdef, proconfig
    from pg_proc where pronamespace='public'::regnamespace and proname in ('ledger_sync_pos_sales_v1','ledger_sync_pos_sales_v2') order by proname`)).rows;
  const adapter = {
    query: (sql, args) => setup.query(sql, args),
    async exec(sql) {
      if (sql !== closeMigration) {
        sql = sql.replace('create role anon; create role authenticated; create role service_role;', () => `do $$ begin
          if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
          if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
          if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
        end $$;`);
        await setup.query(sql); return;
      }
      const before = await definitions();
      await setup.query(sql.replace(/commit;\s*$/, 'rollback;'));
      assert.deepEqual(await definitions(), before);
      assert.equal((await setup.query("select to_regclass('public.pos_sales_business_day_closures') table_name")).rows[0].table_name, null);
      report.migrationRollback = true;
      await setup.query(sql);
      assert.deepEqual(await definitions(), before);
      report.legacyRpcUnchanged = true;
    },
  };
  await initializePosCloseDatabase(adapter);
  const functions=(await setup.query(`select n.nspname,p.proname,p.prosecdef,p.proconfig,r.rolname owner,
    has_function_privilege('service_role',p.oid,'EXECUTE') service_execute,
    has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
    has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where a.grantee=0 and a.privilege_type='EXECUTE') public_execute
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner
    where n.nspname='pos_sales_close_private' or (n.nspname='public' and p.proname in('sales_close_business_day_v1','ledger_sync_pos_sales_v3'))`)).rows;
  assert.equal(functions.length,13);
  for(const fn of functions){
    assert.equal(fn.owner,'postgres');
    assert.ok(fn.proconfig.some(c=>c.replaceAll(' ','')==='search_path=pg_catalog,public'));
    assert.equal(fn.prosecdef,['transaction_guard','movement_guard','sales_close_business_day_v1','ledger_sync_pos_sales_v3'].includes(fn.proname));
    assert.equal(fn.service_execute,fn.nspname==='public');
    assert.equal(fn.anon_execute,false);assert.equal(fn.authenticated_execute,false);assert.equal(fn.public_execute,false);
  }
  assert.equal((await setup.query(`select count(*)::int n from pg_trigger where not tgisinternal
    and tgname in('pos_sales_day_closure_immutable','pos_sales_day_closure_no_truncate','ledger_pos_daily_close_guard','ledger_pos_movement_daily_close_guard')`)).rows[0].n,4);
  report.sqlContractAudit=true;
  const bPid = (await b.query('select pg_backend_pid() pid')).rows[0].pid;
  async function waitForLock() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = (await setup.query('select wait_event_type from pg_stat_activity where pid=$1', [bPid])).rows[0];
      if (row?.wait_event_type === 'Lock') { report.lockWaits++; return; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Second connection never waited on a database lock');
  }
  async function race(first, second) {
    await a.query('begin');
    await b.query('begin');
    try {
      const left = await first(a);
      const pending = second(b).then(value => ({ value }), error => ({ error }));
      await waitForLock();
      await a.query('commit');
      const right = await pending;
      if (right.error) throw right.error;
      await b.query('commit');
      return [left, right.value];
    } catch (error) { await a.query('rollback'); await b.query('rollback'); throw error; }
  }
  for (let round = 0; round < 10; round++) {
    const date = new Date(Date.UTC(2026, 7, 21 + round)).toISOString().slice(0, 10);
    const id = 100 + round;
    await setup.query(`insert into pos_sales_receipts(id,ref_no,business_date,payment_status,is_canceled,final_amount,revision)
      values ($1,'Concurrent',$2,3,false,100000,1)`, [id, date]);
    await setup.query(`insert into pos_sales_receipt_payments(id,receipt_id,business_date,payment_type,payment_name,amount)
      values ($1,$1,$2,1,'tiền mặt',100000)`, [id, date]);
    let source = await daySource(adapter, date);
    let results = await race(c => closeDay(c, source, {actor: round === 0 ? 3 : 1}), c => closeDay(c, source));
    assert.deepEqual(results.map(row => row.status), ['closed', 'already_closed']);
    report.firstCloseRaces++;
    await setup.query('update pos_sales_receipts set final_amount=110000,revision=2 where id=$1', [id]);
    await setup.query('update pos_sales_receipt_payments set amount=110000 where id=$1', [id]);
    source = await daySource(adapter, date);
    results = await race(c => closeDay(c, source, { reclose: true }), c => closeDay(c, source, { reclose: true }));
    assert.deepEqual(results.map(row => row.status), ['reclosed', 'already_closed']);
    assert.equal(results[0].revision, 2);
    report.recloseRaces++;
    await setup.query('update pos_sales_receipts set final_amount=120000,revision=3 where id=$1', [id]);
    await setup.query('update pos_sales_receipt_payments set amount=120000 where id=$1', [id]);
    source = await daySource(adapter, date);
    results = await race(c => closeDay(c, source, { reclose: true }), c => syncDays(c, [source]));
    assert.equal(results[0].revision, 3);
    assert.equal(results[1].updatedCount, 0);
    assert.equal(results[1].unchangedCount, 4);
    report.syncRecloseRaces++;
    const state = await ledgerState(adapter);
    assert.equal(state.closures.filter(row => row.business_date === date).length, 3);
    assert.equal(state.transactions.filter(row => row.business_date === date).reduce((sum, row) => sum + Number(row.amount), 0), 120000);
  }
  // A reconciliation writer holds the same POS card row lock as the real
  // ledger_match_card_reconciliation_v1. Reclose must see its committed line.
  await setup.query(`insert into pos_sales_receipts(id,ref_no,business_date,payment_status,is_canceled,final_amount,revision)
    values(500,'Card race','2026-09-01',3,false,60000,1);
    insert into pos_sales_receipt_payments(id,receipt_id,business_date,payment_type,payment_name,amount)
    values(500,500,'2026-09-01',2,'Visa',60000)`);
  await closeDay(adapter,await daySource(adapter,'2026-09-01'));
  await setup.query('update pos_sales_receipts set final_amount=70000 where id=500; update pos_sales_receipt_payments set amount=70000 where id=500');
  const cardChanged=await daySource(adapter,'2026-09-01');
  await a.query('begin');
  await a.query("select id from ledger_transactions where source_key='pos:2026-09-01:card' for update");
  await addCardSettlement(a,'partial','2026-09-01');
  const cardBefore=await ledgerState(adapter);
  const cardPending=closeDay(b,cardChanged,{reclose:true});
  await waitForLock();
  await a.query('commit');
  assert.equal((await cardPending).status,'card_settlement_locked');
  const cardAfter=await ledgerState(adapter);
  assert.deepEqual(cardAfter.transactions.filter(t=>t.source_type==='pos_sales_daily_payment'),cardBefore.transactions.filter(t=>t.source_type==='pos_sales_daily_payment'));
  assert.deepEqual(cardAfter.closures,cardBefore.closures);
  report.cardSettlementRace=true;

  // A source writer commits between preview and RPC. The table SHARE lock
  // waits for the writer and then live-source validation rejects stale input.
  const stale = await daySource(adapter, '2026-08-20');
  await a.query('begin');
  await a.query('update pos_sales_receipts set final_amount=101000 where id=1');
  await a.query('update pos_sales_receipt_payments set amount=61000 where id=2');
  const pending = closeDay(b, stale).then(value => ({ value }), error => ({ error }));
  await waitForLock();
  await a.query('commit');
  const rejected = await pending;
  assert.match(rejected.error?.message ?? '', /POS_SOURCE_CHANGED_BEFORE_PROJECTION/);
  report.sourceWriteRace = true;
  const source = await daySource(adapter, '2026-08-20');
  await a.query('begin');
  await a.query("select pg_advisory_xact_lock(hashtext('ledger_month_close:2026-08'))");
  await a.query("insert into ledger_month_closures(month) values ('2026-08-01')");
  const monthPending = closeDay(b, source, { reclose: true });
  await waitForLock();
  await a.query('commit');
  assert.equal((await monthPending).status, 'month_closed');
  report.monthCloseRace = true;
  assert.equal((await setup.query('select count(*)::int n from pos_sales_close_private.projection_permissions')).rows[0].n, 0);
  console.log(JSON.stringify({ status: 'PASS', postgresVersion: version, ...report }));
} finally {
  for (const client of clients) await client.end();
  if (databaseCreated) await admin.query(`drop database ${databaseName}`);
  await admin.end();
}
