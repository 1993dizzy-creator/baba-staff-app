import test from 'node:test';
import assert from 'node:assert/strict';
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

test('guard: an October batch that is not the recorded special settlement aborts and drops nothing',async()=>{
  const db=await database();try{
    await db.query(`select payroll_pay_employee_v3('2026-10-01',$1,201,$2,'h',1000000,1000000,null,'2026-11-10',2,1,'monthly-payroll-v12','{}',0)`,[JSON.stringify(targets(IDS)),JSON.stringify(snapshot())]);
    const rows=await state(db),fns=await functions(db);
    await assert.rejects(retire(db),/PAYROLL_2026_10_SETTLEMENT_RETIRE_PRECONDITION/);
    assert.ok(await exists(db,SETTLE_SIG));assert.ok(await exists(db,FINAL_SIG));
    assert.deepEqual(await functions(db),fns);assert.deepEqual(await state(db),rows);
  }finally{await db.close();}
});

test('fresh replay without any October batch applies cleanly',async()=>{
  const db=await install(new PGlite({extensions:{btree_gist}}));try{
    await db.exec(read(MIGRATION));
    await retire(db);
    assert.equal(await exists(db,SETTLE_SIG),false);assert.equal(await exists(db,FINAL_SIG),false);
    for(const sig of SHARED)assert.ok(await exists(db,sig),sig);
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
