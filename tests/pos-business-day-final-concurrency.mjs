// Native PostgreSQL only on an explicit loopback port, disposable database, no .env.
import assert from 'node:assert/strict';
import pg from 'pg';
import {initializePosFinalDatabase,claimFinal,releaseFinal,daySource,finalMigration} from './helpers/pos-business-day-final-fixture.mjs';
import {ledgerState,closeDay} from './helpers/pos-business-day-close-fixture.mjs';
const port=Number(process.env.POS_CLOSE_TEST_PG_PORT);assert.ok(Number.isInteger(port)&&port>1024&&port<65536);
const config={host:'127.0.0.1',port,user:'postgres',database:'postgres'};
const admin=new pg.Client(config),clients=[],name='pos_final_test_'+Date.now();let created=false;
const report={duplicateFinalRaces:0,claimRaces:0,manualCloseRace:false,lockWaits:0,migrationRollback:false,phase1RpcPreserved:false,securityContract:false,checkInsertRollback:false,expiredLeaseReclaim:false};
try{
 await admin.connect();await admin.query('create database '+name+" template template0 encoding 'UTF8'");created=true;
 for(let i=0;i<3;i++){const c=new pg.Client({...config,database:name});await c.connect();await c.query("set statement_timeout='10s';set timezone='UTC'");clients.push(c);}
 const [setup,a,b]=clients;
 const adapter={query:(sql,args)=>setup.query(sql,args),async exec(sql){
  sql=sql.replace('create role anon; create role authenticated; create role service_role;',()=>`do $$ begin
   if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;
   if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;
   if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role;end if;
  end $$;`);
  if(sql===finalMigration){
   const baseline=async()=>(await setup.query("select proname,pg_get_functiondef(oid) definition,proacl,proowner from pg_proc where pronamespace='public'::regnamespace and proname in('ledger_sync_pos_sales_v1','ledger_sync_pos_sales_v2','ledger_sync_pos_sales_v3','sales_close_business_day_v1') order by proname")).rows;
   const before=await baseline();
   await setup.query(sql.replace(/commit;\s*$/,'rollback;'));
   assert.equal((await setup.query("select to_regclass('public.pos_sales_business_day_close_checks') t")).rows[0].t,null);report.migrationRollback=true;
   assert.equal((await setup.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='pos_sales_sync_runs' and column_name='source_complete'")).rows[0].n,0);
   assert.equal((await setup.query("select to_regclass('pos_sales_close_private.final_check_leases') t,to_regprocedure('public.sales_finalize_business_day_v1(date,bigint,uuid,timestamptz,bigint,text,jsonb,jsonb,text,jsonb)') f")).rows[0].t,null);
   await setup.query(sql);assert.deepEqual(await baseline(),before);report.phase1RpcPreserved=true;
   const contract=(await setup.query(`select p.proname,p.prosecdef,p.proconfig,r.rolname owner,
     has_function_privilege('service_role',p.oid,'EXECUTE') service,
     has_function_privilege('anon',p.oid,'EXECUTE') anon,
     has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated
     from pg_proc p join pg_roles r on r.oid=p.proowner where p.proname in(
       'sales_claim_business_day_final_check_v1','sales_release_business_day_final_check_v1','sales_finalize_business_day_v1',
       'sales_close_business_day_after_sync_v1','require_final_actor')`)).rows;
   assert.equal(contract.length,5);for(const fn of contract){assert.equal(fn.owner,'postgres');assert.equal(fn.prosecdef,fn.proname!=='require_final_actor');
     assert.equal(fn.service,fn.proname!=='require_final_actor');assert.equal(fn.anon,false);assert.equal(fn.authenticated,false);assert.ok(fn.proconfig.includes('search_path=pg_catalog, public'));}
   const table=(await setup.query(`select c.relrowsecurity,r.rolname owner,
     has_table_privilege('service_role',c.oid,'SELECT') can_select,
     has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') can_write
     from pg_class c join pg_roles r on r.oid=c.relowner where c.oid='public.pos_sales_business_day_close_checks'::regclass`)).rows[0];
   assert.equal(table.owner,'postgres');assert.equal(table.relrowsecurity,true);assert.equal(table.can_select,true);assert.equal(table.can_write,false);
   assert.equal((await setup.query("select has_table_privilege('service_role','pos_sales_close_private.final_check_leases','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') allowed")).rows[0].allowed,false);
   const publicAcl=(await setup.query(`select count(*)::int n from pg_proc p, lateral aclexplode(p.proacl) acl
     where p.proname in('sales_claim_business_day_final_check_v1','sales_release_business_day_final_check_v1',
       'sales_finalize_business_day_v1','sales_close_business_day_after_sync_v1','require_final_actor') and acl.grantee=0`)).rows[0].n;
   assert.equal(publicAcl,0);report.securityContract=true;return;
  }
  await setup.query(sql);
 }};
 const context=await initializePosFinalDatabase(adapter),bPid=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
 async function wait(){for(let i=0;i<100;i++){if((await setup.query('select wait_event_type t from pg_stat_activity where pid=$1',[bPid])).rows[0].t==='Lock'){report.lockWaits++;return;}await new Promise(r=>setTimeout(r,10));}assert.fail('No database lock wait');}
 const invoke=(c,token,source)=>c.query('select sales_finalize_business_day_v1($1,2,$2,$3,100,$4,$5::jsonb,$6::jsonb) result',
  [context.date,token,context.cutoffAt,source.sourceFingerprint,JSON.stringify(source.sourceSnapshot),JSON.stringify(source.rows)]).then(r=>r.rows[0].result);
 // Actual PostgreSQL rollback after projection + closure INSERT have already executed.
 const initialSource=await daySource(adapter,context.date),initialState=await ledgerState(adapter),rollbackClaim=await claimFinal(setup,context.date);
 await setup.query("create function reject_final_check_test() returns trigger language plpgsql as $$ begin raise exception 'TEST_CHECK_INSERT_FAILURE';end $$;create trigger reject_final_check_test before insert on pos_sales_business_day_close_checks for each row execute function reject_final_check_test();");
 await assert.rejects(invoke(setup,rollbackClaim.token,initialSource),/TEST_CHECK_INSERT_FAILURE/);
 assert.deepEqual(await ledgerState(adapter),initialState);assert.equal((await setup.query('select count(*)::int n from pos_sales_business_day_close_checks')).rows[0].n,0);
 await setup.query('drop trigger reject_final_check_test on pos_sales_business_day_close_checks;drop function reject_final_check_test()');
 await releaseFinal(setup,context.date,rollbackClaim.token);report.checkInsertRollback=true;
 const expired=await claimFinal(setup,context.date);
 await setup.query("update pos_sales_close_private.final_check_leases set expires_at=clock_timestamp()-interval '1 second'");
 await assert.rejects(invoke(setup,expired.token,initialSource),/LEASE_EXPIRED/);
 const reclaimed=await claimFinal(setup,context.date);assert.equal(reclaimed.status,'claimed');
 await assert.rejects(invoke(setup,expired.token,initialSource),/LEASE_EXPIRED/);
 await releaseFinal(setup,context.date,expired.token);assert.equal((await claimFinal(setup,context.date)).status,'in_progress');
 await releaseFinal(setup,context.date,reclaimed.token);report.expiredLeaseReclaim=true;
 for(let round=0;round<10;round++){
  await a.query('begin');const claim=await claimFinal(a,context.date);const pending=claimFinal(b,context.date);await wait();await a.query('commit');
  assert.equal((await pending).status,'in_progress');report.claimRaces++;
  const source=await daySource(adapter,context.date),before=await ledgerState(adapter);
  await a.query('begin');const first=await invoke(a,claim.token,source);const second=invoke(b,claim.token,source);await wait();await a.query('commit');
  const right=await second;assert.equal(right.checkId,first.checkId);report.duplicateFinalRaces++;
  const after=await ledgerState(adapter);assert.equal(after.closures.length,1);if(round>0)assert.deepEqual(after,before);
  await releaseFinal(setup,context.date,claim.token);
 }
 // A final check racing a user close creates one close and one immutable check.
 const source=await daySource(adapter,context.date),claim=await claimFinal(setup,context.date);
 await a.query('begin');await invoke(a,claim.token,source);const manual=closeDay(b,source,{actor:3});await wait();await a.query('commit');assert.equal((await manual).status,'already_closed');report.manualCloseRace=true;
 await releaseFinal(setup,context.date,claim.token);
 assert.equal((await setup.query('select count(*)::int n from pos_sales_business_day_close_checks')).rows[0].n,1);
 console.log(JSON.stringify({status:'PASS',...report}));
}finally{for(const c of clients){await c.query('rollback').catch(()=>{});await c.end();}if(created)await admin.query('drop database '+name);await admin.end();}
