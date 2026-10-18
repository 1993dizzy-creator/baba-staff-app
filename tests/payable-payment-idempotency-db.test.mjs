// Local loopback database only; never loads credentials or a remote URL.
import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import pg from 'pg';
import {database} from './helpers/inventory-ledger-fixture.mjs';
const port=Number(process.env.SETTLEMENT_TEST_PG_PORT);
test('isolated native PostgreSQL payment idempotency',{skip:!port},async t=>{
 assert.ok(Number.isInteger(port)&&port>1024&&port<65536);
 const config={host:'127.0.0.1',port,user:'postgres',database:'postgres'},admin=new pg.Client(config);await admin.connect();
 const name='payment_idempotency_'+Date.now(),clients=[];await admin.query('create database '+name);
 try{
  for(let i=0;i<13;i++){const c=new pg.Client({...config,database:name});await c.connect();await c.query("set statement_timeout='15s'");clients.push(c);}
  const [setup,...workers]=clients;
  class Adapter{async exec(sql){return setup.query(sql.replace(/create role (anon|authenticated|service_role);/g,(_,role)=>'do $$begin create role '+role+';exception when duplicate_object then null;end$$;'))}async query(sql,args){return setup.query(sql,args)}}
  await database(Adapter);await setup.query(readFileSync('supabase/migrations/202608210004_add_ledger_payable_payments.sql','utf8'));
  const definition=async()=>(await setup.query("select pg_get_functiondef('ledger_pay_payables_v1(bigint,bigint,timestamptz,numeric,jsonb,text,bigint)'::regprocedure) as definition")).rows[0].definition;
  const v1=await definition();await setup.query(readFileSync('supabase/migrations/20261018105936_add_payable_payment_idempotency_v2.sql','utf8'));
  const root=async(amount=40000)=>{const tx=(await setup.query("insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,status,source_type,created_by,confirmed_by) values(gen_random_uuid(),'expense','2026-10-05T12:00:00+07:00','2026-10-05','2026-10-01',$1,4,10,'confirmed','manual',2,2) returning id",[amount])).rows[0];return Number((await setup.query("insert into ledger_payables(expense_transaction_id,party_id,original_amount,status) values($1,10,$2,'unpaid') returning id",[tx.id,amount])).rows[0].id)};
  const body=(id,amount=1000)=>({party:10,account:1,date:'2026-10-05T12:00:00+07:00',amount,allocations:[{payableId:id,allocatedAmount:amount}],memo:'isolated payment',actor:2});
  const pay=async(c,key,b)=>(await c.query('select ledger_pay_payables_v2($1,$2,$3,$4,$5,$6::jsonb,$7,$8) as result',[key,b.party,b.account,b.date,b.amount,b.allocations===null?null:JSON.stringify(b.allocations),b.memo,b.actor])).rows[0].result;
  const totals=async()=>(await setup.query("select (select count(*) from ledger_transactions)::int as transactions,(select count(*) from ledger_movements)::int as movements,(select count(*) from ledger_payable_allocations)::int as allocations,(select count(*) from ledger_audit_logs)::int as audits,(select count(*) from ledger_payable_payment_requests)::int as requests")).rows[0];
  const remaining=async id=>Number((await setup.query('select p.original_amount-coalesce(sum(a.allocated_amount),0) as remaining from ledger_payables p left join ledger_payable_allocations a on a.payable_id=p.id where p.id=$1 group by p.id',[id])).rows[0].remaining);
  await t.test('V1 limitation reproduced; original definition/signature unchanged',async()=>{
   assert.equal(await definition(),v1);const id=await root();
   for(let i=0;i<2;i++)assert.equal((await setup.query("select ledger_pay_payables_v1(10,1,'2026-10-05T12:00:00+07:00',1000,$1,'legacy',2) as result",[JSON.stringify(body(id).allocations)])).rows[0].result.status,'paid');
   assert.equal(await remaining(id),38000);
  });
  await t.test('12 sequential retries yield one payment/movement/allocation/audit/request',async()=>{
   const b=body(await root()),key=randomUUID(),before=await totals(),first=await pay(workers[0],key,b);assert.equal(first.status,'paid');
   for(let i=0;i<12;i++)assert.deepEqual(await pay(workers[0],key,b),first);
   const after=await totals();for(const f of Object.keys(before))assert.equal(after[f]-before[f],1,f);assert.equal(await remaining(b.allocations[0].payableId),39000);
  });
  await t.test('12 concurrent sessions with same key produce exactly one result',async()=>{
   const b=body(await root()),key=randomUUID(),before=await totals(),results=await Promise.all(workers.map(c=>pay(c,key,b)));
   assert.equal(results[0].status,'paid');for(const r of results)assert.deepEqual(r,results[0]);const after=await totals();for(const f of Object.keys(before))assert.equal(after[f]-before[f],1,f);
  });
  await t.test('lost response after commit; old request after changed balance replays',async()=>{
   const id=await root(),b=body(id),key=randomUUID(),lost=await pay(workers[0],key,b);assert.equal((await pay(workers[1],randomUUID(),body(id,39000))).status,'paid');
   const before=await totals();assert.deepEqual(await pay(workers[2],key,b),lost);assert.equal(await remaining(id),0);assert.deepEqual(await totals(),before);
  });
  await t.test('same key changing amount/account/allocation/party/time/memo/actor conflicts',async()=>{
   const b=body(await root()),other=await root(),key=randomUUID();await pay(workers[0],key,b);await setup.query("insert into users values(4,'master',true,true)");const before=await totals();
   for(const change of [{amount:0},{amount:-1},{allocations:[{payableId:b.allocations[0].payableId,allocatedAmount:-1}]},{allocations:{bad:true}},{allocations:['bad']},{amount:2000},{account:2},{allocations:body(other).allocations},{party:11},{date:'2026-10-06T12:00:00+07:00'},{memo:'changed'},{actor:4}])assert.equal((await pay(workers[1],key,{...b,...change})).status,'idempotency_conflict');assert.deepEqual(await totals(),before);
  });
  await t.test('normalized numeric allocation order/timezone/memo replay',async()=>{
   const a=await root(),b=await root(),payload={...body(a,2000),allocations:[{payableId:a,allocatedAmount:1000},{payableId:b,allocatedAmount:1000}]},key=randomUUID(),first=await pay(workers[0],key,payload);assert.equal(first.status,'paid');
   assert.deepEqual(await pay(workers[1],key,{...payload,date:'2026-10-05T05:00:00Z',memo:' isolated payment ',allocations:[{payableId:String(b),allocatedAmount:'1000.000'},{payableId:String(a),allocatedAmount:'1000'}]}),first);
  });
  await t.test('12 distinct legitimate identical partial payments concurrently succeed',async()=>{
   const id=await root(),r=await Promise.all(workers.map(c=>pay(c,randomUUID(),body(id))));assert.equal(r.filter(x=>x.status==='paid').length,12);assert.equal(new Set(r.map(x=>x.paymentTransactionId)).size,12);assert.equal(await remaining(id),28000);
  });
  await t.test('distinct concurrent requests cannot overpay',async()=>{
   const id=await root(1500),r=await Promise.all(workers.map(c=>pay(c,randomUUID(),body(id))));assert.equal(r.filter(x=>x.status==='paid').length,1);assert.equal(await remaining(id),500);
  });
  await t.test('oldest-first retries keep original plan after new payables',async()=>{
   const b={...body(await root()),allocations:null},key=randomUUID(),first=await pay(workers[0],key,b);assert.equal(first.status,'paid');await root();assert.deepEqual(await pay(workers[1],key,b),first);
  });
  for(const table of ['ledger_movements','ledger_payable_allocations','ledger_audit_logs'])await t.test('injected '+table+' failure rolls back everything',async()=>{
   const id=await root(),b=body(id),key=randomUUID(),before=await totals();await setup.query('create function fixture_fail() returns trigger language plpgsql as $$begin raise exception \'INJECTED_FAILURE\';end$$;create trigger fixture_failure before insert on '+table+' for each row execute function fixture_fail()');
   await assert.rejects(()=>pay(workers[0],key,b),/INJECTED_FAILURE/);assert.deepEqual(await totals(),before);assert.equal(await remaining(id),40000);
   await setup.query('drop trigger fixture_failure on '+table+';drop function fixture_fail()');assert.equal((await pay(workers[1],key,b)).status,'paid');assert.equal(await remaining(id),39000);
  });
  await t.test('transaction abort immediately after RPC leaves no orphan records',async()=>{
   const b=body(await root()),key=randomUUID(),before=await totals();await workers[0].query('begin');await pay(workers[0],key,b);await workers[0].query('rollback');assert.deepEqual(await totals(),before);assert.equal((await pay(workers[1],key,b)).status,'paid');
  });
  await t.test('forbidden/inactive/deactivated replay actor is denied',async()=>{
   const b=body(await root()),key=randomUUID();await pay(workers[0],key,b);const before=await totals();for(const actor of [1,3,999])assert.equal((await pay(workers[1],key,{...b,actor})).status,'forbidden');
   await setup.query('update users set is_active=false where id=2');assert.equal((await pay(workers[1],key,b)).status,'forbidden');await setup.query('update users set is_active=true where id=2');assert.deepEqual(await totals(),before);
  });
  await t.test('RLS/grants: no direct table access; service_role-only RPC',async()=>{
   assert.equal((await setup.query("select relrowsecurity from pg_class where oid='ledger_payable_payment_requests'::regclass")).rows[0].relrowsecurity,true);
   for(const role of ['anon','authenticated','service_role']){await workers[0].query('set role '+role);await assert.rejects(()=>workers[0].query('select * from ledger_payable_payment_requests'),/permission denied/);if(role!=='service_role')await assert.rejects(()=>pay(workers[0],randomUUID(),body(1)),/permission denied/);await workers[0].query('reset role');}
   const id=await root();await workers[0].query('set role service_role');assert.equal((await pay(workers[0],randomUUID(),body(id))).status,'paid');await workers[0].query('reset role');
  });
  await t.test('missing key/negative/precision/nonfinite/duplicate allocations refuse writes',async()=>{
   const id=await root(),b=body(id),before=await totals();assert.equal((await pay(workers[0],null,b)).status,'idempotency_key_required');
   for(const amount of [0,-1,'NaN','Infinity','0.0001'])assert.equal((await pay(workers[0],randomUUID(),{...b,amount})).status,'invalid_amount');
   for(const allocatedAmount of [0,-1,'NaN','Infinity','0.0001'])assert.equal((await pay(workers[0],randomUUID(),{...b,allocations:[{payableId:id,allocatedAmount}]})).status,'invalid_allocations');
   assert.deepEqual(await totals(),before);assert.equal((await pay(workers[0],randomUUID(),{...b,allocations:[...b.allocations,...b.allocations]})).status,'duplicate_payable');assert.equal(await remaining(id),40000);
  });
  await t.test('same key concurrent different content: one success, one conflict',async()=>{
   const b=body(await root()),key=randomUUID(),r=await Promise.all([pay(workers[0],key,b),pay(workers[1],key,{...b,memo:'different'})]);assert.equal(r.filter(x=>x.status==='paid').length,1);assert.equal(r.filter(x=>x.status==='idempotency_conflict').length,1);
  });
  await t.test('legacy noncash writeoff stays paid and new payment is refused',async()=>{
   const id=await root(49500);assert.equal((await pay(workers[0],randomUUID(),body(id,49000))).status,'paid');
   const tx=(await setup.query("insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,economic_effect_sign,category_id,party_id,status,source_type,source_key,source_snapshot,created_by,confirmed_by) values(gen_random_uuid(),'expense','2026-10-05T12:00:00+07:00','2026-10-05','2026-10-01',500,-1,4,10,'confirmed','ledger_correction',$1,$2,2,2) returning id",['payable-small-diff:2026-10:'+id,JSON.stringify({nonCash:true,cashMovementAmount:0,adjustmentType:'payable_small_difference_writeoff',payableId:id,writeoffAmount:500})])).rows[0];
   await setup.query('insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values($1,$2,500)',[id,tx.id]);await setup.query("update ledger_payables set status='paid' where id=$1",[id]);
   assert.equal((await pay(workers[0],randomUUID(),body(id,500))).status,'invalid_allocation');assert.equal(await remaining(id),0);assert.equal(Number((await setup.query('select count(*) from ledger_movements where transaction_id=$1',[tx.id])).rows[0].count),0);
  });
  await t.test('incomplete existing records fail closed with no writes, including concurrent retries',async()=>{
   for(const broken of ["result=null","completed_at=null","result=null,completed_at=null","result='null'::jsonb","result='[]'::jsonb","result='{}'::jsonb","result='{\"status\":\"\"}'::jsonb"]){
    const id=await root(),b=body(id),key=randomUUID();assert.equal((await pay(workers[0],key,b)).status,'paid');
    await setup.query('update ledger_payable_payment_requests set '+broken+' where request_id=$1',[key]);
    const before=await totals(),record=(await setup.query('select * from ledger_payable_payment_requests where request_id=$1',[key])).rows[0];
    for(let i=0;i<12;i++)assert.equal((await pay(workers[0],key,b)).status,'idempotency_state_invalid');
    const r=await Promise.all(workers.map(c=>pay(c,key,b)));assert.ok(r.every(x=>x.status==='idempotency_state_invalid'));
    assert.deepEqual(await totals(),before);assert.equal(await remaining(id),39000);assert.deepEqual((await setup.query('select * from ledger_payable_payment_requests where request_id=$1',[key])).rows[0],record);
    assert.equal((await pay(workers[0],key,{...b,amount:2000})).status,'idempotency_conflict');
   }
  });
  await t.test('revoking direct V1 execution keeps V2 SECURITY DEFINER payments/retries/guards working',async()=>{
   const signature='ledger_pay_payables_v1(bigint,bigint,timestamptz,numeric,jsonb,text,bigint)';
   await setup.query('revoke execute on function '+signature+' from service_role');
   assert.equal((await setup.query("select has_function_privilege('service_role',$1,'EXECUTE') as allowed",[signature])).rows[0].allowed,false);
   const id=await root(),b=body(id),key=randomUUID(),before=await totals();
   await workers[0].query('set role service_role');
   try{
    await assert.rejects(()=>workers[0].query("select ledger_pay_payables_v1(10,1,'2026-10-05T12:00:00+07:00',1000,$1,'legacy',2)",[JSON.stringify(b.allocations)]),/permission denied/);
    const first=await pay(workers[0],key,b);assert.equal(first.status,'paid');assert.deepEqual(await pay(workers[0],key,b),first);
    assert.equal((await pay(workers[0],randomUUID(),{...b,actor:1})).status,'forbidden');
   }finally{await workers[0].query('reset role')}
   const after=await totals();for(const f of Object.keys(before))assert.equal(after[f]-before[f],1,f);assert.equal(await remaining(id),39000);
   await setup.query('grant execute on function '+signature+' to service_role');
  });
  await t.test('closed month blocks new writes; successful retry is read-only',async()=>{
   const b=body(await root()),key=randomUUID(),first=await pay(workers[0],key,b);await setup.query("insert into ledger_month_closures(month,status) values('2026-10-01','closed')");const before=await totals();
   assert.deepEqual(await pay(workers[0],key,b),first);await assert.rejects(()=>pay(workers[1],randomUUID(),b),/MONTH|closed|마감/i);assert.deepEqual(await totals(),before);
  });
  writeFileSync('.qa-review/october-settlement/idempotency-native.json',JSON.stringify({server:(await setup.query('show server_version')).rows[0].server_version,sequentialRetries:12,concurrentSameKeySessions:12,concurrentNormalPayments:12,totals:await totals()},null,2));
 }finally{for(const c of clients)await c.end();await admin.query('drop database '+name);await admin.end();}
});