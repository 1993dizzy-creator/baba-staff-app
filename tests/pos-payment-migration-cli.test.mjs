import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {nativeInventoryPostgres as nativePostgres} from './helpers/inventory-native-postgres.mjs';
import {paymentFixture,paymentMigration,previousPaymentMigration,productionDefinitionMd5,
  addReceipt,payment,seed,reconcile,snapshot,payments,protectedState} from './helpers/pos-payment-reconciliation-fixture.mjs';

// These tests invoke the real production runner, but only against an owned
// disposable loopback cluster. No .env files or production credentials are read.
assert.ok(process.env.QA_POSTGRES_BIN,'QA_POSTGRES_BIN is required');
assert.ok(process.env.QA_SUPABASE_CLI_BIN,'QA_SUPABASE_CLI_BIN is required');
const cli=path.resolve(process.env.QA_SUPABASE_CLI_BIN);
const version='20261016170140',name='fix_pos_payment_snapshot_replacement';
const filename=version+'_'+name+'.sql';
const run=(args,cwd,runtime)=>new Promise((resolve,reject)=>{
  const env={};for(const key of ['SystemRoot','SYSTEMROOT','PATH','TEMP','TMP','LOCALAPPDATA','APPDATA'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{CI:'true',USERPROFILE:cwd,DOCKER_CONFIG:cwd,PGSSLMODE:'disable'});
  const child=spawn(cli,args,{cwd,env,windowsHide:true});runtime?.trackChild(child);let output='';
  child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  child.on('error',reject);child.on('exit',code=>resolve({code,output}));
});
async function workspace(db,sql,runtime){
  const root=path.resolve('.tmp');mkdirSync(root,{recursive:true});
  const dir=mkdtempSync(path.join(root,'pos-payment-cli-'));
  mkdirSync(path.join(dir,'supabase','migrations'),{recursive:true});
  writeFileSync(path.join(dir,'supabase','config.toml'),'project_id = "pos-payment-isolated-test"\n[db]\nmajor_version = 17\n');
  writeFileSync(path.join(dir,'supabase','migrations','202609030001_reconcile_sales_receipt_payments.sql'),previousPaymentMigration);
  writeFileSync(path.join(dir,'supabase','migrations',filename),sql);
  const {host,port,database}=db.client.connectionParameters;
  assert.equal(host,'127.0.0.1');assert.match(database,/^qa_case_\d+$/);assert.ok(Number(port)>1024);
  const url=new URL('postgresql://postgres@127.0.0.1:'+port+'/'+database);url.searchParams.set('sslmode','disable');
  return {dir,apply:()=>run(['db','push','--db-url',url.toString(),'--workdir',dir,'--yes'],dir,runtime)};
}
async function history(db){return (await db.query('select version,name,statements from supabase_migrations.schema_migrations order by version')).rows;}
async function state(db){return {
  function:(await db.query("select pg_get_functiondef(oid) definition,proowner,proacl::text,proconfig,prosecdef from pg_proc where oid='public.reconcile_sales_receipt_payments_v1(jsonb)'::regprocedure")).rows,
  indexes:(await db.query("select indexname,indexdef from pg_indexes where tablename='pos_sales_receipt_payments' order by indexname")).rows,
  history:await history(db),payments:await payments(db),protected:await protectedState(db),
};}

test('Supabase CLI 2.81.3 db push atomically applies payment DDL and migration history',{timeout:120000},async t=>{
  const versionCheck=await run(['--version'],process.cwd());assert.equal(versionCheck.code,0);assert.match(versionCheck.output,/\b2\.81\.3\b/);
  const runtime=await nativePostgres({testContext:t});console.log(runtime.version);
  async function fixture(sqlFor){
    const db=await paymentFixture(runtime.Database,{upgrade:false});
    await db.exec(`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);
      insert into supabase_migrations.schema_migrations values('202609030001','reconcile_sales_receipt_payments',array['isolated baseline already applied']);`);
    const id=await addReceipt(db);await seed(db,id);
    const cliWorkspace=await workspace(db,sqlFor(db),runtime);return {db,...cliWorkspace};
  }
  async function scenario(label,sqlFor,work){await t.test(label,async()=>{
    const f=await fixture(sqlFor);try{await work(f);}finally{await f.db.close();}
  });}
  try{
    await scenario('matching fixture baseline commits definition ACL and exactly one history row; rerun is a history no-op',db=>db.fixturePaymentMigration,async({db,apply})=>{
      const before=await state(db);const result=await apply();assert.equal(result.code,0,result.output);
      assert.doesNotMatch(result.output,/no transaction in progress|already a transaction/i);
      const after=await state(db);assert.notDeepEqual(after.function,before.function);assert.deepEqual(after.protected,before.protected);assert.deepEqual(after.payments,before.payments);assert.deepEqual(after.indexes,before.indexes);
      assert.equal(after.history.length,before.history.length+1);const entry=after.history.find(r=>r.version===version);assert.equal(entry.name,name);assert.ok(entry.statements.length>1);
      assert.ok(!entry.statements.some(s=>/^\s*(?:begin|commit|rollback)\s*;/i.test(s)));
      const repeat=await apply();assert.equal(repeat.code,0,repeat.output);assert.deepEqual(await state(db),after);
      await reconcile(db,[snapshot([payment()])]);assert.equal(Number((await payments(db))[0].amount),2074200);
    });
    await scenario('unmodified production MD5 mismatch preserves function ACL indexes data and complete history',()=>paymentMigration,async({db,apply})=>{
      assert.notEqual(db.fixtureDefinitionMd5,productionDefinitionMd5);const before=await state(db);
      const result=await apply();assert.notEqual(result.code,0,result.output);assert.match(result.output,/pos_payment_reconciliation_definition_mismatch/);assert.deepEqual(await state(db),before);
    });
    await scenario('SQL error after replacement rolls back definition ACL data and history',db=>db.fixturePaymentMigration+"\nselect 1/0;\n",async({db,apply})=>{
      // Deliberately different ACL makes restoration observable, without changing the definition hash.
      await db.exec('grant execute on function public.reconcile_sales_receipt_payments_v1(jsonb) to authenticated;');
      const before=await state(db);const result=await apply();assert.notEqual(result.code,0,result.output);assert.match(result.output,/division by zero/);assert.deepEqual(await state(db),before);
    });
    await scenario('failure of the runner history INSERT rolls back successful function and ACL changes',db=>db.fixturePaymentMigration,async({db,apply})=>{
      await db.exec(`grant execute on function public.reconcile_sales_receipt_payments_v1(jsonb) to authenticated;
        create function reject_payment_history() returns trigger language plpgsql as $$begin if new.version='20261016170140' then raise exception 'isolated_history_insert_failure';end if;return new;end$$;
        create trigger reject_payment_history before insert on supabase_migrations.schema_migrations for each row execute function reject_payment_history();`);
      const before=await state(db);const result=await apply();assert.notEqual(result.code,0,result.output);assert.match(result.output,/isolated_history_insert_failure/);assert.deepEqual(await state(db),before);
    });
    await scenario('legacy explicit COMMIT reproduces a definition/history split under the same runner',db=>'begin;\n'+db.fixturePaymentMigration+'\ncommit;\n',async({db,apply})=>{
      await db.exec(`create function reject_legacy_history() returns trigger language plpgsql as $$begin if new.version='20261016170140' then raise exception 'isolated_history_insert_failure';end if;return new;end$$;
        create trigger reject_legacy_history before insert on supabase_migrations.schema_migrations for each row execute function reject_legacy_history();`);
      const before=await state(db);const result=await apply();assert.notEqual(result.code,0,result.output);assert.match(result.output,/isolated_history_insert_failure/);
      const after=await state(db);assert.notDeepEqual(after.function,before.function);assert.deepEqual(after.history,before.history);assert.deepEqual(after.payments,before.payments);
    });
  }finally{await runtime.stop();}
});
