import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {btree_gist} from '@electric-sql/pglite/contrib/btree_gist';
import {install,read} from './helpers/payroll-batch-safety-fixture.mjs';
import {MIGRATION,OCT,IDS,snapshot,targets,settle,database,state,syntheticPlan} from './helpers/payroll-2026-10-settlement-fixture.mjs';

// LEGACY-CLEANUP-P1: the retirement migration drops only the two one-off
// 2026-10 settle RPCs. Synthetic data only (isolated PGlite).
const RETIRE='supabase/migrations/20261117055003_retire_payroll_2026_10_settle_rpcs.sql';
const SETTLE_SIG='public.payroll_settle_2026_10_v1(date,jsonb,jsonb,jsonb,jsonb,text,text,text,bigint,text,jsonb,bigint)';
const FINAL_SIG='public.payroll_settle_2026_10_final_state_v1(date,jsonb,bigint,bigint,bigint)';
const SHARED=['public.ledger_project_payroll_payment_group_v1(date,date,bigint,bigint)','public.payroll_cancel_employee_payment_v3(bigint,bigint,text,bigint)','public.payroll_refresh_payment_tax_totals_v1(bigint)'];

const exists=async(db,sig)=>(await db.query('select to_regprocedure($1) is not null e',[sig])).rows[0].e;
// Every public function: signature, body hash, ACL, security and config.
const functions=async db=>(await db.query(`select p.oid::regprocedure::text sig,md5(p.prosrc) body,coalesce(p.proacl::text,'') acl,p.prosecdef sd,coalesce(p.proconfig::text,'') cfg
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by 1`)).rows;
const withoutSettle=rows=>rows.filter(r=>!r.sig.startsWith('payroll_settle_2026_10_'));
async function retire(db){
  try{await db.exec(read(RETIRE));}catch(e){await db.exec('rollback');throw e;}
}
// Recovery path documented in the migration: the original create blocks and grants.
function recoverySql(){
  const sql=read(MIGRATION),start=sql.indexOf('create or replace function public.payroll_settle_2026_10_final_state_v1(');
  const settleAt=sql.indexOf('create or replace function public.payroll_settle_2026_10_v1(');
  const end=sql.indexOf('\n$$;',settleAt)+4;
  assert.ok(start>0&&settleAt>start&&end>settleAt);
  const grants=sql.split('\n').filter(l=>/^(revoke|grant) .* on function public\.payroll_settle_2026_10_/.test(l));
  assert.equal(grants.length,3);
  return `begin;\n${sql.slice(start,end)}\n${grants.join('\n')}\ncommit;\n`;
}
const groupProjection=(db,date,account)=>db.query('select ledger_project_payroll_payment_group_v1($1,$2,$3,1) r',[OCT,date,account]).then(r=>r.rows[0].r);

test('retires both settle RPCs after a completed 17/17 settlement without changing any row or other function',async()=>{
  const db=await database(),p=syntheticPlan();try{
    const r=await settle(db,p);assert.equal(r.status,'completed');
    const rows=await state(db),fns=await functions(db);
    assert.ok(await exists(db,SETTLE_SIG));assert.ok(await exists(db,FINAL_SIG));
    await retire(db);
    assert.equal(await exists(db,SETTLE_SIG),false);assert.equal(await exists(db,FINAL_SIG),false);
    assert.deepEqual(await state(db),rows,'payroll, allocation, residual, request, audit and ledger rows unchanged');
    assert.deepEqual(await functions(db),withoutSettle(fns),'only the two settle RPCs are gone; every other body/ACL is identical');
    for(const sig of SHARED)assert.ok(await exists(db,sig),sig);
    await assert.rejects(settle(db,p),/does not exist/);
    // October stays closed to the standard payment and cancel paths.
    await assert.rejects(db.query(`select payroll_pay_employee_v3('2026-10-01',$1,201,$2,'h',1,1,null,'2026-11-10',2,1,'v','{}',0)`,[JSON.stringify(targets()),JSON.stringify(snapshot())]),/BATCH_COMPLETED/);
    await assert.rejects(db.query("select payroll_cancel_employee_payment_v3($1,201,'x',1)",[r.runId]),/BATCH_COMPLETED/);
    // Existing October cash groups (incl. split + residual) re-project unchanged.
    // (An 'unchanged' projection only refreshes sync timestamps, as before retirement.)
    for(const g of p.plan.expectedGroups)assert.equal((await groupProjection(db,g.paymentDate,g.fundAccountId)).status,'unchanged');
  }finally{await db.close();}
});

test('standard payroll for another month still pays, cancels and completes after retirement',async()=>{
  const db=await database(),p=syntheticPlan();try{
    await settle(db,p);await retire(db);
    const roster=targets([201,202]);
    const pay=(u,amount)=>db.query(`select payroll_pay_employee_v3('2026-09-01',$1,$2,$3,$4,$5,$5,null,'2026-11-12',1,1,'monthly-payroll-v12','{}',0) r`,[JSON.stringify(roster),u,JSON.stringify(snapshot()),'h'+u,amount]).then(x=>x.rows[0].r);
    const a=await pay(201,500000);assert.equal(a.ledgerPaymentGroup.status,'created');
    const c=(await db.query("select payroll_cancel_employee_payment_v3($1,201,'fixture',1) r",[a.runId])).rows[0].r;assert.equal(c.ledgerPaymentGroup.status,'cleared');
    await pay(201,500000);const done=await pay(202,600000);
    assert.equal(done.status,'completed');assert.equal(done.ledgerCompanyCost.status,'created');
  }finally{await db.close();}
});

// Every refused precondition: nothing dropped, no row or function changed (whole transaction rolled back).
async function assertRefused(db,pattern,label){
  const rows=await state(db),fns=await functions(db);
  await assert.rejects(retire(db),pattern,label);
  assert.ok(await exists(db,SETTLE_SIG),label);assert.ok(await exists(db,FINAL_SIG),label);
  assert.deepEqual(await functions(db),fns,label);assert.deepEqual(await state(db),rows,label);
}
// Fixture-only tampering of a settled synthetic DB (append-only triggers bypassed for the fixture only).
async function tampered(sql){
  const db=await database();await settle(db,syntheticPlan());
  await db.exec(`set session_replication_role=replica;${sql};set session_replication_role=origin;`);
  return db;
}
const copyRequest="insert into payroll_special_settlement_requests(payroll_month,request_key,request_hash,plan_hash,user_ids,result,created_by) select payroll_month,'request-key-0002-abcdef',request_hash,plan_hash,user_ids,result,created_by from payroll_special_settlement_requests";
const copyApplied="insert into payroll_payment_audit_logs(payroll_batch_id,action,actor_user_id,reason,after_snapshot) select payroll_batch_id,action,actor_user_id,reason,after_snapshot from payroll_payment_audit_logs where action='special_settlement_applied'";

test('guard: no October batch (fresh replay, or other months only) is refused',async()=>{
  const fresh=await install(new PGlite({extensions:{btree_gist}}));try{
    await fresh.exec(read(MIGRATION));await assertRefused(fresh,/PRECONDITION:batch_count:0/,'fresh replay');
  }finally{await fresh.close();}
  const db=await database();try{
    const done=(await db.query(`select payroll_pay_employee_v3('2026-09-01',$1,201,$2,'h',500000,500000,null,'2026-11-12',1,1,'monthly-payroll-v12','{}',0) r`,[JSON.stringify(targets([201])),JSON.stringify(snapshot())])).rows[0].r;
    assert.equal(done.status,'completed');
    await assertRefused(db,/PRECONDITION:batch_count:0/,'September batch only');
  }finally{await db.close();}
});

test('guard: an incomplete October batch is refused',async()=>{
  const db=await database();try{
    await db.query(`select payroll_pay_employee_v3('2026-10-01',$1,201,$2,'h',1000000,1000000,null,'2026-11-10',2,1,'monthly-payroll-v12','{}',0)`,[JSON.stringify(targets(IDS)),JSON.stringify(snapshot())]);
    await assertRefused(db,/PRECONDITION:status:paying/,'paying batch');
  }finally{await db.close();}
});

for(const [label,sql,pattern] of [
  // payroll_payment_batches_completion_check already forces paid = target on a completed batch.
  ['batch employee counts differ from 17',"update payroll_payment_batches set target_employee_count=18,paid_employee_count=18",/PRECONDITION:employees:18\/18\/17/],
  // payroll_employee_payments_state_check is dropped in the fixture only, to reach a 16-paid-row state.
  ['paid payment rows differ from 17',"alter table payroll_employee_payments drop constraint payroll_employee_payments_state_check;update payroll_employee_payments set payment_status='unpaid' where user_id=217",/PRECONDITION:employees:17\/17\/16/],
  ['no settlement request',"delete from payroll_special_settlement_requests",/PRECONDITION:requests:0/],
  ['two settlement requests',copyRequest,/PRECONDITION:requests:2/],
  ['no applied audit row',"delete from payroll_payment_audit_logs where action='special_settlement_applied'",/PRECONDITION:applied_audit:0\/0/],
  ['two applied audit rows',copyApplied,/PRECONDITION:applied_audit:2\/2/],
  ['shared function missing',"drop function payroll_refresh_payment_tax_totals_v1(bigint)",/PRECONDITION:shared_functions/],
  ['another object depends on a target (RESTRICT)',"create view qa_depends_on_final_state as select payroll_settle_2026_10_final_state_v1(null::date,'[]'::jsonb,0,0,0) x",/depend/],
])test(`guard: ${label} rolls back everything`,async()=>{
  const db=await tampered(sql);try{await assertRefused(db,pattern,label);}finally{await db.close();}
});

test('fresh full replay is already impossible upstream: applied correction 20261115085910 aborts without its pinned rows',async()=>{
  const db=await install(new PGlite({extensions:{btree_gist}}));try{
    // Empty stand-ins only so its LOCK TABLE line runs; its first check reads payroll_employee_payments.
    for(const t of ['employee_level_program_versions','employee_level_audit_logs','payroll_part_time_extra_work_decisions'])
      await db.exec(`create table if not exists public.${t}(id bigint)`);
    const dir='supabase/migrations',name=readdirSync(dir).find(n=>n.startsWith('20261115085910_'));
    await assert.rejects(db.exec(read(`${dir}/${name}`)),/PAID_PAYMENT_BASELINE_MISMATCH: rows 0/);
  }finally{await db.close();}
});

test('recovery: re-running the original create blocks restores identical bodies/ACLs and an intact replay',async()=>{
  const db=await database(),p=syntheticPlan();try{
    const r=await settle(db,p);const fns=await functions(db),rows=await state(db);
    await retire(db);
    await db.exec(recoverySql());
    assert.deepEqual(await functions(db),fns,'restored bodies, ACLs and security settings match the applied migration');
    const replay=await settle(db,p);assert.equal(replay.replayed,true);assert.equal(replay.runId,r.runId);
    assert.deepEqual(await state(db),rows);
  }finally{await db.close();}
});

test('migration file: exact signatures, RESTRICT, no CASCADE, no table or data statements, LF only',()=>{
  const raw=read(RETIRE),code=raw.split('\n').filter(l=>!/^\s*--/.test(l)).join('\n');
  assert.equal(raw.includes('\r'),false);
  assert.doesNotMatch(code,/cascade/i);
  assert.doesNotMatch(code,/\b(insert|update|delete|truncate|alter|create)\b/i);
  const drops=code.match(/drop function[^;]+;/gi);
  assert.deepEqual(drops,[`drop function ${SETTLE_SIG} restrict;`,`drop function ${FINAL_SIG} restrict;`]);
});
