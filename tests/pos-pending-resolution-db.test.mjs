import assert from 'node:assert/strict';
import test from 'node:test';
import {resolutionDatabase,seedPending,review,request,resolve,resolutionMigration} from './helpers/pos-pending-resolution-fixture.mjs';
import {pendingResolutionCases} from './fixtures/pos-pending-resolution-cases.ts';
import {daySource,closeDay,ledgerState,addCardSettlement} from './helpers/pos-business-day-close-fixture.mjs';
test('eight incidents preserve raw/duplicate lines, replace payment once and pause inventory',async()=>{
 const db=await resolutionDatabase();try{
  for(const [index,f] of pendingResolutionCases.entries()){
   const id=10+index;await seedPending(db,{id,...f});const state=await review(db,id);const amount=f.confirmed??f.amount;
   const body=request(state,{requestId:`11111111-1111-4111-8111-${String(index).padStart(12,'0')}`,amount,payments:[{method:'cash',amount:amount-1},{method:'transfer',amount:1}]});
   assert.equal((await resolve(db,body,id)).status,'resolved');assert.equal((await resolve(db,body,id)).status,'resolved');
   const receipt=(await db.query('select * from pos_sales_receipts where id=$1',[id])).rows[0];assert.equal(receipt.raw_json.PaymentStatus,1);assert.equal(receipt.inventory_deduction_processing_paused,true);assert.equal(receipt.inventory_deduction_auto_eligible_at,null);
   const lines=(await db.query('select * from pos_sales_receipt_lines where receipt_id=$1',[id])).rows;assert.equal(lines.length,f.duplicate?2:1);assert.ok(lines.every(l=>l.payment_status===3&&l.raw_json.original));
   assert.equal((await db.query('select count(*)::int n from pos_sales_receipt_resolution_history where receipt_id=$1',[id])).rows[0].n,1);
   assert.equal(Number((await db.query('select sum(amount) n from pos_sales_receipt_payments where receipt_id=$1',[id])).rows[0].n),amount);
  }
  assert.equal((await db.query('select count(*)::int n from pos_resolution_private.capabilities')).rows[0].n,0);
 }finally{await db.close()}
});
test('7072 paid is ineligible; DB role and login policy authoritative',async()=>{
 const db=await resolutionDatabase();try{
  await seedPending(db,{status:3,refNo:'7072'});const state=await review(db);assert.equal(state.eligible,false);assert.equal((await resolve(db,request(state))).status,'not_eligible');
  for(const actor of [4,5,6,999]){assert.equal((await review(db,10,actor)).status,'forbidden');assert.equal((await resolve(db,request(state),10,actor)).status,'forbidden')}
 }finally{await db.close()}
});
test('snapshot/revision/request conflicts, sum mismatch and cancellation adjustment enforced',async()=>{
 const db=await resolutionDatabase();try{
  await seedPending(db);let state=await review(db);assert.equal((await resolve(db,request(state,{payments:[{method:'cash',amount:99999}]}))).status,'payment_total_mismatch');
  await db.exec('update pos_sales_receipt_lines set quantity=2 where receipt_id=10');assert.equal((await resolve(db,request(state))).status,'source_changed');state=await review(db);
  const body=request(state);assert.equal((await resolve(db,body)).status,'resolved');assert.equal((await resolve(db,{...body,reason:'changed'})).status,'request_conflict');
  await seedPending(db,{id:11,refNo:'cancel'});await db.exec("insert into pos_sales_receipt_payments(receipt_id,business_date,amount) values(11,'2026-10-17',10)");state=await review(db,11);
  const cancel=request(state,{requestId:'22222222-2222-4222-8222-222222222222',decision:'canceled',amount:0,payments:[]});assert.equal((await resolve(db,cancel,11)).status,'collection_adjustment_required');
  const confirmed={...cancel,collectionAdjustmentConfirmed:true};assert.equal((await resolve(db,confirmed,11)).status,'resolved');assert.equal((await resolve(db,confirmed,11)).status,'resolved');assert.equal((await db.query('select count(*)::int n from pos_sales_receipt_payments where receipt_id=11')).rows[0].n,0);
 }finally{await db.close()}
});
test('month/inventory blocked; Owner reclose changes same ledger sources atomically',async()=>{
 const db=await resolutionDatabase();try{
  await seedPending(db,{date:'2026-08-20'});let state=await review(db);await db.exec("insert into ledger_month_closures(month,status) values('2026-08-01','closed')");assert.equal((await resolve(db,request(state))).status,'month_closed');await db.exec("update ledger_month_closures set status='reopened'");
  await db.exec('insert into pos_inventory_deductions(receipt_id) values(10)');assert.equal((await resolve(db,request(state))).status,'inventory_history_requires_review');await db.exec('delete from pos_inventory_deductions');
  assert.equal((await closeDay(db,await daySource(db))).status,'closed');state=await review(db);assert.equal((await resolve(db,request(state),10,3)).status,'reclose_required');
  const result=await resolve(db,request(state,{allowReclose:true,closureFingerprint:state.closure.fingerprint}));assert.equal(result.status,'resolved');assert.equal(result.reclose.status,'reclosed');
  const ledger=await ledgerState(db);assert.equal(ledger.closures.length,2);assert.equal(ledger.transactions.filter(t=>t.status==='confirmed').reduce((s,t)=>s+Number(t.amount),0),200000);
 }finally{await db.close()}
});
test('stale sync cannot mutate receipt/raw/lines/payments or activate inventory; audit immutable',async()=>{
 const db=await resolutionDatabase();try{
  await seedPending(db);await resolve(db,request(await review(db)));
  for(const sql of ["update pos_sales_receipts set payment_status=1 where id=10","update pos_sales_receipts set raw_json='{}' where id=10","update pos_sales_receipts set inventory_deduction_auto_eligible_at=now() where id=10","update pos_sales_receipts set inventory_deduction_processing_paused=false where id=10","delete from pos_sales_receipt_payments where receipt_id=10","insert into pos_sales_receipt_lines(receipt_id) values(10)","update pos_sales_receipt_lines set quantity=99 where receipt_id=10"]){await assert.rejects(db.exec(sql),/POS_ADMIN_RESOLUTION_PROTECTED/)}
  for(const table of ['pos_sales_receipt_admin_resolutions','pos_sales_receipt_resolution_history'])await assert.rejects(db.exec(`delete from ${table}`),/POS_RESOLUTION_APPEND_ONLY/);
 }finally{await db.close()}
});
test('POS pending/matched/conflict observations preserve effective state; repeated observation idempotent',async()=>{
 const db=await resolutionDatabase();try{
  await seedPending(db);await resolve(db,request(await review(db)));
  for(const [detailStatus,amount,expected] of [[1,100000,'pending'],[3,100000,'matched'],[4,100000,'conflict'],[3,1,'conflict']]){
   const batch=JSON.stringify([{refId:'ref-6974',observedAt:new Date().toISOString(),origin:'refresh',listStatus:null,detailStatus,amount,raw:{PaymentStatus:detailStatus}}]);await db.query('select sales_observe_resolved_receipts_v1($1::jsonb)',[batch]);await db.query('select sales_observe_resolved_receipts_v1($1::jsonb)',[batch]);assert.equal((await review(db)).lastObservation.reconciliation,expected);
  }
  assert.equal((await db.query('select count(*)::int n from pos_sales_receipt_pos_observations')).rows[0].n,4);assert.equal((await db.query('select payment_status from pos_sales_receipts where id=10')).rows[0].payment_status,3);
 }finally{await db.close()}
});
test('late failure rolls back payment replacement, effective status, audit and capability; RPC ACL restricted',async()=>{
 const db=await resolutionDatabase();try{
  await seedPending(db);const before=await review(db);await db.exec("create function reject_test_history() returns trigger language plpgsql as $$begin raise exception 'TEST_FAIL';end$$;create trigger test_fail before insert on pos_sales_receipt_resolution_history for each row execute function reject_test_history();");await assert.rejects(resolve(db,request(before)),/TEST_FAIL/);assert.equal((await review(db)).fingerprint,before.fingerprint);assert.equal((await db.query('select count(*)::int n from pos_resolution_private.capabilities')).rows[0].n,0);
  for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'sales_resolve_pending_receipt_v1(bigint,bigint,jsonb)','execute') allowed",[role])).rows[0].allowed,false);
  assert.equal((await db.query("select has_function_privilege('service_role','sales_resolve_pending_receipt_v1(bigint,bigint,jsonb)','execute') allowed")).rows[0].allowed,true);await assert.rejects(db.exec(resolutionMigration),/already exists/);
 }finally{await db.close()}
});
test('DB time boundary/fallback mirrors UTC helper; later POS final blocks new manual decision',async()=>{
 const db=await resolutionDatabase();try{
  for(const [ref,created,elapsed,reason] of [['2026-10-21T07:00:01Z','2026-10-21T06:00:00Z',false,null],['2026-10-21T07:00:00Z','2026-10-21T06:00:00Z',true,null],[null,'2026-10-21T07:00:00Z',true,'invalid_ref_date'],['2026-10-21T08:00:00Z','2026-10-21T07:00:00Z',true,'future_ref_date'],[null,null,false,'invalid_ref_date']]){
   const r=(await db.query("select pos_resolution_private.eligibility($1,$2,'2026-10-21T07:30:00Z') result",[ref,created])).rows[0].result;assert.equal(r.elapsed,elapsed);assert.equal(r.fallbackReason,reason);
  }
  await seedPending(db);const before=await review(db);await db.query('select sales_observe_resolved_receipts_v1($1::jsonb)',[JSON.stringify([{refId:'ref-6974',observedAt:new Date().toISOString(),origin:'refresh',listStatus:null,detailStatus:3,amount:100000,raw:{PaymentStatus:3}}])]);assert.equal((await review(db)).eligible,false);assert.equal((await resolve(db,request(before))).status,'pos_final_requires_sync');
 }finally{await db.close()}
});
test('bounded queue leases at most three old receipts, backs off failures, and rejects repeated finish',async()=>{
 const db=await resolutionDatabase();try{
  for(let i=0;i<8;i++)await seedPending(db,{id:10+i,refNo:'retry-'+i});
  const first=(await db.query('select sales_claim_pending_rechecks_v1() jobs')).rows[0].jobs;assert.equal(first.length,3);
  assert.equal((await db.query('select sales_claim_pending_rechecks_v1() jobs')).rows[0].jobs.length,0);
  await db.exec("update pos_resolution_private.recheck_jobs set last_leased_at=now()-interval '5 minutes'");
  const next=(await db.query('select sales_claim_pending_rechecks_v1() jobs')).rows[0].jobs;assert.equal(next.length,3);assert.ok(next.every(j=>!first.some(f=>f.receiptId===j.receiptId)));
  const job=first[0];const finish=()=>db.query("select sales_finish_pending_recheck_v1($1,$2,'failed') ok",[job.receiptId,job.leaseId]);assert.equal((await finish()).rows[0].ok,true);assert.equal((await finish()).rows[0].ok,false);
  const state=(await db.query('select * from pos_resolution_private.recheck_jobs where receipt_id=$1',[job.receiptId])).rows[0];assert.equal(state.last_error,'pos_lookup_failed');assert.ok(Date.parse(state.next_attempt_at)>Date.now()+500000);assert.equal((await db.query("select count(*)::int n from pos_sales_receipt_resolution_history where event='pos_lookup_failed'")).rows[0].n,1);
  await db.exec("update pos_resolution_private.recheck_jobs set last_leased_at=now()-interval '5 minutes'");
  const last=(await db.query('select sales_claim_pending_rechecks_v1() jobs')).rows[0].jobs;assert.equal(last.length,2);
  const rows=(await db.query('select payment_status from pos_sales_receipts where id>=10')).rows;assert.ok(rows.every(r=>r.payment_status===1));
 }finally{await db.close()}
});
test('actual card settlement lock rolls back receipt, payments, history and closure',async()=>{
 const db=await resolutionDatabase();try{
  await db.exec("update pos_sales_receipt_payments set payment_name='Card',card_name='Card',payment_type=2 where id=2");
  await seedPending(db,{date:'2026-08-20'});await closeDay(db,await daySource(db));await addCardSettlement(db,'partial');
  const state=await review(db);const before=await ledgerState(db);
  await assert.rejects(resolve(db,request(state,{payments:[{method:'card',amount:100000}],allowReclose:true,closureFingerprint:state.closure.fingerprint})),/POS_RESOLUTION_RECLOSE_FAILED/);
  assert.equal((await review(db)).fingerprint,state.fingerprint);assert.deepEqual(await ledgerState(db),before);
 }finally{await db.close()}
});
test('late arrival of an older POS response cannot hide a newer conflict',async()=>{
 const db=await resolutionDatabase();try{
  await seedPending(db);await resolve(db,request(await review(db)));
  for(const [observedAt,detailStatus] of [['2026-10-21T07:30:00Z',4],['2026-10-21T07:29:00Z',1]])await db.query('select sales_observe_resolved_receipts_v1($1::jsonb)',[JSON.stringify([{refId:'ref-6974',observedAt,origin:'sync',detailStatus,listStatus:null,amount:100000,raw:{PaymentStatus:detailStatus}}])]);
  assert.equal((await review(db)).lastObservation.reconciliation,'conflict');
 }finally{await db.close()}
});
test('unrelated closed-day source drift must be reviewed before this receipt can reclose',async()=>{
 const db=await resolutionDatabase();try{
  await seedPending(db,{date:'2026-08-20'});await closeDay(db,await daySource(db));
  await db.exec('update pos_sales_receipts set final_amount=110000 where id=1;update pos_sales_receipt_payments set amount=70000 where id=2');
  const state=await review(db);assert.equal(state.daySourceDrift,true);assert.equal((await resolve(db,request(state,{allowReclose:true,closureFingerprint:state.closure.fingerprint}))).status,'day_source_drift_requires_review');
  assert.equal((await db.query('select payment_status from pos_sales_receipts where id=10')).rows[0].payment_status,1);
 }finally{await db.close()}
});
test('original POS duplicate warning survives administrator line edits and raw JSON stays intact',async()=>{
 const db=await resolutionDatabase();try{
  await seedPending(db);const raw={PaymentStatus:1,SAInvoiceDetails:[{RefDetailID:'old-a',ItemCode:'TEST',Quantity:1,UnitPrice:100000},{RefDetailID:'old-b',ItemCode:'TEST',Quantity:1,UnitPrice:100000}]};
  await db.query('update pos_sales_receipts set raw_json=$1::jsonb where id=10',[JSON.stringify(raw)]);assert.equal((await review(db)).rawDuplicateGroups,1);await resolve(db,request(await review(db)));assert.deepEqual((await db.query('select raw_json from pos_sales_receipts where id=10')).rows[0].raw_json,raw);
 }finally{await db.close()}
});
