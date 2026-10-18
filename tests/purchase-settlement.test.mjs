import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,existsSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {calculatePurchaseSettlement,isPayableNonCashAdjustment,payableDisplayAsOf,calculatePayableBalances} from '../lib/ledger/payables.ts';
const adjustment=(amount=500)=>({payable_id:1,allocated_amount:amount,payment:{id:91,type:'expense',status:'confirmed',business_date:'2026-10-08',amount,economic_effect_sign:-1,source_type:'ledger_correction',source_key:'payable-small-diff:2026-10:1',source_snapshot:{nonCash:true,cashMovementAmount:0,adjustmentType:'payable_small_difference_writeoff',payableId:1,originalTransactionId:11,originalAmount:49500,writeoffAmount:amount,actualPaidAmount:49000},movements:[],memo:'verified sheet difference'}});
const cash={payable_id:1,allocated_amount:49000,payment:{id:90,type:'payable_payment',status:'confirmed',business_date:'2026-10-08',movements:[{amount:-49000}]}};
test('one root: original + signed adjustment - cash, with no double allocation subtraction',()=>{
 const s=calculatePurchaseSettlement(49500,[cash,adjustment()],{payableId:1,transactionId:11});
 assert.equal(s.originalAmount,49500);assert.equal(s.adjustmentAmount,-500);assert.equal(s.effectiveAmount,49000);assert.equal(s.cashPaidAmount,49000);assert.equal(s.remainingAmount,0);assert.equal(s.status,'paid');assert.equal(s.adjustments.length,1);assert.equal(s.payments.length,1);
});
test('a noncash adjustment alone can settle without inventing a payment',()=>{
 const a=adjustment(49500);a.payment.source_snapshot.actualPaidAmount=0;
 const s=calculatePurchaseSettlement(49500,[a],{payableId:1,transactionId:11});assert.equal(s.cashPaidAmount,0);assert.equal(s.status,'paid');assert.equal(s.remainingAmount,0);assert.deepEqual(s.payments,[]);
});
test('size, memo or paid flag cannot classify an unverified difference as an adjustment',()=>{
 const good=adjustment();
 for(const mutate of [a=>a.payment.movements.push({amount:-1}),a=>a.payment.source_snapshot.nonCash=false,a=>a.payment.source_snapshot.originalTransactionId=99,a=>a.payment.source_snapshot.payableId=99,a=>a.payment.source_key='unverified',a=>a.payment.economic_effect_sign=1,a=>a.payment.source_snapshot.writeoffAmount=400]){
  const a=structuredClone(good);mutate(a);assert.equal(isPayableNonCashAdjustment(a,49500,{payableId:1,transactionId:11}),false);
 }
});
test('as-of month and party balance use net purchases and actual payments once',()=>{
 const a=adjustment();a.payment.business_date='2026-11-08';a.payment.source_key='payable-small-diff:2026-11:1';
 const october=payableDisplayAsOf(49500,[cash,a],'2026-10',{payableId:1,transactionId:11});assert.equal(october.remainingAmount,500);
 const november=payableDisplayAsOf(49500,[cash,a],'2026-11',{payableId:1,transactionId:11});assert.equal(november.remainingAmount,0);assert.equal(november.paidAmount,49000);
 const source={id:1,party_id:10,original_amount:49500,status:'paid',expense:{id:11,business_date:'2026-10-08',status:'confirmed'}};
 const b=calculatePayableBalances([source],[cash,adjustment()],'2026-10');assert.deepEqual(b.summary,{openingOutstanding:0,periodPurchases:49000,periodPayments:49000,closingOutstanding:0});
});
test('partial and unconfirmed purchases never get automatic writeoffs; repeat reads are immutable',()=>{
 const a={...cash,allocated_amount:23700},before=JSON.stringify(a);
 const source={id:1,party_id:10,original_amount:100000,status:'partially_paid',expense:{id:11,business_date:'2026-10-05',status:'confirmed'}};
 for(let i=0;i<10;i++){const s=calculatePurchaseSettlement(100000,[a]);assert.equal(s.remainingAmount,76300);assert.equal(s.adjustmentAmount,0);}
 assert.equal(JSON.stringify(a),before);assert.equal(calculatePayableBalances([source],[a],'2026-10').totalOutstanding,76300);
});
const fixture=process.env.SETTLEMENT_AUDIT_SNAPSHOT;
test('isolated SQL compares every active October root and all existing economic records',{skip:!fixture||!existsSync(fixture)},async()=>{
 const data=JSON.parse(readFileSync(fixture,'utf8')),db=new PGlite();
 try{
  await db.exec('create table transactions(id bigint primary key,type text,status text,business_date date,amount numeric,economic_effect_sign int,source_type text,source_snapshot jsonb);create table payables(id bigint primary key,expense_transaction_id bigint references transactions(id),original_amount numeric,status text);create table allocations(id bigint primary key,payable_id bigint references payables(id),payment_transaction_id bigint references transactions(id),allocated_amount numeric,unique(payable_id,payment_transaction_id));');
  await db.query('insert into transactions select * from jsonb_to_recordset($1::jsonb) as t(id bigint,type text,status text,business_date date,amount numeric,economic_effect_sign int,source_type text,source_snapshot jsonb)',[JSON.stringify(data.transactions)]);
  await db.query('insert into payables select * from jsonb_to_recordset($1::jsonb) as t(id bigint,expense_transaction_id bigint,original_amount numeric,status text)',[JSON.stringify(data.payables)]);
  await db.query('insert into allocations select * from jsonb_to_recordset($1::jsonb) as t(id bigint,payable_id bigint,payment_transaction_id bigint,allocated_amount numeric)',[JSON.stringify(data.allocations)]);
  const before=(await db.query('select md5(string_agg(row_to_json(t)::text,\',\' order by id)) as hash from transactions t')).rows[0].hash;
  const result=(await db.query(`select p.id,p.expense_transaction_id,p.original_amount,
   coalesce(sum(a.allocated_amount) filter(where t.status='confirmed' and t.type='expense' and t.source_type='ledger_correction' and t.source_snapshot->>'nonCash'='true'),0) as noncash,
   coalesce(sum(a.allocated_amount) filter(where t.status='confirmed' and not(t.type='expense' and t.source_type='ledger_correction' and t.source_snapshot->>'nonCash'='true')),0) as cash,
   greatest(0,p.original_amount-coalesce(sum(a.allocated_amount) filter(where t.status='confirmed'),0)) as remaining
   from payables p join transactions root on root.id=p.expense_transaction_id left join allocations a on a.payable_id=p.id left join transactions t on t.id=a.payment_transaction_id
   where root.business_date>='2026-10-01' and root.business_date<'2026-11-01' and root.status='confirmed' and p.status<>'cancelled' group by p.id order by p.id`)).rows;
  const tm=new Map(data.transactions.map(t=>[t.id,t]));
  for(const row of result){const allocations=data.allocations.filter(a=>a.payable_id===Number(row.id)).map(a=>({...a,payment:{...tm.get(a.payment_transaction_id),movements:data.movements.filter(m=>m.transaction_id===a.payment_transaction_id)}}));const s=calculatePurchaseSettlement(row.original_amount,allocations,{payableId:row.id,transactionId:row.expense_transaction_id});assert.equal(s.adjustmentAmount,Number(row.noncash)===0?0:-Number(row.noncash));assert.equal(s.cashPaidAmount,Number(row.cash));assert.equal(s.remainingAmount,Number(row.remaining));}
  assert.equal(result.length,402);const after=(await db.query('select md5(string_agg(row_to_json(t)::text,\',\' order by id)) as hash from transactions t')).rows[0].hash;assert.equal(before,after);
  console.log('PASS isolated SQL / application comparison',result.length,'active October payables; source hash unchanged');
 }finally{await db.close();}
});

test('numeric(16,3) remaining stays exact above integer-thousandth safe range',()=>{const s=calculatePurchaseSettlement('9007199254740.991',[{allocated_amount:'9007199254740.990',payment:{status:'confirmed',business_date:'2026-10-01'}}]);assert.equal(s.remainingAmount,0.001);assert.equal(s.status,'partial');});
