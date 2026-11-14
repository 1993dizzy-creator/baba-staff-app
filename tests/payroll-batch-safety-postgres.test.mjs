// Run from .local so the existing native cluster lifecycle keeps every temporary
// database and identity-checked cleanup/log artifact inside .local/.qa-review.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeInventoryPostgres} from './helpers/inventory-native-postgres.mjs';
import {install,newEmployee,activate,roster,pay,cancel,state,closeMonth,evidence,definition} from './helpers/payroll-batch-safety-fixture.mjs';

const settle=p=>p.then(value=>({value}),error=>({error}));
async function waitForLock(observer,pid,blocker){
  for(let i=0;i<250;i++){
    const r=(await observer.query('select wait_event_type,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=$1',[pid])).rows[0];
    if(r?.wait_event_type==='Lock'&&r.blockers.includes(blocker))return;
    await delay(10);
  }
  throw Error('Expected native PostgreSQL lock wait was not observed');
}
test('native PostgreSQL: actual v3/v2/v1 + formal safety migration concurrency',{timeout:180000},async t=>{
  const runtime=await nativeInventoryPostgres({testContext:t});t.diagnostic(runtime.version);
  async function scenario(name,fn){
    await t.test(name,{timeout:18000},async()=>{
      const db=new runtime.Database();const rolesExist=(await db.query("select exists(select 1 from pg_roles where rolname='anon') yes")).rows[0].yes;
      await install(db,{rolesExist});const a=await runtime.connect(db.name),b=await runtime.connect(db.name);const pending=[];
      const pidA=(await a.query('select pg_backend_pid() pid')).rows[0].pid,pidB=(await b.query('select pg_backend_pid() pid')).rows[0].pid;
      const start=p=>{const result=settle(p);pending.push(result);return result;};
      const lock=()=>waitForLock(db,pidB,pidA);
      try{
        for(const c of[a,b])await c.query("set statement_timeout='10s';set deadlock_timeout='100ms'");
        await fn({db,a,b,start,lock});
      }finally{
        await a.query('rollback');await b.query('rollback');await Promise.allSettled(pending);
        for(const c of[a,b])await c.query('select pg_stat_force_next_flush()');
        await db.query('select pg_stat_clear_snapshot()');
        assert.equal(Number((await db.query('select deadlocks from pg_stat_database where datname=current_database()')).rows[0].deadlocks),0,'No 40P01/deadlock accepted');
        await db.close();
      }
    });
  }
  await scenario('same employee concurrent payment: one paid row/audit/cash effect',async({db,a,b,start,lock})=>{
    const users=[await newEmployee(db,'a'),await newEmployee(db,'b')],targets=roster(users);
    await a.query('begin');await pay(a,users[0].id,targets);
    const second=start(pay(b,users[0].id,targets));await lock();await a.query('commit');
    assert.match((await second).error?.message??'',/ALREADY_PAID/);
    const s=await state(db);assert.equal(s.payroll_payment_audit_logs.filter(r=>r.action==='employee_paid').length,1);
    assert.equal(s.ledger_movements.reduce((n,m)=>n+Number(m.amount),0),-4129032);
  });
  await scenario('different employees concurrent first payments: one full roster and no lost totals',async({db,a,b,start,lock})=>{
    const users=[await newEmployee(db,'a'),await newEmployee(db,'b'),await newEmployee(db,'c',{active:false})],targets=roster(users,users[2].id);
    await a.query('begin');await pay(a,users[0].id,targets);
    const second=start(pay(b,users[1].id,targets));await lock();await a.query('commit');assert.equal((await second).value.status,'paying');
    const s=await state(db);assert.equal(s.payroll_payment_batches.length,1);assert.equal(s.payroll_employee_payments.length,3);
    assert.equal(s.payroll_payment_batches[0].paid_employee_count,2);assert.equal(s.ledger_movements.reduce((n,m)=>n+Number(m.amount),0),-8258064);
  });
  for(const finalFirst of[true,false])await scenario('last payment vs cancellation: '+(finalFirst?'completion wins':'cancellation wins'),async({db,a,b,start,lock})=>{
    const users=[await newEmployee(db,'a'),await newEmployee(db,'b')],targets=roster(users);await pay(db,users[0].id,targets);
    await a.query('begin');if(finalFirst)await pay(a,users[1].id,targets);else await cancel(a,users[0].id);
    const second=start(finalFirst?cancel(b,users[0].id):pay(b,users[1].id,targets));await lock();await a.query('commit');const r=await second;
    const s=await state(db);
    if(finalFirst){assert.match(r.error?.message??'',/BATCH_COMPLETED/);assert.equal(s.payroll_payment_batches[0].status,'completed');assert.equal(s.payroll_payment_audit_logs.filter(a=>a.action==='batch_completed').length,1);}
    else{assert.equal(r.value.status,'paying');assert.equal(s.payroll_payment_batches[0].paid_employee_count,1);assert.equal(s.ledger_transactions.filter(r=>r.source_type==='payroll_completed_batch').length,0);}
  });
  for(const closeFirst of[true,false])await scenario('policy link vs close: '+(closeFirst?'close wins':'link wins'),async({db,a,b,start,lock})=>{
    const u=await newEmployee(db,'pending',{active:false});await a.query('begin');
    if(closeFirst)await closeMonth(a);else assert.equal((await activate(a,u.id)).status,'created');
    const second=start(closeFirst?activate(b,u.id):closeMonth(b));await lock();await a.query('commit');const r=await second;
    assert.equal(r.value.status,closeFirst?'policy_review_required':'closed');
    assert.equal((await db.query('select status from payroll_first_month_policies')).rows[0].status,closeFirst?'pending':'active');
  });
  await scenario('policy registration waits for close and cannot commit enrollment afterwards',async({db,a,b,start,lock})=>{
    await a.query('begin');await closeMonth(a);const second=start(newEmployee(b,'late',{active:false}));await lock();await a.query('commit');
    assert.match((await second).error?.message??'',/FIRST_MONTH_POLICY_REVIEW_REQUIRED/);
    assert.equal((await db.query('select count(*)::int n from payroll_first_month_policies')).rows[0].n,0);
  });
  await scenario('actual policy date correction wins: stale payment rejected without deadlock',async({db,a,b,start,lock})=>{
    const users=[await newEmployee(db,'a'),await newEmployee(db,'b')],targets=roster(users),snapshot=await evidence(db,users[0].id);
    const historyBefore=(await db.query('select jsonb_array_length(change_history)::int n from payroll_first_month_policies where user_id=$1',[users[0].id])).rows[0].n;
    await a.query('begin');await a.query(`update users set hire_date='2026-08-17' where id=$1`,[users[0].id]);
    const corrected=(await a.query(`select payroll_correct_first_month_hire_date_v1($1,'2026-08-16','2026-08-17','explicit correction',1) r`,[users[0].id])).rows[0].r;
    assert.equal(corrected.status,'corrected');
    const second=start(pay(b,users[0].id,targets,{snapshot}));await lock();await a.query('commit');
    assert.match((await second).error?.message??'',/FIRST_MONTH_POLICY_REVIEW_REQUIRED/);
    const s=await state(db);assert.equal(s.payroll_employee_payments.length,0);assert.equal(s.ledger_movements.length,0);
    assert.equal((await db.query('select jsonb_array_length(change_history)::int n from payroll_first_month_policies where user_id=$1',[users[0].id])).rows[0].n,historyBefore+1);
  });
  await scenario('contract correction wins: old payment evidence rejected, no payment/cash committed',async({db,a,b,start,lock})=>{
    const users=[await newEmployee(db,'a'),await newEmployee(db,'b')],targets=roster(users),snapshot=await evidence(db,users[0].id);
    await db.exec(`alter table payroll_contract_audit_logs drop constraint payroll_contract_audit_logs_action_check;
      alter table payroll_contract_audit_logs add constraint payroll_contract_audit_logs_action_check check(action in('created','corrected'));`);
    await db.exec(definition('20260909231222_fix_contract_correction_payment_snapshot.sql','payroll_correct_latest_unused_contract_core_v2'));
    const audit=(await db.query('select max(id) id from payroll_contract_audit_logs where user_id=$1',[users[0].id])).rows[0].id;
    await a.query('begin');const corrected=(await a.query(`select payroll_correct_latest_unused_contract_core_v2($1,$2,1,$3,'2026-08-01','monthly','fixed_monthly',9000000,0,26,540,1,'none','ignore','ignore','ignore','unpaid','2026-08-01',1,null,'explicit correction') r`,[snapshot.contractSnapshot[0].id,users[0].id,audit])).rows[0].r;
    assert.equal(corrected.status,'corrected');const second=start(pay(b,users[0].id,targets,{snapshot}));await lock();await a.query('commit');
    assert.match((await second).error?.message??'',/FIRST_MONTH_POLICY_REVIEW_REQUIRED/);const s=await state(db);
    assert.equal(s.payroll_employee_payments.length,0);assert.equal(s.ledger_movements.length,0);
  });
});
