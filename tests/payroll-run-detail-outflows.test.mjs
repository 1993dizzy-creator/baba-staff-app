import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {buildPaymentOutflows,payrollAuditLabel,payrollAuditEmployeeName} from '../lib/payroll/payment-outflows.ts';

// Synthetic amounts only (the repository is public). Real batch-4 figures are verified
// read-only outside Git. Covers: run detail shows split allocations / batch residual /
// per date·account outflow, the one-off 2026-10 settlement path is gone, the old URL
// redirects, and the standard payment API still refuses 2026-10 but serves other months.

const BANK=2,CASH=1,D10='2026-11-10',D14='2026-11-14';
const paid=(id,amount,{date=D10,account=BANK,status='paid'}={})=>({id,employee_name:'QA '+id,payment_status:status,actual_paid_amount:amount,payment_date:date,fund_account_id:account});
const allocation=(id,paymentId,amount,account,kind='salary',status='active',note=null)=>({id,employee_payment_id:paymentId,payment_date:D10,fund_account_id:account,amount,allocation_kind:kind,note,status});

test('split payment, residual and per date/account outflow follow the DB projector rule',()=>{
  const employees=[paid(1,5000000),paid(2,4000002),paid(3,7000000,{account:CASH}),paid(4,3000000,{date:D14,account:CASH}),paid(5,null,{status:'unpaid',date:null,account:null})];
  const allocations=[allocation(10,2,3800002,BANK),allocation(11,2,200000,CASH,'penalty_refund','active','synthetic refund'),allocation(12,1,999,CASH,'salary','cancelled')];
  const residuals=[{id:1,payment_date:D10,fund_account_id:BANK,amount:1,reason:'synthetic rounding'}];
  const o=buildPaymentOutflows({employees,allocations,residuals});
  assert.deepEqual(o.groups,[
    {paymentDate:D10,fundAccountId:CASH,amount:7200000,employeeCount:2,residualAmount:0},
    {paymentDate:D10,fundAccountId:BANK,amount:5000000+3800002+1,employeeCount:2,residualAmount:1},
    {paymentDate:D14,fundAccountId:CASH,amount:3000000,employeeCount:1,residualAmount:0},
  ]);
  assert.equal(o.employeePaidTotal,5000000+4000002+7000000+3000000);
  assert.equal(o.residualTotal,1);
  assert.equal(o.outflowTotal,o.employeePaidTotal+1,'outflow = employee paid + residual (residual assigned to nobody)');
  assert.deepEqual(o.linesByPayment.get(2).map(l=>[l.fundAccountId,l.amount,l.kind,l.note]),[[CASH,200000,'penalty_refund','synthetic refund'],[BANK,3800002,'salary',null]]);
  assert.deepEqual(o.linesByPayment.get(1),[{paymentDate:D10,fundAccountId:BANK,amount:5000000,kind:'salary',note:null}],'cancelled allocation is ignored');
  assert.equal(o.linesByPayment.has(5),false,'unpaid rows have no outflow');
  assert.deepEqual(o.mismatchedPaymentIds,[]);
  assert.deepEqual(buildPaymentOutflows({employees:[paid(2,4000002)],allocations:[allocation(10,2,4000000,BANK)]}).mismatchedPaymentIds,[2],'split sum ≠ paid amount is surfaced, never corrected');
});

test('ordinary months (no allocations/residuals, legacy null account) keep one line per employee',()=>{
  const o=buildPaymentOutflows({employees:[paid(1,100),paid(2,200,{account:null}),paid(3,300)],allocations:null,residuals:undefined});
  assert.deepEqual(o.groups.map(g=>[g.fundAccountId,g.amount,g.employeeCount]),[[BANK,400,2],[null,200,1]]);
  assert.equal(o.outflowTotal,600);assert.equal(o.residualTotal,0);
});

test('audit labels are KO/VI and the employee name comes from the stored snapshot only',()=>{
  for(const action of ['batch_started','employee_paid','employee_payment_cancelled','batch_completed','special_settlement_applied']){
    assert.match(payrollAuditLabel(action,false),/[가-힣]/);assert.doesNotMatch(payrollAuditLabel(action,true),/[가-힣]/);
  }
  assert.equal(payrollAuditLabel('unknown_action',true),'unknown_action');
  assert.equal(payrollAuditEmployeeName({id:1,action:'employee_paid',reason:null,created_at:'',employee_payment_id:1,after_snapshot:{employee_name:'QA'}}),'QA');
  assert.equal(payrollAuditEmployeeName({id:2,action:'batch_completed',reason:null,created_at:'',employee_payment_id:null,after_snapshot:{id:4}}),null);
});

// --- route-level checks (real routes + real payroll permission code; only session and Supabase stubbed)
const external=createRequire(import.meta.url),cache=new Map();let current;
function query(table){
  const filters=[];const result=()=>{
    if(current.fail?.[table])return {data:null,error:current.fail[table]};
    const rows=(current.tables[table]??[]).filter(row=>filters.every(([k,v])=>row[k]===v));return {data:rows,error:null};
  };
  const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},neq(){return q;},order(){return q;},
    async maybeSingle(){const r=result();return {data:r.data?.[0]??null,error:r.error};},then(ok,ko){return Promise.resolve(result()).then(ok,ko);}};
  current.reads.push(table);return q;
}
const db={from:query,async rpc(name){current.rpcs.push(name);return {data:null,error:{message:'not expected'}};}};
const stubs=new Map([
  ['@/lib/supabase/server',{supabaseServer:db}],
  ['@/lib/auth/server-auth',{getAuthenticatedActor:async()=>current.role?{ok:true,actor:{id:1,role:current.role}}:{ok:false,code:'UNAUTHENTICATED',status:401}}],
  ['@/lib/payroll/meal-allowance-eligibility-server',{loadMealAllowanceEligibilityDuringMonth:async()=>new Map()}],
  ['@/lib/payroll/overview-server',{loadPayrollOverview:async()=>{throw new Error('overview must not be read');}}],
]);
function load(file){
  const path=resolve(file);if(cache.has(path))return cache.get(path).exports;const m={exports:{}};cache.set(path,m);
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const require=name=>{if(stubs.has(name))return stubs.get(name);if(name==='server-only')return {};
    if(name.startsWith('.')||name.startsWith('@/')){let child=name.startsWith('@/')?resolve(name.slice(2)):resolve(dirname(path),name);if(!existsSync(child))child+='.ts';return load(child);}return external(name);};
  new Function('require','module','exports',code)(require,m,m.exports);return m.exports;
}
const runRoute=load('app/api/admin/payroll/runs/[runId]/route.ts');
const payments=load('app/api/admin/payroll/payments/route.ts');
function fixture(role='owner'){
  return current={role,reads:[],rpcs:[],fail:null,tables:{
    payroll_payment_batches:[{id:4,payroll_month:'2026-10-01',status:'completed',actual_paid_total:9000002}],
    payroll_employee_payments:[{id:1,payroll_batch_id:4,user_id:101,...paid(1,5000000)},{id:2,payroll_batch_id:4,user_id:102,...paid(2,4000002)}],
    payroll_payment_audit_logs:[{id:9,payroll_batch_id:4,action:'special_settlement_applied',reason:'synthetic',created_at:'2026-11-16T00:00:00Z',employee_payment_id:null}],
    payroll_employee_payment_allocations:[{...allocation(10,2,3800002,BANK),payroll_batch_id:4},{...allocation(11,2,200000,CASH,'penalty_refund'),payroll_batch_id:4}],
    payroll_payment_group_residuals:[{id:1,payroll_batch_id:4,payment_date:D10,fund_account_id:BANK,amount:1,reason:'synthetic rounding'}],
    ledger_fund_accounts:[{id:1,code:'store_cash',display_name:'매장 현금'},{id:2,code:'baba_corporate_bank',display_name:'BABA 법인계좌'}],
  }};
}
const getRun=async id=>{const r=await runRoute.GET(new Request('http://local.test/r'),{params:Promise.resolve({runId:String(id)})});return {status:r.status,body:await r.json()};};

test('run detail API returns split allocations, residuals and account names read-only (owner and master)',async()=>{
  for(const role of ['owner','master']){
    fixture(role);const r=await getRun(4);
    assert.equal(r.status,200,role);assert.equal(r.body.ok,true);
    assert.equal(r.body.allocations.length,2);assert.equal(r.body.residuals[0].amount,1);assert.equal(r.body.fundAccounts.length,2);assert.equal(r.body.audit.length,1);
    assert.deepEqual(current.rpcs,[],'no RPC (read only)');
    const o=buildPaymentOutflows({employees:r.body.employees,allocations:r.body.allocations,residuals:r.body.residuals});
    assert.equal(o.employeePaidTotal,r.body.run.actual_paid_total);assert.equal(o.outflowTotal,9000003);
  }
  for(const [role,status] of [['staff',403],['manager',403],[null,401]]){fixture(role);const r=await getRun(4);assert.equal(r.status,status);assert.deepEqual(current.reads,[]);}
});

test('run detail API: tables missing in an older environment read as empty; other read errors fail closed',async()=>{
  fixture();current.fail={payroll_employee_payment_allocations:{code:'42P01'},payroll_payment_group_residuals:{code:'PGRST205'}};
  let r=await getRun(4);assert.equal(r.status,200);assert.deepEqual(r.body.allocations,[]);assert.deepEqual(r.body.residuals,[]);
  fixture();current.fail={payroll_employee_payment_allocations:{code:'57014',message:'timeout'}};
  r=await getRun(4);assert.equal(r.status,500);assert.equal(r.body.code,'PAYROLL_RUN_READ_FAILED');
  fixture();r=await getRun(99);assert.equal(r.status,404);
});

test('standard payment API refuses 2026-10 (settled) before any read and still serves other months',async()=>{
  const call=month=>payments.POST(new Request('http://local.test/p',{method:'POST',body:JSON.stringify({month,userId:101,fundAccountId:1,actualPaidAmount:4000000,paymentDate:'2026-11-10',calculationHash:'x'})}));
  fixture();let r=await call('2026-10');let body=await r.json();
  assert.equal(r.status,409);assert.equal(body.code,'PAYROLL_SPECIAL_SETTLEMENT_COMPLETED');assert.match(body.message,/[가-힣]/);assert.doesNotMatch(body.messageVi,/[가-힣]/);
  assert.deepEqual(current.reads,[]);assert.deepEqual(current.rpcs,[]);
  fixture();r=await call('2026-09');body=await r.json();assert.notEqual(body.code,'PAYROLL_SPECIAL_SETTLEMENT_COMPLETED');
});

test('one-off 2026-10 settlement code is removed and the old URL redirects to the run detail',()=>{
  for(const file of ['app/api/admin/payroll/special-settlements/2026-10/route.ts','lib/payroll/special-settlement-2026-10.ts','lib/payroll/special-settlement-2026-10-server.ts'])assert.equal(existsSync(file),false,file);
  const legacy=readFileSync('app/(protected)/admin/payroll/special-settlement-2026-10/page.tsx','utf8');
  assert.match(legacy,/requireRole\(PAYROLL_MANAGER_ROLES\)/);assert.match(legacy,/redirect\(/);assert.match(legacy,/\/admin\/payroll\/\$\{runId\}/);assert.match(legacy,/payrollOverviewHref\("2026-10"\)/);
  assert.doesNotMatch(legacy,/BABA_PAYROLL_SETTLEMENT_2026_10_PLAN_JSON|method:\s*"POST"|NOTHING_TO_SETTLE/);
  const page=readFileSync('app/(protected)/admin/payroll/[runId]/page.tsx','utf8');
  for(const text of ['지급일·계좌별 출금','Chi theo ngày · tài khoản','반올림 잔차(직원 미배분)','Chênh lệch làm tròn (không phân bổ cho nhân viên)','전체 출금 합계','Tổng chi thực tế','패널티 반환','hoàn phạt','감사 이력','Lịch sử kiểm toán'])assert.ok(page.includes(text),text);
});
