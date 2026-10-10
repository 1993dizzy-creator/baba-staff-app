import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calculateMonthCloseOperatingSummary} from '../lib/ledger/month-close-operating.ts';
import {database,seedSale,autoDeposit,call,balance,outstanding} from './helpers/card-fee-fixture.mjs';
const migration=readFileSync('supabase/migrations/20261001193526_auto_finalize_closed_month_card_fees.sql','utf8');
async function fixture(){const db=await database();try{await db.exec(migration);
 await db.exec(`alter table ledger_month_closures add constraint ledger_month_closures_status_check check(status='closed');
 alter table ledger_month_closures add column closed_at timestamptz default now(),add column closed_by bigint default 1,
 add column preflight_snapshot jsonb default '{}',add column summary_snapshot jsonb default '{}',add column snapshot_hash text default repeat('0',64),add column warning_snapshot jsonb default '[]';`);
 await db.exec(readFileSync('supabase/migrations/20260916161512_add_ledger_month_reopen.sql','utf8'));
 return db;}catch(e){await db.close();throw e;}}
test('closed prior month automatically finalizes 2.15% fee and keeps movement in finalization month',async()=>{
 const db=await fixture();try{
 await seedSale(db,100000000,'2026-08-20');await autoDeposit(db,95000000,'2026-08-25');
 await db.exec("insert into ledger_month_closures(month) values('2026-08-01')");
 const before=await balance(db,'baba_corporate_bank');const result=await autoDeposit(db,2850000,'2026-09-05');
 assert.equal(result.status,'created');assert.equal(result.autoFeeClosures.length,1);assert.equal(Number(result.autoFeeClosures[0].feeAmount),2150000);
 assert.equal((await outstanding(db))[0].outstandingGrossAmount,0);assert.equal(await balance(db,'baba_corporate_bank'),before+2850000);
 const tx=(await db.query("select recognition_month::text,business_date::text,source_snapshot from ledger_transactions where source_type='card_fee_month_close'")).rows[0];
 assert.equal(tx.recognition_month,'2026-08-01');assert.ok(tx.business_date>'2026-08-31');assert.equal(tx.source_snapshot.autoConfirmed,true);
 assert.equal((await db.query('select count(*)::int n from ledger_card_fee_private.finalization_permissions')).rows[0].n,0);
 }finally{await db.close();}
});

async function prepare(db,remaining=5000000,month='2026-08',gross=100000000){
 await seedSale(db,gross,`${month}-20`);await autoDeposit(db,gross-remaining,`${month}-25`);
 await db.query('insert into ledger_month_closures(month,summary_snapshot) values($1,$2::jsonb)',[`${month}-01`,JSON.stringify({funds:{bank:gross-remaining,cardClearing:remaining},card:{feeStatus:'pending'}})]);
}
for(const [label,deposit,fee] of [['upper normal range',2600000,2400000],['lower normal range',3200000,1800000],['insufficient deposits',1500000,0]])test(label,async()=>{
 const db=await fixture();try{await prepare(db);const result=await autoDeposit(db,deposit,'2026-09-05');assert.equal(result.status,'created');assert.equal(result.autoFeeClosures.length,fee?1:0);if(fee)assert.equal(Number(result.autoFeeClosures[0].feeAmount),fee);}finally{await db.close();}
});
test('overshoot splits prior-month payment, target fee and current sales with exact total and frozen close snapshot',async()=>{
 const db=await fixture();try{
 await prepare(db,3000000);const next=await seedSale(db,10000000,'2026-09-02');
 const snapshot=(await db.query('select * from ledger_month_closures')).rows;
 const result=await autoDeposit(db,4000000,'2026-09-05');assert.equal(result.status,'created');assert.equal(Number(result.autoFeeClosures[0].feeAmount),2150000);
 assert.deepEqual(result.allocations.map(row=>Number(row.allocatedAmount)),[850000,3150000]);assert.equal(Number(result.allocations[1].transactionId),next);
 assert.equal(result.allocations.reduce((n,row)=>n+Number(row.allocatedAmount),0),4000000);
 assert.equal(Number((await db.query('select sum(allocated_gross_amount) n from ledger_card_reconciliation_lines where reconciliation_id=$1',[result.reconciliationId])).rows[0].n),4000000);
 assert.deepEqual((await db.query('select * from ledger_month_closures')).rows,snapshot);
 assert.equal(Number((await db.query("select sum(m.amount) n from ledger_movements m join ledger_transactions t on t.id=m.transaction_id join ledger_fund_accounts f on f.id=m.fund_account_id where f.code='card_clearing' and t.business_date<'2026-09-01' and t.status='confirmed'")).rows[0].n),3000000);
 assert.equal((await outstanding(db))[0].outstandingGrossAmount,0);assert.ok(await balance(db,'card_clearing')>=0);
 const fee=(await db.query("select * from ledger_transactions where source_type='card_fee_month_close'")).rows[0];assert.equal(fee.recognition_month.toISOString().slice(0,10),'2026-08-01');
 assert.equal(Number((await db.query("select count(*) n from ledger_movements m join ledger_fund_accounts f on f.id=m.fund_account_id where m.transaction_id=$1 and f.code<>'card_clearing'",[fee.id])).rows[0].n),0);
 }finally{await db.close();}
});
test('multiple closed months finalize oldest first then allocate the same deposit to the running month',async()=>{
 const db=await fixture();try{
 await prepare(db,3000000,'2026-07');
 // Deposit August principal only after July is not closed (stage separately to avoid cross-month settlement).
 const aug=await seedSale(db,100000000,'2026-08-20');
 // Legacy exact allocation to stage historical August principal without touching July.
 const legacy=await call(db,'ledger_create_card_deposit_v1',['2026-08-25T12:00:00+07:00',97000000,await (async()=>Number((await db.query("select id from ledger_fund_accounts where code='baba_corporate_bank'")).rows[0].id))(),null,null,1]);
 assert.equal((await call(db,'ledger_match_card_reconciliation_v1',[legacy.reconciliationId,JSON.stringify([{transactionId:aug,allocatedGrossAmount:97000000}]),true,1])).status,'matched');
 await db.exec("insert into ledger_month_closures(month) values('2026-08-01')");
 await seedSale(db,10000000,'2026-09-02');const result=await autoDeposit(db,4000000,'2026-09-05');
 assert.equal(result.status,'created');assert.deepEqual(result.autoFeeClosures.map(row=>row.feeMonth),['2026-07-01','2026-08-01']);assert.deepEqual(result.allocations.map(row=>Number(row.allocatedAmount)),[850000,850000,2300000]);
 }finally{await db.close();}
});
test('review and insufficient next-month capacity leave deposits, fee closures, movements and audits untouched',async()=>{
 for(const remaining of [1000000,3000000]){
 const db=await fixture();try{
 await prepare(db,remaining);const before=(await db.query('select (select count(*) from ledger_transactions) t,(select count(*) from ledger_movements) m,(select count(*) from ledger_card_fee_closures) f,(select count(*) from ledger_audit_logs) a')).rows;
 const result=await autoDeposit(db,remaining===1000000?500000:2000000,'2026-09-05');assert.equal(result.status,remaining===1000000?'card_fee_review_required':'insufficient_unsettled_card_sales');
 assert.deepEqual((await db.query('select (select count(*) from ledger_transactions) t,(select count(*) from ledger_movements) m,(select count(*) from ledger_card_fee_closures) f,(select count(*) from ledger_audit_logs) a')).rows,before);
 }finally{await db.close();}
 }
});
test('preflight fee pending is a warning, real corruption is a blocker, and real close/reopen policies still work',async()=>{
 const db=await fixture();try{
 await seedSale(db,100000000,'2026-08-20');await autoDeposit(db,95000000,'2026-08-25');
 const check=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);assert.equal(check.canClose,true);assert.ok(check.warnings.some(row=>row.code==='CARD_FEE_PENDING'&&Number(row.amount)===5000000));assert.ok(!check.blockers.some(row=>row.code==='CARD_FEE_NOT_CONFIRMED'));
 const summary={funds:{bank:95000000,cardClearing:5000000},card:{feeStatus:'pending'}};
 const close=await call(db,'ledger_close_month_v1',['2026-08-01',check.preflightHash,JSON.stringify(check),JSON.stringify(summary),'0'.repeat(64),1]);assert.equal(close.status,'closed');
 const before=(await db.query('select * from ledger_month_closures')).rows;
 assert.equal((await autoDeposit(db,2850000,'2026-09-05')).status,'created');assert.deepEqual((await db.query('select * from ledger_month_closures')).rows,before);
 assert.equal((await call(db,'ledger_reopen_month_v1',['2026-08-01','ordinary review',1])).status,'reopened');
 // Intentional malformed confirmed deposit is detected by current preflight.
 const result=await autoDeposit(db,100000,'2026-09-05');assert.equal(result.status,'insufficient_card_pending');
 await db.exec('update ledger_card_reconciliation_lines set allocated_gross_amount=allocated_gross_amount-1 where id=(select min(id) from ledger_card_reconciliation_lines)');
 const broken=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);assert.equal(broken.canClose,false);assert.ok(broken.blockers.some(row=>row.code==='CARD_ALLOCATION_MISMATCH'));
 }finally{await db.close();}
});
test('no running-month auto fee, confirmed fee is never duplicated, deposit cancellation restores only its principal',async()=>{
 const db=await fixture();try{
 await prepare(db);await seedSale(db,10000000,'2026-09-02');const result=await autoDeposit(db,4000000,'2026-09-05');assert.equal(result.status,'created');
 const feeId=result.autoFeeClosures[0].closureId;await autoDeposit(db,100000,'2026-09-05');assert.equal(Number((await db.query('select count(*) n from ledger_card_fee_closures')).rows[0].n),1);
 const bankBefore=await balance(db,'baba_corporate_bank');assert.equal((await call(db,'ledger_cancel_card_reconciliation_v1',[result.reconciliationId,'wrong deposit',1])).status,'cancelled');assert.equal(await balance(db,'baba_corporate_bank'),bankBefore-4000000);assert.equal((await db.query('select status from ledger_card_fee_closures where id=$1',[feeId])).rows[0].status,'confirmed');
 const current=(await db.query("select date_trunc('month',((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date)::date::text as current_month")).rows[0].current_month;
 await seedSale(db,100000000,current);const beforeFees=Number((await db.query('select count(*) n from ledger_card_fee_closures')).rows[0].n);await autoDeposit(db,1000,current);assert.equal(Number((await db.query('select count(*) n from ledger_card_fee_closures')).rows[0].n),beforeFees);
 }finally{await db.close();}
});
test('fee guard capability cannot be forged, ordinary historical writes remain blocked and audit failure is atomic',async()=>{
 const db=await fixture();try{
 await prepare(db);await seedSale(db,10000000,'2026-09-02');
 await assert.rejects(seedSale(db,10,'2026-08-21'),/LEDGER_MONTH_CLOSED/);
 await assert.rejects(db.exec("insert into ledger_card_fee_closures(fee_month,fee_amount,confirmed_by) values('2026-08-01',0,1)"),/LEDGER_MONTH_CLOSED/);
 await db.exec("create function fail_auto_fee_audit() returns trigger language plpgsql as $$ begin if new.action='card_fee_month_confirmed' then raise exception 'fixture audit failure';end if;return new;end $$;create trigger fixture_fee_audit before insert on ledger_audit_logs for each row execute function fail_auto_fee_audit()");
 const bankBefore=await balance(db,'baba_corporate_bank');await assert.rejects(autoDeposit(db,4000000,'2026-09-05'),/fixture audit failure/);assert.equal(await balance(db,'baba_corporate_bank'),bankBefore);assert.equal(Number((await db.query('select count(*) n from ledger_card_fee_closures')).rows[0].n),0);
 assert.equal(Number((await db.query('select count(*) n from ledger_card_fee_private.finalization_permissions')).rows[0].n),0);
 await db.exec('set role service_role');await assert.rejects(db.exec('select * from ledger_card_fee_private.finalization_permissions'),/permission denied/);await db.exec('reset role');
 }finally{await db.close();}
});

test('September fees confirmed by October deposits affect only September P&L without duplicate current-month expense',async()=>{
 const db=await fixture();try{
 await prepare(db,5000000,'2026-09');await seedSale(db,10000000,'2026-10-01');
 const result=await autoDeposit(db,2850000,'2026-10-02');assert.equal(result.status,'created');
 const c=(await db.query('select fee_month::text,confirmed_at::text,finalization_business_date::text from ledger_card_fee_closures')).rows[0];assert.equal(c.fee_month,'2026-09-01');assert.ok(c.confirmed_at.startsWith('2026-10'));assert.ok(c.finalization_business_date.startsWith('2026-10'));
 const txs=(await db.query("select type,source_type,source_key,recognition_month::text,amount,economic_effect_sign from ledger_transactions where source_type='card_fee_month_close'")).rows;
 const sep=calculateMonthCloseOperatingSummary('2026-09',txs.filter(t=>t.recognition_month==='2026-09-01'),[]);const oct=calculateMonthCloseOperatingSummary('2026-10',txs.filter(t=>t.recognition_month==='2026-10-01'),[]);
 assert.equal(sep.expense.total,2150000);assert.equal(oct.expense.total,0);
 }finally{await db.close();}
});
test('legacy unallocated deposits and negative clearing remain genuine close blockers',async()=>{
 const db=await fixture();try{
 await prepare(db);await seedSale(db,10000000,'2026-09-02');
 await call(db,'ledger_create_card_deposit_v1',['2026-09-03T12:00:00+07:00',100000,Number((await db.query("select id from ledger_fund_accounts where code='baba_corporate_bank'")).rows[0].id),null,null,1]);
 const before=(await db.query('select count(*) n from ledger_transactions')).rows;
 assert.equal((await autoDeposit(db,100000,'2026-09-05')).status,'card_fee_review_required');assert.deepEqual((await db.query('select count(*) n from ledger_transactions')).rows,before);
 await db.exec("update ledger_month_closures set status='reopened'");
 const pre=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);assert.equal(pre.canClose,true);assert.ok(!pre.blockers.some(b=>b.code==='CARD_LEGACY_UNALLOCATED'||b.code==='CARD_UNMATCHED'));
 const sep=await call(db,'ledger_close_preflight_v1',['2026-09-01',1]);assert.ok(sep.blockers.some(b=>b.code==='CARD_UNMATCHED'));
 await db.exec("update ledger_movements set amount=-200000000 where id=(select min(m.id) from ledger_movements m join ledger_fund_accounts f on f.id=m.fund_account_id where f.code='card_clearing')");
 const neg=await call(db,'ledger_close_preflight_v1',['2026-08-01',1]);assert.ok(neg.blockers.some(b=>b.code==='CARD_CLEARING_NEGATIVE'));
 }finally{await db.close();}
});

test('cancelled manual fee history is preserved when a later closed-month automatic fee is created',async()=>{
 const db=await fixture();try{
 await seedSale(db,100000000,'2026-08-20');await autoDeposit(db,95000000,'2026-08-25');const manual=await call(db,'ledger_confirm_card_fee_month_v1',['2026-08-01','legacy manual',1]);assert.equal(manual.status,'confirmed');
 assert.equal((await call(db,'ledger_cancel_card_fee_month_v1',[manual.closureId,'late bank receipt',1])).status,'cancelled');
 await db.exec("insert into ledger_month_closures(month) values('2026-08-01')");assert.equal((await autoDeposit(db,2850000,'2026-09-05')).status,'created');
 assert.deepEqual((await db.query('select status from ledger_card_fee_closures order by id')).rows.map(r=>r.status),['cancelled','confirmed']);
 }finally{await db.close();}
});

test('closed automatic fee cancellation appends a current-day reversal and restores only clearing with immutable history',async()=>{
 const db=await fixture();try{
 await prepare(db,5000000,'2026-09');await seedSale(db,10000000,'2026-10-01');const confirm=await autoDeposit(db,2850000,'2026-10-02');assert.equal(confirm.status,'created');const id=confirm.autoFeeClosures[0].closureId;
 const original=(await db.query('select * from ledger_transactions where id=(select expense_transaction_id from ledger_card_fee_closures where id=$1)',[id])).rows[0];
 const snapshot=(await db.query('select * from ledger_month_closures')).rows;const lines=(await db.query('select * from ledger_card_fee_allocation_lines')).rows;
 const bank=await balance(db,'baba_corporate_bank'),clearing=await balance(db,'card_clearing');
 await assert.rejects(db.query("update ledger_card_fee_closures set status='cancelled' where id=$1",[id]),/LEDGER_MONTH_CLOSED/);
 await assert.rejects(db.query("insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,status,source_type,source_key,source_snapshot,correction_of_id,created_by,confirmed_by,economic_effect_sign) select gen_random_uuid(),type,now(),((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date,recognition_month,amount,category_id,party_id,'confirmed','card_fee_month_close_reversal',source_key||':reversal','{\"autoConfirmed\":true,\"autoCancellation\":true}'::jsonb,id,1,1,-1 from ledger_transactions where id=$1",[original.id]),/LEDGER_MONTH_CLOSED/);
 await db.exec('set role anon');await assert.rejects(call(db,'ledger_cancel_card_fee_month_v1',[id,'cancel',1]),/permission denied/);await db.exec('reset role');
 await db.exec('set role service_role');const cancel=await call(db,'ledger_cancel_card_fee_month_v1',[id,'  bank corrected  ',1]);await db.exec('reset role');assert.equal(cancel.status,'cancelled');
 assert.deepEqual((await db.query('select * from ledger_transactions where id=$1',[original.id])).rows[0],original);
 assert.deepEqual((await db.query('select * from ledger_month_closures')).rows,snapshot);assert.deepEqual((await db.query('select * from ledger_card_fee_allocation_lines')).rows,lines);
 assert.equal(await balance(db,'baba_corporate_bank'),bank);assert.equal(await balance(db,'card_clearing'),clearing+2150000);
 const reversal=(await db.query('select recognition_month::text,business_date::text,occurred_at,economic_effect_sign,amount,correction_of_id from ledger_transactions where id=$1',[cancel.reversalTransactionId])).rows[0];
 const today=(await db.query("select ((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date::text as business_day")).rows[0].business_day;
 assert.equal(reversal.recognition_month,'2026-09-01');assert.equal(reversal.business_date,today);assert.equal(Number(reversal.amount),2150000);assert.equal(reversal.economic_effect_sign,-1);assert.equal(Number(reversal.correction_of_id),Number(original.id));
 const movements=(await db.query('select m.amount,f.code from ledger_movements m join ledger_fund_accounts f on f.id=m.fund_account_id where m.transaction_id=$1',[cancel.reversalTransactionId])).rows;assert.equal(movements.length,1);assert.equal(movements[0].code,'card_clearing');assert.equal(Number(movements[0].amount),2150000);
 const recognized=(await db.query("select type,source_type,source_key,recognition_month::text,amount,economic_effect_sign from ledger_transactions where source_type in('card_fee_month_close','card_fee_month_close_reversal')")).rows;
 assert.equal(calculateMonthCloseOperatingSummary('2026-09',recognized.filter(t=>t.recognition_month==='2026-09-01'),[]).expense.total,0);assert.equal(calculateMonthCloseOperatingSummary('2026-10',recognized.filter(t=>t.recognition_month==='2026-10-01'),[]).expense.total,0);
 assert.equal((await outstanding(db))[0].outstandingGrossAmount,2150000);
 const audit=(await db.query("select * from ledger_audit_logs where action='card_fee_month_cancelled'")).rows[0];assert.equal(Number(audit.actor_user_id),1);assert.equal(audit.reason,'bank corrected');assert.equal(audit.after_snapshot.autoCancellation,true);
 const before=(await db.query('select count(*) n from ledger_transactions')).rows;assert.equal((await call(db,'ledger_cancel_card_fee_month_v1',[id,'again',1])).status,'already_cancelled');assert.deepEqual((await db.query('select count(*) n from ledger_transactions')).rows,before);
 assert.equal((await db.query('select count(*)::int n from ledger_card_fee_private.cancellation_permissions')).rows[0].n,0);
 await assert.rejects(db.query("update ledger_transactions set memo='forged' where id=$1",[original.id]),/LEDGER_MONTH_CLOSED/);
 await db.exec('set role service_role');await assert.rejects(db.exec('select * from ledger_card_fee_private.cancellation_permissions'),/permission denied/);await db.exec('reset role');
 }finally{await db.close();}
});
test('closed legacy fee cancellation stays blocked; automatic cancellation requires actor reason and an open actual month',async()=>{
 const db=await fixture();try{
 await seedSale(db,100000000,'2026-08-20');await autoDeposit(db,95000000,'2026-08-25');const legacy=await call(db,'ledger_confirm_card_fee_month_v1',['2026-08-01',null,1]);await db.exec("insert into ledger_month_closures(month) values('2026-08-01')");assert.equal((await call(db,'ledger_cancel_card_fee_month_v1',[legacy.closureId,'cancel',1])).status,'month_closed');
 await prepare(db,5000000,'2026-09');await seedSale(db,10000000,'2026-10-01');const confirm=await autoDeposit(db,2850000,'2026-10-02');const id=confirm.autoFeeClosures[0].closureId;
 assert.equal((await call(db,'ledger_cancel_card_fee_month_v1',[id,'cancel',999])).status,'forbidden');assert.equal((await call(db,'ledger_cancel_card_fee_month_v1',[id,'   ',1])).status,'reason_required');
 await db.exec("insert into ledger_month_closures(month) values(date_trunc('month',((now() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date)::date)");
 const before=await balance(db,'card_clearing');assert.equal((await call(db,'ledger_cancel_card_fee_month_v1',[id,'cancel',1])).status,'month_closed');assert.equal(await balance(db,'card_clearing'),before);
 }finally{await db.close();}
});
test('automatic cancellation audit failure rolls back reversal movement closure state and capability',async()=>{
 const db=await fixture();try{
 await prepare(db);const result=await autoDeposit(db,2850000,'2026-09-05');const id=result.autoFeeClosures[0].closureId;
 await db.exec("create function fail_cancel_audit() returns trigger language plpgsql as $$ begin if new.action='card_fee_month_cancelled' then raise exception 'fixture cancel audit failure';end if;return new;end $$;create trigger fixture_cancel_audit before insert on ledger_audit_logs for each row execute function fail_cancel_audit()");
 const before=(await db.query('select (select count(*) from ledger_transactions) t,(select count(*) from ledger_movements) m,(select count(*) from ledger_audit_logs) a')).rows;const clearing=await balance(db,'card_clearing');
 await assert.rejects(call(db,'ledger_cancel_card_fee_month_v1',[id,'cancel',1]),/fixture cancel audit failure/);assert.deepEqual((await db.query('select (select count(*) from ledger_transactions) t,(select count(*) from ledger_movements) m,(select count(*) from ledger_audit_logs) a')).rows,before);assert.equal(await balance(db,'card_clearing'),clearing);assert.equal((await db.query('select status from ledger_card_fee_closures where id=$1',[id])).rows[0].status,'confirmed');assert.equal((await db.query('select count(*)::int n from ledger_card_fee_private.cancellation_permissions')).rows[0].n,0);
 }finally{await db.close();}
});

test('October unmatched deposit does not block September close while September unmatched still does',async()=>{
 const db=await fixture();try{
 await seedSale(db,100000000,'2026-09-20');await autoDeposit(db,95000000,'2026-09-25');const bank=Number((await db.query("select id from ledger_fund_accounts where code='baba_corporate_bank'")).rows[0].id);
 await call(db,'ledger_create_card_deposit_v1',['2026-10-01T12:00:00+07:00',100000,bank,null,null,1]);
 const sep=await call(db,'ledger_close_preflight_v1',['2026-09-01',1]);assert.equal(sep.canClose,true);assert.ok(!sep.blockers.some(b=>b.code==='CARD_UNMATCHED'||b.code==='CARD_LEGACY_UNALLOCATED'));assert.ok(sep.warnings.some(w=>w.code==='CARD_FEE_PENDING'));
 const oct=await call(db,'ledger_close_preflight_v1',['2026-10-01',1]);assert.equal(oct.canClose,false);assert.ok(oct.blockers.some(b=>b.code==='CARD_UNMATCHED'));
 await call(db,'ledger_create_card_deposit_v1',['2026-09-27T12:00:00+07:00',100000,bank,null,null,1]);assert.ok((await call(db,'ledger_close_preflight_v1',['2026-09-01',1])).blockers.some(b=>b.code==='CARD_UNMATCHED'));
 }finally{await db.close();}
});
