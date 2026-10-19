// Isolated PostgreSQL execution (PGlite) of the deployed projection chain plus the
// display-category migration. Never reads production credentials or data.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
 displayCategoryDatabase,applyDisplayCategoryMigration,displayCategoryMigrationSql,receipt,displayUpdate,
 projectV1,projectDisplay,candidates,ledgerState,one,
} from './helpers/inventory-display-category-fixture.mjs';

const PROCESSED={category:'가공식품',categoryVi:'Thực phẩm chế biến'};
const count=async(db,sql,args=[])=>Number((await one(db,sql,args)).n);
const auditCount=(db,action)=>count(db,'select count(*) n from ledger_audit_logs where action=$1',[action]);
// Economic projection of the books: signed expense total and every payable/movement amount.
const economics=async db=>({
 expense:Number((await one(db,'select coalesce(sum(amount*economic_effect_sign),0) n from ledger_transactions')).n),
 unpaid:Number((await one(db,"select coalesce(sum(original_amount),0) n from ledger_payables where status='unpaid'")).n),
 movements:Number((await one(db,'select coalesce(sum(amount),0) n from ledger_movements')).n),
});
const effectiveTx=async(db,id)=>one(db,`select t.* from ledger_candidates c join ledger_transactions t on t.id=c.resolved_transaction_id
 where c.source_key=$1 and c.status='confirmed'`,['inventory-log:'+id]);
async function confirmedPostpaid(db,{id=13561,item=620,price=270000}={}){
 await db.exec("update business_partners set payment_mode='postpaid',default_payment_term_days=7 where id=33");
 await receipt(db,{id,item,price});
 assert.equal((await projectV1(db,id)).code,'PROJECTED');
 return effectiveTx(db,id);
}

test('baseline reproduces production: before the migration a category-only change supersedes 1872 and keeps #66 on the new pending candidate',async()=>{
 const db=await displayCategoryDatabase({apply:false});try{
  await db.exec("select setval('ledger_candidates_id_seq',1872,false)");
  await receipt(db);assert.equal((await projectV1(db,13561)).status,'pending');
  await displayUpdate(db,13561,PROCESSED);
  const result=await projectV1(db,13561);
  assert.equal(result.status,'pending');assert.equal(result.code,'RESOLUTION_REQUIRED');assert.equal(result.supersededCount,1);
  const rows=await candidates(db,13561);
  assert.deepEqual(rows.map(r=>[r.id,r.status,Number(r.proposed_category_id),r.category]),[[1872,'superseded',66,'기타'],[1873,'pending',66,'가공식품']]);
 }finally{await db.close();}
});

test('production state 13561/13563: display sync remaps existing pending #66 -> #31 in place, no new candidate, no payment or policy change',async()=>{
 const db=await displayCategoryDatabase({apply:false});try{
  // Rebuild the reported chain: 1872/1873 superseded, 1900/1901 pending, all still on #66.
  await db.exec("select setval('ledger_candidates_id_seq',1872,false)");
  await receipt(db,{id:13561,item:620,price:270000});await receipt(db,{id:13563,item:621,price:65000});
  await projectV1(db,13561);await projectV1(db,13563);
  await db.exec("select setval('ledger_candidates_id_seq',1900,false)");
  for(const id of [13561,13563]){await displayUpdate(db,id,PROCESSED);await projectV1(db,id);}
  assert.deepEqual((await db.query("select id::text,status,proposed_category_id::int c from ledger_candidates order by id")).rows,
   [{id:'1872',status:'superseded',c:66},{id:'1873',status:'superseded',c:66},{id:'1900',status:'pending',c:66},{id:'1901',status:'pending',c:66}]);
  const partnerBefore=(await one(db,'select to_jsonb(p) p from business_partners p where id=33')).p;
  const ledgerBefore=await ledgerState(db);
  await applyDisplayCategoryMigration(db);
  for(const id of [13561,13563]){
   const result=await projectDisplay(db,id);
   // Partner #33 is payment_mode=unspecified: the candidate stays pending for an owner decision.
   assert.equal(result.status,'pending');assert.equal(result.code,'RESOLUTION_REQUIRED');assert.equal(result.createdCount,0);assert.equal(result.supersededCount,0);
  }
  assert.deepEqual((await db.query("select id::text,status,proposed_category_id::int c,proposed_amount::numeric::text a,proposed_party_id::int p from ledger_candidates order by id")).rows,[
   {id:'1872',status:'superseded',c:66,a:'270000.000',p:33},{id:'1873',status:'superseded',c:66,a:'65000.000',p:33},
   {id:'1900',status:'pending',c:31,a:'270000.000',p:33},{id:'1901',status:'pending',c:31,a:'65000.000',p:33}]);
  assert.equal(await auditCount(db,'inventory_candidate_display_synced'),2);
  const audit=await one(db,"select before_snapshot,after_snapshot from ledger_audit_logs where action='inventory_candidate_display_synced' and entity_id=1900");
  assert.equal(Number(audit.before_snapshot.proposed_category_id),66);assert.equal(Number(audit.after_snapshot.proposed_category_id),31);
  assert.deepEqual(await ledgerState(db),ledgerBefore);
  assert.deepEqual((await one(db,'select to_jsonb(p) p from business_partners p where id=33')).p,partnerBefore);
  // Repeated syncs are no-ops: no candidate, audit or status churn.
  const audits=await count(db,'select count(*) n from ledger_audit_logs');
  for(let i=0;i<3;i++)for(const id of [13561,13563])assert.equal((await projectDisplay(db,id)).createdCount,0);
  assert.equal(await count(db,'select count(*) n from ledger_candidates'),4);assert.equal(await count(db,'select count(*) n from ledger_audit_logs'),audits);
 }finally{await db.close();}
});

test('first category change after the migration keeps one pending candidate per receipt across repeated syncs',async()=>{
 const db=await displayCategoryDatabase();try{
  await receipt(db);await projectV1(db,13561);
  await displayUpdate(db,13561,PROCESSED);
  for(let i=0;i<3;i++)await projectDisplay(db,13561);
  const rows=await candidates(db,13561);assert.equal(rows.length,1);assert.equal(rows[0].status,'pending');assert.equal(Number(rows[0].proposed_category_id),31);assert.equal(rows[0].category,'가공식품');
  // category_vi-only edits refresh the snapshot in place and keep the mapped category.
  await displayUpdate(db,13561,{categoryVi:'Đồ chế biến'});await projectDisplay(db,13561);
  const after=await candidates(db,13561);assert.equal(after.length,1);assert.equal(Number(after[0].proposed_category_id),31);assert.notEqual(after[0].source_fingerprint,rows[0].source_fingerprint);
  assert.equal(await auditCount(db,'inventory_candidate_display_synced'),2);
 }finally{await db.close();}
});

test('pending display-only sync never changes proposed_party_id (owner-chosen or unresolved payee)',async()=>{
 for(const party of [34,null]){
  const db=await displayCategoryDatabase();try{
   await receipt(db);await projectV1(db,13561);
   await db.query("update ledger_candidates set proposed_party_id=$1 where status='pending'",[party]);
   await displayUpdate(db,13561,PROCESSED);
   for(let i=0;i<3;i++){const result=await projectDisplay(db,13561);assert.equal(result.status,'pending',String(party));assert.equal(result.createdCount,0);}
   const rows=await candidates(db,13561);assert.equal(rows.length,1);
   assert.equal(Number(rows[0].proposed_category_id),31);assert.equal(rows[0].proposed_party_id===null?null:Number(rows[0].proposed_party_id),party);
   const audit=await one(db,"select after_snapshot from ledger_audit_logs where action='inventory_candidate_display_synced'");
   assert.equal(audit.after_snapshot.proposed_party_id===null?null:Number(audit.after_snapshot.proposed_party_id),party);
   assert.equal(await auditCount(db,'inventory_candidate_display_synced'),1);
   assert.equal(await count(db,'select count(*) n from ledger_transactions'),0);
  }finally{await db.close();}
 }
});

test('display RPC re-checks the original receipt part against the current item and writes nothing on mismatch',async()=>{
 const cases=[
  ['item part moved',"update inventory set part='bar' where id=620"],
  ['receipt new_part differs',"update inventory_logs set new_part='bar' where id=13561"],
  ['receipt part differs',"update inventory set part='bar' where id=620; update inventory_logs set new_part='bar' where id=13561"],
  ['item part missing',"update inventory set part=null where id=620"],
 ];
 for(const confirmed of [false,true])for(const [label,setup] of cases){
  const db=await displayCategoryDatabase();try{
   if(confirmed)await confirmedPostpaid(db);else{await receipt(db);await projectV1(db,13561);}
   await displayUpdate(db,13561,PROCESSED);await db.exec(setup);
   const before={rows:await candidates(db,13561),ledger:await ledgerState(db),audits:await count(db,'select count(*) n from ledger_audit_logs'),
    status:(await one(db,'select to_jsonb(s) s from ledger_inventory_projection_status s where inventory_log_id=13561')).s};
   const result=await projectDisplay(db,13561);
   assert.equal(result.status,'review_required',label);assert.equal(result.code,'DISPLAY_SYNC_PART_MISMATCH',label);
   assert.deepEqual(await candidates(db,13561),before.rows,label);assert.deepEqual(await ledgerState(db),before.ledger,label);
   assert.equal(await count(db,'select count(*) n from ledger_audit_logs'),before.audits,label);
   assert.deepEqual((await one(db,'select to_jsonb(s) s from ledger_inventory_projection_status s where inventory_log_id=13561')).s,before.status,label);
   assert.equal((await one(db,"select current_setting('baba.inventory_display_sync',true) s")).s??'','');
  }finally{await db.close();}
 }
});

test('gas item/supplier rule wins over display category mappings for pending and confirmed receipts',async()=>{
 const gasReceipt=async(db,mode)=>{
  await db.query("update business_partners set payment_mode=$1,default_payment_term_days=7 where id=21",[mode]);
  await receipt(db,{id:3430,item:342,price:1395000,partner:21,supplier:'Cửa hàng gas petrolimex chính hãng',date:'2026-10-20'});
  await db.exec("update inventory_logs set created_at=clock_timestamp() where id=3430");await projectV1(db,3430);
 };
 // Pending with no category yet: the rule (#23) is chosen, never the display mapping (#31).
 const empty=await displayCategoryDatabase();try{
  await gasReceipt(empty,'unspecified');await empty.exec("update ledger_candidates set proposed_category_id=null");
  await displayUpdate(empty,3430,PROCESSED);await projectDisplay(empty,3430);
  const rows=await candidates(empty,3430);assert.equal(rows.length,1);assert.equal(Number(rows[0].proposed_category_id),23);
 }finally{await empty.close();}
 // A mapping that would prove #23 came from the inventory category still yields to the rule.
 const mapped=await displayCategoryDatabase();try{
  await mapped.exec("insert into ledger_inventory_category_mappings(inventory_category,ledger_category_id) values('가스',23)");
  await mapped.exec("update business_partners set payment_mode='unspecified' where id=21");
  await receipt(mapped,{id:3430,item:342,price:1395000,partner:21,supplier:'Cửa hàng gas petrolimex chính hãng',date:'2026-10-20',category:'가스'});
  // Recorded before the rule's starts_at: the rule does not apply, so #23 came from the '가스' mapping.
  await mapped.exec("update inventory_logs set created_at='2020-01-01T00:00:00Z' where id=3430");
  await projectV1(mapped,3430);assert.equal(Number((await candidates(mapped,3430))[0].proposed_category_id),23);
  await displayUpdate(mapped,3430,PROCESSED);await projectDisplay(mapped,3430);
  assert.equal(Number((await candidates(mapped,3430))[0].proposed_category_id),23);
 }finally{await mapped.close();}
 // Confirmed gas payable: no category rebook, books unchanged, repeated runs are no-ops.
 const confirmed=await displayCategoryDatabase();try{
  await gasReceipt(confirmed,'postpaid');
  const tx=await effectiveTx(confirmed,3430);assert.equal(Number(tx.category_id),23);
  const before=await ledgerState(confirmed);await displayUpdate(confirmed,3430,PROCESSED);
  for(let i=0;i<3;i++){const result=await projectDisplay(confirmed,3430);assert.equal(result.status,'synced');assert.notEqual(result.code,'CATEGORY_REBOOKED');}
  assert.deepEqual(await ledgerState(confirmed),before);assert.equal(await auditCount(confirmed,'inventory_source_rebooked'),0);
 }finally{await confirmed.close();}
});

test('preflight and postflight SQL run read-only against the reconstructed schema (month alias fixed)',async()=>{
 const {readFileSync}=await import('node:fs');
 const db=await displayCategoryDatabase({apply:false});try{
  await db.exec('create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,name text)');
  await receipt(db,{id:13561,item:620,price:270000});await receipt(db,{id:13563,item:621,price:65000});
  await projectV1(db,13561);await projectV1(db,13563);
  // The previous bare label is a syntax error in PostgreSQL.
  await assert.rejects(db.query("select to_char(month,'YYYY-MM') month, status from public.ledger_month_closures where month = '2026-10-01'"),/syntax error/);
  const fingerprint=async()=>JSON.stringify([await ledgerState(db),(await db.query('select * from ledger_candidates order by id')).rows,
   await count(db,'select count(*) n from ledger_audit_logs')]);
  const before=await fingerprint();
  await db.exec(readFileSync('supabase/inventory_display_category_sync_preflight.sql','utf8'));
  await applyDisplayCategoryMigration(db);
  const migrated=await fingerprint();assert.equal(migrated,before);
  await db.exec(readFileSync('supabase/inventory_display_category_sync_postflight.sql','utf8'));
  assert.equal(await fingerprint(),migrated);
  const part=(await db.query(`select (i.part = coalesce(nullif(btrim(l.part),''), l.new_part)) same_part from inventory_logs l join inventory i on i.id=l.item_id where l.id in (13561,13563)`)).rows;
  assert.deepEqual(part.map(r=>r.same_part),[true,true]);
 }finally{await db.close();}
});

test('part changes and other callers keep the existing supersede/review path after the migration',async()=>{
 const db=await displayCategoryDatabase();try{
  await receipt(db);await projectV1(db,13561);
  // The daily sync route sends part changes through the unscoped projection.
  await displayUpdate(db,13561,{...PROCESSED,part:'bar'});
  const result=await projectV1(db,13561);assert.equal(result.supersededCount,1);
  const rows=await candidates(db,13561);assert.deepEqual(rows.map(r=>[r.status,Number(r.proposed_category_id)]),[['superseded',66],['pending',66]]);
  assert.equal(await auditCount(db,'inventory_candidate_display_synced'),0);
 }finally{await db.close();}
});

test('real price, quantity or supplier changes never use the in-place display path even when called with the display scope',async()=>{
 for(const change of ["new_purchase_price=280000","change_quantity=2","new_supplier='Other Mart',purchase_supplier_partner_id=null"]){
  const db=await displayCategoryDatabase();try{
   await receipt(db);await projectV1(db,13561);
   await db.exec(`update inventory_logs set ${change},category='가공식품',new_category='가공식품' where id=13561`);
   const result=await projectDisplay(db,13561);assert.equal(result.supersededCount,1,change);
   const rows=await candidates(db,13561);assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>Number(r.proposed_category_id)),[66,66]);
   assert.equal(await auditCount(db,'inventory_candidate_display_synced'),0);
  }finally{await db.close();}
 }
});

test('production default display_snapshot={} on a confirmed expense is not a manual edit (October: 421/421 rows are {})',async()=>{
 const db=await displayCategoryDatabase();try{
  const original=await confirmedPostpaid(db);
  assert.deepEqual(original.display_snapshot,{});
  assert.equal(await count(db,"select count(*) n from ledger_transactions where display_snapshot='{}'::jsonb"),1);
  await displayUpdate(db,13561,PROCESSED);
  const result=await projectDisplay(db,13561);assert.equal(result.status,'synced');assert.equal(result.code,'CATEGORY_REBOOKED');
  const current=await effectiveTx(db,13561);assert.equal(Number(current.category_id),31);assert.deepEqual(current.display_snapshot,{});
  // The replacement also carries the default, so a later display change still follows.
  await displayUpdate(db,13561,{category:'기타',categoryVi:'Khác'});
  assert.equal((await projectDisplay(db,13561)).code,'CATEGORY_REBOOKED');assert.equal(Number((await effectiveTx(db,13561)).category_id),66);
  assert.equal(await auditCount(db,'inventory_source_rebooked'),2);
 }finally{await db.close();}
});

test('confirmed unpaid open-month expense follows the category by audited rebook with identical money, party, payable and due date',async()=>{
 const db=await displayCategoryDatabase();try{
  const original=await confirmedPostpaid(db);assert.equal(Number(original.category_id),66);
  const payable=await one(db,'select * from ledger_payables where expense_transaction_id=$1',[original.id]);
  const money=await economics(db);
  await displayUpdate(db,13561,PROCESSED);
  const result=await projectDisplay(db,13561);assert.equal(result.status,'synced');assert.equal(result.code,'CATEGORY_REBOOKED');
  const current=await effectiveTx(db,13561);
  assert.equal(Number(current.category_id),31);assert.notEqual(current.id,original.id);assert.equal(Number(result.transactionId),Number(current.id));
  for(const field of ['amount','party_id','business_date','recognition_month','memo'])assert.deepEqual(current[field],original[field],field);
  const replacement=await one(db,"select * from ledger_payables where expense_transaction_id=$1 and status='unpaid'",[current.id]);
  assert.equal(replacement.original_amount,payable.original_amount);assert.equal(Number(replacement.party_id),Number(payable.party_id));assert.deepEqual(replacement.due_date,payable.due_date);
  assert.deepEqual(await economics(db),money);
  assert.equal((await one(db,'select status from ledger_payables where id=$1',[payable.id])).status,'cancelled');
  const audit=await one(db,"select after_snapshot,reason from ledger_audit_logs where action='inventory_source_rebooked'");assert.equal(audit.reason,'Inventory display category sync');assert.equal(Number(audit.after_snapshot.categoryId),31);
  const transactions=await count(db,'select count(*) n from ledger_transactions');
  for(let i=0;i<3;i++){const again=await projectDisplay(db,13561);assert.equal(again.status,'synced');assert.notEqual(again.code,'CATEGORY_REBOOKED');}
  assert.equal(await count(db,'select count(*) n from ledger_transactions'),transactions);assert.equal(await count(db,'select count(*) n from ledger_candidates'),1);
 }finally{await db.close();}
});

test('confirmed protections: paid/allocated payable, immediate payment, month close and manual edits stay untouched and reported once',async()=>{
 const cases=[
  ['paid payable',"update ledger_payables set status='paid'",'CATEGORY_SYNC_PAYMENT_COMPLETED'],
  ['partially paid payable',"update ledger_payables set status='partially_paid'",'CATEGORY_SYNC_PAYMENT_COMPLETED'],
  ['allocated payment',`insert into ledger_transactions(id,operation_id,type,occurred_at,business_date,amount,party_id,source_type,source_key,created_by,confirmed_by)
    values(900,gen_random_uuid(),'payable_payment','2026-10-19T05:00:00Z','2026-10-19',100000,33,'payable_payment','fixture:900',2,2);
    insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) select id,900,100000 from ledger_payables`,'CATEGORY_SYNC_PAYMENT_COMPLETED'],
  ['month closed',"insert into ledger_month_closures(month) values('2026-10-01')",'CATEGORY_SYNC_MONTH_CLOSED'],
  ['manual amount',"update ledger_transactions set amount=260000; update ledger_payables set original_amount=260000",'CATEGORY_SYNC_MANUAL_OVERRIDE'],
  ['manual display override',`update ledger_transactions set display_snapshot='{"titleOverride":"사장님 수정"}'`,'CATEGORY_SYNC_MANUAL_OVERRIDE'],
  ['manual memo audit history',`update ledger_transactions set memo='사장님 메모';
    insert into ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
    select 2,'manual_transaction_edited','transaction',id,'{}','{}','QA memo edit' from ledger_transactions`,'CATEGORY_SYNC_MANUAL_OVERRIDE'],
  ['manual category audit history',`insert into ledger_audit_logs(actor_user_id,action,entity_type,entity_id,before_snapshot,after_snapshot,reason)
    select 2,'inventory_transaction_rebooked','transaction',id,'{}','{}','QA owner rebook' from ledger_transactions`,'CATEGORY_SYNC_MANUAL_OVERRIDE'],
  ['linked correction',`insert into ledger_transactions(id,operation_id,type,occurred_at,business_date,recognition_month,amount,party_id,category_id,source_type,source_key,created_by,confirmed_by,correction_of_id,economic_effect_sign)
    select 901,gen_random_uuid(),'expense','2026-10-19T05:00:00Z','2026-10-19','2026-10-01',10000,33,66,'manual','fixture:901',2,2,id,-1 from ledger_transactions where id<>901`,'CATEGORY_SYNC_MANUAL_OVERRIDE'],
 ];
 for(const [label,setup,code] of cases){
  const db=await displayCategoryDatabase();try{
   await confirmedPostpaid(db);await db.exec(setup);
   const before=await ledgerState(db);
   await displayUpdate(db,13561,PROCESSED);
   const result=await projectDisplay(db,13561);assert.equal(result.status,'review_required',label);assert.equal(result.code,code,label);
   assert.deepEqual(await ledgerState(db),before,label);
   assert.equal(await count(db,'select count(*) n from ledger_candidates'),1,label);
   // Drift evidence is retained for the admin; repeating the sync does not add audit rows.
   assert.equal((await one(db,"select source_drift_snapshot->>'category' c from ledger_candidates")).c,'가공식품',label);
   const audits=await count(db,'select count(*) n from ledger_audit_logs');await projectDisplay(db,13561);await projectDisplay(db,13561);
   assert.equal(await count(db,'select count(*) n from ledger_audit_logs'),audits,label);
  }finally{await db.close();}
 }
});

test('immediate payment and an explicit Ledger category are never rebooked by a display sync',async()=>{
 const db=await displayCategoryDatabase();try{
  await receipt(db);await projectV1(db,13561);
  const {id}=await one(db,"select id from ledger_candidates where status='pending'");
  const account=Number((await one(db,"select id from ledger_fund_accounts where is_active and type<>'card_clearing' order by id limit 1")).id);
  const resolved=await one(db,"select ledger_resolve_inventory_candidate_v1($1,'immediate',66,33,$2,null,null,null,2) r",[id,account]);assert.equal(resolved.r.status,'confirmed');
  const before=await ledgerState(db);await displayUpdate(db,13561,PROCESSED);
  const paid=await projectDisplay(db,13561);assert.equal(paid.code,'CATEGORY_SYNC_PAYMENT_COMPLETED');assert.deepEqual(await ledgerState(db),before);
 }finally{await db.close();}
 const manual=await displayCategoryDatabase();try{
  await confirmedPostpaid(manual);await manual.exec('update ledger_transactions set category_id=77');
  const before=await ledgerState(manual);await displayUpdate(manual,13561,PROCESSED);
  const result=await projectDisplay(manual,13561);assert.equal(result.status,'synced');assert.equal(result.code,'METADATA_SYNCED');
  assert.deepEqual(await ledgerState(manual),before);
 }finally{await manual.close();}
});

test('pending candidates in a closed month, dismissed history and explicit gas rules keep their existing results',async()=>{
 const closed=await displayCategoryDatabase();try{
  await receipt(closed);await projectV1(closed,13561);await closed.exec("insert into ledger_month_closures(month) values('2026-10-01')");
  await displayUpdate(closed,13561,PROCESSED);const result=await projectDisplay(closed,13561);
  assert.equal(result.code,'MONTH_CLOSED');assert.equal(Number((await candidates(closed,13561))[0].proposed_category_id),66);
 }finally{await closed.close();}
 const dismissed=await displayCategoryDatabase();try{
  await receipt(dismissed);await projectV1(dismissed,13561);
  await dismissed.exec("update ledger_candidates set status='dismissed',dismissal_reason='QA',resolved_by=2,resolved_at=now()");
  await displayUpdate(dismissed,13561,PROCESSED);await projectDisplay(dismissed,13561);
  assert.deepEqual((await candidates(dismissed,13561)).map(r=>r.status),['dismissed','pending']);
  assert.equal(await auditCount(dismissed,'inventory_candidate_display_synced'),0);
 }finally{await dismissed.close();}
 const gas=await displayCategoryDatabase();try{
  await gas.exec("update business_partners set payment_mode='unspecified' where id=21");
  await receipt(gas,{id:3430,item:342,price:1395000,partner:21,supplier:'Cửa hàng gas petrolimex chính hãng',date:'2026-10-20'});
  await gas.exec("update inventory_logs set created_at=clock_timestamp() where id=3430");await projectV1(gas,3430);
  assert.equal(Number((await candidates(gas,3430))[0].proposed_category_id),23);
  await displayUpdate(gas,3430,PROCESSED);await projectDisplay(gas,3430);
  const rows=await candidates(gas,3430);assert.equal(rows.length,1);assert.equal(Number(rows[0].proposed_category_id),23);
 }finally{await gas.close();}
});

test('permissions: display RPC is owner/master only, service_role executable, private helpers closed',async()=>{
 const db=await displayCategoryDatabase();try{
  await receipt(db);await projectV1(db,13561);
  assert.deepEqual(await projectDisplay(db,13561,1),{status:'failed',code:'FORBIDDEN'});
  assert.deepEqual(await projectDisplay(db,99999,2),{status:'failed',code:'SOURCE_NOT_FOUND'});
  const grants=(await db.query(`select p.proname,r.rolname,has_function_privilege(r.rolname,p.oid,'execute') can
   from pg_proc p cross join (values('anon'),('authenticated'),('service_role')) r(rolname)
   where p.proname in ('ledger_project_inventory_display_sync_v1','display_sync_category_v1','sync_confirmed_display_category_v1','ledger_project_inventory_purchase_log_v1')
   order by 1,2`)).rows;
  for(const row of grants)assert.equal(row.can,row.rolname==='service_role'&&row.proname.startsWith('ledger_'),row.proname+'/'+row.rolname);
  // The scope never leaks into a later unscoped call in the same transaction.
  await displayUpdate(db,13561,PROCESSED);
  const leaked=await one(db,"select ledger_project_inventory_display_sync_v1(13561,2) a,current_setting('baba.inventory_display_sync',true) s");assert.equal(leaked.s,'');
 }finally{await db.close();}
});

test('optional backfill file: guarded, touches only 1900/1901 (#66 -> #31), aborts on unexpected state',async()=>{
 const {readFileSync}=await import('node:fs');
 const sql=readFileSync('supabase/inventory_display_category_sync_backfill_20261020.sql','utf8');
 const runnable=actor=>sql.replace('v_actor bigint := null;',`v_actor bigint := ${actor};`)+'\ncommit;';
 const productionState=async()=>{
  const db=await displayCategoryDatabase({apply:false});
  await db.exec("select setval('ledger_candidates_id_seq',1872,false)");
  await receipt(db,{id:13561,item:620,price:270000});await receipt(db,{id:13563,item:621,price:65000});
  await projectV1(db,13561);await projectV1(db,13563);await db.exec("select setval('ledger_candidates_id_seq',1900,false)");
  for(const id of [13561,13563]){await displayUpdate(db,id,PROCESSED);await projectV1(db,id);}
  await applyDisplayCategoryMigration(db);return db;
 };
 const db=await productionState();try{
  const before=await ledgerState(db);
  await assert.rejects(db.exec(sql),/BACKFILL_ACTOR_REQUIRED/);await db.exec('rollback');
  await db.exec(runnable(2));
  assert.deepEqual((await db.query("select id::text,status,proposed_category_id::int c from ledger_candidates order by id")).rows,
   [{id:'1872',status:'superseded',c:66},{id:'1873',status:'superseded',c:66},{id:'1900',status:'pending',c:31},{id:'1901',status:'pending',c:31}]);
  assert.deepEqual(await ledgerState(db),before);
  // Re-running is refused by the state guard instead of silently re-applying.
  await assert.rejects(db.exec(runnable(2)),/BACKFILL_STATE_MISMATCH/);await db.exec('rollback');
 }finally{await db.close();}
 const moved=await productionState();try{
  await moved.exec("update inventory_logs set part='bar',new_part='bar' where id=13561");
  await assert.rejects(moved.exec(runnable(2)),/BACKFILL_STATE_MISMATCH/);await moved.exec('rollback');
  assert.equal(Number((await one(moved,'select proposed_category_id from ledger_candidates where id=1900')).proposed_category_id),66);
 }finally{await moved.close();}
});

test('rollback script restores byte-identical pre-migration bodies (LF/CRLF) and removes the new functions',async()=>{
 const {readFileSync}=await import('node:fs');const rollback=readFileSync('supabase/inventory_display_category_sync_rollback.sql','utf8');
 for(const eol of ['LF','CRLF']){
  const db=await displayCategoryDatabase({apply:false,projectionBodyEol:eol});try{
   const bodies=async()=>(await db.query("select proname,md5(pg_get_functiondef(oid)) h from pg_proc where proname in ('sync_candidate','ledger_project_inventory_purchase_log_v1') order by proname")).rows;
   const before=await bodies();await applyDisplayCategoryMigration(db);assert.notDeepEqual(await bodies(),before);
   await db.exec(rollback);assert.deepEqual(await bodies(),before,eol);
   assert.equal((await one(db,"select count(*) n from pg_proc where proname in ('ledger_project_inventory_display_sync_v1','display_sync_category_v1','sync_confirmed_display_category_v1')")).n,0);
   // The restored chain behaves as before (supersede on category change) and can be re-applied.
   await receipt(db);await projectV1(db,13561);await displayUpdate(db,13561,PROCESSED);assert.equal((await projectV1(db,13561)).supersededCount,1);
   await applyDisplayCategoryMigration(db);
  }finally{await db.close();}
 }
});

test('migration contract: LF/CRLF bodies, unexpected bodies and re-application abort without partial changes',async()=>{
 for(const eol of ['LF','CRLF']){
  const db=await displayCategoryDatabase({projectionBodyEol:eol});try{
   const body=(await one(db,"select pg_get_functiondef('public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure) d")).d;
   assert.equal(body.includes('\r\n'),eol==='CRLF');assert.ok(!body.includes('\r\r\n'));
   assert.match((await one(db,"select pg_get_functiondef('inventory_ledger_private.sync_candidate(jsonb,bigint)'::regprocedure) d")).d,/baba\.inventory_display_sync/);
   await assert.rejects(db.exec(displayCategoryMigrationSql()),/already exists|INVENTORY_DISPLAY_SYNC_ALREADY_APPLIED/);await db.exec('rollback');
  }finally{await db.close();}
 }
 const db=await displayCategoryDatabase({apply:false});try{
  const signature='inventory_ledger_private.sync_candidate(jsonb,bigint)';
  const {d}=await one(db,'select pg_get_functiondef($1::regprocedure) d',[signature]);
  await db.exec(d.replace('v_pending.source_fingerprint = v_fingerprint then','v_pending.source_fingerprint = v_fingerprint  then'));
  const hashes=async()=>(await db.query("select md5(pg_get_functiondef(oid)) h from pg_proc where proname in ('sync_candidate','ledger_project_inventory_purchase_log_v1') order by proname")).rows;
  const before=await hashes();
  await assert.rejects(db.exec(displayCategoryMigrationSql()),/INVENTORY_DISPLAY_SYNC_CONTRACT_MISMATCH/);await db.exec('rollback');
  assert.deepEqual(await hashes(),before);
  assert.equal((await one(db,"select to_regprocedure('public.ledger_project_inventory_display_sync_v1(bigint,bigint)') f")).f,null);
 }finally{await db.close();}
});
