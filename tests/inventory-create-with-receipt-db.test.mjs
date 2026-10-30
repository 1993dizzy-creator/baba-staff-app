import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {billedFixture} from './helpers/inventory-billed-amount-fixture.mjs';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
const migration='supabase/migrations/20261030170000_inventory_create_with_receipt.sql';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
// Isolated database only: the 실청구금액 fixture plus the atomic create RPC. Production gives
// inventory.id an identity; the fixture table gets an equivalent default.
async function createFixture(Database){
 const db=await billedFixture(Database);
 await db.exec("create sequence fixture_inventory_id_seq start 500; alter table inventory alter column id set default nextval('fixture_inventory_id_seq')");
 await db.exec(readFileSync(migration,'utf8'));
 return db;
}
const orange={item_name:'오렌지',item_name_vi:'Cam',part:'kitchen',category:'Drinks',category_vi:'Nuoc',quantity:3.57,unit:'kg',
 purchase_price:85000,supplier:'Won Mart',supplier_partner_id:10,code:'OR',low_stock_threshold:2,low_stock_enabled:false,note:'시장',
 updated_at:'2000-01-01T00:00:00Z',updated_by_name:'client',updated_by_username:'client'};
const create=async(db,payload,reason='purchase',actor=1)=>(await one(db,'select inventory_create_with_receipt_v1($1::jsonb,$2,$3::date,$4) as r',
 [JSON.stringify(payload),reason,'2026-10-11',actor])).r;
const counts=async db=>(await one(db,`select (select count(*) from inventory)::int as items,(select count(*) from inventory_logs)::int as logs,
 (select count(*) from inventory_price_logs)::int as prices,(select count(*) from ledger_candidates)::int as candidates,
 (select count(*) from ledger_inventory_projection_status)::int as statuses`));

test('purchase registration writes item, create log, price history and projection together (orange, manual 303,000)',async()=>{
 const db=await createFixture();try{
  const r=await create(db,{...orange,billed_amount_mode:'manual',billed_amount:303000});
  assert.equal(r.status,'ok');assert.equal(r.item.item_name,'오렌지');assert.equal(Number(r.item.quantity),3.57);
  assert.equal(r.item.updated_by_name,'Session actor','actor metadata is server-side');assert.notEqual(r.item.updated_at,'2000-01-01T00:00:00+00:00');
  const log=await one(db,'select * from inventory_logs where id=$1',[r.inventoryLogId]);
  assert.equal(Number(log.item_id),Number(r.item.id));assert.equal(log.action,'create');assert.equal(log.source,'create');assert.equal(log.reason,'purchase');
  assert.equal(Number(log.change_quantity),3.57);assert.equal(Number(log.prev_quantity),0);assert.equal(Number(log.new_purchase_price),85000);
  assert.equal(log.new_supplier,'Won Mart');assert.equal(Number(log.purchase_supplier_partner_id),10);assert.equal(Number(log.source_actor_user_id),1);
  assert.equal(log.billed_amount_mode,'manual');assert.equal(Number(log.billed_amount),303000);assert.equal(String(log.business_date.toISOString?.()??log.business_date).slice(0,10),'2026-10-11');
  const price=await one(db,'select * from inventory_price_logs where item_id=$1',[r.item.id]);
  assert.equal(Number(price.new_price),85000);assert.equal(price.old_price,null);assert.equal(price.source,'create');assert.equal(price.reason,'create');
  assert.ok(r.ledgerSync,'projection ran in the same call');
  assert.ok(await one(db,'select * from ledger_inventory_projection_status where inventory_log_id=$1',[r.inventoryLogId]));
  const c=await one(db,'select * from ledger_candidates where source_key=$1 order by id desc limit 1',['inventory-log:'+r.inventoryLogId]);
  assert.equal(Number(c.proposed_amount),303000);assert.equal(Number(c.source_snapshot.calculated_amount),303450);
  // Auto: quantity x price, no billed snapshot keys.
  const auto=await create(db,{...orange,item_name:'사과',code:'AP',quantity:2,billed_amount_mode:'auto'});
  const ac=await one(db,'select * from ledger_candidates where source_key=$1 order by id desc limit 1',['inventory-log:'+auto.inventoryLogId]);
  assert.equal(Number(ac.proposed_amount),170000);assert.equal(ac.source_snapshot.billed_amount_mode,undefined);
 }finally{await db.close();}
});

test('existing stock registration: no projection and no billed state; zero quantity and no price are allowed',async()=>{
 const db=await createFixture();try{
  const r=await create(db,{...orange,quantity:0,purchase_price:null,billed_amount_mode:'auto'},'stock_check');
  assert.equal(r.status,'ok');assert.equal(r.ledgerSync,null);
  const log=await one(db,'select * from inventory_logs where id=$1',[r.inventoryLogId]);
  assert.equal(log.reason,'stock_check');assert.equal(log.billed_amount_mode,null);
  assert.equal(Number((await one(db,'select count(*) as n from inventory_price_logs where item_id=$1',[r.item.id])).n),0);
  assert.equal(await one(db,'select * from ledger_inventory_projection_status where inventory_log_id=$1',[r.inventoryLogId]),undefined);
 }finally{await db.close();}
});

test('refused input writes nothing: zero-rounding purchase, invalid billed, unknown keys, inactive actor',async()=>{
 const db=await createFixture();try{
  const before=await counts(db);
  for(const [payload,reason,status] of [
   [{...orange,quantity:0.004,billed_amount_mode:'manual',billed_amount:340},'purchase','purchase_quantity_must_increase'],
   [{...orange,quantity:0},'purchase','purchase_quantity_must_increase'],
   [{...orange,quantity:-1},'purchase','purchase_quantity_must_increase'],
   [{...orange,billed_amount_mode:'manual',billed_amount:0},'purchase','invalid_billed_amount'],
   [{...orange,billed_amount_mode:'manual'},'purchase','invalid_billed_amount'],
   [{...orange,billed_amount_mode:'auto',billed_amount:5},'purchase','invalid_billed_amount'],
   [{...orange,billed_amount_mode:'manual',billed_amount:1.0001},'purchase','invalid_billed_amount'],
   [{...orange,purchase_price:null,billed_amount_mode:'manual',billed_amount:5},'purchase','invalid_billed_amount'],
   [{...orange,billed_amount_mode:'manual',billed_amount:5},'stock_check','invalid_billed_amount'],
   [{...orange,quantity:'abc'},'purchase','invalid_payload'],
   [{...orange,id:9},'purchase','invalid_payload'],
   [{...orange,is_active:false},'purchase','invalid_payload'],
   [orange,'bogus','invalid_payload'],
  ])assert.equal((await create(db,payload,reason)).status,status,JSON.stringify({payload,reason}));
  assert.equal((await create(db,orange,'purchase',3)).status,'forbidden');
  assert.deepEqual(await counts(db),before);
 }finally{await db.close();}
});

for(const [table,label] of [['inventory_logs','receipt log'],['inventory_price_logs','price history'],['inventory','item']])
 test(`a failing ${label} insert rolls back the item, log and price history together`,async()=>{
  const db=await createFixture();try{
   const before=await counts(db);
   await db.exec(`create function qa_fail() returns trigger language plpgsql as $$begin raise exception 'QA_ATOMIC_FAIL';end$$;
    create trigger qa_fail before insert on ${table} for each row execute function qa_fail();`);
   await assert.rejects(create(db,{...orange,billed_amount_mode:'manual',billed_amount:303000}),/QA_ATOMIC_FAIL/);
   assert.deepEqual(await counts(db),before,'no item without its receipt');
  }finally{await db.close();}
 });

test('a failed projection is recorded with the receipt; retries and monthly reconcile book it once',async()=>{
 const db=await createFixture();try{
  await db.exec(`create function qa_fail_candidate() returns trigger language plpgsql as $$begin raise exception 'QA_PROJECTION_DOWN';end$$;
   create trigger qa_fail_candidate before insert on ledger_candidates for each row execute function qa_fail_candidate();`);
  const r=await create(db,{...orange,billed_amount_mode:'manual',billed_amount:303000});
  assert.equal(r.status,'ok');assert.equal(r.ledgerSync.status,'failed');
  assert.equal((await one(db,'select status from ledger_inventory_projection_status where inventory_log_id=$1',[r.inventoryLogId])).status,'failed');
  await db.exec('drop trigger qa_fail_candidate on ledger_candidates');
  for(let i=0;i<2;i++)await one(db,'select ledger_project_inventory_purchase_log_v1($1,2) as r',[r.inventoryLogId]);
  for(let i=0;i<2;i++)assert.equal((await one(db,"select ledger_reconcile_inventory_month_v1('2026-10-01',2) as r")).r.status,'ok');
  const live=(await db.query("select * from ledger_candidates where source_key=$1 and status<>'superseded'",['inventory-log:'+r.inventoryLogId])).rows;
  assert.equal(live.length,1);assert.equal(Number(live[0].proposed_amount),303000);
  assert.ok((await db.query("select t.id from ledger_transactions t join ledger_candidates c on c.resolved_transaction_id=t.id where c.source_key=$1",['inventory-log:'+r.inventoryLogId])).rows.length<=1);
  assert.equal(Number((await one(db,"select count(*) as n from ledger_transactions where source_type in ('inventory_purchase_reversal','inventory_purchase_rebook')")).n),0,'receipt #100 untouched');
 }finally{await db.close();}
});

test('migration: requires the billed migration, refuses re-application, service_role only',async()=>{
 const db=await createFixture();try{
  await assert.rejects(db.exec(readFileSync(migration,'utf8')),/INVENTORY_CREATE_WITH_RECEIPT_ALREADY_APPLIED/);await db.exec('rollback').catch(()=>{});
  const p=await one(db,"select has_function_privilege('service_role',$1,'execute') as s,has_function_privilege('authenticated',$1,'execute') as a,has_function_privilege('anon',$1,'execute') as n",
   ['public.inventory_create_with_receipt_v1(jsonb,text,date,bigint)']);
  assert.deepEqual(p,{s:true,a:false,n:false});
 }finally{await db.close();}
 const {receiptEditFixture}=await import('./helpers/inventory-receipt-edit-fixture.mjs');
 const bare=await receiptEditFixture();try{
  await assert.rejects(bare.exec(readFileSync(migration,'utf8')),/INVENTORY_CREATE_REQUIRES_BILLED_AMOUNT_MIGRATION/);
 }finally{await bare.close();}
});

// Real lock wait: a month close holding the month lock makes the create's projection wait; after
// it commits, the create finishes with the item and log committed together and a recorded status.
test('native PostgreSQL: create waits for a month close, no deadlock, item and receipt commit together',{skip:!process.env.QA_POSTGRES_BIN,timeout:90000},async t=>{
 const runtime=await nativeInventoryPostgres({testContext:t});
 try{
  const db=await createFixture(runtime.Database),a=await runtime.connect(db.name),b=await runtime.connect(db.name);let pending;
  try{
   await a.query("set statement_timeout='5s';begin");await a.query("select pg_advisory_xact_lock(hashtext('ledger_month_close:2026-10'))");
   await a.query("insert into ledger_month_closures(month) values('2026-10-01')");
   await b.query("set statement_timeout='5s';set deadlock_timeout='100ms'");
   const pid=(await one(b,'select pg_backend_pid() as pid')).pid;
   pending=one(b,'select inventory_create_with_receipt_v1($1::jsonb,$2,$3::date,$4) as r',[JSON.stringify({...orange,billed_amount_mode:'manual',billed_amount:303000}),'purchase','2026-10-11',1]);pending.catch(()=>{});
   for(let i=0;i<100&&(await one(db,'select cardinality(pg_blocking_pids($1)) as n',[pid])).n===0;i++)await delay(20);
   assert.ok((await one(db,'select cardinality(pg_blocking_pids($1)) as n',[pid])).n>0,'real lock wait');
   await a.query('commit');
   const r=(await pending).r;assert.equal(r.status,'ok');
   assert.equal((await one(db,'select code from ledger_inventory_projection_status where inventory_log_id=$1',[r.inventoryLogId])).code,'MONTH_CLOSED');
   assert.equal(Number((await one(db,'select count(*) as n from inventory_logs where item_id=$1',[r.item.id])).n),1);
   assert.equal(Number((await one(db,'select count(*) as n from ledger_candidates where source_key=$1',['inventory-log:'+r.inventoryLogId])).n),0,'closed month books nothing');
   assert.equal(Number((await one(db,'select deadlocks from pg_stat_database where datname=current_database()')).deadlocks),0);
  }finally{await a.query('rollback').catch(()=>{});await b.query('rollback').catch(()=>{});if(pending)await pending.catch(()=>{});await a.end();await b.end();await db.close();}
 }finally{await runtime.stop();}
});

test('duplicate key matches lib/inventory/normalize.ts; policy = same code and same KO or VI name, inactive included',async()=>{
 const db=await createFixture();try{
  const {normalizeInventoryName}=await import('../lib/inventory/normalize.ts');
  const samples=['  Nước ép nho ','NUOC EP NHO','Đá viên','đá  viên','로쿠 진','로쿠  진 ','Cà Phê Sữa Đá','ÁO','Crème Brûlée','Gin\tTonic','PC','',null];
  for(const value of samples)assert.equal((await one(db,'select inventory_ledger_private.inventory_name_key_v1($1) as k',[value])).k,normalizeInventoryName(value),String(value));
  // Existing duplicate pair in the data stays as it is; only the new item is checked.
  await db.exec(`insert into inventory(id,item_name,item_name_vi,code,unit,quantity,purchase_price,part) values(201,'레몬','Chanh','LM','kg',1,1000,'kitchen'),(202,'레몬','Chanh','LM','kg',1,1000,'kitchen')`);
  assert.equal((await create(db,{...orange,item_name:'레몬 슬라이스',item_name_vi:'Chanh lát',code:'LM'})).status,'ok','other names, same code');
  assert.equal((await create(db,{...orange,item_name:'레몬',item_name_vi:'',code:'LM2'})).status,'ok','same name, different code');
  const ko=await create(db,{...orange,item_name:' 레몬 ',item_name_vi:'Other',code:'lm'});
  assert.equal(ko.status,'duplicate');assert.equal(Number(ko.duplicateItemId),201);assert.deepEqual(ko.matchedFields,['item_name']);
  const vi=await create(db,{...orange,item_name:'',item_name_vi:'CHANH',code:'LM'});assert.deepEqual(vi.matchedFields,['item_name_vi']);
  await db.exec("update inventory set is_active=false where id in (201,202)");
  assert.equal((await create(db,{...orange,item_name:'레몬',code:'LM'})).status,'duplicate','inactive items count, like the app');
  assert.equal(Number((await one(db,"select count(*) as n from inventory where code in ('LM','lm')")).n),3,'existing pair untouched, one new item');
 }finally{await db.close();}
});

test('a receipt created by the RPC keeps the existing correction, payment and month-close protections',async()=>{
 const db=await createFixture();try{
  const r=await create(db,{...orange,billed_amount_mode:'manual',billed_amount:303000});
  const itemId=Number(r.item.id),rootId=Number(r.inventoryLogId);
  const expected=async()=>(await one(db,'select to_jsonb(i) as item from inventory i where id=$1',[itemId])).item;
  const edit=async(change,date='2026-10-11')=>{const old=await expected();return (await one(db,'select inventory_apply_purchase_receipt_edit_v1($1,$2,$3,$4::jsonb,$5::jsonb,$6::date,1) as r',
   [itemId,rootId,old.quantity,JSON.stringify(old),JSON.stringify({quantity:3.57,purchase_price:85000,supplier:'Won Mart',supplier_partner_id:10,reason:'QA',...change}),date])).r;};
  const v3=async payload=>{const old=await expected();return (await one(db,'select inventory_apply_purchase_correction_v3($1,$2,$3,$4::jsonb,$5::jsonb,$6::date,1) as r',
   [itemId,rootId,old.quantity,JSON.stringify(old),JSON.stringify(payload),'2026-10-11'])).r;};
  const booked=await one(db,"select t.* from ledger_transactions t join ledger_candidates c on c.resolved_transaction_id=t.id where c.source_key=$1 and t.status='confirmed' order by t.id desc limit 1",['inventory-log:'+rootId]);
  assert.equal(Number(booked.amount),303000,'booked at the billed amount');
  // A quick-save reduction cannot silently keep or drop the manual amount.
  await assert.rejects(v3({quantity:3,purchase_price:85000}),/PURCHASE_BILLED_AMOUNT_EDIT_REQUIRED/);
  // 입고 수정 rebooks the unpaid receipt at the new billed amount.
  const e=await edit({billed_amount_mode:'manual',billed_amount:302000});assert.equal(e.status,'ok');assert.equal(e.ledgerSync.code,'REBOOKED');
  // Paid, allocated or closed: every further edit is refused without writes.
  for(const [setup,blockReason] of [
   ["insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) select id,expense_transaction_id,1 from ledger_payables where status='unpaid'",'payment_allocated'],
   ["delete from ledger_payable_allocations;update ledger_payables set status='paid' where status='unpaid'",'payment_completed'],
   ["update ledger_payables set status='unpaid' where status='paid';insert into ledger_month_closures(month) values('2026-10-01')",'month_closed']]){
   await db.exec(setup);const before=(await db.query('select count(*)::int as n from inventory_logs')).rows[0].n;
   const blocked=await edit({billed_amount_mode:'manual',billed_amount:301000});
   assert.equal(blocked.status,'purchase_correction_review_required');assert.equal(blocked.blockReason,blockReason);
   assert.equal((await db.query('select count(*)::int as n from inventory_logs')).rows[0].n,before);
  }
  // Creating a new receipt in the closed month records MONTH_CLOSED and books nothing.
  const closed=await create(db,{...orange,code:'OR3'});assert.equal(closed.ledgerSync.code,'MONTH_CLOSED');
  assert.equal(Number((await one(db,'select count(*) as n from ledger_candidates where source_key=$1',['inventory-log:'+closed.inventoryLogId])).n),0);
 }finally{await db.close();}
});
