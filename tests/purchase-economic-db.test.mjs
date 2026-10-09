import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { database } from '../tests/helpers/inventory-ledger-fixture.mjs';
const one=async(db,sql)=>(await db.query(sql)).rows[0];
const rpc=async(db,name,...args)=>(await db.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
const project=db=>rpc(db,'ledger_project_inventory_purchase_log_v1',12008,2);
const preview=db=>rpc(db,'ledger_inventory_purchase_repair_preview_v1',12008,2);
const resolve=(db,root=12007)=>rpc(db,'ledger_resolve_inventory_purchase_correction_v1',12008,root,2);
async function applyCurrentPaymentContract(db) {
 const verification=readFileSync('supabase/migrations/20260921170100_add_inventory_payment_verification.sql','utf8');
 // Use actual resolver/sync/rebook/projection amendments; isolate unrelated month preflight schema.
 await db.exec(verification.slice(0,verification.indexOf('  -- Keep the existing preflight'))+'end;\n$payment_verification$;');
}
async function milan({paymentMode='postpaid',source='quick_save',delta=-1,price=80000,linked=false}={}) {
 const db=await database();
 await db.exec('alter table inventory_logs add column prev_supplier text,add column prev_purchase_supplier_partner_id bigint');
 await applyCurrentPaymentContract(db);
 for(const name of ['20261007182027_resolve_inventory_purchase_projection.sql','20261009080243_detect_inventory_purchase_economic_corrections.sql'])await db.exec(readFileSync('supabase/migrations/'+name,'utf8'));
 await db.exec(`update business_partners set name='Milan Food',payment_mode='${paymentMode}',default_fund_account_id=null where id=10;
 update inventory_logs set id=12007,unit='kg',item_name='Chicken breast',change_quantity=1,new_purchase_price=80000,new_supplier='Milan Food',purchase_supplier_partner_id=10,business_date='2026-09-26',created_at='2026-09-26T10:00:00Z',source='quick_save' where id=100;
 select setval(pg_get_serial_sequence('ledger_candidates','id'),1363,true);select setval(pg_get_serial_sequence('ledger_transactions','id'),1961,true);select setval(pg_get_serial_sequence('ledger_payables','id'),865,true);select ledger_project_inventory_purchase_log_v1(12007,2);`);
 await db.query(`insert into inventory_logs(id,item_id,item_name,unit,change_quantity,new_purchase_price,new_supplier,purchase_supplier_partner_id,business_date,created_at,source,reason,source_actor_user_id,correction_of_inventory_log_id) values(12008,1,'Chicken breast','kg',$1,$2,'Milan Food',10,'2026-09-26','2026-09-26T10:00:07Z',$3,'purchase',1,$4)`,[delta,price,source,linked?12007:null]);await db.exec("update inventory_logs set prev_supplier='Milan Food' where id=12008");return db;
}
const counts=db=>one(db,`select (select count(*) from ledger_transactions) as transactions,(select count(*) from ledger_payables) as payables,(select count(*) from ledger_audit_logs) as audits`);
test('Milan full cancellation: reversal only, unpaid cancelled, zero cash, evidence and identical retry',async()=>{
 const db=await milan();try{
 assert.equal((await project(db)).code,'PURCHASE_CORRECTION_REFERENCE_REQUIRED');const p=await preview(db);assert.equal(p.candidates[0].newAmount,0);assert.equal(p.candidates[0].safe,true);
 const original=await one(db,'select to_jsonb(t) as row from ledger_transactions t where id=1962');
 const result=await resolve(db);assert.equal(result.status,'synced');
 assert.deepEqual((await one(db,'select to_jsonb(t) as row from ledger_transactions t where id=1962')).row,original.row);
 const reversals=(await db.query("select * from ledger_transactions where source_type='inventory_purchase_reversal'")).rows;
 assert.equal(reversals.length,1);assert.equal(Number(reversals[0].amount),80000);assert.equal(reversals[0].economic_effect_sign,-1);assert.equal(Number(reversals[0].correction_of_id),1962);
 assert.equal(Number((await one(db,"select count(*) as n from ledger_transactions where source_type='inventory_purchase_rebook' or amount<=0")).n),0);
 assert.equal(Number((await one(db,'select count(*) as n from ledger_payables')).n),1);
 const candidate=await one(db,'select * from ledger_candidates where id=1364');assert.equal(candidate.resolved_transaction_id,null);assert.equal(candidate.dismissal_reason,'Inventory purchase fully cancelled');
 assert.equal(Number((await one(db,'select correction_of_inventory_log_id as root from inventory_logs where id=12008')).root),12007);
 const cancelAudit=await one(db,"select after_snapshot from ledger_audit_logs where action='inventory_source_rebooked'");assert.equal(cancelAudit.after_snapshot.finalAmount,0);assert.equal(cancelAudit.after_snapshot.rebookTransactionId,null);assert.equal(cancelAudit.after_snapshot.newPayableId,null);assert.equal((await one(db,'select status from ledger_payables where id=866')).status,'cancelled');assert.equal((await one(db,'select status from ledger_candidates where id=1364')).status,'dismissed');
 assert.equal(Number((await one(db,'select amount from ledger_transactions where id=1962')).amount),80000);assert.equal(Number((await one(db,'select sum(amount*economic_effect_sign) as amount from ledger_transactions')).amount),0);assert.equal(Number((await one(db,'select count(*) as n from ledger_movements')).n),0);
 const before=await counts(db);assert.deepEqual(await resolve(db),result);assert.deepEqual(await counts(db),before);assert.equal((await project(db)).code,'PURCHASE_CANCELLED');assert.equal(Number((await one(db,'select count(*) as n from inventory_logs')).n),2);
 }finally{await db.close();}
});
for(const source of ['quick_save','edit_form'])test(source+' partial cancellation requires approval; rebooks 60000 once',async()=>{
 const db=await milan({source,delta:-0.25,linked:true});try{
 assert.equal((await project(db)).code,'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED');assert.equal((await counts(db)).transactions,1);assert.equal((await preview(db)).candidates[0].newAmount,60000);assert.equal((await resolve(db)).status,'synced');assert.equal(Number((await one(db,'select sum(amount*economic_effect_sign) as amount from ledger_transactions')).amount),60000);const before=await counts(db);await resolve(db);assert.deepEqual(await counts(db),before);
 }finally{await db.close();}
});
test('linked full cancellation shows original cancelled before confirmation',async()=>{const db=await milan({linked:true});try{assert.equal((await project(db)).code,'PURCHASE_ORIGINAL_CANCELLED');assert.equal((await counts(db)).transactions,1);assert.equal((await resolve(db)).status,'synced');}finally{await db.close();}});
test('metadata-only linked edit syncs immediately',async()=>{const db=await milan({source:'edit_form',delta:0,linked:true});try{await db.exec("update inventory_logs set item_name='Renamed' where id=12008");assert.equal((await project(db)).code,'METADATA_SYNCED');assert.equal((await counts(db)).transactions,1);assert.equal((await one(db,'select source_drift_snapshot from ledger_candidates where id=1364')).source_drift_snapshot.item_name,'Renamed');}finally{await db.close();}});
test('price-only quick_save edit requires confirmation',async()=>{const db=await milan({delta:0,price:90000,linked:true});try{assert.equal((await project(db)).code,'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED');assert.equal((await preview(db)).candidates[0].newAmount,90000);assert.equal((await resolve(db)).status,'synced');assert.equal(Number((await one(db,'select sum(amount*economic_effect_sign) as amount from ledger_transactions')).amount),90000);}finally{await db.close();}});
test('supplier change requires confirmation and new mapped payable party',async()=>{const db=await milan({delta:0,linked:true});try{await db.exec("update inventory_logs set new_supplier='Postpaid',purchase_supplier_partner_id=12 where id=12008");assert.equal((await project(db)).code,'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED');assert.equal((await resolve(db)).code,'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED');const check=(await preview(db)).candidates[0];assert.equal(check.safe,false);assert.equal(check.supplierChange.beforeSupplier,'Milan Food');assert.equal(check.supplierChange.afterSupplier,'Postpaid');assert.equal((await confirmSupplier(db,check)).status,'synced');assert.equal(Number((await one(db,"select party_id from ledger_transactions where source_type='inventory_purchase_rebook'")).party_id),12);}finally{await db.close();}});
for(const status of ['paid','partially_paid'])test(status+' blocks explicit approval',async()=>{const db=await milan({linked:true});try{await db.exec(`update ledger_payables set status='${status}' where id=866`);await project(db);assert.equal((await resolve(db)).code,'PAYABLE_ALREADY_PAID');assert.equal((await counts(db)).transactions,1);}finally{await db.close();}});
test('closed September blocks legacy NOT_A_PURCHASE; isolated reopen permits cancellation, cash unchanged',async()=>{
 const db=await milan();try{await db.exec("insert into ledger_inventory_projection_status(inventory_log_id,status,code) values(12008,'synced','NOT_A_PURCHASE');insert into ledger_month_closures(month) values('2026-09-01')");assert.equal((await preview(db)).candidates[0].code,'MONTH_CLOSED');assert.equal((await resolve(db)).code,'MONTH_CLOSED');assert.equal((await counts(db)).transactions,1);
 // Fixture closure state only; production month APIs must preserve revision snapshots.
 await db.exec("update ledger_month_closures set status='reopened' where month='2026-09-01'");assert.equal((await resolve(db)).status,'synced');await db.exec("update ledger_month_closures set status='closed' where month='2026-09-01'");assert.equal(Number((await one(db,'select coalesce(sum(amount),0) as cash from ledger_movements')).cash)+338845642,338845642);
 }finally{await db.close();}
});
test('ambiguous roots never auto-link',async()=>{const db=await milan();try{await db.exec("insert into inventory_logs select (jsonb_populate_record(null::inventory_logs,to_jsonb(l)||jsonb_build_object('id',12006))).* from inventory_logs l where id=12007;select ledger_project_inventory_purchase_log_v1(12006,2)");await project(db);const p=await preview(db);assert.equal(p.candidates.length,2);assert.equal(p.recommended,false);assert.equal((await one(db,'select correction_of_inventory_log_id as root from inventory_logs where id=12008')).root,null);}finally{await db.close();}});
for(const reason of ['sale','stock_check'])test(reason+' reduction is never purchase cancellation',async()=>{const db=await milan();try{await db.query('update inventory_logs set reason=$1 where id=12008',[reason]);assert.equal((await project(db)).code,'NOT_A_PURCHASE');assert.equal((await preview(db)).code,'ISSUE_NOT_RESOLVABLE');assert.equal((await counts(db)).transactions,1);}finally{await db.close();}});
test('direct original price drift can be confirmed without self-link',async()=>{const db=await milan();try{await db.exec("update inventory_logs set new_purchase_price=90000 where id=12007");assert.equal((await rpc(db,'ledger_project_inventory_purchase_log_v1',12007,2)).code,'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED');assert.equal((await rpc(db,'ledger_inventory_purchase_repair_preview_v1',12007,2)).candidates[0].newAmount,90000);assert.equal((await rpc(db,'ledger_resolve_inventory_purchase_correction_v1',12007,12007,2)).status,'synced');assert.equal((await one(db,'select correction_of_inventory_log_id as root from inventory_logs where id=12007')).root,null);}finally{await db.close();}});
test('already cash-paid original blocks cancellation and preserves cash movement',async()=>{const db=await milan();try{
 await db.exec("delete from ledger_payables where id=866;insert into ledger_movements(transaction_id,fund_account_id,amount) values(1962,1,-80000)");await project(db);assert.equal((await resolve(db)).code,'PAYABLE_ALREADY_PAID');assert.equal((await counts(db)).transactions,1);assert.equal(Number((await one(db,'select sum(amount) as amount from ledger_movements')).amount),-80000);
}finally{await db.close();}});
test('allocation blocks cancellation even when payable says unpaid',async()=>{const db=await milan();try{await db.exec("insert into ledger_payable_allocations(payable_id,payment_transaction_id,allocated_amount) values(866,1962,1000)");await project(db);assert.equal((await resolve(db)).code,'PAYABLE_ALREADY_PAID');assert.equal((await counts(db)).transactions,1);}finally{await db.close();}});
test('excess reduction is blocked before link or audit',async()=>{const db=await milan({delta:-1.1});try{await project(db);const before=await counts(db);assert.equal((await resolve(db)).code,'PURCHASE_CORRECTION_EXCEEDS_PURCHASE');assert.deepEqual(await counts(db),before);}finally{await db.close();}});
test('invalid projection rolls back link, payable and audit atomically',async()=>{const db=await milan();try{
 await project(db);const before=await counts(db);
 await db.exec(`create or replace function ledger_project_inventory_purchase_log_v1(p_inventory_log_id bigint,p_request_actor_user_id bigint) returns jsonb language plpgsql as $$begin update ledger_payables set status='cancelled';return '{"status":"review_required","code":"TEST_BLOCKED"}'::jsonb;end$$`);
 assert.equal((await resolve(db)).code,'TEST_BLOCKED');assert.deepEqual(await counts(db),before);assert.equal((await one(db,'select status from ledger_payables where id=866')).status,'unpaid');assert.equal((await one(db,'select correction_of_inventory_log_id as root from inventory_logs where id=12008')).root,null);
}finally{await db.close();}});
test('RPC permissions and owner/master checks remain restricted',async()=>{const db=await milan();try{
 await project(db);assert.equal((await rpc(db,'ledger_resolve_inventory_purchase_correction_v1',12008,12007,1)).code,'FORBIDDEN');
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(resolve(db),/permission denied/);await db.exec('reset role');}
 for(const signature of ['inventory_ledger_private.inspect_purchase_repair(bigint,bigint)','inventory_ledger_private.economics(jsonb)','public.inventory_purchase_correction_guard_v1()'])assert.equal((await db.query("select has_function_privilege('service_role',$1,'EXECUTE') as allowed",[signature])).rows[0].allowed,false);
}finally{await db.close();}});
test('pear #12655 regression on new SQL: 49700 -> 46200, no repeat repair effects',async()=>{
 const db=await database();try{
 await applyCurrentPaymentContract(db);
 for(const name of ['20261007182027_resolve_inventory_purchase_projection.sql','20261009080243_detect_inventory_purchase_economic_corrections.sql'])await db.exec(readFileSync('supabase/migrations/'+name,'utf8'));
 await db.exec(`update business_partners set payment_mode='postpaid',default_fund_account_id=null where id=10;update inventory_logs set id=12581,item_id=314,unit='kg',change_quantity=1.42,new_purchase_price=35000,purchase_supplier_partner_id=10,business_date='2026-10-05',created_at='2026-10-05T10:00:00Z' where id=100;select ledger_project_inventory_purchase_log_v1(12581,2);
 insert into inventory_logs(id,item_id,unit,change_quantity,new_purchase_price,new_supplier,purchase_supplier_partner_id,business_date,created_at,source,reason,source_actor_user_id) values(12655,314,'kg',-0.1,35000,'Won Mart',10,'2026-10-06','2026-10-06T10:00:00Z','edit_form','purchase',1);select ledger_project_inventory_purchase_log_v1(12655,2)`);
 const p=await rpc(db,'ledger_inventory_purchase_repair_preview_v1',12655,2);assert.equal(p.candidates[0].oldAmount,49700);assert.equal(p.candidates[0].newAmount,46200);
 const result=await rpc(db,'ledger_resolve_inventory_purchase_correction_v1',12655,12581,2);assert.equal(result.status,'synced');const before=await counts(db);assert.deepEqual(await rpc(db,'ledger_resolve_inventory_purchase_correction_v1',12655,12581,2),result);assert.deepEqual(await counts(db),before);assert.equal(Number((await one(db,'select sum(amount*economic_effect_sign) as amount from ledger_transactions')).amount),46200);
}finally{await db.close();}});
test('real reopen/reclose RPC retains September revision 2, records revision 3 and unchanged cash',async()=>{
 const db=await milan();try{
 const month=readFileSync('supabase/migrations/202608210008_add_ledger_month_close_corrections.sql','utf8');
 await db.exec('drop table ledger_month_closures');await db.exec(month.slice(month.indexOf('create table public.ledger_month_closures'),month.indexOf('alter table public.ledger_transactions')));
 const reopen=readFileSync('supabase/migrations/20260916161512_add_ledger_month_reopen.sql','utf8');await db.exec(reopen.slice(0,reopen.indexOf('-- Keep the current profit-capacity')));
 // Isolate other business domains: run actual reopen/close functions with a deterministic preflight contract.
 await db.exec(`create function ledger_close_preflight_v1(date,bigint) returns jsonb language sql as $$select jsonb_build_object('status','ok','preflightHash','isolated','canClose',not exists(select 1 from ledger_inventory_projection_status where status in ('failed','review_required')),'warnings','[]'::jsonb,'blockers','[]'::jsonb)$$;
 insert into ledger_month_closures(month,closed_by,preflight_snapshot,summary_snapshot,snapshot_hash,revision) values('2026-09-01',2,'{}','{"finalFunds":338845642}',repeat('a',64),2);`);
 await project(db);assert.equal((await resolve(db)).code,'MONTH_CLOSED');
 assert.equal((await rpc(db,'ledger_reopen_month_v1','2026-09-01','Milan purchase cancellation isolated test',2)).status,'reopened');
 assert.equal((await one(db,'select revision,summary_snapshot from ledger_month_closure_history')).revision,2);
 assert.equal((await resolve(db)).status,'synced');
 const result=await rpc(db,'ledger_close_month_v1','2026-09-01','isolated',{}, {finalFunds:338845642},'b'.repeat(64),2);assert.equal(result.status,'closed');assert.equal(result.revision,3);
 assert.equal((await one(db,'select summary_snapshot from ledger_month_closures')).summary_snapshot.finalFunds,338845642);
 assert.equal((await one(db,'select summary_snapshot from ledger_month_closure_history')).summary_snapshot.finalFunds,338845642);
 assert.equal(Number((await one(db,'select count(*) as n from ledger_movements')).n),0);
 for(const action of ['month_reopen','month_reclose','inventory_source_rebooked'])assert.equal(Number((await db.query('select count(*) as n from ledger_audit_logs where action=$1',[action])).rows[0].n),1);
}finally{await db.close();}});

test('note-only correction preserves memo evidence without rebook or false economic review',async()=>{
 const db=await milan({delta:0,linked:true});try{await db.exec("alter table inventory_logs add column new_note text;update inventory_logs set new_note='Supplier note only' where id=12008");assert.equal((await project(db)).status,'synced');assert.equal((await counts(db)).transactions,1);assert.equal((await one(db,'select new_note from inventory_logs where id=12008')).new_note,'Supplier note only');}finally{await db.close();}
});
test('original create source drift remains reviewable and confirmable',async()=>{
 const db=await milan();try{await db.exec("update inventory_logs set source='create',new_purchase_price=90000 where id=12007");assert.equal((await rpc(db,'ledger_project_inventory_purchase_log_v1',12007,2)).code,'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED');assert.equal((await rpc(db,'ledger_resolve_inventory_purchase_correction_v1',12007,12007,2)).status,'synced');}finally{await db.close();}
});
test('manual amount override cannot be undone by correction confirmation',async()=>{
 const db=await milan();try{await db.exec('update ledger_transactions set amount=79000 where id=1962');await project(db);assert.equal((await resolve(db)).code,'MANUAL_LEDGER_OVERRIDE');assert.equal((await counts(db)).transactions,1);}finally{await db.close();}
});

const supplierConfirmation = check => ({confirmed:true,fingerprint:check.supplierChange.confirmationFingerprint});
const confirmSupplier = (db,check,root=12007,actor=2,confirmation=supplierConfirmation(check)) => rpc(db,'ledger_resolve_inventory_purchase_correction_v2',12008,root,actor,confirmation);
async function changeSupplier(db,extra='') {
 await db.exec("update inventory_logs set new_supplier='Postpaid',purchase_supplier_partner_id=12 "+extra+" where id=12008");await project(db);
 return (await preview(db)).candidates.find(c=>Number(c.inventoryLogId)===12007);
}
test('different supplier without previous-supplier proof cannot link through either RPC or guard',async()=>{
 const db=await milan({delta:0});try{
 await db.exec("update inventory_logs set prev_supplier=null,new_supplier='Postpaid',purchase_supplier_partner_id=12 where id=12008");await project(db);
 const check=(await preview(db)).candidates[0];assert.equal(check.code,'SUPPLIER_REFERENCE_REQUIRED');const before=await counts(db);
 assert.equal((await resolve(db)).code,'SUPPLIER_REFERENCE_REQUIRED');assert.equal((await confirmSupplier(db,check)).code,'SUPPLIER_REFERENCE_REQUIRED');
 await assert.rejects(db.exec('update inventory_logs set correction_of_inventory_log_id=12007 where id=12008'),/SUPPLIER_REFERENCE_REQUIRED/);assert.deepEqual(await counts(db),before);
 }finally{await db.close();}
});
test('matching current supplier cannot mask a different previous supplier or wrong root',async()=>{
 const db=await milan({delta:0});try{
 await db.exec("insert into inventory_logs select (jsonb_populate_record(null::inventory_logs,to_jsonb(l)||jsonb_build_object('id',12006,'new_supplier','Postpaid','purchase_supplier_partner_id',12))).* from inventory_logs l where id=12007;select ledger_project_inventory_purchase_log_v1(12006,2)");
 const correct=await changeSupplier(db);const p=await preview(db);assert.equal(p.recommended,false);
 const wrong=p.candidates.find(c=>Number(c.inventoryLogId)===12006);assert.equal(wrong.code,'SUPPLIER_MISMATCH');assert.equal(wrong.safe,false);
 const before=await counts(db);assert.equal((await resolve(db,12006)).code,'SUPPLIER_MISMATCH');assert.equal((await confirmSupplier(db,correct,12006)).code,'SUPPLIER_MISMATCH');
 await assert.rejects(db.exec('update inventory_logs set correction_of_inventory_log_id=12006 where id=12008'),/SUPPLIER_MISMATCH/);assert.deepEqual(await counts(db),before);
 assert.equal((await confirmSupplier(db,correct)).status,'synced');assert.equal(Number((await one(db,'select correction_of_inventory_log_id as root from inventory_logs where id=12008')).root),12007);
 }finally{await db.close();}
});
test('supplier confirmation requires true boolean, current fingerprint, owner and audited idempotency',async()=>{
 const db=await milan({delta:0});try{
 const check=await changeSupplier(db);assert.equal(check.code,'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED');assert.equal(check.supplierChange.beforePartnerId,'10');assert.equal(check.supplierChange.afterPartnerId,'12');
 const before=await counts(db);assert.equal((await resolve(db)).code,'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED');
 for(const confirmation of [null,{}, {confirmed:false,fingerprint:check.supplierChange.confirmationFingerprint},{confirmed:'true',fingerprint:check.supplierChange.confirmationFingerprint}])assert.equal((await confirmSupplier(db,check,12007,2,confirmation)).code,'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED');
 assert.equal((await confirmSupplier(db,check,12007,2,{confirmed:true,fingerprint:'stale'})).code,'SUPPLIER_CHANGE_CONFIRMATION_STALE');
 assert.equal((await confirmSupplier(db,check,12007,1)).code,'FORBIDDEN');assert.deepEqual(await counts(db),before);
 const result=await confirmSupplier(db,check);assert.equal(result.status,'synced');const after=await counts(db);assert.deepEqual(await confirmSupplier(db,check),result);assert.deepEqual(await counts(db),after);
 const audit=await one(db,"select after_snapshot from ledger_audit_logs where action='inventory_purchase_correction_linked'");assert.deepEqual(audit.after_snapshot.supplierConfirmation,supplierConfirmation(check));assert.equal(audit.after_snapshot.preview.supplierChange.beforeSupplier,'Milan Food');assert.equal(audit.after_snapshot.preview.supplierChange.afterSupplier,'Postpaid');
 assert.equal((await resolve(db)).code,'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED');assert.deepEqual(await counts(db),after);
 }finally{await db.close();}
});
test('source changes after supplier preview invalidate the separate confirmation',async()=>{
 const db=await milan({delta:0});try{const check=await changeSupplier(db);await db.exec('update inventory_logs set new_purchase_price=90000 where id=12008');const before=await counts(db);assert.equal((await confirmSupplier(db,check)).code,'SUPPLIER_CHANGE_CONFIRMATION_STALE');assert.deepEqual(await counts(db),before);assert.equal((await confirmSupplier(db,(await preview(db)).candidates[0])).status,'synced');}finally{await db.close();}
});
test('supplier-change confirmation cannot bypass payment or closed recognition month',async()=>{
 for(const [setup,code] of [["update ledger_payables set status='partially_paid' where id=866",'PAYABLE_ALREADY_PAID'],["update ledger_candidates set proposed_recognition_month='2026-08-01';update ledger_transactions set recognition_month='2026-08-01';insert into ledger_month_closures(month) values('2026-08-01')",'MONTH_CLOSED']]){
 const db=await milan({delta:0});try{const check=await changeSupplier(db);await db.exec(setup);const before=await counts(db);assert.equal((await confirmSupplier(db,check)).code,code);assert.deepEqual(await counts(db),before);}finally{await db.close();}
 }
});
test('normalized supplier-name fallback allows the unchanged Milan cancellation',async()=>{
 const db=await milan();try{await db.exec("update inventory_logs set purchase_supplier_partner_id=null,new_supplier='  MILAN FOOD  ',prev_supplier=' milan food ' where id=12008");await project(db);assert.equal((await preview(db)).candidates[0].safe,true);assert.equal((await resolve(db)).status,'synced');assert.equal((await one(db,'select status from ledger_payables where id=866')).status,'cancelled');}finally{await db.close();}
});
test('same supplier name with conflicting partner IDs requires unambiguous previous identity',async()=>{
 const db=await milan({delta:0});try{
 await db.exec("update business_partners set name='Milan Food' where id=12;update inventory_logs set new_supplier='Milan Food',purchase_supplier_partner_id=12 where id=12008");await project(db);
 assert.equal((await resolve(db)).code,'SUPPLIER_MISMATCH');await db.exec('update inventory_logs set prev_purchase_supplier_partner_id=10 where id=12008');
 const check=(await preview(db)).candidates[0];assert.equal(check.code,'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED');assert.equal(check.supplierChange.beforePartnerId,'10');assert.equal(check.supplierChange.afterPartnerId,'12');assert.equal((await confirmSupplier(db,check)).status,'synced');
 }finally{await db.close();}
});
test('full cancellation with separately confirmed supplier change still uses reversal-only zero amount',async()=>{
 const db=await milan();try{const check=await changeSupplier(db);assert.equal(check.newAmount,0);assert.equal((await resolve(db)).code,'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED');assert.equal((await confirmSupplier(db,check)).status,'synced');assert.equal((await one(db,'select status from ledger_payables where id=866')).status,'cancelled');assert.equal((await counts(db)).transactions,2);assert.equal((await counts(db)).payables,1);assert.equal(Number((await one(db,'select count(*) as n from ledger_movements')).n),0);assert.equal(Number((await one(db,'select sum(amount*economic_effect_sign) as expense from ledger_transactions')).expense),0);}finally{await db.close();}
});
test('direct original supplier drift compares immutable booked supplier and needs separate confirmation',async()=>{
 const db=await milan();try{
 await db.exec("update inventory_logs set new_supplier='Postpaid',purchase_supplier_partner_id=12 where id=12007");await rpc(db,'ledger_project_inventory_purchase_log_v1',12007,2);
 const check=(await rpc(db,'ledger_inventory_purchase_repair_preview_v1',12007,2)).candidates[0];assert.equal(check.supplierChange.beforeSupplier,'Milan Food');assert.equal(check.supplierChange.afterSupplier,'Postpaid');
 assert.equal((await rpc(db,'ledger_resolve_inventory_purchase_correction_v1',12007,12007,2)).code,'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED');assert.equal((await rpc(db,'ledger_resolve_inventory_purchase_correction_v2',12007,12007,2,supplierConfirmation(check))).status,'synced');
 }finally{await db.close();}
});
test('separate confirmation RPC and private supplier helpers retain restricted permissions',async()=>{
 const db=await milan({delta:0});try{const check=await changeSupplier(db);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(confirmSupplier(db,check),/permission denied/);await db.exec('reset role');}
 for(const signature of ['inventory_ledger_private.purchase_supplier_matches(text,text,text,text)','inventory_ledger_private.compare_purchase_supplier(jsonb,jsonb)'])assert.equal((await db.query("select has_function_privilege('service_role',$1,'EXECUTE') as allowed",[signature])).rows[0].allowed,false);
 assert.equal((await one(db,"select has_function_privilege('service_role','public.ledger_resolve_inventory_purchase_correction_v2(bigint,bigint,bigint,jsonb)','EXECUTE') as allowed")).allowed,true);
 }finally{await db.close();}
});

test('same partner ID with contradictory previous supplier name is rejected',async()=>{
 const db=await milan();try{await db.exec("update inventory_logs set prev_supplier='Postpaid',prev_purchase_supplier_partner_id=10 where id=12008");await project(db);assert.equal((await resolve(db)).code,'SUPPLIER_MISMATCH');await assert.rejects(db.exec('update inventory_logs set correction_of_inventory_log_id=12007 where id=12008'),/SUPPLIER_MISMATCH/);}finally{await db.close();}
});
test('same partner ID with changed supplier label still requires explicit before/after confirmation',async()=>{
 const db=await milan({delta:0});try{await db.exec("update inventory_logs set new_supplier='Milan Food renamed' where id=12008");await project(db);const check=(await preview(db)).candidates[0];assert.equal(check.code,'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED');assert.equal(check.supplierChange.beforePartnerId,check.supplierChange.afterPartnerId);assert.equal((await resolve(db)).code,'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED');assert.equal((await confirmSupplier(db,check)).status,'synced');}finally{await db.close();}
});
test('current verification_pending rebook contract accepts full cancellation amount zero with no replacement payable or cash',async()=>{
 const db=await milan({paymentMode:'immediate'});try{
 assert.equal((await one(db,'select source_snapshot from ledger_transactions where id=1962')).source_snapshot.paymentVerification,'pending');
 await project(db);assert.equal((await preview(db)).candidates[0].newAmount,0);assert.equal((await resolve(db)).status,'synced');
 assert.equal((await counts(db)).transactions,2);assert.equal((await counts(db)).payables,1);assert.equal((await one(db,'select status from ledger_payables where id=866')).status,'cancelled');assert.equal(Number((await one(db,'select count(*) as n from ledger_movements')).n),0);
 const audit=await one(db,"select after_snapshot from ledger_audit_logs where action='inventory_source_rebooked'");assert.equal(audit.after_snapshot.finalAmount,0);assert.equal(audit.after_snapshot.rebookTransactionId,null);assert.equal(audit.after_snapshot.newPayableId,null);
}finally{await db.close();}
});

test('confirmed supplier change becomes the previous identity for later quantity corrections',async()=>{
 const db=await milan({delta:0});try{
 const check=await changeSupplier(db);assert.equal((await confirmSupplier(db,check)).status,'synced');
 await db.exec("insert into inventory_logs(id,item_id,unit,change_quantity,new_purchase_price,prev_supplier,new_supplier,purchase_supplier_partner_id,business_date,created_at,source,reason,source_actor_user_id,correction_of_inventory_log_id) values(12009,1,'kg',-0.25,80000,'Postpaid','Postpaid',12,'2026-09-26','2026-09-26T10:01:00Z','edit_form','purchase',1,12007)");
 await rpc(db,'ledger_project_inventory_purchase_log_v1',12009,2);const p=(await rpc(db,'ledger_inventory_purchase_repair_preview_v1',12009,2)).candidates[0];assert.equal(p.safe,true);assert.equal(p.supplierChange.requiresConfirmation,false);
 assert.equal((await rpc(db,'ledger_resolve_inventory_purchase_correction_v1',12009,12007,2)).status,'synced');assert.equal(Number((await one(db,'select sum(amount*economic_effect_sign) as expense from ledger_transactions')).expense),60000);assert.equal(Number((await one(db,'select count(*) as n from ledger_movements')).n),0);
 }finally{await db.close();}
});
test('supplier change cannot be inserted behind a later family correction',async()=>{
 const db=await milan({delta:0});try{
 const check=await changeSupplier(db);
 await db.exec("insert into inventory_logs(id,item_id,unit,change_quantity,new_purchase_price,prev_supplier,new_supplier,purchase_supplier_partner_id,business_date,created_at,source,reason,source_actor_user_id,correction_of_inventory_log_id) values(12009,1,'kg',0,80000,'Milan Food','Milan Food',10,'2026-09-26','2026-09-26T10:01:00Z','edit_form','purchase',1,12007)");
 const before=await counts(db);assert.equal((await confirmSupplier(db,check)).code,'SUPPLIER_CORRECTION_ORDER_REQUIRED');await assert.rejects(db.exec('update inventory_logs set correction_of_inventory_log_id=12007 where id=12008'),/SUPPLIER_CORRECTION_ORDER_REQUIRED/);assert.deepEqual(await counts(db),before);
 }finally{await db.close();}
});
test('booked source fingerprint changes invalidate a previously shown supplier confirmation',async()=>{
 const db=await milan({delta:0});try{const check=await changeSupplier(db);await db.exec("update ledger_candidates set source_fingerprint=repeat('a',64) where id=1364");const before=await counts(db);assert.equal((await confirmSupplier(db,check)).code,'SUPPLIER_CHANGE_CONFIRMATION_STALE');assert.deepEqual(await counts(db),before);}finally{await db.close();}
});

test('service_role can still update linked source metadata without gaining link mutation or private helper access',async()=>{
 const db=await milan({delta:0,linked:true});try{
 await db.exec('grant select,update on inventory_logs to service_role;grant select on business_partners,business_partner_supplier_aliases to service_role;set role service_role');
 await db.exec("update inventory_logs set item_name='Metadata update from server' where id=12008");
 await assert.rejects(db.exec('update inventory_logs set correction_of_inventory_log_id=null where id=12008'),/PURCHASE_CORRECTION_LINK_IMMUTABLE/);
 await db.exec('reset role');assert.equal((await one(db,'select item_name from inventory_logs where id=12008')).item_name,'Metadata update from server');assert.equal((await counts(db)).transactions,1);
 assert.equal((await one(db,"select has_schema_privilege('service_role','inventory_ledger_private','USAGE') as allowed")).allowed,false);
 }finally{await db.close();}
});

test('name-only evidence with duplicate partner names is blocked until identities are explicit',async()=>{
 const db=await milan();try{
 await db.exec("update business_partners set name='Milan Food' where id=12;update inventory_logs set purchase_supplier_partner_id=null where id in (12007,12008)");await project(db);
 assert.equal((await resolve(db)).code,'SUPPLIER_MISMATCH');await assert.rejects(db.exec('update inventory_logs set correction_of_inventory_log_id=12007 where id=12008'),/SUPPLIER_MISMATCH/);
 await db.exec('update inventory_logs set purchase_supplier_partner_id=10 where id in (12007,12008);update inventory_logs set prev_purchase_supplier_partner_id=10 where id=12008');assert.equal((await resolve(db)).status,'synced');
 }finally{await db.close();}
});
