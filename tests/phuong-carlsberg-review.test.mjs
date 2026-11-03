import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';

// Synthetic in-memory fixture ONLY. No env, network or production credentials.
// Tests the one-off SQL, not a second allocation/rebuild implementation.
const sql=readFileSync('scripts/ledger/phuong-carlsberg-20261103-REVIEW-ONLY.sql','utf8');
const beforeDo=sql.slice(0,sql.indexOf('DO $correction$'));
const migration=name=>readFileSync(`supabase/migrations/${name}`,'utf8');
const take=(text,start)=>{const i=text.indexOf(start);assert.ok(i>=0,start);return text.slice(i,text.indexOf('end$$;',i)+7);};
async function fixture(){
 const db=new PGlite();
 await db.exec(`
 CREATE TABLE users(id bigint PRIMARY KEY,role text,is_active boolean,app_login_enabled boolean);
 INSERT INTO users VALUES(1,'owner',true,true);
 CREATE TABLE ledger_parties(id bigint PRIMARY KEY,name text,type text,is_active boolean);
 INSERT INTO ledger_parties VALUES(10,'Carlsberg','supplier',true),(20,'Phương','supplier',true);
 CREATE TABLE ledger_transactions(id bigint PRIMARY KEY,party_id bigint,type text,business_date date,
   amount numeric,status text,recognition_month date,source_snapshot jsonb DEFAULT '{}',memo text);
 CREATE TABLE ledger_fund_accounts(id bigint PRIMARY KEY,code text);
 INSERT INTO ledger_fund_accounts VALUES(2,'baba_corporate_bank');
 CREATE TABLE ledger_movements(id bigint PRIMARY KEY,transaction_id bigint,fund_account_id bigint,amount numeric);
 CREATE TABLE inventory_logs(id bigint PRIMARY KEY,new_purchase_price numeric);
 INSERT INTO inventory_logs VALUES(1,936000);
 CREATE TABLE ledger_month_closures(month date PRIMARY KEY,status text,revision integer);
 INSERT INTO ledger_month_closures VALUES('2026-08-01','reopened',4),('2026-09-01','reopened',4);
 CREATE TABLE ledger_month_closure_history(id bigint PRIMARY KEY,month date,revision integer,snapshot_hash text);
 INSERT INTO ledger_month_closure_history SELECT i,'2026-08-01',i,'original' FROM generate_series(1,4) i;
 CREATE TABLE ledger_audit_logs(id bigserial PRIMARY KEY,actor_user_id bigint,action text,entity_type text,
   entity_id bigint,before_snapshot jsonb,after_snapshot jsonb,reason text);
 INSERT INTO ledger_audit_logs(action,before_snapshot) VALUES('historical','{"keep":true}');
 `);
 const purchase=migration('202608210003_add_inventory_purchase_candidates.sql');
 await db.exec(purchase.slice(purchase.indexOf('create table public.ledger_payables('),purchase.indexOf('alter table public.ledger_inventory_category_mappings enable')));
 const requests=migration('20261018105936_add_payable_payment_idempotency_v2.sql');
 await db.exec(requests.slice(requests.indexOf('create table public.ledger_payable_payment_requests'),requests.indexOf('alter table public.ledger_payable_payment_requests')));
 // Use repository month guard bodies, which distinguish closed from reopened.
 const guard=migration('202608210008_add_ledger_month_close_corrections.sql');
 await db.exec(guard.slice(guard.indexOf('create or replace function public.ledger_month_is_closed_v1'),
   guard.indexOf('create or replace function public.ledger_transaction_month_guard_v1')));
 for(const fn of ['ledger_transaction_month_guard_v1','ledger_payable_allocation_month_guard_v1'])
   await db.exec(take(guard,`create or replace function public.${fn}`));
 await db.exec(`CREATE TRIGGER tx_guard BEFORE UPDATE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION ledger_transaction_month_guard_v1();
 CREATE TRIGGER alloc_guard BEFORE DELETE ON ledger_payable_allocations FOR EACH ROW EXECUTE FUNCTION ledger_payable_allocation_month_guard_v1();
 INSERT INTO ledger_transactions(id,party_id,type,business_date,amount,status) VALUES
 (1641,10,'payable_payment','2026-09-17',19992000,'confirmed'),
 (1638,20,'payable_payment','2026-09-01',10362000,'confirmed'),
 (1796,NULL,'balance_adjustment','2026-09-02',24464000,'confirmed'),
 (1797,NULL,'balance_adjustment','2026-09-17',16940000,'confirmed'),
 (2399,20,'payable_payment','2026-10-03',18504000,'confirmed'),
 (3336,20,'payable_payment','2026-10-20',21900000,'confirmed'),
 (3337,10,'payable_payment','2026-10-20',21450000,'confirmed'),
 (3582,20,'payable_payment','2026-10-31',20724000,'confirmed'),
 (9999,10,'payable_payment','2026-10-01',26103084,'confirmed');
 INSERT INTO ledger_movements SELECT id,id,2,-amount FROM ledger_transactions;
 INSERT INTO ledger_payable_payment_requests(request_id,actor_user_id,request_payload,result,payment_transaction_id)
 VALUES('11111111-1111-4111-8111-111111111111',1,'{"partyId":10,"keep":936000}','{"original":true}',1641);
 INSERT INTO ledger_transactions(id,party_id,type,business_date,recognition_month,amount,status)
 SELECT 10000+i,CASE WHEN i=19 THEN 20 ELSE 10 END,'expense','2026-08-31','2026-08-01',
 CASE WHEN i<12 THEN 1000000 WHEN i=12 THEN 8992000 WHEN i<18 THEN 1000000
   WHEN i=18 THEN 4587992 WHEN i=19 THEN 3170000 WHEN i=20 THEN 10362000
   WHEN i=302 THEN 26102803 ELSE 1 END,'confirmed' FROM generate_series(1,302) i;
 INSERT INTO ledger_payables(id,expense_transaction_id,party_id,original_amount,status)
 SELECT CASE WHEN id=10019 THEN 388 ELSE id-10000 END,id,party_id,amount,'paid'
 FROM ledger_transactions WHERE id>10000;
 INSERT INTO ledger_payable_allocations(id,payable_id,payment_transaction_id,allocated_amount)
 SELECT id,CASE WHEN id=19 THEN 388 ELSE id END,
 CASE WHEN id<=12 THEN 1641 WHEN id<=18 THEN 3337 WHEN id=19 THEN 2399 WHEN id=20 THEN 1638 ELSE 9999 END,
 amount FROM (SELECT id-10000 id,amount FROM ledger_transactions WHERE id>10000) e;
 `);
 return db;
}
async function baseline(db){await db.exec(beforeDo);const {rows}=await db.query('select snapshot from pc_review_baseline');await db.exec('rollback');return rows[0].snapshot;}
function populated(snapshot,{commit=false}={}){
 const value=JSON.stringify(snapshot).replaceAll("'","''");
 return sql.replace('expected_baseline constant jsonb := NULL',`expected_baseline constant jsonb := '${value}'::jsonb`)
   .replace('actor_user_id constant bigint := NULL','actor_user_id constant bigint := 1')
   .replace(/ROLLBACK;\s*$/,commit?'COMMIT;':'ROLLBACK;');
}
test('review-only correction: gates, preservation and exact release',async t=>{
 const db=await fixture();t.after(()=>db.close());
 await db.exec(readFileSync('scripts/ledger/phuong-carlsberg-20261103-preflight-READONLY.sql','utf8'));
 const snap=await baseline(db);
 assert.equal(Number(snap.augustRows),302);assert.equal(Number(snap.augustAmount),69215076);
 await t.test('unfilled proposal fails closed',async()=>{
   await assert.rejects(db.exec(sql),/PC_REVIEW_BLOCKED/);await db.exec('rollback');
 });
 await t.test('independent stale baseline fails closed',async()=>{
   await assert.rejects(db.exec(populated({...snap,augustFingerprint:'stale'})),/PC_APPROVED_BASELINE_STALE/);await db.exec('rollback');
 });
 await t.test('successful review still rolls back',async()=>{
   await db.exec(populated(snap));assert.deepEqual(await baseline(db),snap);
 });
 await t.test('applied rebuild blocks correction',async()=>{
   await db.exec("create schema baba_august_rebuild_private; create table baba_august_rebuild_private.runs(status text); insert into baba_august_rebuild_private.runs values('applied')");
   await assert.rejects(db.exec(populated(snap)),/PC_REBUILD_ALREADY_ACTIVE/);await db.exec('rollback');
   await db.exec('drop schema baba_august_rebuild_private cascade');
 });
 await t.test('postwrite preservation failure rolls back earlier writes',async()=>{
   await db.exec(`CREATE FUNCTION fixture_corruption() RETURNS trigger LANGUAGE plpgsql AS $$begin
     UPDATE ledger_movements SET amount=amount-1 WHERE transaction_id=1641; RETURN NEW; end$$;
     CREATE TRIGGER fixture_corruption AFTER UPDATE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION fixture_corruption();`);
   await assert.rejects(db.exec(populated(snap)),/PC_PROTECTED_ROWS_CHANGED:ledger_movements/);await db.exec('rollback');
   assert.deepEqual(await baseline(db),snap);
   await db.exec('DROP TRIGGER fixture_corruption ON ledger_transactions; DROP FUNCTION fixture_corruption()');
 });
 await t.test('isolated execution copy releases exactly twelve and audits originals',async()=>{
   await db.exec(populated(snap,{commit:true}));
   const after=await baseline(db);
   assert.equal(Number(after.augustRows),290);assert.equal(Number(after.augustAmount),49223076);
   assert.equal(Number(after.payments.find(x=>x.id===1641).party_id),20);
   assert.equal(after.allocations.filter(x=>x.payment_transaction_id===1641).length,0);
   for(const id of [1638,1796,1797,2399,3336,3337,3582])
     assert.deepEqual(after.allocations.filter(x=>x.payment_transaction_id===id),snap.allocations.filter(x=>x.payment_transaction_id===id));
   assert.deepEqual(after.payables.find(x=>x.id===388),snap.payables.find(x=>x.id===388));
   const audit=(await db.query("select * from ledger_audit_logs where entity_id=1641")).rows;
   assert.equal(audit.length,1);assert.equal(audit[0].before_snapshot.allocations.length,12);
   assert.equal(audit[0].after_snapshot.unallocated,19992000);
   const request=(await db.query('select request_payload,result from ledger_payable_payment_requests')).rows[0];
   assert.deepEqual(request,{request_payload:{partyId:10,keep:936000},result:{original:true}});
   await assert.rejects(db.exec(populated(snap)),/PC_APPROVED_BASELINE_STALE/);await db.exec('rollback');
 });
});
