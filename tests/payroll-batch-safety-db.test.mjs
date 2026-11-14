import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {btree_gist} from '@electric-sql/pglite/contrib/btree_gist';
import {install,newEmployee,activate,roster,pay,cancel,state,closeMonth,read,safetyPath} from './helpers/payroll-batch-safety-fixture.mjs';

const database=async(options)=>install(new PGlite({extensions:{btree_gist}}),options);
test('nine ready employees and one pending: full roster retained, selected employee only, final completion once',async()=>{
  const db=await database();try{
    const users=[];for(let i=0;i<10;i++)users.push(await newEmployee(db,'person-'+i,{active:i!==9}));
    let targets=roster(users,users[9].id);
    await assert.rejects(pay(db,users[9].id,targets),/BATCH_PREFLIGHT_FAILED/);
    assert.equal((await state(db)).payroll_payment_batches.length,0);
    const first=await pay(db,users[0].id,targets,{hash:'first-original-hash'});assert.equal(first.status,'paying');
    let current=await state(db);assert.equal(current.payroll_employee_payments.length,10);assert.equal(current.payroll_payment_batches[0].target_employee_count,10);
    const saved=current.payroll_employee_payments.find(p=>Number(p.user_id)===users[0].id);
    assert.equal(saved.calculation_hash,'first-original-hash');
    for(let i=1;i<9;i++)assert.equal((await pay(db,users[i].id,targets)).status,'paying');
    await assert.rejects(pay(db,users[0].id,targets),/ALREADY_PAID/);
    assert.equal((await activate(db,users[9].id)).status,'created');targets=roster(users);
    // Existing close-first operation remains valid. Final salary cash is in September.
    assert.equal((await closeMonth(db)).status,'closed');
    assert.equal((await pay(db,users[9].id,targets)).status,'completed');
    current=await state(db);assert.equal(current.payroll_payment_batches[0].paid_employee_count,10);
    assert.deepEqual(current.payroll_employee_payments.find(p=>Number(p.user_id)===users[0].id),saved);
    assert.equal(current.payroll_payment_audit_logs.filter(a=>a.action==='batch_completed').length,1);
    assert.equal(current.payroll_payment_audit_logs.filter(a=>a.action==='employee_paid').length,10);
    assert.equal(current.ledger_transactions.filter(t=>t.source_type==='payroll_completed_batch').length,1);
    assert.equal(current.ledger_movements.reduce((sum,m)=>sum+Number(m.amount),0),-4129032*10);
    assert.ok(current.ledger_transactions.some(t=>t.source_type==='payroll_payment_group_reversal'));
    await assert.rejects(pay(db,users[0].id,targets),/BATCH_COMPLETED/);
  }finally{await db.close();}
});
test('malformed/duplicate/missing targets and changing a started roster are rejected without writes',async()=>{
  const db=await database();try{
    const a=await newEmployee(db,'a'),b=await newEmployee(db,'b'),targets=roster([a,b]);
    for(const bad of [[],{},null,[targets[0],targets[0]],[targets[1]],[{...targets[0],userId:'101'}],[{...targets[0],isPayable:null}],[{...targets[0],failureCodes:{}}]]){
      const before=await state(db);await assert.rejects(pay(db,a.id,bad),/INVALID_PAYMENT_REQUEST/);assert.deepEqual(await state(db),before);
    }
    await pay(db,a.id,targets);const before=await state(db);
    await assert.rejects(pay(db,b.id,[targets[1]]),/BATCH_TARGET_MISMATCH/);assert.deepEqual(await state(db),before);
    const outside=await newEmployee(db,'outside');
    await assert.rejects(pay(db,outside.id,roster([a,outside])),/BATCH_TARGET_MISMATCH/);
    assert.deepEqual(await state(db),before);
  }finally{await db.close();}
});
test('selected-only checks run on existing batches and trigger/ledger failures roll back payment, snapshot, audit and cash',async()=>{
  const db=await database();try{
    const a=await newEmployee(db,'a'),b=await newEmployee(db,'b'),targets=roster([a,b]);
    await pay(db,a.id,targets);const before=await state(db);
    await assert.rejects(pay(db,b.id,roster([a,b],b.id)),/BATCH_PREFLIGHT_FAILED/);assert.deepEqual(await state(db),before);
    await assert.rejects(pay(db,b.id,targets,{snapshot:{employee:{},automaticItemsSnapshot:[]}}),/FIRST_MONTH_POLICY_REVIEW_REQUIRED/);assert.deepEqual(await state(db),before);
    await db.exec(`delete from ledger_categories`);
    await assert.rejects(pay(db,b.id,targets),/COMPANY_COST_SYNC_FAILED/);assert.deepEqual(await state(db),before);
    // Reusing September's cash date after its ledger is closed fails atomically.
    await closeMonth(db,'2026-09-01');const closed=await state(db);
    await assert.rejects(pay(db,b.id,targets),/LEDGER_PROJECTION_FAILED/);assert.deepEqual(await state(db),closed);
  }finally{await db.close();}
});
test('cancellation keeps snapshots in audit, rebooks cash, and pending after close is never auto-activated',async()=>{
  const db=await database();try{
    const a=await newEmployee(db,'a'),b=await newEmployee(db,'b',{active:false});const targets=roster([a,b],b.id);
    await pay(db,a.id,targets,{hash:'paid-original'});await cancel(db,a.id);
    const s=await state(db),audit=s.payroll_payment_audit_logs.find(a=>a.action==='employee_payment_cancelled');
    assert.equal(audit.before_snapshot.calculation_hash,'paid-original');
    assert.equal(s.ledger_movements.reduce((sum,m)=>sum+Number(m.amount),0),0);
    await pay(db,a.id,targets);await closeMonth(db);
    assert.equal((await activate(db,b.id)).status,'policy_review_required');
    assert.equal((await state(db)).payroll_payment_batches[0].status,'paying');
  }finally{await db.close();}
});
test('forward migration changes routines only and refuses an unexpected/repeated function contract atomically',async()=>{
  const db=await database({safety:false});try{
    const a=await newEmployee(db,'a');await activate(db,a.id);const before=await state(db);
    const policyBefore=(await db.query('select * from payroll_first_month_policies')).rows;
    const permissions=()=>db.query(`select oid::regprocedure::text signature,proacl::text,prosecdef,proconfig from pg_proc
      where pronamespace='public'::regnamespace and proname in ('payroll_pay_employee_v1','payroll_pay_employee_v3',
      'payroll_cancel_employee_payment_v3','ledger_close_month_v1','ledger_reopen_month_v1','employee_create_with_proration_v1',
      'payroll_link_first_month_contract_v1','payroll_correct_first_month_hire_date_v1') order by 1`);
    const permissionsBefore=(await permissions()).rows;
    await db.exec(read(safetyPath));assert.deepEqual(await state(db),before);
    assert.deepEqual((await db.query('select * from payroll_first_month_policies')).rows,policyBefore);
    assert.deepEqual((await permissions()).rows,permissionsBefore);
    for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query(
      `select has_function_privilege($1,'public.payroll_lock_months_v1(date[])','EXECUTE') allowed`,[role])).rows[0].allowed,false);
    await assert.rejects(db.exec(read(safetyPath)),/already exists/);await db.exec('rollback');
    assert.deepEqual(await state(db),before);
  }finally{await db.close();}
});

test('a changed downstream function contract rolls back all earlier migration patches',async()=>{
  const db=await database({safety:false});try{
    const original=(await db.query(`select pg_get_functiondef('public.ledger_close_month_v1(date,text,jsonb,jsonb,text,bigint)'::regprocedure) body`)).rows[0].body;
    await db.exec(original.replace("'ledger_month_close_serial'","'unexpected_lock'"));
    const before=(await db.query(`select pg_get_functiondef('public.payroll_pay_employee_v1(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,text,jsonb,bigint)'::regprocedure) body`)).rows[0].body;
    await assert.rejects(db.exec(read(safetyPath)),/PAYROLL_SAFETY_CONTRACT_MISMATCH: public.ledger_close_month_v1/);
    await db.exec('rollback');
    assert.equal((await db.query(`select to_regprocedure('public.payroll_lock_months_v1(date[])') value`)).rows[0].value,null);
    assert.equal((await db.query(`select pg_get_functiondef('public.payroll_pay_employee_v1(date,jsonb,bigint,jsonb,text,bigint,bigint,text,date,bigint,text,jsonb,bigint)'::regprocedure) body`)).rows[0].body,before);
  }finally{await db.close();}
});

test('existing explicit owner reopen/reclose preserves close history; pending never repairs itself',async()=>{
  const db=await database();try{
    const a=await newEmployee(db,'owner-reviewed',{active:false});await closeMonth(db);
    const original=(await db.query('select * from ledger_month_closures')).rows[0];
    assert.equal((await activate(db,a.id)).status,'policy_review_required');
    // This is the existing owner RPC, NOT an automatic policy recovery path.
    assert.equal((await db.query(`select ledger_reopen_month_v1('2026-08-01','Owner-approved review',1) r`)).rows[0].r.status,'reopened');
    assert.equal((await activate(db,a.id)).status,'created');await closeMonth(db);
    const history=(await db.query('select * from ledger_month_closure_history')).rows;
    assert.equal(history.length,1);assert.equal(history[0].snapshot_hash,original.snapshot_hash);
    assert.equal(history[0].revision,1);assert.equal((await db.query('select revision from ledger_month_closures')).rows[0].revision,2);
    assert.equal((await pay(db,a.id,roster([a]))).status,'completed');
  }finally{await db.close();}
});
