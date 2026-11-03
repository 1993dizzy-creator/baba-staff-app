import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';

// Synthetic accounting examples only: candidate IDs are provided, individual
// amounts/items below are invented. This never reads env or opens a connection.
const sql=readFileSync('scripts/ledger/phuong-chain-20261103-REVIEW-ONLY.sql','utf8');
const prefix=sql.slice(0,sql.indexOf('DO $chain$'));
const migration=n=>readFileSync(`supabase/migrations/${n}`,'utf8');
const extract=(s,start)=>{const i=s.indexOf(start);assert.ok(i>=0);return s.slice(i,s.indexOf('end$$;',i)+7);};
async function snapshot(db){await db.exec(prefix);const v=(await db.query('select snapshot from pc_chain_snapshot')).rows[0].snapshot;await db.exec('rollback');return v;}
function review(baseline,invoices,{commit=false}={}){
 const quote=x=>"'"+JSON.stringify(x).replaceAll("'","''")+"'::jsonb";
 return sql.replace('approved_baseline constant jsonb := NULL',`approved_baseline constant jsonb := ${quote(baseline)}`)
   .replace('approved_invoice_rows constant jsonb := NULL',`approved_invoice_rows constant jsonb := ${quote(invoices)}`)
   .replace('actor_user_id constant bigint := NULL','actor_user_id constant bigint := 1')
   .replace(/ROLLBACK;\s*$/,commit?'COMMIT;':'ROLLBACK;');
}
async function fixture(){
 const db=new PGlite();
 await db.exec(`CREATE TABLE users(id bigint PRIMARY KEY,role text,is_active boolean,app_login_enabled boolean);
 INSERT INTO users VALUES(1,'owner',true,true);
 CREATE TABLE ledger_parties(id bigint PRIMARY KEY,name text,type text,is_active boolean);
 INSERT INTO ledger_parties VALUES(10,'Carlsberg','supplier',true),(20,'Phương','supplier',true);
 CREATE TABLE ledger_transactions(id bigint PRIMARY KEY,party_id bigint,type text,business_date date,amount numeric,status text,
 recognition_month date,source_snapshot jsonb DEFAULT '{}');
 CREATE TABLE ledger_fund_accounts(id bigint PRIMARY KEY,code text);
 INSERT INTO ledger_fund_accounts VALUES(2,'baba_corporate_bank');
 CREATE TABLE ledger_movements(id bigint PRIMARY KEY,transaction_id bigint,fund_account_id bigint,amount numeric);
 CREATE TABLE inventory_logs(id bigint PRIMARY KEY,new_purchase_price numeric);
 INSERT INTO inventory_logs VALUES(1,936000),(2,360000);
 CREATE TABLE ledger_month_closures(month date PRIMARY KEY,status text,revision integer);
 INSERT INTO ledger_month_closures VALUES('2026-08-01','reopened',4),('2026-09-01','reopened',4);
 CREATE TABLE ledger_month_closure_history(id bigint PRIMARY KEY,month date,revision integer,snapshot_hash text);
 INSERT INTO ledger_month_closure_history VALUES(1,'2026-08-01',4,'keep'),(2,'2026-09-01',4,'keep');
 CREATE TABLE ledger_audit_logs(id bigserial PRIMARY KEY,actor_user_id bigint,action text,entity_type text,
 entity_id bigint,before_snapshot jsonb,after_snapshot jsonb,reason text);
 INSERT INTO ledger_audit_logs(action,entity_type,entity_id,before_snapshot) VALUES('historical','transaction',1641,'{"keep":true}');`);
 const purchases=migration('202608210003_add_inventory_purchase_candidates.sql');
 await db.exec(purchases.slice(purchases.indexOf('create table public.ledger_payables('),purchases.indexOf('alter table public.ledger_inventory_category_mappings enable')));
 const requests=migration('20261018105936_add_payable_payment_idempotency_v2.sql');
 await db.exec(requests.slice(requests.indexOf('create table public.ledger_payable_payment_requests'),requests.indexOf('alter table public.ledger_payable_payment_requests')));
 const guards=migration('202608210008_add_ledger_month_close_corrections.sql');
 await db.exec(guards.slice(guards.indexOf('create or replace function public.ledger_month_is_closed_v1'),guards.indexOf('create or replace function public.ledger_transaction_month_guard_v1')));
 for(const fn of ['ledger_transaction_month_guard_v1','ledger_payable_allocation_month_guard_v1'])
   await db.exec(extract(guards,`create or replace function public.${fn}`));
 await db.exec(`CREATE TRIGGER tx_guard BEFORE UPDATE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION ledger_transaction_month_guard_v1();
 CREATE TRIGGER alloc_guard BEFORE INSERT OR UPDATE OR DELETE ON ledger_payable_allocations FOR EACH ROW EXECUTE FUNCTION ledger_payable_allocation_month_guard_v1();
 INSERT INTO ledger_transactions(id,party_id,type,business_date,amount,status) VALUES
 (1641,10,'payable_payment','2026-09-17',19992000,'confirmed'),(1638,20,'payable_payment','2026-09-01',10362000,'confirmed'),
 (1796,NULL,'balance_adjustment','2026-09-02',24464000,'confirmed'),(1797,NULL,'balance_adjustment','2026-09-17',16940000,'confirmed'),
 (2399,20,'payable_payment','2026-10-03',18504000,'confirmed'),(3336,20,'payable_payment','2026-10-20',21900000,'confirmed'),
 (3337,10,'payable_payment','2026-10-20',21450000,'confirmed'),(3582,20,'payable_payment','2026-10-31',20724000,'confirmed'),
 (9999,10,'payable_payment','2026-10-01',26103084,'confirmed');
 INSERT INTO ledger_movements SELECT id,id,2,-amount FROM ledger_transactions;
 INSERT INTO ledger_payable_payment_requests(request_id,actor_user_id,request_payload,result,payment_transaction_id)
 VALUES('11111111-1111-4111-8111-111111111111',1,'{"partyId":10,"keep":936000}','{"original":true}',1641);`);
 // Seed original 302 August allocations; candidate IDs deliberately do not
 // overlap these synthetic Carlsberg/other payables.
 await db.exec(`INSERT INTO ledger_transactions(id,party_id,type,business_date,recognition_month,amount,status)
 SELECT 20000+i,CASE WHEN i IN(19,20) THEN 20 ELSE 10 END,'expense','2026-08-31','2026-08-01',
 CASE WHEN i<12 THEN 1000000 WHEN i=12 THEN 8992000 WHEN i<18 THEN 1000000 WHEN i=18 THEN 4587992
 WHEN i=19 THEN 3170000 WHEN i=20 THEN 10362000 WHEN i=302 THEN 26102803 ELSE 1 END,'confirmed' FROM generate_series(1,302) i;
 INSERT INTO ledger_payables(id,expense_transaction_id,party_id,original_amount,status)
 SELECT CASE WHEN id=20019 THEN 388 ELSE id END,id,party_id,amount,'paid' FROM ledger_transactions WHERE id>20000;
 INSERT INTO ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount)
 SELECT CASE WHEN id=20019 THEN 388 ELSE id END,CASE WHEN id<=20012 THEN 1641 WHEN id<=20018 THEN 3337
 WHEN id=20019 THEN 2399 WHEN id=20020 THEN 1638 ELSE 9999 END,amount FROM ledger_transactions WHERE id>20000;`);
 await db.exec(prefix);
 const targetRows=(await db.query('select * from pc_chain_targets order by payment_id,payable_id')).rows;
 await db.exec('rollback');
 const invoices=[];const amounts=new Map();
 for(const payment of [1641,2399,3336,3582]){
   const group=targetRows.filter(x=>Number(x.payment_id)===payment);
   // Shape synthetic FIFO links to the handed-off counts 12/12/18/15.
   const total=Number(group[0].allocated),base=payment===1641?1530000:payment===3336?1500000:Math.floor(total/group.length);
   for(let i=0;i<group.length;i++){
     const r=group[i],id=Number(r.payable_id),amount=i===group.length-1?total-base*i:base;
     amounts.set(id,amount);
     await db.query(`insert into ledger_transactions(id,party_id,type,business_date,recognition_month,amount,status,source_snapshot)
       values($1,20,'expense',$2,date_trunc('month',$2::date),$3,'confirmed',$4)`,[30000+id,r.d1,amount,{inventory_log_id:1,fixtureInvoice:`TEST-${id}`,items:['synthetic only']}]);
     await db.query("insert into ledger_payables(id,expense_transaction_id,party_id,original_amount,status) values($1,$2,20,$3,'unpaid')",[id,30000+id,amount]);
     invoices.push({payableId:id,paymentId:payment,amount,invoiceReference:`TEST-${id}`,lineEvidence:'synthetic item verification ONLY'});
   }
 }
 // Existing FIFO chain: #2399 starts with #388; following payments spill forward.
 const ordered=invoices.filter(x=>x.paymentId!==3582).map(x=>({id:x.payableId,left:amounts.get(x.payableId)}));
 let cursor=0;
 for(const [payment,budget]of [[2399,15334000],[3336,21900000],[3582,20724000]]){
   let left=budget;
   while(left>0){const row=ordered[cursor],part=Math.min(left,row.left);
     await db.query('insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values($1,$2,$3)',[row.id,payment,part]);
     row.left-=part;left-=part;if(!row.left)cursor++;
   }
 }
 await db.exec(`UPDATE ledger_payable_allocations SET id=id+10000;
 WITH ranked AS (SELECT id,payment_transaction_id,row_number() OVER(PARTITION BY payment_transaction_id ORDER BY id) n
   FROM ledger_payable_allocations WHERE payment_transaction_id IN(1641,2399,3336,3582))
 UPDATE ledger_payable_allocations a SET id=CASE r.payment_transaction_id
   WHEN 1641 THEN 121 WHEN 2399 THEN 927 WHEN 3336 THEN 1268 WHEN 3582 THEN 1345 END+r.n
 FROM ranked r WHERE a.id=r.id;
 SELECT setval(pg_get_serial_sequence('ledger_payable_allocations','id'),(SELECT max(id) FROM ledger_payable_allocations));
 UPDATE ledger_payables p SET status=CASE WHEN a.paid=p.original_amount THEN 'paid'
 WHEN a.paid>0 THEN 'partially_paid' ELSE 'unpaid' END
 FROM (SELECT p.id,coalesce(sum(a.allocated_amount),0) paid FROM ledger_payables p LEFT JOIN ledger_payable_allocations a ON a.payable_id=p.id GROUP BY p.id) a WHERE p.id=a.id;`);
 return {db,invoices};
}
test('atomic Phuong chain review',async t=>{
 const {db,invoices}=await fixture();t.after(()=>db.close());
 await db.exec(readFileSync('scripts/ledger/phuong-chain-20261103-evidence-READONLY.sql','utf8'));
 const before=await snapshot(db);
 await t.test('missing approvals and incomplete/duplicate/mismatched invoice evidence block',async()=>{
   await assert.rejects(db.exec(sql),/CHAIN_REVIEW_BLOCKED/);await db.exec('rollback');
   for(const inv of [invoices.slice(1),invoices.map((r,i)=>i===0?invoices[1]:r),invoices.map((r,i)=>i===0?{...r,lineEvidence:''}:r)]){
     await assert.rejects(db.exec(review(before,inv)),/CHAIN_INVOICE_REVIEW_/);await db.exec('rollback');
   }
 });
 await t.test('stale baseline, altered candidate and foreign allocation block',async()=>{
   await assert.rejects(db.exec(review({...before,history:[]},invoices)),/CHAIN_BASELINE_STALE/);await db.exec('rollback');
   await db.exec('update ledger_payables set original_amount=original_amount+1 where id=679');
   await assert.rejects(db.exec(review(await snapshot(db),invoices)),/CHAIN_PERIOD_TOTAL_DRIFT/);await db.exec('rollback');
   await db.exec('update ledger_payables set original_amount=original_amount-1 where id=679');
   await db.exec('insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values(1278,9999,1)');
   await assert.rejects(db.exec(review(await snapshot(db),invoices)),/CHAIN_FOREIGN_PAYMENT_ON_CANDIDATE/);await db.exec('rollback');
   await db.exec('delete from ledger_payable_allocations where payable_id=1278 and payment_transaction_id=9999');
 });
 await t.test('rebuild applied and closed month block',async()=>{
   await db.exec("create schema baba_august_rebuild_private; create table baba_august_rebuild_private.runs(status text); insert into baba_august_rebuild_private.runs values('applied')");
   await assert.rejects(db.exec(review(before,invoices)),/CHAIN_REBUILD_ALREADY_ACTIVE/);await db.exec('rollback');
   await db.exec('drop schema baba_august_rebuild_private cascade');
   await db.exec("insert into ledger_month_closures values('2026-10-01','closed',1)");
   await assert.rejects(db.exec(review(await snapshot(db),invoices)),/LEDGER_MONTH_CLOSED/);await db.exec('rollback');
   await db.exec("delete from ledger_month_closures where month='2026-10-01'");
 });
 await t.test('postwrite movement corruption rolls back the entire chain',async()=>{
   await db.exec(`CREATE FUNCTION fixture_corruption() RETURNS trigger LANGUAGE plpgsql AS $$begin
     UPDATE ledger_movements SET amount=amount-1 WHERE transaction_id=1641; RETURN NEW; end$$;
     CREATE TRIGGER fixture_corruption AFTER UPDATE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION fixture_corruption();`);
   const b=await snapshot(db);
   await assert.rejects(db.exec(review(b,invoices)),/CHAIN_PROTECTED_SCOPE_CHANGED/);await db.exec('rollback');
   assert.deepEqual(await snapshot(db),b);
   await db.exec('drop trigger fixture_corruption on ledger_transactions; drop function fixture_corruption()');
 });
 await t.test('linked inventory cost corruption rolls back the entire chain',async()=>{
   await db.exec(`CREATE FUNCTION fixture_inventory_corruption() RETURNS trigger LANGUAGE plpgsql AS $$begin
     UPDATE inventory_logs SET new_purchase_price=1 WHERE id=1; RETURN NEW; end$$;
     CREATE TRIGGER fixture_inventory_corruption AFTER UPDATE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION fixture_inventory_corruption();`);
   const b=await snapshot(db);
   await assert.rejects(db.exec(review(b,invoices)),/CHAIN_PROTECTED_SCOPE_CHANGED/);await db.exec('rollback');
   assert.deepEqual(await snapshot(db),b);
   await db.exec('drop trigger fixture_inventory_corruption on ledger_transactions; drop function fixture_inventory_corruption()');
 });
 await t.test('audit insertion cannot rewrite historical audit rows',async()=>{
   await db.exec(`CREATE FUNCTION fixture_audit_corruption() RETURNS trigger LANGUAGE plpgsql AS $$begin
     UPDATE ledger_audit_logs SET reason='corruption' WHERE id=1; RETURN NEW; end$$;
     CREATE TRIGGER fixture_audit_corruption AFTER INSERT ON ledger_audit_logs FOR EACH ROW EXECUTE FUNCTION fixture_audit_corruption();`);
   const b=await snapshot(db);
   await assert.rejects(db.exec(review(b,invoices)),/CHAIN_AUDIT_SIDE_EFFECT/);await db.exec('rollback');
   assert.deepEqual(await snapshot(db),b);
   await db.exec('drop trigger fixture_audit_corruption on ledger_audit_logs; drop function fixture_audit_corruption()');
 });
 await t.test('successful review rolls back all changes',async()=>{
   await db.exec(review(before,invoices));assert.deepEqual(await snapshot(db),before);
 });
 await t.test('isolated commit: exact windows, residuals, stable IDs, cash, request and audit preservation',async()=>{
   const inventory=(await db.query('select * from inventory_logs order by id')).rows;
   await db.exec(review(before,invoices,{commit:true}));
   const after=await snapshot(db);
   assert.equal(after.augustSummary.count,289);assert.equal(Number(after.augustSummary.amount),46053076);
   for(const payment of [1641,2399,3336,3582]){
     const rows=after.allocations.filter(x=>x.payment_transaction_id===payment);
     assert.deepEqual(rows.map(x=>x.payable_id).sort((a,b)=>a-b),invoices.filter(x=>x.paymentId===payment).map(x=>x.payableId).sort((a,b)=>a-b));
     assert.equal(rows.reduce((s,x)=>s+Number(x.allocated_amount),0),payment===3582?19428000:before.transactions.find(x=>x.id===payment).amount);
   }
   assert.equal(after.payables.find(x=>x.id===388).status,'unpaid');
   for(const p of [1638,1796,1797,3337])assert.deepEqual(after.allocations.filter(x=>x.payment_transaction_id===p),before.allocations.filter(x=>x.payment_transaction_id===p));
   for(const old of before.allocations.filter(x=>[1641,2399,3336,3582].includes(x.payment_transaction_id))){
     const retained=after.allocations.find(x=>x.payable_id===old.payable_id&&x.payment_transaction_id===old.payment_transaction_id);
     if(retained)assert.equal(retained.id,old.id);
   }
   assert.deepEqual(after.movements,before.movements);assert.deepEqual(after.requests,before.requests);
   assert.deepEqual(after.history,before.history);assert.deepEqual((await db.query('select * from inventory_logs order by id')).rows,inventory);
   const audits=(await db.query("select * from ledger_audit_logs where action='payable_allocation_chain_corrected'")).rows;
   assert.equal(audits.length,1);assert.deepEqual(audits[0].before_snapshot.scope.allocations,before.allocations);
   assert.equal(audits[0].after_snapshot.unallocated3582,1296000);
   const phuongOpen=after.payables.filter(x=>x.party_id===20).reduce((s,p)=>s+Number(p.original_amount)-after.allocations.filter(a=>a.payable_id===p.id).reduce((s,a)=>s+Number(a.allocated_amount),0),0);
   const beforeOpen=before.payables.filter(x=>x.party_id===20).reduce((s,p)=>s+Number(p.original_amount)-before.allocations.filter(a=>a.payable_id===p.id).reduce((s,a)=>s+Number(a.allocated_amount),0),0);
   assert.equal(phuongOpen-beforeOpen,-18696000);assert.equal(phuongOpen,3170000);
   await assert.rejects(db.exec(review(before,invoices)),/CHAIN_BASELINE_STALE/);await db.exec('rollback');
 });
});
