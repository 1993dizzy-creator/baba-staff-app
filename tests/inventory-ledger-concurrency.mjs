// Explicit opt-in native PostgreSQL test. Loopback only, fresh disposable database;
// never loads .env or accepts a production URL. Run against PostgreSQL 17.6.
import pg from 'pg';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { database } from './helpers/inventory-ledger-fixture.mjs';

const port=Number(process.env.INVENTORY_TEST_PG_PORT);
assert.ok(Number.isInteger(port)&&port>1024&&port<65536,'Set INVENTORY_TEST_PG_PORT for an isolated local PostgreSQL 17.6');
const rounds=Number(process.env.INVENTORY_TEST_ROUNDS??20);
assert.ok(Number.isInteger(rounds)&&rounds>0&&rounds<=1000);
const config={host:'127.0.0.1',port,user:'postgres',database:'postgres'};
const setup=new pg.Client(config);await setup.connect();
assert.equal((await setup.query('show server_version_num')).rows[0].server_version_num,'170006');
const dbName='inventory_lock_test_'+Date.now();
await setup.query('create database '+dbName);
const clients=[];
async function connect(){const client=new pg.Client({...config,database:dbName});await client.connect();clients.push(client);await client.query("set statement_timeout='10s'; set deadlock_timeout='200ms'");return client;}
const c=await connect(),a=await connect(),b=await connect();
const metadata=`select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,pg_get_function_result(p.oid) result,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,p.proacl,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='public' and p.proname like 'ledger_%') or n.nspname='inventory_ledger_private' order by 1,2,3`;
const report={server:'17.6',rounds,scenarios:{},deadlocks:0,duplicateCandidates:0,duplicateTransactions:0,duplicateMovements:0,duplicatePayables:0};
class Adapter {
  async exec(sql){
    sql=sql.replace('create role anon; create role authenticated; create role service_role;',()=>`do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
    end $$;`);
    if(!sql.includes('create schema inventory_ledger_private')){await c.query(sql);return;}
    // Include the original drift trigger definition for the compatibility comparison.
    const old=readFileSync('supabase/migrations/202608210008_add_ledger_month_close_corrections.sql','utf8');
    await c.query(old.slice(old.indexOf('create or replace function public.ledger_confirmed_candidate_drift_v1'),old.indexOf('create or replace function public.ledger_record_source_drift_v1')).split('create trigger')[0]);
    const before=(await c.query(metadata)).rows;
    await c.query('begin');await c.query(sql);await c.query('rollback');
    assert.deepEqual((await c.query(metadata)).rows,before);
    assert.equal((await c.query("select to_regnamespace('inventory_ledger_private') n")).rows[0].n,null);
    assert.equal((await c.query("select count(*) n from information_schema.columns where table_name='inventory_logs' and column_name='source_actor_user_id'")).rows[0].n,'0');
    await c.query('begin');await c.query(sql);await c.query('commit');
    const after=(await c.query(metadata)).rows;
    for(const original of before){
      const current=after.find(x=>x.nspname===original.nspname&&x.proname===original.proname&&x.args===original.args);
      assert.deepEqual({...current,definition:null},{...original,definition:null});
      if(['ledger_rebook_inventory_transaction_v1','ledger_resolve_inventory_candidate_v1','ledger_sync_inventory_candidates_core_v1'].includes(original.proname)){
        // Removing ONLY the inserted lock preamble must reproduce the original body.
        const cleaned=current.definition.replace(/  begin\n    perform inventory_ledger_private\.lock_sources\([\s\S]*?\n  end;\n/,'')
          .replace(/ {1,2}perform inventory_ledger_private\.lock_sources\(array\([\s\S]*?;\n/g,'');
        assert.equal(cleaned,original.definition);
      }
    }
    report.transactionApplyRollback='PASS';report.existingRpcAttributes='PASS';
    report.functionAttributes=after.map(row=>{const attributes={...row};delete attributes.definition;return attributes;});
    const privileges=(await c.query(`select p.proname,r.rolname,has_schema_privilege(r.oid,n.oid,'USAGE') usage,has_function_privilege(r.oid,p.oid,'EXECUTE') execute
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r
      where r.rolname in ('anon','authenticated','service_role') and (n.nspname='inventory_ledger_private' or p.proname in ('ledger_project_inventory_purchase_log_v1','ledger_reconcile_inventory_month_v1'))`)).rows;
    for(const row of privileges){if(row.proname.startsWith('ledger_'))assert.equal(row.execute,row.rolname==='service_role');else {assert.equal(row.execute,false);assert.equal(row.usage,false);}}
    report.grants='PASS';
  }
}
const query=(client,sql,args=[])=>client.query(sql,args).catch(error=>{if(error.code==='40P01')report.deadlocks++;throw error;});
const project=(client,id=100)=>query(client,'select ledger_project_inventory_purchase_log_v1($1,1) r',[id]);
const month=client=>query(client,"select ledger_reconcile_inventory_month_v1('2026-09-01',2) r");
function success(result){const r=result.rows[0].r;assert.ok(['synced','ok','rebooked'].includes(r.status),JSON.stringify(r));assert.equal(r.failedCount??0,0);assert.equal(r.reviewRequiredCount??0,0);return r;}
async function both(left,right){const results=await Promise.all([left,right]);results.forEach(success);}
async function reset(postpaid=false){
  await c.query('truncate inventory_logs,ledger_candidates,ledger_transactions,ledger_movements,ledger_payables,ledger_payable_allocations,ledger_audit_logs restart identity cascade');
  await c.query(`insert into inventory_logs(id,item_id,item_name,item_name_vi,category,category_vi,unit,change_quantity,new_purchase_price,new_supplier,business_date,created_at,source,reason,actor_username,source_actor_user_id,purchase_supplier_partner_id)
    select id,1,'Coca','Cola','Drinks','Nuoc','can',10,20000,$1,'2026-09-01','2026-09-01T10:00:00Z','create','purchase','staff',1,$2 from unnest(array[100,101]) id`,[postpaid?'Postpaid':'Won Mart',postpaid?12:10]);
}
async function counts(tx=2,postpaid=false,rebook=false){
  const row=(await c.query(`select (select count(*) from ledger_candidates where status='confirmed') candidates,
    (select count(*) from ledger_transactions) transactions,(select count(*) from ledger_movements) movements,
    (select count(*) from ledger_payables) payables,(select count(*) from ledger_payables where status<>'cancelled') active_payables,
    (select count(*) from (select source_key from ledger_candidates where status='confirmed' group by source_key having count(*)>1) d) duplicate_candidates,
    (select count(*) from (select transaction_id from ledger_movements group by transaction_id having count(*)>1) d) duplicate_movements,
    (select count(*) from (select expense_transaction_id from ledger_payables group by expense_transaction_id having count(*)>1) d) duplicate_payables`).then(x=>x.rows))[0];
  assert.equal(Number(row.candidates),tx===1?1:2);assert.equal(Number(row.transactions),tx);
  assert.equal(Number(row.movements),postpaid?0:tx);
  assert.equal(Number(row.payables),postpaid?(rebook?3:2):0);
  assert.equal(Number(row.active_payables),postpaid?2:0);
  assert.equal(Number(row.duplicate_candidates),0);assert.equal(Number(row.duplicate_movements),0);assert.equal(Number(row.duplicate_payables),0);
}
async function waitBlocked(pid){for(let i=0;i<200;i++){const rows=(await c.query('select locktype,mode,classid,objid,relation::regclass::text,transactionid from pg_locks where pid=$1 and not granted',[pid])).rows;if(rows.length)return rows;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('expected real lock contention');}
try{
  await database(Adapter);
  for(let i=0;i<rounds;i++){
    for(const postpaid of [false,true]){
      await reset(postpaid);success(await project(c));
      await c.query('update inventory_logs set new_purchase_price=21000 where id=100');success(await project(c));
      await b.query("begin;select pg_advisory_xact_lock(hashtext('ledger_inventory_candidate:inventory-log:101'))");
      const running=month(a);const locks=await waitBlocked(a.processID);
      // Same scheduling as the original 40P01 reproduction. A now holds no month lock.
      assert.equal((await c.query("select count(*) n from pg_locks where pid=$1 and locktype='advisory' and granted and objid=hashtext('ledger_month_close:2026-09')::oid",[a.processID])).rows[0].n,'0');
      success(await project(b,101));await b.query('commit');success(await running);await counts(4,postpaid,true);
      report.originalScenarioWait=locks;
      report.scenarios.originalMonthlySingle=(report.scenarios.originalMonthlySingle??0)+1;

      await reset(postpaid);await both(project(a),project(b));
      // Only log100 has been posted.
      assert.equal((await c.query('select count(*) n from ledger_transactions')).rows[0].n,'1');
      success(await project(c,101));await counts(2,postpaid);
      report.scenarios.sameSingle=(report.scenarios.sameSingle??0)+1;

      await reset(postpaid);await both(month(a),month(b));await counts(2,postpaid);
      report.scenarios.sameMonth=(report.scenarios.sameMonth??0)+1;

      const snapshots=(await c.query('select id,source_snapshot from ledger_transactions order by id')).rows;
      await c.query("update inventory_logs set item_name='Latest',category='Soda' where id=100");
      await both(project(a),project(b));await counts(2,postpaid);
      assert.deepEqual((await c.query('select id,source_snapshot from ledger_transactions order by id')).rows,snapshots);
      assert.equal((await c.query("select source_drift_snapshot->>'item_name' name from ledger_candidates where source_key='inventory-log:100'")).rows[0].name,'Latest');
      report.scenarios.metadataSingle=(report.scenarios.metadataSingle??0)+1;

      for(const useMonth of [true,false]){
        await reset(postpaid);success(await month(c));await c.query('update inventory_logs set new_purchase_price=21000 where id=100');
        await both(project(a),useMonth?month(b):project(b));await counts(4,postpaid,true);
        const key=useMonth?'sourceCorrectionMonth':'sourceCorrectionSingle';report.scenarios[key]=(report.scenarios[key]??0)+1;
        await reset(postpaid);success(await month(c));
        const id=(await c.query("select resolved_transaction_id id from ledger_candidates where source_key='inventory-log:100'")).rows[0].id;
        const manual=query(a,"select ledger_rebook_inventory_transaction_v1($1,$2,4,$3,'2026-09-08',200000,null,'Concurrent manual correction',2) r",[id,postpaid?'payable':'immediate',postpaid?null:1]);
        await both(manual,useMonth?month(b):project(b));await counts(4,postpaid,true);
        const manualKey=useMonth?'manualRebookMonth':'manualRebookSingle';report.scenarios[manualKey]=(report.scenarios[manualKey]??0)+1;
      }
    }
    // Two recovery months overlap after an explicit Source date correction.
    await reset();success(await month(c));
    await c.query("update inventory_logs set business_date='2026-10-01',new_purchase_price=21000 where id=100");
    await both(month(a),query(b,"select ledger_reconcile_inventory_month_v1('2026-10-01',2) r"));
    await counts(4);
    assert.equal((await c.query('select sum(amount*economic_effect_sign)::text total from ledger_transactions')).rows[0].total,'410000.000');
    report.scenarios.overlappingRecoveryMonths=(report.scenarios.overlappingRecoveryMonths??0)+1;

    // The month closer owns only its month mutex; it never waits on Source locks.
    // Exercise that real namespace with a waiting single and a waiting monthly call.
    await reset();await c.query("begin;select pg_advisory_xact_lock(hashtext('ledger_month_close:2026-09'))");
    const singleWaiting=project(b,101);await waitBlocked(b.processID);
    const monthWaiting=month(a);await waitBlocked(a.processID);
    await c.query('commit');await both(singleWaiting,monthWaiting);await counts();
    report.scenarios.monthCloseMutex=(report.scenarios.monthCloseMutex??0)+1;
    if((i+1)%5===0)console.log(`PASS ${i+1}/${rounds} rounds`);
  }
  console.log(JSON.stringify({...report,functionAttributes:undefined},null,2));
  if(process.env.INVENTORY_TEST_REPORT)writeFileSync(process.env.INVENTORY_TEST_REPORT,JSON.stringify(report,null,2));
}finally{
  await Promise.all(clients.map(client=>client.end()));
  await setup.end();
}
