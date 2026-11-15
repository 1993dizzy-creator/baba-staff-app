import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {installCleaningFixture,context,confirm,addOrder,scope,tableId} from './helpers/tables-cleaning-fixture.mjs';
import {FUNCTION_HASHES} from './helpers/pos-open-orders-native-fixture.mjs';
const file=name=>readFileSync(new URL('../docs/sql/tables-cleaning-v1-'+name+'.sql',import.meta.url),'utf8');
const PREFLIGHT=file('preflight'),POSTFLIGHT=file('postflight'),STOP=file('stop'),EMERGENCY=file('emergency-disable'),RECOVER=file('recover');
const settle=p=>p.then(value=>({value}),error=>({error}));
async function waitLock(observer,pid){for(let i=0;i<300;i++){
 if((await observer.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'",[pid])).rows.length)return;
 await delay(10);
}throw Error('Expected lock wait missing');}

test('cleaning P0 native safety regressions',{skip:!process.env.QA_POSTGRES_BIN&&'QA_POSTGRES_BIN not set',timeout:180000},async t=>{
 const cwd=process.cwd(),root=path.join(cwd,'.local/tables-cleaning-p0');mkdirSync(root,{recursive:true});process.chdir(root);
 const runtime=await nativeInventoryPostgres({testContext:t}),metrics=[];t.diagnostic(runtime.version);
 async function scenario(name,run){await t.test(name,{timeout:30000},async()=>{
  const db=new runtime.Database();await db.ready;const day=await installCleaningFixture(db);
  await db.exec(`alter table pos_sales_receipts add column synced_at timestamptz,add column updated_at timestamptz;
   alter table pos_sales_receipt_lines add column synced_at timestamptz,add column updated_at timestamptz,
   add column item_id text,add column unit_price numeric,add column raw_json jsonb;
   insert into pos_sales_receipt_lines(id,receipt_id,source,item_name,quantity,final_amount,is_canceled,item_id,unit_price,raw_json)
   values(1,100,'cukcuk','Synthetic',1,100000,false,'item-1',100000,'{"Quantity":1,"ModifiedDate":"old","Nested":{"UpdatedDate":"old","Amount":100000}}');
   update table_operations_private.config set enabled=true;`);
  const a=await runtime.connect(db.name),b=await runtime.connect(db.name);
  try{await run({db,a,b,day});assert.equal(Number((await db.query('select deadlocks from pg_stat_database where datname=current_database()')).rows[0].deadlocks),0);}
  finally{await a.query('rollback');await b.query('rollback');await a.end();await b.end();await db.close();}
 });}
 try{
  await scenario('P0-A OFF POS writes do not access audit tables, hash or insert invalidations',async({db,a,b,day})=>{
   const c=await context(db,day);await confirm(db,day,c);await db.exec('update table_operations_private.config set enabled=false');
   await b.query('begin;lock table table_operations_private.cleaning_events,table_operations_private.invalidations in access exclusive mode');
   await a.query("set statement_timeout='700ms'");const start=performance.now();
   await addOrder({query:(...args)=>a.query(...args)},day);
   await a.query("update pos_open_orders_private.orders set status=3");
   await a.query(`insert into pos_sales_receipts(id,source,branch_id,business_date,payment_status,is_canceled,total_amount,final_amount,ref_date,raw_json)
    select 101,source,branch_id,business_date,3,false,1,1,ref_date,'{"OrderId":"off-order","TableName":"BAR4"}' from pos_sales_receipts where id=100;
    update pos_sales_receipts set final_amount=2 where id=101;delete from pos_sales_receipts where id=101;
    insert into pos_sales_receipt_lines(id,receipt_id,source,item_name,quantity,final_amount,is_canceled) values(2,100,'cukcuk','OFF',1,1,false);
    update pos_sales_receipt_lines set final_amount=2 where id=2;delete from pos_sales_receipt_lines where id=2;`);
   metrics.push({case:'off-writes-under-audit-lock',ms:performance.now()-start});await b.query('rollback');
   assert.equal(Number((await db.query('select count(*) n from table_operations_private.invalidations')).rows[0].n),0);
  });
  await scenario('P0-B GET context holds no receipt SHARE/advisory lock while transaction stays open',async({a,b,day})=>{
   await a.query('begin');await context(a,day);await b.query("set statement_timeout='700ms'");const start=performance.now();
   await b.query('update pos_sales_receipts set updated_at=clock_timestamp() where id=100');
   await b.query('update pos_sales_receipt_lines set updated_at=clock_timestamp() where id=1');
   const lock=(await b.query("select pg_try_advisory_xact_lock(hashtextextended('pos_open_orders:'||$1,0)) ok",[scope])).rows[0].ok;
   assert.equal(lock,true);metrics.push({case:'writers-during-open-get',ms:performance.now()-start});
  });
  await scenario('P1-C metadata-only repeat sync preserves receipt version, cleaning key and record',async({db,day})=>{
   const c=await context(db,day);await confirm(db,day,c);const before=c.keys[tableId].evidenceKey;
   for(let i=0;i<5;i++)await db.query(`update pos_sales_receipts set synced_at=clock_timestamp(),updated_at=clock_timestamp(),status_changed_at=clock_timestamp(),
    raw_json=raw_json||jsonb_build_object('ModifiedDate',$1::text) where id=100`,['sync-'+i]);
   await db.exec(`update pos_sales_receipt_lines set synced_at=clock_timestamp(),updated_at=clock_timestamp(),
    raw_json=jsonb_set(jsonb_set(raw_json,'{ModifiedDate}','"new"'),'{Nested,UpdatedDate}','"new"') where id=1;`);
   const after=await context(db,day);assert.equal(after.receipts[0].version,c.receipts[0].version);assert.equal(after.keys[tableId].evidenceKey,before);
   assert.ok(after.cleanedTableIds.includes(tableId));assert.equal(Number((await db.query('select count(*) n from table_operations_private.invalidations')).rows[0].n),0);
   assert.equal((await confirm(db,day,c)).saved,true,'metadata-only change must not cause stale rejection');
  });
  await scenario('P0-A OFF→change→ON cannot resurrect records; unchanged OFF→ON also changes generation',async({db,day})=>{
   const c=await context(db,day);await confirm(db,day,c);await db.exec('update table_operations_private.config set enabled=false');
   await addOrder(db,day);await db.exec('delete from pos_open_orders_private.orders');
   await db.exec('update table_operations_private.config set enabled=true');const after=await context(db,day);
   assert.notEqual(after.keys[tableId].evidenceKey,c.keys[tableId].evidenceKey);assert.ok(!after.cleanedTableIds.includes(tableId));
   await assert.rejects(confirm(db,day,c),/stale/);
   await confirm(db,day,after,{requestId:'00000000-0000-4000-8000-000000000002'});
   await db.exec('update table_operations_private.config set enabled=false;update table_operations_private.config set enabled=true');
   const again=await context(db,day);assert.notEqual(again.keys[tableId].evidenceKey,after.keys[tableId].evidenceKey);assert.ok(!again.cleanedTableIds.includes(tableId));
  });
  await scenario('ON semantic amount/menu/merge evidence changes still invalidate; repeated sync load',async({db,day})=>{
   const c=await context(db,day);await confirm(db,day,c);
   const start=performance.now();await db.exec(`do $$begin for i in 1..100 loop
    update pos_sales_receipts set synced_at=clock_timestamp(),updated_at=clock_timestamp() where id=100;
    update pos_sales_receipt_lines set synced_at=clock_timestamp(),updated_at=clock_timestamp() where id=1;
   end loop;end $$;`);
   metrics.push({case:'200-metadata-updates',ms:performance.now()-start});
   assert.ok((await context(db,day)).cleanedTableIds.includes(tableId));
   await db.exec('update pos_sales_receipt_lines set quantity=2 where id=1');assert.ok(!(await context(db,day)).cleanedTableIds.includes(tableId));
   const next=await context(db,day);await confirm(db,day,next,{requestId:'00000000-0000-4000-8000-000000000002'});
   await db.exec("update pos_sales_receipts set raw_json=raw_json||'{\"SAInvoiceDetails\":[{\"Amount\":200000,\"OrderDetailID\":\"merge-change\"}]}'::jsonb where id=100");
   assert.ok(!(await context(db,day)).cleanedTableIds.includes(tableId));
   const fresh=await context(db,day);await confirm(db,day,fresh,{requestId:'00000000-0000-4000-8000-000000000003'});
   await db.exec('update pos_sales_receipts set final_amount=200000 where id=100');assert.ok(!(await context(db,day)).cleanedTableIds.includes(tableId));
  });
  await scenario('POST lock_timeout returns 55P03 without a saved event; GET remains available',async({db,a,b,day})=>{
   const c=await context(db,day);await b.query('begin;update pos_sales_receipts set updated_at=clock_timestamp() where id=100');
   const readStart=performance.now();await context(a,day);metrics.push({case:'get-during-uncommitted-pos-write',ms:performance.now()-readStart});
   const start=performance.now(),result=await settle(confirm(a,day,c));
   assert.equal(result.error?.code,'55P03');const ms=performance.now()-start;assert.ok(ms>=2500&&ms<6000);
   metrics.push({case:'post-lock-timeout',ms});await b.query('rollback');
   assert.equal(Number((await db.query('select count(*) n from table_operations_private.cleaning_events')).rows[0].n),0);
   assert.equal((await confirm(a,day,c)).saved,true,'locks released after timeout; retry succeeds');
  });
  for(const writer of ['receipt','line','collector','config'])await scenario('POST-first race with '+writer,async({db,a,b,day})=>{
   const c=await context(db,day);await a.query('begin');await confirm(a,day,c);
   const pid=(await b.query('select pg_backend_pid() p')).rows[0].p;
   let pending;
   if(writer==='receipt')pending=settle(b.query('update pos_sales_receipts set final_amount=200000 where id=100'));
   if(writer==='line')pending=settle(b.query('update pos_sales_receipt_lines set quantity=2 where id=1'));
   if(writer==='config')pending=settle(b.query('update table_operations_private.config set enabled=false'));
   if(writer==='collector')pending=settle((async()=>{
    await b.query('begin');await b.query("select pg_advisory_xact_lock(hashtextextended('pos_open_orders:'||$1,0))",[scope]);
    await addOrder({query:(...args)=>b.query(...args)},day);await b.query('commit');
   })());
   await waitLock(db.client,pid);await a.query('commit');assert.ok(!(await pending).error);
   const after=await context(db,day);assert.ok(!after.cleanedTableIds?.includes(tableId));
   if(writer==='config')assert.deepEqual(after,{enabled:false});
  });
  await scenario('ON metadata writes bypass audit-table locks; important field matrix is fail-closed',async({db,a,b,day})=>{
   const c=await context(db,day);await confirm(db,day,c);
   await b.query('begin;lock table table_operations_private.cleaning_events,table_operations_private.invalidations in access exclusive mode');
   await a.query("set statement_timeout='700ms';update pos_sales_receipts set synced_at=clock_timestamp() where id=100;update pos_sales_receipt_lines set updated_at=clock_timestamp() where id=1");
   await b.query('rollback');
   const queries=[
    'update pos_sales_receipts set payment_status=1 where id=100',
    'update pos_sales_receipts set is_canceled=true where id=100',
    "update pos_sales_receipts set business_date=business_date-1 where id=100",
    "update pos_sales_receipts set raw_json=jsonb_set(raw_json,'{OrderId}','\"changed-order\"') where id=100",
    "update pos_sales_receipts set raw_json=jsonb_set(raw_json,'{TableName}','\"BAR8\"') where id=100",
    'update pos_sales_receipts set total_amount=200000 where id=100',
    'update pos_sales_receipts set final_amount=200000 where id=100',
    "update pos_sales_receipt_lines set item_id='new-item' where id=1",
    "update pos_sales_receipt_lines set item_name='Changed' where id=1",
    'update pos_sales_receipt_lines set quantity=2 where id=1',
    'update pos_sales_receipt_lines set unit_price=200000 where id=1',
    'update pos_sales_receipt_lines set final_amount=200000 where id=1',
    "update pos_sales_receipt_lines set raw_json=jsonb_set(raw_json,'{Nested,Amount}','200000') where id=1",
   ];
   await db.query('begin');
   for(const sql of queries){await db.query('savepoint important');await db.query(sql);
    const after=await context(db,day);assert.ok(!after.cleanedTableIds.includes(tableId),sql);await assert.rejects(confirm(db,day,c),/stale/);
    await db.query('rollback to savepoint important');
   }await db.query('rollback');
   assert.ok((await context(db,day)).cleanedTableIds.includes(tableId));
   await db.exec('update pos_sales_receipt_lines set id=99 where id=1');
   assert.equal((await context(db,day)).receipts[0].version,c.receipts[0].version,'surrogate line id does not change business content');
  });
  await scenario('bounded load: 500 receipts / 2496 lines, coherent reads while writers proceed',async({db,a,b,day})=>{
   await db.exec(`update table_operations_private.config set enabled=false;
    insert into pos_sales_receipts(id,source,branch_id,business_date,payment_status,is_canceled,total_amount,final_amount,ref_date,raw_json)
     select 1000+n,source,branch_id,business_date,3,false,500,500,ref_date,jsonb_build_object('OrderId','load-'||n,'TableName','BAR4')
     from pos_sales_receipts cross join generate_series(1,499) n where id=100;
    insert into pos_sales_receipt_lines(id,receipt_id,source,item_name,quantity,final_amount,is_canceled,raw_json)
     select 10000+n*10+j,1000+n,'cukcuk','Synthetic',1,100,false,jsonb_build_object('Quantity',1,'Amount',100,'ModifiedDate','metadata')
     from generate_series(1,499) n cross join generate_series(1,5) j;
    update table_operations_private.config set enabled=true;analyze pos_sales_receipts;analyze pos_sales_receipt_lines;`);
   const times=[];for(let i=0;i<5;i++){const start=performance.now();const ctx=await context(a,day);assert.equal(ctx.receipts.length,500);times.push(performance.now()-start);}
   const pending=context(a,day);const writeStart=performance.now();await b.query('update pos_sales_receipts set synced_at=clock_timestamp() where id=100');const writerMs=performance.now()-writeStart;await pending;
   metrics.push({case:'500-receipts-2496-lines',readMs:times,writerMs,writerAndConcurrentReadMs:performance.now()-writeStart});
  });
  await t.test('Preflight/Postflight, untouched v3/data, emergency stop and recover',{timeout:30000},async()=>{
   const db=new runtime.Database();await db.ready;let hashes,dataHashes,preflightV3;
   const sourceHashes=async()=>({receipts:(await db.query("select md5(coalesce(string_agg(to_jsonb(r)::text,',' order by id),'')) h from pos_sales_receipts r")).rows,
    lines:(await db.query("select md5(coalesce(string_agg(to_jsonb(l)::text,',' order by id),'')) h from pos_sales_receipt_lines l")).rows});
   try{
    const day=await installCleaningFixture(db,{beforeCleaning:async()=>{
     const pre=(await db.query(PREFLIGHT)).rows;assert.ok(pre.every(r=>r.pass),JSON.stringify(pre));
     preflightV3=pre[0].v3_function_hashes;
     await db.query(`insert into pos_sales_receipts(id,source,branch_id,business_date,payment_status,is_canceled,total_amount,final_amount,ref_no,ref_date,raw_json)
      values(200,'cukcuk',split_part($1,':',2),public.store_business_date_for_timestamp_v1(clock_timestamp()),3,false,12345,12345,'synthetic-ledger',clock_timestamp()-interval '1 minute','{"OrderId":"preserved-ledger","TableName":"BAR1"}');`,[scope]);
     await db.exec("insert into pos_sales_receipt_lines(id,receipt_id,source,item_name,quantity,final_amount,is_canceled) values(200,200,'cukcuk','Preserved',1,12345,false)");
     hashes=(await db.query(FUNCTION_HASHES)).rows;dataHashes=await sourceHashes();
    },afterCleaning:async()=>{assert.deepEqual((await db.query(FUNCTION_HASHES)).rows,hashes);assert.deepEqual(await sourceHashes(),dataHashes);}});
    await db.exec("insert into supabase_migrations.schema_migrations(version,name) values('20261115103656','tables_cleaning_v1')");
    const post=(await db.query(POSTFLIGHT)).rows;assert.ok(post.every(r=>r.pass),JSON.stringify(post));
    assert.deepEqual(post[0].v3_function_hashes,preflightV3);
    assert.ok((await db.query(PREFLIGHT)).rows.some(r=>!r.pass),'preflight rejects reapplication/repair');
    await db.exec('update table_operations_private.config set enabled=true');const c=await context(db,day);await confirm(db,day,c);
    await db.exec(STOP);assert.deepEqual(await context(db,day),{enabled:false});
    await db.exec(EMERGENCY);await addOrder(db,day);await db.exec('delete from pos_open_orders_private.orders');
    await db.exec(RECOVER);assert.ok((await db.query(POSTFLIGHT)).rows.every(r=>r.pass));
    await db.exec('update table_operations_private.config set enabled=true');assert.ok(!(await context(db,day)).cleanedTableIds.includes(tableId));
    assert.deepEqual((await db.query(FUNCTION_HASHES)).rows,hashes);
    for(const actorId of [0,999])await assert.rejects(confirm(db,day,await context(db,day),{actorId}),/forbidden/);
    const fresh=await context(db,day);
    await assert.rejects(confirm(db,day,fresh,{id:'00000000-0000-4000-8000-000000000999'}),/stale/);
    await assert.rejects(confirm(db,day,{...fresh,keys:{...fresh.keys,[tableId]:{...fresh.keys[tableId],receiptId:999}}}),/stale/);
    await confirm(db,day,fresh,{requestId:'00000000-0000-4000-8000-000000000004'});
    await assert.rejects(confirm(db,day,fresh,{requestId:'00000000-0000-4000-8000-000000000004',actorId:2}),/request_conflict/);
    const dates=(await db.query("select public.store_business_date_for_timestamp_v1('2026-11-15T02:59:59+07:00')::text a,public.store_business_date_for_timestamp_v1('2026-11-15T03:00:00+07:00')::text b")).rows[0];
    assert.deepEqual(dates,{a:'2026-11-14',b:'2026-11-15'});
    await db.exec('set role anon');await assert.rejects(context(db,day),/permission denied/);await db.exec('reset role');
    metrics.push({case:'preflight-postflight-stop-recover',preflight:true,postflight:true,v3Unchanged:true,sourceDataUnchangedByMigration:true});
   }finally{await db.close();}
  });
 }finally{writeFileSync(path.join(root,process.env.QA_EVIDENCE_PHASE==='red'?'red-metrics.json':'green-metrics.json'),JSON.stringify(metrics,null,2));process.chdir(cwd);}
});
