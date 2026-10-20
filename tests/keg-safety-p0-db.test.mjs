import assert from 'node:assert/strict';
import test,{before,after,beforeEach} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupKegSafety,seedKegSafety,previewKeg,applyKeg,kegState} from './helpers/keg-safety-fixture.mjs';
let db;before(async()=>{db=new PGlite();await setupKegSafety(db);});after(async()=>{await db?.close();});beforeEach(async()=>{await seedKegSafety(db);});

test('time preview is read-only and boundary 330ml/2700ml recalculation saves atomically with audit',async()=>{
 const before=await kegState(db),p=await previewKeg(db);assert.deepEqual(await kegState(db),before);
 assert.equal(p.storedSoldMl,330);assert.equal(p.posBeforeSoldMl,330);assert.equal(p.soldMl,3030);assert.equal(p.lossMl,26970);assert.equal(p.soldDeltaMl,2700);assert.equal(p.snapshotMismatch,false);
 const r=await applyKeg(db,p);assert.equal(r.ok,true);const state=await kegState(db);
 assert.equal(state.inventory[0].quantity,10);assert.equal(state.logs.length,1);assert.equal(state.sessions[0].sold_quantity,3030);assert.equal(state.sessions[0].loss_quantity,26970);assert.equal(state.sessions[0].loss_rate,0.899);
 assert.equal(state.sessions[0].ended_at,state.sessions[1].started_at);assert.equal(state.audit.length,1);assert.equal(state.audit[0].actor_username,'alice');assert.equal(state.audit[0].before_state.previous.sold_quantity,330);assert.equal(state.audit[0].after_state.previous.sold_quantity,3030);
});

test('330ml glasses and both 2700/3000ml towers respect half-open boundaries',async()=>{
 for(const tower of [2700,3000]){await seedKegSafety(db,{tower});let p=await previewKeg(db,{at:'2026-07-10T10:00Z'});assert.equal(p.soldMl,330);p=await previewKeg(db);assert.equal(p.soldMl,330+tower);p=await previewKeg(db,{at:'2026-07-10T10:31Z'});assert.equal(p.soldMl,660+tower);}
});

test('receipt cancellation/exclusion and delayed POS sync invalidate a stale preview without writes',async()=>{
 let p=await previewKeg(db),state=await kegState(db);await db.exec('update pos_sales_receipts set is_canceled=true where id=2');await assert.rejects(applyKeg(db,p),/KEG_STALE_PREVIEW/);assert.deepEqual(await kegState(db),state);
 p=await previewKeg(db);assert.equal(p.soldMl,330);await db.exec('update pos_sales_receipts set is_canceled=false where id=2;update pos_sales_receipt_lines set is_excluded=true where id=2');p=await previewKeg(db);assert.equal(p.soldMl,330);
 await db.exec("insert into pos_sales_receipts values(9,'2026-07-10T09:50Z',now(),now(),3,false);insert into pos_sales_receipt_lines(id,receipt_id,item_id,quantity,payment_status,ref_date,synced_at) values(9,9,'glass',1,3,'2026-07-10T09:50Z',now())");p=await previewKeg(db);assert.equal(p.snapshotMismatch,true);await assert.rejects(applyKeg(db,p),/KEG_STORED_SNAPSHOT_MISMATCH/);assert.deepEqual(await kegState(db),state);
});

test('July L2 #22/#32, L3 #25 and October L3 #138 are isolated synthetic drift fixtures, never backfilled',async()=>{
 for(const [previousId,date]of [[22,'2026-07-10'],[32,'2026-07-12'],[25,'2026-07-11'],[138,'2026-10-11']]){
  await seedKegSafety(db,{previousId,activeId:previousId+1,date,drift:true,itemCode:previousId===22||previousId===32?'L2':'L3'});const state=await kegState(db),p=await previewKeg(db,{session:previousId+1,at:date+'T10:30Z'});assert.equal(p.snapshotMismatch,true);assert.equal(p.storedSoldMl,999);assert.equal(p.posBeforeSoldMl,330);await assert.rejects(applyKeg(db,p),/KEG_STORED_SNAPSHOT_MISMATCH/);assert.deepEqual(await kegState(db),state);
 }
});

test('future, before predecessor start, broken boundaries and missing actors are rejected',async()=>{
 const state=await kegState(db);await assert.rejects(previewKeg(db,{at:'2099-01-01T10:30Z'}),/KEG_FUTURE_TIME/);await assert.rejects(previewKeg(db,{at:'2026-07-10T08:59Z'}),/KEG_TIME_CONFLICT/);await assert.rejects(previewKeg(db,{actor:'spoof'}),/KEG_INVALID_ACTOR/);assert.deepEqual(await kegState(db),state);
 await db.exec("update inventory_keg_sessions set ended_at='2026-07-10T09:59Z' where status='closed'");await assert.rejects(previewKeg(db),/KEG_BOUNDARY_CONFLICT/);
});

test('normal replacement keeps the legacy -1 stock/log/session path and idempotent retry',async()=>{
 const p=await previewKeg(db,{action:'replace',at:'2026-07-10T11:00Z'});assert.deepEqual(p.warnings,[]);const r=await applyKeg(db,p);assert.equal(r.quantity,9);let state=await kegState(db);assert.equal(state.logs.length,2);assert.equal(state.sessions.filter(s=>s.status==='active').length,1);assert.equal(state.audit.length,1);
 const retry=await applyKeg(db,p);assert.equal(retry.replayed,true);assert.equal(retry.logId,r.logId);assert.deepEqual(await kegState(db),state);await assert.rejects(applyKeg(db,p,{reason:'different'}),/KEG_IDEMPOTENCY_CONFLICT/);assert.deepEqual(await kegState(db),state);
});

test('L3 0-minute/2-minute zero-sales replacements require explicit confirmation and reason, legitimate replacement allowed',async()=>{
 for(const at of ['2026-07-10T10:00Z','2026-07-10T10:02Z']){
  await seedKegSafety(db);await db.exec('update pos_sales_receipts set is_canceled=true where id=2');const p=await previewKeg(db,{action:'replace',at});assert.ok(p.warnings.includes('SHORT_INTERVAL'));assert.ok(p.warnings.includes('ZERO_SALES'));const state=await kegState(db);
  await assert.rejects(applyKeg(db,p,{reason:''}),/KEG_REASON_REQUIRED/);await assert.rejects(applyKeg(db,p),/KEG_CONFIRMATION_REQUIRED/);assert.deepEqual(await kegState(db),state);assert.equal((await applyKeg(db,p,{reason:'Real equipment replacement',confirmed:true})).quantity,9);
 }
});

test('two staff previews cannot both mutate after the first change, and time edits also reject stale versions',async()=>{
 const a=await previewKeg(db,{action:'replace',at:'2026-07-10T11:00Z'}),b=await previewKeg(db,{action:'replace',at:'2026-07-10T11:00Z',actor:'bob'});await applyKeg(db,a);await assert.rejects(applyKeg(db,b,{actor:'bob',key:'20000000-0000-4000-8000-000000000002'}),/KEG_QUANTITY_CONFLICT|KEG_STALE_PREVIEW/);
 await seedKegSafety(db);const first=await previewKeg(db),second=await previewKeg(db,{at:'2026-07-10T10:31Z'});await applyKeg(db,first);await assert.rejects(applyKeg(db,second,{key:'20000000-0000-4000-8000-000000000002'}),/KEG_STALE_PREVIEW/);
});

test('failures after active update, legacy replacement, or audit insert fully roll back',async()=>{
 for(const action of ['edit-start','replace']){
  await seedKegSafety(db);const p=await previewKeg(db,{action,at:'2026-07-10T11:00Z'}),state=await kegState(db);
  await db.exec("create function qa_fail_audit() returns trigger language plpgsql as $$begin raise exception 'qa injected audit failure'; end$$; create trigger qa_fail before insert on inventory_keg_safety_audit for each row execute function qa_fail_audit()");await assert.rejects(applyKeg(db,p),/qa injected/);assert.deepEqual(await kegState(db),state);await db.exec('drop trigger qa_fail on inventory_keg_safety_audit;drop function qa_fail_audit()');
 }
 const p=await previewKeg(db),state=await kegState(db);await db.exec("create function qa_fail_previous() returns trigger language plpgsql as $$begin if new.status='closed' then raise exception 'qa previous failure'; end if;return new;end$$;create trigger qa_fail before update on inventory_keg_sessions for each row execute function qa_fail_previous()");await assert.rejects(applyKeg(db,p),/qa previous failure/);assert.deepEqual(await kegState(db),state);await db.exec('drop trigger qa_fail on inventory_keg_sessions;drop function qa_fail_previous()');
});

test('new RPCs are service-role only and append-only audit is inaccessible to browser roles',async()=>{
 const rows=(await db.query("select rol,has_function_privilege(rol,'inventory_preview_keg_change(text,bigint,bigint,timestamptz,date,text,numeric)','execute') preview,has_function_privilege(rol,'inventory_apply_keg_change(text,bigint,bigint,timestamptz,date,text,numeric,text,uuid,text,boolean)','execute') apply,has_table_privilege(rol,'inventory_keg_safety_audit','select') read,has_table_privilege(rol,'inventory_keg_safety_audit','update') update from unnest(array['anon','authenticated','service_role']) rol")).rows;
 for(const r of rows){assert.equal(r.preview,r.rol==='service_role');assert.equal(r.apply,r.rol==='service_role');assert.equal(r.read,r.rol==='service_role');assert.equal(r.update,false);}
 assert.equal((await db.query("select relrowsecurity from pg_class where relname='inventory_keg_safety_audit'")).rows[0].relrowsecurity,true);
});

test('POS option/canceled/unpaid/receipt-unpaid rows never enter the boundary recomputation',async()=>{
 await db.exec("insert into pos_sales_receipts(id,ref_date,payment_status,is_canceled) select n,'2026-07-10T10:15Z',case when n=8 then 2 else 3 end,n=4 from generate_series(4,8) n;insert into pos_sales_receipt_lines(id,receipt_id,item_id,quantity,payment_status,ref_date,is_option,is_excluded,is_canceled) select n,n,'tower',10,case when n=7 then 2 else 3 end,'2026-07-10T10:15Z',n=5,false,n=6 from generate_series(4,8) n");
 const p=await previewKeg(db);assert.equal(p.soldMl,3030);assert.equal(p.salesBreakdown.towerUnits,1);assert.equal(p.snapshotMismatch,false);
});

test('preview works in a read-only transaction and zero-sales after a long interval still requires reconfirmation',async()=>{
 await db.exec('begin read only');try{assert.equal((await previewKeg(db)).soldMl,3030);}finally{await db.exec('rollback');}
 await db.exec('update pos_sales_receipts set is_canceled=true where id in (2,3)');const p=await previewKeg(db,{action:'replace',at:'2026-07-10T11:00Z'});assert.deepEqual(p.warnings,['ZERO_SALES']);await assert.rejects(applyKeg(db,p),/KEG_CONFIRMATION_REQUIRED/);assert.equal((await applyKeg(db,p,{confirmed:true,reason:'Verified zero sale replacement'})).quantity,9);
});


test('a real two-minute replacement with nonzero POS sales remains allowed after confirmation and reason',async()=>{
 const p=await previewKeg(db,{action:'replace',at:'2026-07-10T10:02Z'});assert.deepEqual(p.warnings,['SHORT_INTERVAL']);assert.equal(p.soldMl,2700);await assert.rejects(applyKeg(db,p),/KEG_CONFIRMATION_REQUIRED/);const r=await applyKeg(db,p,{confirmed:true,reason:'Damaged tap requires genuine replacement'});assert.equal(r.quantity,9);assert.equal((await kegState(db)).audit[0].reason,'Damaged tap requires genuine replacement');
});


test('first replacement without a prior active session also requires the zero-sale confirmation, not an inferred history',async()=>{
 await db.exec('delete from inventory_keg_sessions');const p=await previewKeg(db,{action:'replace',at:'2026-07-10T11:00Z'});assert.equal(p.activeSessionId,null);assert.deepEqual(p.warnings,['ZERO_SALES']);const before=await kegState(db);await assert.rejects(applyKeg(db,p,{reason:'\t\n',confirmed:true}),/KEG_REASON_REQUIRED/);await assert.rejects(applyKeg(db,p),/KEG_CONFIRMATION_REQUIRED/);assert.deepEqual(await kegState(db),before);const r=await applyKeg(db,p,{confirmed:true,reason:'Initial installation'});assert.equal(r.quantity,9);assert.equal(r.closedSession,null);
});


test('missing active POS mappings block a time preview rather than inventing zero sales',async()=>{
 await db.exec('update inventory_keg_tracking_mappings set is_active=false');const state=await kegState(db);await assert.rejects(previewKeg(db),/KEG_MAPPING_NOT_FOUND/);assert.deepEqual(await kegState(db),state);
});


test('preview tokens are stable across pooled connection timezone settings',async()=>{
 const p=await previewKeg(db);await db.exec("set timezone='Asia/Seoul'");try{const q=await previewKeg(db);assert.equal(q.previewToken,p.previewToken);assert.equal((await applyKeg(db,p)).ok,true);}finally{await db.exec("set timezone='UTC'");}
});

test('Vietnam business date 03:00 cutoff is enforced on preview and save, including UTC/local midnight and year/month boundaries',async()=>{
 const cases=[['2026-07-10T17:00:00Z','2026-07-10'],['2026-07-10T19:59:59.999Z','2026-07-10'],['2026-07-10T20:00:00Z','2026-07-11'],['2026-07-11T03:00:00+07:00','2026-07-11'],['2026-01-31T20:00:00Z','2026-02-01'],['2025-12-31T19:59:59.999Z','2025-12-31'],['2025-12-31T20:00:00Z','2026-01-01']];
 for(const [at,businessDate] of cases){
  await seedKegSafety(db);await db.exec('delete from inventory_keg_sessions');const before=await kegState(db);
  const p=await previewKeg(db,{action:'replace',at,businessDate});assert.equal(p.businessDate,businessDate);assert.deepEqual(await kegState(db),before);
  const wrongDate=businessDate==='2026-07-10'?'2026-07-11':'2026-07-10';
  await assert.rejects(previewKeg(db,{action:'replace',at,businessDate:wrongDate}),/KEG_BUSINESS_DATE_MISMATCH/);
  await assert.rejects(applyKeg(db,{...p,businessDate:wrongDate},{confirmed:true}),/KEG_BUSINESS_DATE_MISMATCH/);assert.deepEqual(await kegState(db),before);
  await applyKeg(db,p,{confirmed:true});assert.equal((await kegState(db)).sessions[0].started_business_date,businessDate);
 }
});

test('first 20L session time edit has no closed-session sales/loss estimate or full-capacity loss',async()=>{
 await db.exec("delete from inventory_keg_sessions where status='closed';update inventory_keg_sessions set capacity_quantity=20000;update inventory set package_content_quantity=20000");
 const before=await kegState(db),p=await previewKeg(db);
 assert.equal(p.previousSessionId,null);assert.equal(p.capacityMl,20000);
 for(const k of ['soldMl','lossMl','overageMl','usagePercent','storedSoldMl','storedLossMl','posBeforeSoldMl','posBeforeLossMl','soldDeltaMl','lossDeltaMl','priorDriftMl','salesBreakdown'])assert.equal(p[k],null,k);
 assert.equal(p.snapshotMismatch,false);assert.deepEqual(p.warnings,[]);assert.deepEqual(await kegState(db),before);
 await applyKeg(db,p);const after=await kegState(db);assert.equal(after.sessions.length,1);assert.equal(after.sessions[0].started_at,p.replacementAt);assert.equal(after.sessions[0].sold_quantity,null);assert.equal(after.sessions[0].loss_quantity,null);assert.deepEqual(after.inventory,before.inventory);assert.deepEqual(after.logs,before.logs);assert.equal(after.audit[0].before_state.preview.lossMl,null);
});

test('synthetic L3 closed session #141: six late 330mL POS glasses (+1980mL) block stale and fresh mismatch saves',async()=>{
 // Only the supplied ID and +6 glasses reproduce the reported case; dates/base totals are synthetic.
 await seedKegSafety(db,{previousId:141,activeId:142,date:'2026-10-15',itemCode:'L3'});
 const state=await kegState(db),p=await previewKeg(db,{session:142,at:'2026-10-15T10:30Z'});assert.equal(p.snapshotMismatch,false);
 await db.exec("insert into pos_sales_receipts(id,ref_date,synced_at,updated_at,payment_status,is_canceled) select n,'2026-10-15T09:50Z','2026-10-20T01:00Z','2026-10-20T01:00Z',3,false from generate_series(14101,14106) n;insert into pos_sales_receipt_lines(id,receipt_id,item_id,quantity,payment_status,ref_date,synced_at) select n,n,'glass',1,3,'2026-10-15T09:50Z','2026-10-20T01:00Z' from generate_series(14101,14106) n");
 await assert.rejects(applyKeg(db,p),/KEG_STALE_PREVIEW/);
 const q=await previewKeg(db,{session:142,at:'2026-10-15T10:30Z'});assert.equal(q.previousSessionId,141);assert.equal(q.storedSoldMl,330);assert.equal(q.posBeforeSoldMl,2310);assert.equal(q.priorDriftMl,1980);assert.equal(q.posBeforeLossMl,27690);assert.equal(q.storedLossMl,29670);assert.equal(q.snapshotMismatch,true);
 await assert.rejects(applyKeg(db,q),/KEG_STORED_SNAPSHOT_MISMATCH/);assert.deepEqual(await kegState(db),state);
});