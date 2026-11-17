import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {btree_gist} from '@electric-sql/pglite/contrib/btree_gist';
import {install,read,state as baseState} from './helpers/payroll-batch-safety-fixture.mjs';
import {MIGRATION,OCT,BANK,CASH,D10,D14,IDS,SPLIT,CASH_ONLY,INS,OWNER,MASTER,STAFF,INACTIVE_MASTER,NO_LOGIN_MASTER,
  syntheticPlan,snapshot,targets,payments,hex,settle,database,state} from './helpers/payroll-2026-10-settlement-fixture.mjs';

// The one-off settlement app path (plan loader/API/page) was retired after the
// production run (batch 4). This test stays as the regression proof for the
// APPLIED migration: the shared split-allocation/residual tables, the group
// projector, cancel v3 and payment tax refresh that other months keep using.
// Synthetic plan/settle helpers: tests/helpers/payroll-2026-10-settlement-fixture.mjs.
const activeGroups=async db=>Object.fromEntries((await db.query(`select t.source_snapshot->>'groupKey' k,t.amount::float8 a from ledger_transactions t where t.source_type='payroll_payment_group' and t.status='confirmed'
  and not exists(select 1 from ledger_transactions r where r.correction_of_id=t.id and r.source_type='payroll_payment_group_reversal')`)).rows.map(r=>[r.k.split(':').slice(2).join(':'),r.a]));
const balances=async db=>Object.fromEntries((await db.query('select fund_account_id f,sum(amount)::float8 s from ledger_movements group by 1')).rows.map(r=>[Number(r.f),r.s]));
const key=(d,f)=>`${d}:${f}`;
const expectedCost=plan=>plan.employees.reduce((n,e)=>n+e.actualPaidAmount+INS.employee+INS.employer,0)+1;
const applied=s=>s.payroll_payment_audit_logs.filter(a=>a.action==='special_settlement_applied').length;

for(const [label,actor] of [['owner',OWNER],['master',MASTER]])
test(`${label} completes 17/17 with exact cash groups, split refund, residual and one closed-month company cost`,async()=>{
  const db=await database(),p=syntheticPlan();try{
    const closureBefore=(await db.query("select * from ledger_month_closures where month='2026-10-01'")).rows;
    const r=await settle(db,p,{actor});
    assert.equal(r.status,'completed');assert.equal(r.paidEmployeeCount,17);assert.equal(r.targetEmployeeCount,17);assert.equal(r.ledgerCompanyCost.status,'created');
    const [bank,cash10,cash14]=p.plan.expectedGroups.map(g=>g.amount);
    assert.deepEqual(await activeGroups(db),{[key(D10,BANK)]:bank,[key(D10,CASH)]:cash10,[key(D14,CASH)]:cash14});
    assert.deepEqual(await balances(db),{[BANK]:-bank,[CASH]:-(cash10+cash14)});
    const s=await state(db);
    const cost=s.ledger_transactions.filter(t=>t.source_type==='payroll_completed_batch');
    assert.equal(cost.length,1);assert.equal(cost[0].recognition_month.toISOString().slice(0,10),OCT);assert.equal(Number(cost[0].amount),expectedCost(p.plan));
    assert.equal(Number(s.payroll_payment_batches[0].actual_paid_total),p.plan.employees.reduce((n,e)=>n+e.actualPaidAmount,0));
    const split=s.payroll_employee_payments.find(x=>Number(x.user_id)===SPLIT);
    assert.equal(Number(split.actual_paid_amount),4150000);assert.equal(Number(split.fund_account_id),BANK);assert.equal(Number(split.difference_amount),2);assert.match(split.difference_reason,/차액 \+2₫/);
    assert.deepEqual(s.payroll_employee_payment_allocations.map(a=>[a.allocation_kind,Number(a.fund_account_id),Number(a.amount),a.status]),[['salary',BANK,4000000,'active'],['penalty_refund',CASH,150000,'active']]);
    assert.equal(s.payroll_payment_audit_logs.filter(a=>a.action==='employee_paid').length,17);
    assert.equal(s.payroll_payment_audit_logs.filter(a=>a.action==='batch_completed').length,1);
    assert.equal(applied(s),1);assert.equal(Number(s.payroll_payment_audit_logs.find(a=>a.action==='special_settlement_applied').actor_user_id),actor);
    assert.deepEqual((await db.query("select * from ledger_month_closures where month='2026-10-01'")).rows,closureBefore);
    assert.equal(s.ledger_transactions.filter(t=>t.business_date.toISOString().slice(0,7)==='2026-10').length,0);
  }finally{await db.close();}
});

test('permission: staff, inactive master and login-disabled master are refused without writes',async()=>{
  const db=await database(),p=syntheticPlan();try{
    const before=await state(db);
    await assert.rejects(settle(db,p,{actor:STAFF}),/PAYROLL_FORBIDDEN/);assert.deepEqual(await state(db),before);
    await assert.rejects(settle(db,p,{actor:INACTIVE_MASTER}),/PAYROLL_FORBIDDEN/);assert.deepEqual(await state(db),before);
    // Passes the payroll actor check, but the ledger projector requires app login: whole call rolls back.
    await assert.rejects(settle(db,p,{actor:NO_LOGIN_MASTER}),/PAYROLL_LEDGER_PROJECTION_FAILED:forbidden/);assert.deepEqual(await state(db),before);
    await assert.rejects(settle(db,p,{actor:999}),/PAYROLL_FORBIDDEN/);assert.deepEqual(await state(db),before);
  }finally{await db.close();}
});

test('partial or mismatched scope is rejected before any write and never audited as applied',async()=>{
  const db=await database(),p=syntheticPlan();try{
    const before=await state(db),sixteen=IDS.slice(0,16);
    for(const [name,o] of [
      ['16 payments, 17 targets',{payments:payments(p.plan,sixteen)}],
      ['16 targets and payments',{targets:targets(sixteen),payments:payments(p.plan,sixteen)}],
      ['one target not payable',{targets:targets(IDS,209)}],
      ['targets differ from payments',{targets:targets([...sixteen,299])}],
      ['duplicate target',{targets:[...targets(sixteen),targets([201])[0]]}],
    ]){await assert.rejects(settle(db,p,o),/SCOPE_MISMATCH/,name);assert.deepEqual(await state(db),before,name);}
    assert.equal(applied(await state(db)),0);
  }finally{await db.close();}
});

test('any failure after writes started rolls back the whole transaction',async()=>{
  const db=await database(),p=syntheticPlan();try{
    const before=await state(db);
    const bad=structuredClone(p.plan.expectedGroups);bad[0].amount+=1;
    await assert.rejects(settle(db,p,{expected:bad}),/GROUP_MISMATCH:cash_groups/);assert.deepEqual(await state(db),before);
    // Fault injection (fixture only): the last employee's payment write fails after 16 succeeded.
    await db.exec(`create function qa_fail_last() returns trigger language plpgsql as $$begin if new.user_id=217 and new.payment_status='paid' then raise exception 'QA_INJECTED_FAILURE';end if;return new;end$$;
      create trigger qa_fail_last before update on payroll_employee_payments for each row execute function qa_fail_last();`);
    await assert.rejects(settle(db,p),/QA_INJECTED_FAILURE/);
    await db.exec('drop trigger qa_fail_last on payroll_employee_payments;drop function qa_fail_last();');assert.deepEqual(await state(db),before);
    const broken=payments(p.plan);broken.find(x=>x.userId===SPLIT).allocations[1].amount=149999;
    await assert.rejects(settle(db,p,{payments:broken}),/ALLOCATION_MISMATCH/);assert.deepEqual(await state(db),before);
    await assert.rejects(settle(db,p,{expected:p.plan.expectedGroups.slice(0,2)}),/GROUP_UNDECLARED/);assert.deepEqual(await state(db),before);
    await assert.rejects(settle(db,p,{month:'2026-09-01'}),/MONTH_NOT_ALLOWED/);assert.deepEqual(await state(db),before);
    await assert.rejects(settle(db,p,{key:'short'}),/INVALID_PAYMENT_REQUEST/);assert.deepEqual(await state(db),before);
    await db.exec('delete from ledger_categories');
    await assert.rejects(settle(db,p),/COMPANY_COST_SYNC_FAILED/);assert.deepEqual(await state(db),before);
    assert.equal(applied(await state(db)),0);
  }finally{await db.close();}
});

test('retry: replay needs same request/plan hash and an intact final state; a second execution is refused',async()=>{
  const db=await database(),p=syntheticPlan();try{
    const r=await settle(db,p);const after=await state(db);
    const replay=await settle(db,p);assert.equal(replay.replayed,true);assert.equal(replay.runId,r.runId);assert.deepEqual(await state(db),after);
    await assert.rejects(settle(db,p,{hash:hex('b')}),/REQUEST_CONFLICT/);assert.deepEqual(await state(db),after);
    await assert.rejects(settle(db,p,{planHash:hex('c')}),/REQUEST_CONFLICT/);assert.deepEqual(await state(db),after);
    await assert.rejects(settle(db,p,{key:'request-key-0002-abcdef'}),/BATCH_EXISTS/);assert.deepEqual(await state(db),after);
    // Fixture-only tampering: replay must notice a batch that no longer matches the recorded result.
    await db.exec('update payroll_payment_batches set actual_paid_total=actual_paid_total+1');
    const tampered=await state(db);
    await assert.rejects(settle(db,p),/REPLAY_STATE_MISMATCH:paid_total/);assert.deepEqual(await state(db),tampered);
  }finally{await db.close();}
});

test('completed batch keeps the existing no-cancel rule; THÀNH-style split cancel re-books both accounts',async()=>{
  const db=await database(),p=syntheticPlan();try{
    const r=await settle(db,p);const after=await state(db);
    for(const user of [SPLIT,CASH_ONLY])await assert.rejects(db.query("select payroll_cancel_employee_payment_v3($1,$2,'x',1)",[r.runId,user]),/BATCH_COMPLETED/);
    await assert.rejects(db.query(`select payroll_pay_employee_v3('2026-10-01',$1,201,$2,'h',1,1,null,'2026-11-10',2,1,'v','{}',0)`,[JSON.stringify(targets()),JSON.stringify(snapshot())]),/BATCH_COMPLETED/);
    assert.deepEqual(await state(db),after);
    // Fixture only: reopen the batch to exercise the allocation-aware cancel function itself.
    await db.exec("update payroll_payment_batches set status='paying',completed_by=null,completed_at=null");
    const [bank,cash10,cash14]=p.plan.expectedGroups.map(g=>g.amount);
    const c=(await db.query("select payroll_cancel_employee_payment_v3($1,$2,'synthetic re-check',1) r",[r.runId,SPLIT])).rows[0].r;
    assert.equal(c.ledgerPaymentGroups.length,2);assert.ok(c.ledgerPaymentGroup.groupKey.endsWith(key(D10,BANK)));
    assert.deepEqual(await activeGroups(db),{[key(D10,BANK)]:bank-4000000,[key(D10,CASH)]:cash10-150000,[key(D14,CASH)]:cash14});
    assert.deepEqual(await balances(db),{[BANK]:-(bank-4000000),[CASH]:-(cash10-150000+cash14)});
    const s=await state(db);
    assert.deepEqual(s.payroll_employee_payment_allocations.map(a=>[a.status,a.cancellation_reason]),[['cancelled','synthetic re-check'],['cancelled','synthetic re-check']]);
    assert.equal(s.payroll_employee_payments.find(x=>Number(x.user_id)===SPLIT).payment_status,'unpaid');
    assert.equal(s.payroll_payment_audit_logs.filter(a=>a.action==='employee_payment_cancelled').length,1);
  }finally{await db.close();}
});

test('migration leaves existing payroll/ledger rows untouched and existing groups re-project as unchanged; standard v3 path still works',async()=>{
  const db=await install(new PGlite({extensions:{btree_gist}}));try{
    await db.exec(`insert into users(id,username,password,name,role,hire_date) select g,'qa'||g,'x','QA '||g,'staff','2025-01-01' from generate_series(301,303) g;`);
    const roster=[301,302,303].map(userId=>({userId,employeeName:`QA ${userId}`,part:null,position:null,isPayable:true,failureCodes:[]}));
    const pay=(month,u,amount,account,date)=>db.query(`select payroll_pay_employee_v3($1,$2,$3,$4,$5,$6,$6,null,$7,$8,1,'monthly-payroll-v12','{}',0) r`,[month,JSON.stringify(roster),u,JSON.stringify(snapshot()),'h'+u,amount,date,account]).then(r=>r.rows[0].r);
    const cancel=(run,u)=>db.query("select payroll_cancel_employee_payment_v3($1,$2,'fixture',1) r",[run,u]).then(r=>r.rows[0].r);
    const a=await pay('2026-08-01',301,1000000,1,'2026-09-10');await pay('2026-08-01',302,2000000,1,'2026-09-10');
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
    const b=await pay('2026-09-01',301,500000,1,'2026-10-10');assert.equal(b.ledgerPaymentGroup.status,'created');
    await pay('2026-09-01',302,600000,1,'2026-10-10');const c=await cancel(b.runId,301);assert.equal(c.ledgerPaymentGroup.status,'rebooked');assert.equal(c.ledgerPaymentGroups.length,1);
    await pay('2026-09-01',301,500000,1,'2026-10-10');const done=await pay('2026-09-01',303,700000,2,'2026-10-10');
    assert.equal(done.status,'completed');assert.equal(done.ledgerCompanyCost.status,'created');
    const s=await baseState(db),sep=s.ledger_transactions.filter(t=>t.source_type==='payroll_payment_group'&&t.source_snapshot.payrollMonth==='2026-09-01');
    for(const t of sep)for(const e of t.source_snapshot.employees)assert.deepEqual(Object.keys(e).sort(),['amount','calculatedNetAmount','differenceAmount','differenceReason','employeeName','paidAt','paymentId','userId']);
    const batch=s.payroll_payment_batches.find(x=>x.payroll_month.toISOString().slice(0,10)==='2026-09-01');
    assert.equal(Number(batch.actual_company_cost_total),1800000+3*300);
    await assert.rejects(cancel(b.runId,301),/BATCH_COMPLETED/,'existing completed-batch rule unchanged for normal months');
  }finally{await db.close();}
});
