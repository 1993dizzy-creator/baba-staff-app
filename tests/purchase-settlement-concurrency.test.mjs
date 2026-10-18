// Explicit local PostgreSQL only. Never loads .env or accepts a server URL.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,writeFileSync} from 'node:fs';
import pg from 'pg';
import {database} from './helpers/inventory-ledger-fixture.mjs';
const port=Number(process.env.SETTLEMENT_TEST_PG_PORT);
test('native PostgreSQL: parallel full settlement, stale retry, paid writeoff, month guards and partial retry audit',{skip:!port},async()=>{
 assert.ok(Number.isInteger(port)&&port>1024&&port<65536);
 const config={host:'127.0.0.1',port,user:'postgres',database:'postgres'},admin=new pg.Client(config);await admin.connect();
 const name='settlement_test_'+Date.now(),clients=[];await admin.query('create database '+name);
 try{
  const connect=async()=>{const c=new pg.Client({...config,database:name});await c.connect();await c.query("set statement_timeout='10s';set deadlock_timeout='200ms'");clients.push(c);return c};
  const setup=await connect(),a=await connect(),b=await connect();
  class Adapter{async exec(sql){return setup.query(sql)}async query(sql,args){return setup.query(sql,args)}}
  await database(Adapter);
  await setup.query(readFileSync('supabase/migrations/202608210004_add_ledger_payable_payments.sql','utf8'));
  const root=async amount=>{const t=(await setup.query("insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,status,source_type,created_by,confirmed_by) values(gen_random_uuid(),'expense','2026-10-05T12:00:00+07:00','2026-10-05','2026-10-01',$1,4,10,'confirmed','manual',2,2) returning id",[amount])).rows[0];return (await setup.query('insert into ledger_payables(expense_transaction_id,party_id,original_amount,status) values($1,10,$2,\'unpaid\') returning id,expense_transaction_id',[t.id,amount])).rows[0]};
  const pay=async(c,p,amount)=>(await c.query("select ledger_pay_payables_v1(10,1,'2026-10-05T12:00:00+07:00',$1,$2::jsonb,'isolated test',2) as result",[amount,JSON.stringify([{payableId:Number(p.id),allocatedAmount:amount}])])).rows[0].result;
  for(let n=0;n<10;n++){const p=await root(76300);const results=await Promise.all([pay(a,p,76300),pay(b,p,76300)]);assert.equal(results.filter(r=>r.status==='paid').length,1);assert.equal((await pay(a,p,76300)).status,'invalid_allocation');const paid=(await setup.query('select sum(allocated_amount) as amount,count(*) as count from ledger_payable_allocations where payable_id=$1',[p.id])).rows[0];assert.equal(Number(paid.amount),76300);assert.equal(Number(paid.count),1);}
  const p=await root(49500);assert.equal((await pay(a,p,49000)).status,'paid');
  const snapshot={nonCash:true,cashMovementAmount:0,adjustmentType:'payable_small_difference_writeoff',payableId:Number(p.id),originalTransactionId:Number(p.expense_transaction_id),originalAmount:49500,writeoffAmount:500,actualPaidAmount:49000};
  const correction=(await setup.query("insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,economic_effect_sign,category_id,party_id,status,source_type,source_key,source_snapshot,created_by,confirmed_by) values(gen_random_uuid(),'expense','2026-10-05T12:00:00+07:00','2026-10-05','2026-10-01',500,-1,4,10,'confirmed','ledger_correction',$1,$2,2,2) returning id",['payable-small-diff:2026-10:'+p.id,snapshot])).rows[0];
  await setup.query('insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values($1,$2,500)',[p.id,correction.id]);await setup.query("update ledger_payables set status='paid' where id=$1",[p.id]);
  assert.equal((await pay(a,p,500)).status,'invalid_allocation');assert.equal(Number((await setup.query('select count(*) from ledger_movements where transaction_id=$1',[correction.id])).rows[0].count),0);
  // Record the existing RPC limitation; this change adds no new write path.
  const partial=await root(40000);assert.equal((await pay(a,partial,1000)).status,'paid');assert.equal((await pay(a,partial,1000)).status,'paid');
  assert.equal(Number((await setup.query('select sum(allocated_amount) as amount from ledger_payable_allocations where payable_id=$1',[partial.id])).rows[0].amount),2000);
  const closed=await root(40000);await setup.query("insert into ledger_month_closures(month,status) values('2026-10-01','closed')");
  const countBefore=Number((await setup.query('select count(*) from ledger_movements')).rows[0].count);
  await assert.rejects(()=>pay(a,closed,40000),/MONTH|closed|마감/i);assert.equal(Number((await setup.query('select count(*) from ledger_movements')).rows[0].count),countBefore);
  const report={server:(await setup.query('show server_version')).rows[0].server_version,parallelRounds:10,doubleFullPayments:0,staleFullRetriesBlocked:true,nonCashMovementCount:0,monthCloseBlocked:true,existingPartialRetryIsNotIdempotent:true};
  writeFileSync('.qa-review/october-settlement/native-concurrency.json',JSON.stringify(report,null,2));console.log(report);
 }finally{for(const c of clients)await c.end();await admin.query('drop database '+name);await admin.end();}
});
