import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';

const external=createRequire(import.meta.url),cache=new Map();let current;
const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
const db={from(table){assert.ok(['payroll_payment_batches','payroll_employee_payments'].includes(table));const filters=[];return {select(){return this;},eq(k,v){filters.push([k,v]);return this;},
  async maybeSingle(){return {data:current.batch,error:null};},
  then(resolve){resolve({data:current.members.filter(row=>filters.every(([k,v])=>row[k]===v)),error:null});}};},
  async rpc(name,args){current.calls.push({name,args});return {data:{status:'paying'},error:null};}};
const stubs=new Map([
  ['@/lib/supabase/server',{supabaseServer:db}],
  ['@/lib/payroll/monthly-run',{validPayrollMonth:v=>/^\d{4}-\d{2}$/.test(v??'')?v:null}],
  ['@/lib/payroll/overview-server',{loadPayrollOverview:async()=>current.overview}],
  ['@/lib/payroll/server',{requirePayrollActor:async()=>({actor:{id:1},response:null}),payrollJson:response}],
]);
function load(file){
  const path=resolve(file);if(cache.has(path))return cache.get(path).exports;const m={exports:{}};cache.set(path,m);
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const require=name=>{if(stubs.has(name))return stubs.get(name);if(name==='server-only')return {};
    if(name.startsWith('.')||name.startsWith('@/')){let child=name.startsWith('@/')?resolve(name.slice(2)):resolve(dirname(path),name);if(!existsSync(child))child+='.ts';return load(child);}return external(name);};
  new Function('require','module','exports',code)(require,m,m.exports);return m.exports;
}
const {POST}=load('app/api/admin/payroll/payments/route.ts');
const {buildEmployeePaymentSnapshot,payrollPaymentSnapshotHash}=load('lib/payroll/payment-snapshot.ts');
function fixture(started=false){
  const contracts=[10,20].map(id=>({id,userId:id,payType:'monthly',calculationBasis:'fixed_monthly',effectiveFrom:'2026-08-01',effectiveTo:null,revision:1}));
  const employees=contracts.map(c=>({userId:c.userId,name:'QA '+c.userId,part:'kitchen',position:'staff',contract:c,
    calculationStatus:'calculable',blockingCount:0,tax:{status:'calculated',warningCodes:[]},amounts:{currentAmount:4000000,netPayoutAmount:4000000},adjustments:[],automaticPenalties:[]}));
  const rawByUser=new Map(contracts.map(c=>[c.userId,{contractSnapshot:[c],attendanceSnapshot:{calculationDate:'2026-08-31'},items:[],reviews:[],insuranceSnapshot:{},partTimeExtraWork:[]}]));
  return current={batch:started?{id:1,status:'paying'}:null,members:started?employees.map(e=>({payroll_batch_id:1,user_id:e.userId,payment_status:'unpaid',employee_name:e.name,part_snapshot:e.part,position_snapshot:e.position})):[],
    overview:{employees,rawByUser,period:{asOfDate:'2026-08-31'},snapshot:{context:{contracts},sourceSnapshot:{engineVersion:'monthly-payroll-v12'}},directorInsuranceAmount:0},calls:[]};
}
function request(id=10,extra={}){
  const e=current.overview.employees.find(e=>e.userId===id),raw=current.overview.rawByUser.get(id);
  const calculationHash=e&&raw?payrollPaymentSnapshotHash(buildEmployeePaymentSnapshot(e,raw,current.overview.snapshot.sourceSnapshot)):'missing';
  return new Request('http://local.test/api/admin/payroll/payments',{method:'POST',body:JSON.stringify({month:'2026-08',userId:id,fundAccountId:1,actualPaidAmount:4000000,paymentDate:'2026-09-10',calculationHash,...extra})});
}
for(const started of[false,true]){
  test(`${started?'existing':'first'} batch: a different pending employee does not block selected employee`,async()=>{
    fixture(started);const bad=current.overview.employees[1];bad.calculationStatus='requires_review';bad.blockingCount=1;
    current.overview.rawByUser.get(20).reviews=[{reviewLevel:'blocking',warningCode:'FIRST_MONTH_POLICY_REVIEW_REQUIRED'}];
    const r=await POST(request());assert.equal(r.status,200);assert.equal(current.calls.length,1);
    const targets=current.calls[0].args.p_targets;assert.equal(targets.length,2);assert.equal(targets[0].isPayable,true);assert.equal(targets[1].isPayable,false);
    assert.ok(targets[1].failureCodes.includes('FIRST_MONTH_POLICY_REVIEW_REQUIRED'));
  });
  for(const [name,mutate] of[
    ['missing contract',()=>{current.overview.employees[0].contract=null;}],
    ['overlap',()=>{current.overview.snapshot.context.contracts.push({...current.overview.snapshot.context.contracts[0],id:99});}],
    ['uncalculable',()=>{current.overview.employees[0].calculationStatus='unavailable';}],
    ['blocking',()=>{current.overview.rawByUser.get(10).reviews=[{reviewLevel:'blocking',warningCode:'MISSING_CHECK_OUT'}];}],
    ['tax',()=>{current.overview.employees[0].tax.status='requires_review';}],
    ['tax warnings',()=>{current.overview.employees[0].tax.warningCodes=['TAX_POLICY_MISSING'];}],
    ['unsafe calculated amount',()=>{current.overview.employees[0].amounts.netPayoutAmount=Number.MAX_SAFE_INTEGER+1;}],
    ['snapshot missing',()=>{current.overview.rawByUser.delete(10);}],
  ])test(`${started?'existing':'first'} batch refuses selected ${name}`,async()=>{
    fixture(started);mutate();const r=await POST(request());assert.equal(r.status,409);assert.equal(current.calls.length,0);
  });
  test(`${started?'existing':'first'} batch rejects stale hash and invalid actual amount`,async()=>{
    fixture(started);const stale=request();current.overview.snapshot.sourceSnapshot.engineVersion='changed';
    assert.equal((await POST(stale)).status,409);assert.equal(current.calls.length,0);
    for(const amount of[-1,0,1.2,Number.MAX_SAFE_INTEGER+1])assert.equal((await POST(request(10,{actualPaidAmount:amount}))).status,400);
    assert.equal(current.calls.length,0);
  });
}
test('existing batch rejects already paid, completed and outside-member requests before any mutation',async()=>{
  fixture(true);current.members[0].payment_status='paid';assert.equal((await (await POST(request())).json()).code,'PAYROLL_EMPLOYEE_ALREADY_PAID');
  fixture(true);current.batch.status='completed';assert.equal((await (await POST(request())).json()).code,'PAYROLL_BATCH_COMPLETED');
  fixture(true);current.members=current.members.slice(1);assert.equal((await (await POST(request())).json()).code,'PAYROLL_EMPLOYEE_NOT_IN_BATCH');assert.equal(current.calls.length,0);
});
test('duplicate live IDs or missing selected employee are rejected',async()=>{
  fixture();current.overview.employees.push(current.overview.employees[0]);assert.equal((await POST(request())).status,409);assert.equal(current.calls.length,0);
  fixture();assert.equal((await POST(request(99))).status,409);assert.equal(current.calls.length,0);
});
test('existing roster cannot lose an unavailable employee or silently add a new employee',async()=>{
  fixture(true);current.overview.employees=current.overview.employees.slice(0,1);
  assert.equal((await POST(request())).status,200);const targets=current.calls[0].args.p_targets;
  assert.deepEqual(targets.map(t=>t.userId),[10,20]);assert.equal(targets[1].isPayable,false);assert.deepEqual(targets[1].failureCodes,['MISSING_SNAPSHOT']);
});
