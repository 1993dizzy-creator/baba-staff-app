import assert from 'node:assert/strict';
import test from 'node:test';
import {posFinalDatabase,daySource,finalCheck,claimFinal,releaseFinal} from './helpers/pos-business-day-final-fixture.mjs';
import {closeDay,ledgerState,addCardSettlement} from './helpers/pos-business-day-close-fixture.mjs';
for(const kind of ['unchanged','metadata','total','cash','card'])test('manual close final check '+kind+' keeps Ledger immutable',async()=>{
 const {db,...context}=await posFinalDatabase();
 try{
  const source=await daySource(db,context.date);await closeDay(db,source,{actor:3});
  const before=await ledgerState(db);
  if(kind==='metadata')await db.exec('update pos_sales_receipts set revision=2 where id=1');
  if(kind==='total')await db.exec('update pos_sales_receipts set final_amount=200000 where id=1;update pos_sales_receipt_payments set amount=160000 where id=2');
  if(kind==='cash')await db.exec('update pos_sales_receipt_payments set amount=50000 where id=1;update pos_sales_receipt_payments set amount=50000 where id=2');
  if(kind==='card')await db.exec("update pos_sales_receipt_payments set payment_type=2,payment_name='Visa' where id=2");
  const current=await daySource(db,context.date);
  const result=await finalCheck(db,context,{source:current});
  assert.equal(result.status,kind==='unchanged'?'verified_unchanged':kind==='metadata'?'metadata_changed_only':'financial_drift');
  assert.deepEqual(await ledgerState(db),before);
  const check=(await db.query('select * from pos_sales_business_day_close_checks')).rows[0];
  assert.equal(Number(check.total_delta),kind==='total'?100000:0);
  if(kind==='cash')assert.equal(Number(check.bucket_delta.cash),10000);
  if(kind==='card')assert.equal(Number(check.bucket_delta.card),60000);
  assert.equal((await finalCheck(db,context,{source:current})).checkId,result.checkId);
  assert.equal((await db.query('select count(*)::int n from pos_sales_business_day_close_checks')).rows[0].n,1);
 }finally{await db.close();}
});
test('no closure auto closes as system actor, repeated check has one close and check',async()=>{
 const {db,...context}=await posFinalDatabase();
 try{
  const source=await daySource(db,context.date);
  const result=await finalCheck(db,context,{source});assert.equal(result.status,'verified_unchanged');assert.equal(result.closeResult.status,'closed');
  const before=await ledgerState(db);
  assert.equal(before.closures[0].close_method,'automatic');assert.equal(before.closures[0].closed_by,2);
  assert.equal((await finalCheck(db,context,{source})).checkId,result.checkId);assert.deepEqual(await ledgerState(db),before);
 }finally{await db.close();}
});
test('failed sync/source checks persist idempotently without projecting or closing',async()=>{
 const {db,...context}=await posFinalDatabase();
 try{for(const failure of ['sync_failed','source_invalid']){
 const result=await finalCheck(db,context,{failure,run:null});assert.equal(result.status,failure);
  const detail=(await db.query('select detail_snapshot from pos_sales_business_day_close_checks where id=$1',[result.checkId])).rows[0].detail_snapshot;
  assert.equal(detail.businessDate,context.date);assert.equal(detail.reason,failure);assert.ok(detail.cutoffAt);
  for(const key of ['failureCode','finalSync','retryExecuted','retryFailureReason','syncRunId'])assert.ok(key in detail);
  assert.equal((await finalCheck(db,context,{failure,run:null})).checkId,result.checkId);
 }assert.equal((await ledgerState(db)).transactions.length,0);assert.equal((await ledgerState(db)).closures.length,0);
 }finally{await db.close();}
});
test('month-closed automatic close is a distinct blocker and never projects',async()=>{
 const {db,...context}=await posFinalDatabase();
 try{
  await db.query('insert into ledger_month_closures(month) values($1)',[context.date.slice(0,7)+'-01']);
  const before=await ledgerState(db),result=await finalCheck(db,context,{source:await daySource(db,context.date)});
  assert.equal(result.status,'month_closed');assert.deepEqual(await ledgerState(db),before);
  const check=(await db.query('select * from pos_sales_business_day_close_checks')).rows[0];
  assert.equal(check.result,'month_closed');assert.equal(check.detail_snapshot.failureCode,'month_closed');
  assert.equal(check.closure_id,null);
 }finally{await db.close();}
});
test('check insert failure rolls back the automatic closure, Ledger and audits',async()=>{
 const {db,...context}=await posFinalDatabase();
 try{
  const before=await ledgerState(db),source=await daySource(db,context.date);
  await db.exec("create function reject_final_check_test() returns trigger language plpgsql as $$ begin raise exception 'TEST_CHECK_INSERT_FAILURE';end $$;create trigger reject_final_check_test before insert on pos_sales_business_day_close_checks for each row execute function reject_final_check_test();");
  await assert.rejects(finalCheck(db,context,{source}),/TEST_CHECK_INSERT_FAILURE/);
  assert.deepEqual(await ledgerState(db),before);
  assert.equal((await db.query('select count(*)::int n from pos_sales_business_day_close_checks')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from pos_sales_close_private.final_check_leases')).rows[0].n,0);
 }finally{await db.close();}
});
test('lease TTL, wrong token/actor, expiration and crash reclaim are enforced',async()=>{
 const {db,...context}=await posFinalDatabase();
 try{
  const first=await claimFinal(db,context.date),source=await daySource(db,context.date);
  const ttl=Number((await db.query('select extract(epoch from expires_at-clock_timestamp()) ttl from pos_sales_close_private.final_check_leases')).rows[0].ttl);
  assert.ok(ttl>590&&ttl<=600);
  const invoke=(token,actor=2)=>db.query('select sales_finalize_business_day_v1($1,$2,$3,$4,100,$5,$6::jsonb,$7::jsonb)',[context.date,actor,token,context.cutoffAt,source.sourceFingerprint,JSON.stringify(source.sourceSnapshot),JSON.stringify(source.rows)]);
  await assert.rejects(invoke('00000000-0000-0000-0000-000000000000'),/LEASE_EXPIRED/);
  await assert.rejects(invoke(first.token,1),/FORBIDDEN/);
  await db.exec("update pos_sales_close_private.final_check_leases set expires_at=clock_timestamp()-interval '1 second'");
  await assert.rejects(invoke(first.token),/LEASE_EXPIRED/);
  const next=await claimFinal(db,context.date);assert.equal(next.status,'claimed');assert.notEqual(next.token,first.token);
  await assert.rejects(invoke(first.token),/LEASE_EXPIRED/);
  await releaseFinal(db,context.date,first.token);assert.equal((await claimFinal(db,context.date)).status,'in_progress');
  await releaseFinal(db,context.date,next.token);assert.equal((await db.query('select count(*)::int n from pos_sales_close_private.final_check_leases')).rows[0].n,0);
 }finally{await db.close();}
});
test('missing completeness, pre-cutoff and mismatch fail closed; auto projection failure rolls back check',async()=>{
 const {db,...context}=await posFinalDatabase();
 try{
  const source=await daySource(db,context.date);
  await db.exec('update pos_sales_sync_runs set source_complete=null where id=100');
  await assert.rejects(finalCheck(db,context,{source}),/POS_FINAL_SYNC_REQUIRED/);
  await db.query("update pos_sales_sync_runs set source_complete=true,started_at=$1::timestamptz-interval '1 minute' where id=100",[context.cutoffAt]);
  await assert.rejects(finalCheck(db,context,{source}),/POS_FINAL_SYNC_REQUIRED/);
  await db.exec("update pos_sales_sync_runs set started_at=clock_timestamp()-interval '2 minutes' where id=100;update pos_sales_receipt_payments set amount=50000 where id=2");
  await assert.rejects(finalCheck(db,context,{source}),/MISMATCH/);
  await db.exec("update pos_sales_receipt_payments set amount=60000 where id=2;delete from ledger_payment_method_mappings where bucket='transfer'");
  await assert.rejects(finalCheck(db,context,{source}),/PROJECTION_FAILED/);
  assert.equal((await ledgerState(db)).transactions.length,0);assert.equal((await db.query('select count(*)::int n from pos_sales_business_day_close_checks')).rows[0].n,0);
 }finally{await db.close();}
});
test('lease prevents overlapping cron; check history and grants are immutable',async()=>{
 const {db,...context}=await posFinalDatabase();
 try{
  const first=await claimFinal(db,context.date);assert.equal(first.status,'claimed');assert.equal((await claimFinal(db,context.date)).status,'in_progress');
  await releaseFinal(db,context.date,first.token);
  await finalCheck(db,context,{source:await daySource(db,context.date)});
  for(const sql of ["update pos_sales_business_day_close_checks set result='sync_failed'",'delete from pos_sales_business_day_close_checks','truncate pos_sales_business_day_close_checks'])await assert.rejects(db.exec(sql),/IMMUTABLE/);
  await db.exec('set role service_role');await assert.rejects(db.exec('delete from pos_sales_business_day_close_checks'),/permission denied/);
  await db.exec('reset role');
  await assert.rejects(db.query('select sales_claim_business_day_final_check_v1($1,3)',[context.date]),/FORBIDDEN/);
  await db.exec('set role anon');await assert.rejects(db.query('select sales_claim_business_day_final_check_v1($1,2)',[context.date]),/permission denied/);
 }finally{await db.close();}
});

test('after-sync manual wrapper preserves manager initial permission, card/month locks and fresh completeness',async()=>{
 const {db,...context}=await posFinalDatabase();
 const invoke=async(source,actor=1,reclose=false)=>(await db.query('select sales_close_business_day_after_sync_v1($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,100) result',
  [context.date,source.sourceFingerprint,JSON.stringify(source.sourceSnapshot),JSON.stringify(source.rows),actor,'manual',reclose])).rows[0].result;
 try{
  await db.exec("update pos_sales_receipt_payments set payment_type=2,payment_name='Visa' where id=2");
  const source=await daySource(db,context.date);
  await db.exec('update pos_sales_sync_runs set source_complete=null where id=100');await assert.rejects(invoke(source,3),/SOURCE_INVALID/);
  await db.exec('update pos_sales_sync_runs set source_complete=true where id=100');assert.equal((await invoke(source,3)).status,'closed');
  assert.equal((await invoke(source,3,true)).status,'forbidden');
  await addCardSettlement(db,'partial',context.date);
  const before=await ledgerState(db);
  await db.exec('update pos_sales_receipts set final_amount=110000 where id=1;update pos_sales_receipt_payments set amount=70000 where id=2');
  const changed=await daySource(db,context.date);assert.equal((await invoke(changed,1,true)).status,'card_settlement_locked');assert.deepEqual(await ledgerState(db),before);
  await db.query('insert into ledger_month_closures(month) values($1)',[context.date.slice(0,7)+'-01']);assert.equal((await invoke(changed,2,true)).status,'month_closed');assert.deepEqual(await ledgerState(db),before);
 }finally{await db.close();}
});
test('running POS source cannot authorize manual projection or scheduled final projection',async()=>{
 const {db,...context}=await posFinalDatabase();
 try{
  const source=await daySource(db,context.date);
  await db.query("insert into pos_sales_sync_runs(id,business_date,status) values(101,$1,'running')",[context.date]);
  await assert.rejects(finalCheck(db,context,{source}),/SYNC_RUNNING/);
  await assert.rejects(db.query('select sales_close_business_day_after_sync_v1($1,$2,$3::jsonb,$4::jsonb,1,$5,false,100)',
   [context.date,source.sourceFingerprint,JSON.stringify(source.sourceSnapshot),JSON.stringify(source.rows),'manual']),/SOURCE_INVALID/);
  assert.equal((await ledgerState(db)).transactions.length,0);assert.equal((await ledgerState(db)).closures.length,0);
 }finally{await db.close();}
});
test('final check still audits an existing closed month without changing Ledger; zero days auto close',async()=>{
 const {db,...context}=await posFinalDatabase();
 try{
  const source=await daySource(db,context.date);await closeDay(db,source);
  await db.query('insert into ledger_month_closures(month) values($1)',[context.date.slice(0,7)+'-01']);
  const before=await ledgerState(db);assert.equal((await finalCheck(db,context,{source})).status,'verified_unchanged');assert.deepEqual(await ledgerState(db),before);
 }finally{await db.close();}
 const other=await posFinalDatabase();
 try{
  await other.db.exec('update pos_sales_receipts set final_amount=0 where id=1;update pos_sales_receipt_payments set amount=0 where receipt_id=1');
  assert.equal((await finalCheck(other.db,other,{source:await daySource(other.db,other.date)})).status,'verified_unchanged');assert.equal((await ledgerState(other.db)).transactions.length,0);
 }finally{await other.db.close();}
});
