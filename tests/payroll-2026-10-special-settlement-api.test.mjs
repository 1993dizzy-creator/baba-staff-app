import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';

// Synthetic data only; supabase and auth are stubs (no network, no credentials).
const external=createRequire(import.meta.url),cache=new Map();let current;
const response=(body,status=200)=>new Response(JSON.stringify(body),{status});
const db={from(table){assert.ok(['payroll_payment_batches','payroll_employee_payments'].includes(table));const filters=[];return {select(){return this;},eq(k,v){filters.push([k,v]);return this;},
  async maybeSingle(){return {data:current.batch,error:null};},
  then(resolve){resolve({data:current.members.filter(row=>filters.every(([k,v])=>row[k]===v)),error:null});}};},
  async rpc(name,args){current.calls.push({name,args});return current.rpcError?{data:null,error:{message:current.rpcError}}:{data:{status:'completed',paidEmployeeCount:2,targetEmployeeCount:2},error:null};}};
const stubs=new Map([
  ['@/lib/supabase/server',{supabaseServer:db}],
  ['@/lib/payroll/monthly-run',{validPayrollMonth:v=>/^\d{4}-\d{2}$/.test(v??'')?v:null}],
  ['@/lib/payroll/overview-server',{loadPayrollOverview:async()=>current.overview}],
  ['@/lib/payroll/server',{requirePayrollActor:async()=>({actor:{id:1,role:current.role},response:null}),payrollJson:response}],
]);
function load(file){
  const path=resolve(file);if(cache.has(path))return cache.get(path).exports;const m={exports:{}};cache.set(path,m);
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const require=name=>{if(stubs.has(name))return stubs.get(name);if(name==='server-only')return {};
    if(name.startsWith('.')||name.startsWith('@/')){let child=name.startsWith('@/')?resolve(name.slice(2)):resolve(dirname(path),name);if(!existsSync(child))child+='.ts';return load(child);}return external(name);};
  new Function('require','module','exports',code)(require,m,m.exports);return m.exports;
}
const route=load('app/api/admin/payroll/special-settlements/2026-10/route.ts');
const payments=load('app/api/admin/payroll/payments/route.ts');
const ENV='BABA_PAYROLL_SETTLEMENT_2026_10_PLAN_JSON';
const plan={version:1,payrollMonth:'2026-10',sourceTitle:'synthetic',
  employees:[{userId:10,actualPaidAmount:4000000,allocations:[{paymentDate:'2026-11-10',fundAccountId:2,amount:4000000,kind:'salary'}]},
    {userId:20,actualPaidAmount:4000002,allocations:[{paymentDate:'2026-11-10',fundAccountId:2,amount:3850002,kind:'salary'},{paymentDate:'2026-11-10',fundAccountId:1,amount:150000,kind:'penalty_refund'}],note:'synthetic refund'}],
  residuals:[{paymentDate:'2026-11-10',fundAccountId:2,amount:1,reason:'synthetic rounding'}],
  expectedGroups:[{paymentDate:'2026-11-10',fundAccountId:2,amount:7850003},{paymentDate:'2026-11-10',fundAccountId:1,amount:150000}],expectedTotal:8000003};
function fixture({role='owner',configured=true}={}){
  if(configured)process.env[ENV]=JSON.stringify(plan);else delete process.env[ENV];
  const contracts=[10,20].map(id=>({id,userId:id,payType:'monthly',calculationBasis:'fixed_monthly',effectiveFrom:'2026-08-01',effectiveTo:null,revision:1}));
  const employees=contracts.map(c=>({userId:c.userId,name:'QA '+c.userId,part:'kitchen',position:'staff',contract:c,
    calculationStatus:'calculable',blockingCount:0,tax:{status:'calculated',warningCodes:[]},amounts:{currentAmount:4000000,netPayoutAmount:4000000},adjustments:[],automaticPenalties:[]}));
  const rawByUser=new Map(contracts.map(c=>[c.userId,{contractSnapshot:[c],attendanceSnapshot:{calculationDate:'2026-10-31'},items:[],reviews:[],insuranceSnapshot:{},partTimeExtraWork:[]}]));
  return current={role,batch:null,members:[],calls:[],rpcError:null,
    overview:{employees,rawByUser,period:{asOfDate:'2026-10-31'},snapshot:{context:{contracts},sourceSnapshot:{engineVersion:'monthly-payroll-v12'}},directorInsuranceAmount:0}};
}
const post=body=>route.POST(new Request('http://local.test/x',{method:'POST',body:JSON.stringify(body)}));
const json=async r=>({status:r.status,body:await r.json()});

test('Owner only: master is refused before any read or RPC',async()=>{
  fixture({role:'master'});
  assert.equal((await json(await route.GET())).status,403);
  const r=await json(await post({previewToken:'a'.repeat(64),requestKey:'oct2026-0123456789abcdef',confirm:true}));
  assert.equal(r.status,403);assert.equal(r.body.code,'OWNER_REQUIRED');assert.equal(current.calls.length,0);
});

test('missing or invalid private plan is reported without executing',async()=>{
  fixture({configured:false});let r=await json(await route.GET());assert.equal(r.status,503);assert.equal(r.body.code,'SETTLEMENT_PLAN_NOT_CONFIGURED');
  fixture();process.env[ENV]=JSON.stringify({...plan,expectedTotal:1});r=await json(await route.GET());assert.equal(r.body.code,'SETTLEMENT_PLAN_INVALID');assert.ok(r.body.errors.length>0);
});

test('preview → confirmed POST sends the full roster, split allocations, residual, declared groups and reasons',async()=>{
  fixture();const preview=(await json(await route.GET())).body;
  assert.deepEqual(preview.blockers,[]);assert.equal(preview.rows.length,2);
  assert.equal(preview.rows.find(r=>r.userId===20).differenceAmount,2);
  assert.equal((await json(await post({previewToken:preview.previewToken,requestKey:'oct2026-0123456789abcdef'}))).status,400,'confirm flag required');
  let r=await json(await post({previewToken:'f'.repeat(64),requestKey:'oct2026-0123456789abcdef',confirm:true}));
  assert.equal(r.status,409);assert.equal(r.body.code,'PAYROLL_CALCULATION_STALE');assert.equal(current.calls.length,0);
  r=await json(await post({previewToken:preview.previewToken,requestKey:'oct2026-0123456789abcdef',confirm:true}));
  assert.equal(r.status,200);assert.equal(current.calls.length,1);
  const {name,args}=current.calls[0];assert.equal(name,'payroll_settle_2026_10_v1');
  assert.equal(args.p_month,'2026-10-01');assert.equal(args.p_targets.length,2);assert.equal(args.p_request_hash,preview.previewToken);
  assert.deepEqual(args.p_residuals,plan.residuals);assert.deepEqual(args.p_expected_groups,plan.expectedGroups);
  const split=args.p_payments.find(p=>p.userId===20);
  assert.equal(split.allocations.length,2);assert.equal(split.actualPaidAmount,4000002);assert.equal(split.calculatedNetAmount,4000000);assert.match(split.differenceReason,/차액 \+2₫\) · synthetic refund$/);
  assert.equal(args.p_payments.find(p=>p.userId===10).differenceReason,null);
  assert.match(split.calculationHash,/^[0-9a-f]{64}$/);
});

test('blocked employee, roster mismatch and DB errors stop with explicit codes',async()=>{
  fixture();current.overview.rawByUser.get(20).reviews=[{reviewLevel:'blocking',warningCode:'MISSING_CHECK_OUT'}];
  let preview=(await json(await route.GET())).body;assert.deepEqual(preview.blockers,['EMPLOYEE_NOT_PAYABLE:20']);
  let r=await json(await post({previewToken:preview.previewToken,requestKey:'oct2026-0123456789abcdef',confirm:true}));
  assert.equal(r.status,409);assert.equal(r.body.code,'SETTLEMENT_BLOCKED');assert.equal(current.calls.length,0);
  fixture();current.overview.employees.pop();current.overview.rawByUser.delete(20);
  preview=(await json(await route.GET())).body;assert.deepEqual(preview.blockers,['PLAN_USER_NOT_IN_ROSTER:20']);
  fixture();preview=(await json(await route.GET())).body;current.rpcError='PAYROLL_SPECIAL_SETTLEMENT_GROUP_MISMATCH:x';
  r=await json(await post({previewToken:preview.previewToken,requestKey:'oct2026-0123456789abcdef',confirm:true}));
  assert.equal(r.status,409);assert.equal(r.body.code,'PAYROLL_SPECIAL_SETTLEMENT_GROUP_MISMATCH');
});

test('standard per-employee payment API refuses 2026-10 and still serves other months',async()=>{
  fixture();
  const call=month=>payments.POST(new Request('http://local.test/p',{method:'POST',body:JSON.stringify({month,userId:10,fundAccountId:1,actualPaidAmount:4000000,paymentDate:'2026-11-10',calculationHash:'x'})}));
  const r=await json(await call('2026-10'));assert.equal(r.status,409);assert.equal(r.body.code,'PAYROLL_SPECIAL_SETTLEMENT_REQUIRED');assert.equal(current.calls.length,0);
  const other=await json(await call('2026-09'));assert.notEqual(other.body.code,'PAYROLL_SPECIAL_SETTLEMENT_REQUIRED');
});
