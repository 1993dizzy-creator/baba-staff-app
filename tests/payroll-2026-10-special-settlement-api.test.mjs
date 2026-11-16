import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';

// Synthetic data only. Only the session lookup and Supabase client are stubbed:
// the real payroll permission check (lib/payroll/server.ts + authorization.ts),
// preflight, snapshot and hash code run unchanged.
const external=createRequire(import.meta.url),cache=new Map();let current;
const db={from(table){assert.ok(['payroll_payment_batches','payroll_employee_payments'].includes(table));const filters=[];return {select(){return this;},eq(k,v){filters.push([k,v]);return this;},
  async maybeSingle(){return {data:current.batch,error:null};},
  then(resolve){resolve({data:current.members.filter(row=>filters.every(([k,v])=>row[k]===v)),error:null});}};},
  async rpc(name,args){current.calls.push({name,args});return current.rpcError?{data:null,error:{message:current.rpcError}}:{data:{status:'completed',paidEmployeeCount:17,targetEmployeeCount:17},error:null};}};
const stubs=new Map([
  ['@/lib/supabase/server',{supabaseServer:db}],
  ['@/lib/payroll/monthly-run',{validPayrollMonth:v=>/^\d{4}-\d{2}$/.test(v??'')?v:null}],
  ['@/lib/payroll/overview-server',{loadPayrollOverview:async()=>current.overview}],
  ['@/lib/auth/server-auth',{getAuthenticatedActor:async()=>current.role?{ok:true,actor:{id:current.actorId,role:current.role}}:{ok:false,code:'UNAUTHENTICATED',status:401}}],
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
const {buildEmployeePaymentSnapshot,payrollPaymentSnapshotHash}=load('lib/payroll/payment-snapshot.ts');
const ENV='BABA_PAYROLL_SETTLEMENT_2026_10_PLAN_JSON';
const IDS=Array.from({length:17},(_,i)=>101+i),SPLIT=105,LAST=117;
const plan={version:1,payrollMonth:'2026-10',sourceTitle:'synthetic',
  employees:IDS.map(userId=>userId===SPLIT
    ?{userId,actualPaidAmount:4000002,allocations:[{paymentDate:'2026-11-10',fundAccountId:2,amount:3850002,kind:'salary'},{paymentDate:'2026-11-10',fundAccountId:1,amount:150000,kind:'penalty_refund'}],note:'synthetic refund'}
    :{userId,actualPaidAmount:4000000,allocations:[{paymentDate:'2026-11-10',fundAccountId:2,amount:4000000,kind:'salary'}]}),
  residuals:[{paymentDate:'2026-11-10',fundAccountId:2,amount:1,reason:'synthetic rounding'}],
  expectedGroups:[{paymentDate:'2026-11-10',fundAccountId:2,amount:16*4000000+3850002+1},{paymentDate:'2026-11-10',fundAccountId:1,amount:150000}],expectedTotal:17*4000000+2+1};
function fixture({role='owner',configured=true}={}){
  if(configured)process.env[ENV]=JSON.stringify(plan);else delete process.env[ENV];
  const contracts=IDS.map(id=>({id,userId:id,payType:'monthly',calculationBasis:'fixed_monthly',effectiveFrom:'2026-08-01',effectiveTo:null,revision:1}));
  const employees=contracts.map(c=>({userId:c.userId,name:'QA '+c.userId,part:'kitchen',position:'staff',contract:c,
    calculationStatus:'calculable',blockingCount:0,tax:{status:'calculated',warningCodes:[]},amounts:{currentAmount:4000000,netPayoutAmount:4000000},adjustments:[],automaticPenalties:[]}));
  const rawByUser=new Map(contracts.map(c=>[c.userId,{contractSnapshot:[c],attendanceSnapshot:{calculationDate:'2026-10-31',days:[]},items:[],reviews:[],insuranceSnapshot:{},partTimeExtraWork:[]}]));
  return current={role,actorId:role==='master'?1:2,batch:null,members:[],calls:[],rpcError:null,
    overview:{employees,rawByUser,period:{asOfDate:'2026-10-31'},snapshot:{context:{contracts},sourceSnapshot:{engineVersion:'monthly-payroll-v12'}},directorInsuranceAmount:0}};
}
const post=body=>route.POST(new Request('http://local.test/x',{method:'POST',body:JSON.stringify(body)}));
const json=async r=>({status:r.status,body:await r.json()});
const KEY='oct2026-0123456789abcdef';
const preview=async()=>(await json(await route.GET())).body;

test('permission: owner and master (payroll managers) allowed; staff and anonymous refused before any read or RPC',async()=>{
  for(const role of ['owner','master']){
    fixture({role});const p=await preview();assert.equal(p.ok,true,role);assert.deepEqual(p.blockers,[]);
    const r=await json(await post({previewToken:p.previewToken,requestKey:KEY,confirm:true}));
    assert.equal(r.status,200,role);assert.equal(current.calls.length,1);assert.equal(current.calls[0].args.p_actor_user_id,current.actorId);
  }
  for(const [role,status,code] of [['staff',403,'FORBIDDEN'],['manager',403,'FORBIDDEN'],[null,401,'UNAUTHENTICATED']]){
    fixture({role});
    const g=await json(await route.GET());assert.equal(g.status,status);assert.equal(g.body.code,code);
    const r=await json(await post({previewToken:'a'.repeat(64),requestKey:KEY,confirm:true}));
    assert.equal(r.status,status);assert.equal(current.calls.length,0);
  }
});

test('missing or invalid private plan is reported without executing',async()=>{
  fixture({configured:false});let r=await json(await route.GET());assert.equal(r.status,503);assert.equal(r.body.code,'SETTLEMENT_PLAN_NOT_CONFIGURED');
  fixture();process.env[ENV]=JSON.stringify({...plan,expectedTotal:1});r=await json(await route.GET());assert.equal(r.body.code,'SETTLEMENT_PLAN_INVALID');assert.ok(r.body.errors.length>0);
});

test('server recomputes snapshot and hash for all 17 and ignores anything calculated by the client',async()=>{
  fixture();const p=await preview();
  assert.equal((await json(await post({previewToken:p.previewToken,requestKey:KEY}))).status,400,'confirm flag required');
  const r=await json(await post({previewToken:p.previewToken,requestKey:KEY,confirm:true,
    calculationHash:'f'.repeat(64),payments:[{userId:101,calculationHash:'f'.repeat(64),calculatedNetAmount:1}],targets:[]}));
  assert.equal(r.status,200);assert.equal(current.calls.length,1);
  const {name,args}=current.calls[0];assert.equal(name,'payroll_settle_2026_10_v1');
  assert.equal(args.p_targets.length,17);assert.equal(args.p_payments.length,17);assert.ok(args.p_targets.every(t=>t.isPayable&&t.failureCodes.length===0));
  for(const sent of args.p_payments){
    const employee=current.overview.employees.find(e=>e.userId===sent.userId),raw=current.overview.rawByUser.get(sent.userId);
    const snapshot=buildEmployeePaymentSnapshot(employee,raw,current.overview.snapshot.sourceSnapshot);
    assert.deepEqual(sent.calculationSnapshot,snapshot);
    assert.equal(sent.calculationHash,payrollPaymentSnapshotHash(snapshot),`hash recomputed for ${sent.userId}`);
    assert.equal(sent.calculatedNetAmount,employee.amounts.netPayoutAmount);
  }
  assert.equal(args.p_request_hash,p.previewToken);assert.deepEqual(args.p_residuals,plan.residuals);assert.deepEqual(args.p_expected_groups,plan.expectedGroups);
  const split=args.p_payments.find(x=>x.userId===SPLIT);
  assert.equal(split.allocations.length,2);assert.equal(split.actualPaidAmount,4000002);assert.match(split.differenceReason,/\(차액 \+2₫\) · synthetic refund$/);
});

test('any change after the confirmed preview, for any of the 17, stops before the RPC',async()=>{
  for(const [name,mutate,code] of [
    ['net amount of the last employee',()=>{current.overview.employees.find(e=>e.userId===LAST).amounts.netPayoutAmount=3999999;},'PAYROLL_CALCULATION_STALE'],
    ['attendance snapshot (hash input)',()=>{current.overview.rawByUser.get(103).attendanceSnapshot.days=[{date:'2026-10-02'}];},'PAYROLL_CALCULATION_STALE'],
    ['engine source snapshot',()=>{current.overview.snapshot.sourceSnapshot.engineVersion='monthly-payroll-v13';},'PAYROLL_CALCULATION_STALE'],
    ['new blocking review',()=>{current.overview.rawByUser.get(LAST).reviews=[{reviewLevel:'blocking',warningCode:'MISSING_CHECK_OUT'}];},'SETTLEMENT_BLOCKED'],
    ['tax warning',()=>{current.overview.employees.find(e=>e.userId===109).tax.warningCodes=['TAX_POLICY_MISSING'];},'SETTLEMENT_BLOCKED'],
    ['contract overlap',()=>{current.overview.snapshot.context.contracts.push({...current.overview.snapshot.context.contracts[0],id:999});},'SETTLEMENT_BLOCKED'],
    ['employee left roster',()=>{current.overview.employees.pop();current.overview.rawByUser.delete(LAST);},'SETTLEMENT_BLOCKED'],
  ]){
    fixture();const p=await preview();assert.deepEqual(p.blockers,[],name);mutate();
    const r=await json(await post({previewToken:p.previewToken,requestKey:KEY,confirm:true}));
    assert.equal(r.status,409,name);assert.equal(r.body.code,code,name);assert.equal(current.calls.length,0,name);
  }
});

test('an existing batch or DB failure stops with explicit codes',async()=>{
  fixture();let p=await preview();current.batch={id:7,status:'completed'};current.members=IDS.map(id=>({payroll_batch_id:7,user_id:id,payment_status:'paid',employee_name:'QA '+id,part_snapshot:null,position_snapshot:null}));
  let r=await json(await post({previewToken:p.previewToken,requestKey:KEY,confirm:true}));assert.equal(r.status,409);assert.equal(r.body.code,'PAYROLL_BATCH_COMPLETED');assert.equal(current.calls.length,0);
  assert.deepEqual((await preview()).blockers,['NOTHING_TO_SETTLE']);
  fixture();p=await preview();current.rpcError='PAYROLL_SPECIAL_SETTLEMENT_GROUP_MISMATCH:cash_groups';
  r=await json(await post({previewToken:p.previewToken,requestKey:KEY,confirm:true}));assert.equal(r.status,409);assert.equal(r.body.code,'PAYROLL_SPECIAL_SETTLEMENT_GROUP_MISMATCH');
});

test('standard per-employee payment API refuses 2026-10 and still serves other months',async()=>{
  fixture();
  const call=month=>payments.POST(new Request('http://local.test/p',{method:'POST',body:JSON.stringify({month,userId:101,fundAccountId:1,actualPaidAmount:4000000,paymentDate:'2026-11-10',calculationHash:'x'})}));
  const r=await json(await call('2026-10'));assert.equal(r.status,409);assert.equal(r.body.code,'PAYROLL_SPECIAL_SETTLEMENT_REQUIRED');assert.equal(current.calls.length,0);
  const other=await json(await call('2026-09'));assert.notEqual(other.body.code,'PAYROLL_SPECIAL_SETTLEMENT_REQUIRED');
});
