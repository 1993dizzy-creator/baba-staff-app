import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {btree_gist} from '@electric-sql/pglite/contrib/btree_gist';
import {install,read,closeMonth,state as baseState} from './helpers/payroll-batch-safety-fixture.mjs';
import {parseSettlementPlan,settlementDifferenceReason} from '../lib/payroll/special-settlement-2026-10.ts';

// Synthetic employees and amounts only. Real October data lives in the private
// server-only plan and is never part of this repository.
const MIGRATION='supabase/migrations/20261116163616_payroll_2026_10_special_settlement.sql';
const OCT='2026-10-01',BANK=2,CASH=1,D10='2026-11-10',D14='2026-11-14';
const IDS=Array.from({length:17},(_,i)=>201+i);
const SPLIT=212,CASH_ONLY=216,FREELANCE=217,LAST_BANK=201;
const INS={employee:100,employer:200};

function syntheticPlan(){
  const employees=IDS.map(userId=>{
    if(userId===CASH_ONLY)return{userId,actualPaidAmount:7000000,allocations:[{paymentDate:D10,fundAccountId:CASH,amount:7000000,kind:'salary'}],note:'synthetic cash payee'};
    if(userId===FREELANCE)return{userId,actualPaidAmount:2500000,allocations:[{paymentDate:D14,fundAccountId:CASH,amount:2500000,kind:'salary'}]};
    if(userId===SPLIT)return{userId,actualPaidAmount:4150000,allocations:[{paymentDate:D10,fundAccountId:BANK,amount:4000000,kind:'salary'},{paymentDate:D10,fundAccountId:CASH,amount:150000,kind:'penalty_refund',note:'synthetic cancelled penalty returned in cash'}]};
    const amount=5000000+userId*1001;return{userId,actualPaidAmount:amount,allocations:[{paymentDate:D10,fundAccountId:BANK,amount,kind:'salary'}]};
  });
  const bank=employees.flatMap(e=>e.allocations).filter(a=>a.fundAccountId===BANK).reduce((n,a)=>n+a.amount,0)+1;
  const raw={version:1,payrollMonth:'2026-10',sourceTitle:'synthetic corrected payroll',employees,
    residuals:[{paymentDate:D10,fundAccountId:BANK,amount:1,reason:'synthetic batch transfer rounding residual'}],
    expectedGroups:[{paymentDate:D10,fundAccountId:BANK,amount:bank},{paymentDate:D10,fundAccountId:CASH,amount:7150000},{paymentDate:D14,fundAccountId:CASH,amount:2500000}],
    expectedTotal:bank+7150000+2500000};
  const parsed=parseSettlementPlan(raw);assert.equal(parsed.ok,true,JSON.stringify(parsed.errors));return parsed;
}
// APP calculation differs from the accountant amount for two synthetic employees.
const calculatedNet=(e)=>e.userId===CASH_ONLY?e.actualPaidAmount+5555:e.userId===SPLIT?e.actualPaidAmount-2:e.actualPaidAmount;
const snapshot=()=>({employee:{amounts:{employeeInsuranceDeductionAmount:INS.employee,employerInsuranceAmount:INS.employer,advanceAmount:0},tax:{employeePitDeductionAmount:0,companyPitAmount:0}},automaticItemsSnapshot:[]});
const targets=(blocked=null)=>IDS.map(userId=>({userId,employeeName:`QA ${userId}`,part:null,position:null,isPayable:userId!==blocked,failureCodes:userId===blocked?['BLOCKING_REVIEW']:[]}));
function payments(plan,userIds=IDS){
  return plan.employees.filter(e=>userIds.includes(e.userId)).map(e=>({userId:e.userId,calculationSnapshot:snapshot(),calculationHash:`hash-${e.userId}`,calculatedNetAmount:calculatedNet(e),actualPaidAmount:e.actualPaidAmount,
    differenceReason:settlementDifferenceReason({sourceTitle:'synthetic',calculatedNetAmount:calculatedNet(e),actualPaidAmount:e.actualPaidAmount,note:e.note}),allocations:structuredClone(e.allocations)}));
}
const hex=c=>c.repeat(64);
async function settle(db,{plan,planHash},o={}){
  const args=[o.month??OCT,JSON.stringify(o.targets??targets()),JSON.stringify(o.payments??payments(plan,o.userIds)),JSON.stringify(o.residuals??plan.residuals),JSON.stringify(o.expected??plan.expectedGroups),
    o.key??'request-key-0001-abcdef',o.hash??hex('a'),planHash,o.actor??1];
  return (await db.query(`select payroll_settle_2026_10_v1($1::date,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8,$9,'monthly-payroll-v12','{}'::jsonb,0) r`,args)).rows[0].r;
}
async function database(){
  const db=await install(new PGlite({extensions:{btree_gist}}));
  await db.exec(read(MIGRATION));
  await db.exec(`insert into users(id,username,password,name,role,hire_date) values(2,'master','x','Master','master','2025-01-01');
    insert into users(id,username,password,name,role,hire_date) select g,'qa'||g,'x','QA '||g,'staff','2025-01-01' from generate_series(201,217) g;`);
  assert.equal((await closeMonth(db,OCT)).status,'closed');
  return db;
}
async function state(db){
  const s=await baseState(db);
  for(const t of ['payroll_employee_payment_allocations','payroll_payment_group_residuals','payroll_special_settlement_requests','ledger_month_closures'])s[t]=(await db.query(`select * from ${t} order by id`)).rows;
  return s;
}
const activeGroups=async db=>Object.fromEntries((await db.query(`select t.source_snapshot->>'groupKey' k,t.amount::float8 a from ledger_transactions t where t.source_type='payroll_payment_group' and t.status='confirmed'
  and not exists(select 1 from ledger_transactions r where r.correction_of_id=t.id and r.source_type='payroll_payment_group_reversal')`)).rows.map(r=>[r.k.split(':').slice(2).join(':'),r.a]));
const balances=async db=>Object.fromEntries((await db.query('select fund_account_id f,sum(amount)::float8 s from ledger_movements group by 1')).rows.map(r=>[Number(r.f),r.s]));
const key=(d,f)=>`${d}:${f}`;
const expectedCost=plan=>plan.employees.reduce((n,e)=>n+e.actualPaidAmount+INS.employee+INS.employer,0)+1;

test('17/17 settlement: exact cash groups by date/account, split refund, residual, one closed-month company cost, idempotent replay',async()=>{
  const db=await database(),p=syntheticPlan();try{
    const closureBefore=(await db.query("select * from ledger_month_closures where month='2026-10-01'")).rows;
    const r=await settle(db,p);
    assert.equal(r.status,'completed');assert.equal(r.paidEmployeeCount,17);assert.equal(r.ledgerCompanyCost.status,'created');
    const [bank,cash10,cash14]=p.plan.expectedGroups.map(g=>g.amount);
    assert.deepEqual(await activeGroups(db),{[key(D10,BANK)]:bank,[key(D10,CASH)]:cash10,[key(D14,CASH)]:cash14});
    assert.deepEqual(await balances(db),{[BANK]:-bank,[CASH]:-(cash10+cash14)});
    const s=await state(db);
    const cost=s.ledger_transactions.filter(t=>t.source_type==='payroll_completed_batch');
    assert.equal(cost.length,1);assert.equal(cost[0].recognition_month.toISOString().slice(0,10),OCT);assert.equal(Number(cost[0].amount),expectedCost(p.plan));
    assert.equal(Number(s.payroll_payment_batches[0].actual_company_cost_total),expectedCost(p.plan));
    // Employee totals are counted once; the residual is in cost but in no employee row.
    assert.equal(Number(s.payroll_payment_batches[0].actual_paid_total),p.plan.employees.reduce((n,e)=>n+e.actualPaidAmount,0));
    const split=s.payroll_employee_payments.find(x=>Number(x.user_id)===SPLIT);
    assert.equal(Number(split.actual_paid_amount),4150000);assert.equal(Number(split.fund_account_id),BANK);assert.equal(Number(split.difference_amount),2);assert.match(split.difference_reason,/차액 \+2₫/);
    assert.deepEqual(s.payroll_employee_payment_allocations.map(a=>[a.allocation_kind,Number(a.fund_account_id),Number(a.amount),a.status]),[['salary',BANK,4000000,'active'],['penalty_refund',CASH,150000,'active']]);
    assert.equal(s.payroll_employee_payment_allocations.length,2,'only the split payment gets allocation rows');
    const khoi=s.payroll_employee_payments.find(x=>Number(x.user_id)===CASH_ONLY);assert.equal(Number(khoi.difference_amount),-5555);
    assert.equal(s.payroll_payment_group_residuals.length,1);
    assert.equal(s.payroll_payment_audit_logs.filter(a=>a.action==='special_settlement_applied').length,1);
    assert.equal(s.payroll_payment_audit_logs.filter(a=>a.action==='employee_paid').length,17);
    assert.equal(s.payroll_payment_audit_logs.filter(a=>a.action==='batch_completed').length,1);
    // Closed October is untouched except the guarded first company-cost recognition.
    assert.deepEqual((await db.query("select * from ledger_month_closures where month='2026-10-01'")).rows,closureBefore);
    assert.equal(s.ledger_transactions.filter(t=>t.business_date.toISOString().slice(0,7)==='2026-10').length,0);
    const bankTx=s.ledger_transactions.find(t=>t.source_type==='payroll_payment_group'&&t.source_snapshot.groupKey.endsWith(key(D10,BANK)));
    assert.equal(bankTx.source_snapshot.employeeCount,15);assert.equal(bankTx.source_snapshot.employees.at(-1).kind,'rounding_residual');

    const after=await state(db);
    assert.equal((await settle(db,p)).replayed,true);assert.deepEqual(await state(db),after);
    await assert.rejects(settle(db,p,{hash:hex('b')}),/REQUEST_CONFLICT/);assert.deepEqual(await state(db),after);
    await assert.rejects(settle(db,p,{key:'request-key-0002-abcdef'}),/BATCH_COMPLETED/);assert.deepEqual(await state(db),after);
    await assert.rejects(db.query("select payroll_cancel_employee_payment_v3($1,$2,'x',1)",[r.runId,SPLIT]),/BATCH_COMPLETED/);assert.deepEqual(await state(db),after);
  }finally{await db.close();}
});

test('any failure, including mid-loop after earlier employees were written, rolls back everything',async()=>{
  const db=await database(),p=syntheticPlan();try{
    const before=await state(db);
    const bad=structuredClone(p.plan.expectedGroups);bad[0].amount+=1;
    await assert.rejects(settle(db,p,{expected:bad}),/GROUP_MISMATCH/);assert.deepEqual(await state(db),before);
    await assert.rejects(settle(db,p,{targets:targets(209)}),/BATCH_PREFLIGHT_FAILED/);assert.deepEqual(await state(db),before);
    // The highest user id is processed last; drop it from the roster so it fails after 16 writes.
    await assert.rejects(settle(db,p,{targets:targets().filter(t=>t.userId!==217)}),/INVALID_PAYMENT_REQUEST/);assert.deepEqual(await state(db),before);
    const broken=payments(p.plan);broken.find(x=>x.userId===SPLIT).allocations[1].amount=199999;
    await assert.rejects(settle(db,p,{payments:broken}),/ALLOCATION_MISMATCH/);assert.deepEqual(await state(db),before);
    await assert.rejects(settle(db,p,{expected:p.plan.expectedGroups.slice(0,2)}),/GROUP_UNDECLARED/);assert.deepEqual(await state(db),before);
    await assert.rejects(settle(db,p,{actor:2}),/OWNER_REQUIRED/);assert.deepEqual(await state(db),before);
    await assert.rejects(settle(db,p,{month:'2026-09-01'}),/MONTH_NOT_ALLOWED/);assert.deepEqual(await state(db),before);
    await assert.rejects(settle(db,p,{key:'short'}),/INVALID_PAYMENT_REQUEST/);assert.deepEqual(await state(db),before);
    await db.exec('delete from ledger_categories');
    await assert.rejects(settle(db,p),/COMPANY_COST_SYNC_FAILED/);assert.deepEqual(await state(db),before);
  }finally{await db.close();}
});

test('partial settlement, cancel of the split employee re-books both accounts, re-settle completes once',async()=>{
  const db=await database(),p=syntheticPlan();try{
    const [bank,cash10,cash14]=p.plan.expectedGroups.map(g=>g.amount);
    const last=p.plan.employees.find(e=>e.userId===LAST_BANK).actualPaidAmount;
    const first=await settle(db,p,{userIds:IDS.filter(id=>id!==LAST_BANK),key:'request-key-part-0001'});
    assert.equal(first.status,'paying');assert.equal(first.ledgerCompanyCost,null);
    assert.deepEqual(await activeGroups(db),{[key(D10,BANK)]:bank-last,[key(D10,CASH)]:cash10,[key(D14,CASH)]:cash14});

    const cancelled=(await db.query("select payroll_cancel_employee_payment_v3($1,$2,'synthetic re-check',1) r",[first.runId,SPLIT])).rows[0].r;
    assert.equal(cancelled.ledgerPaymentGroups.length,2);assert.equal(cancelled.ledgerPaymentGroup.groupKey.endsWith(key(D10,BANK)),true);
    assert.deepEqual(await activeGroups(db),{[key(D10,BANK)]:bank-last-4000000,[key(D10,CASH)]:cash10-150000,[key(D14,CASH)]:cash14});
    assert.deepEqual(await balances(db),{[BANK]:-(bank-last-4000000),[CASH]:-(cash10-150000+cash14)});
    let s=await state(db);
    assert.deepEqual(s.payroll_employee_payment_allocations.map(a=>[a.status,a.cancellation_reason]),[['cancelled','synthetic re-check'],['cancelled','synthetic re-check']]);
    assert.equal(s.payroll_employee_payments.find(x=>Number(x.user_id)===SPLIT).payment_status,'unpaid');

    // Residual already recorded: identical resubmission is a no-op, a different one is rejected.
    const before=await state(db);
    await assert.rejects(settle(db,p,{userIds:[LAST_BANK,SPLIT],key:'request-key-part-0002',residuals:[{...p.plan.residuals[0],amount:2}]}),/RESIDUAL_CONFLICT/);assert.deepEqual(await state(db),before);
    const done=await settle(db,p,{userIds:[LAST_BANK,SPLIT],key:'request-key-part-0003'});
    assert.equal(done.status,'completed');assert.equal(done.ledgerCompanyCost.status,'created');
    assert.deepEqual(await activeGroups(db),{[key(D10,BANK)]:bank,[key(D10,CASH)]:cash10,[key(D14,CASH)]:cash14});
    assert.deepEqual(await balances(db),{[BANK]:-bank,[CASH]:-(cash10+cash14)});
    s=await state(db);
    assert.deepEqual(s.payroll_employee_payment_allocations.map(a=>a.status),['cancelled','cancelled','active','active']);
    assert.equal(s.ledger_transactions.filter(t=>t.source_type==='payroll_completed_batch').length,1);
    assert.equal(Number(s.ledger_transactions.find(t=>t.source_type==='payroll_completed_batch').amount),expectedCost(p.plan));
    assert.equal(s.payroll_payment_group_residuals.length,1);
    assert.equal(s.payroll_payment_audit_logs.filter(a=>a.action==='special_settlement_applied').length,2);
  }finally{await db.close();}
});

test('migration leaves existing payroll/ledger rows untouched and existing groups re-project as unchanged; standard v3 path still works',async()=>{
  const db=await install(new PGlite({extensions:{btree_gist}}));try{
    await db.exec(`insert into users(id,username,password,name,role,hire_date) select g,'qa'||g,'x','QA '||g,'staff','2025-01-01' from generate_series(301,303) g;`);
    const roster=[301,302,303].map(userId=>({userId,employeeName:`QA ${userId}`,part:null,position:null,isPayable:true,failureCodes:[]}));
    const pay=(month,u,amount,account,date)=>db.query(`select payroll_pay_employee_v3($1,$2,$3,$4,$5,$6,$6,null,$7,$8,1,'monthly-payroll-v12','{}',0) r`,[month,JSON.stringify(roster),u,JSON.stringify(snapshot()),'h'+u,amount,date,account]).then(r=>r.rows[0].r);
    const cancel=(run,u)=>db.query("select payroll_cancel_employee_payment_v3($1,$2,'fixture',1) r",[run,u]).then(r=>r.rows[0].r);
    // Historical month paid with the pre-migration functions (like Aug/Sep in production).
    const a=await pay('2026-08-01',301,1000000,1,'2026-09-10');await pay('2026-08-01',302,1500000,1,'2026-09-10');
    await cancel(a.runId,301);await pay('2026-08-01',301,1100000,2,'2026-09-10');
    assert.equal((await pay('2026-08-01',303,2500000,2,'2026-09-11')).status,'completed');
    const before=await baseState(db);
    await db.exec(read(MIGRATION));
    assert.deepEqual(await baseState(db),before,'applying the migration changes no existing row');
    for(const [date,account] of [['2026-09-10',1],['2026-09-10',2],['2026-09-11',2]]){
      const r=(await db.query('select ledger_project_payroll_payment_group_v1($1,$2,$3,1) r',['2026-08-01',date,account])).rows[0].r;
      assert.equal(r.status,'unchanged',`${date}/${account} fingerprint identical`);
    }
    const cost=before.payroll_payment_batches[0].actual_company_cost_total;
    await db.query('select payroll_refresh_payment_tax_totals_v1($1)',[a.runId]);
    assert.equal((await db.query('select actual_company_cost_total c from payroll_payment_batches where id=$1',[a.runId])).rows[0].c,cost);
    // New month through the unchanged standard API path, after the migration.
    const b=await pay('2026-09-01',301,500000,1,'2026-10-10');assert.equal(b.ledgerPaymentGroup.status,'created');
    await pay('2026-09-01',302,600000,1,'2026-10-10');const c=await cancel(b.runId,301);assert.equal(c.ledgerPaymentGroup.status,'rebooked');assert.equal(c.ledgerPaymentGroups.length,1);
    await pay('2026-09-01',301,500000,1,'2026-10-10');const done=await pay('2026-09-01',303,700000,2,'2026-10-10');
    assert.equal(done.status,'completed');assert.equal(done.ledgerCompanyCost.status,'created');
    const s=await baseState(db),sep=s.ledger_transactions.filter(t=>t.source_type==='payroll_payment_group'&&t.source_snapshot.payrollMonth==='2026-09-01');
    for(const t of sep)for(const e of t.source_snapshot.employees)assert.deepEqual(Object.keys(e).sort(),['amount','calculatedNetAmount','differenceAmount','differenceReason','employeeName','paidAt','paymentId','userId']);
    const batch=s.payroll_payment_batches.find(x=>x.payroll_month.toISOString().slice(0,10)==='2026-09-01');
    assert.equal(Number(batch.actual_company_cost_total),1800000+3*300);
  }finally{await db.close();}
});
