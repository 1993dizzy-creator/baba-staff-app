import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';

const external=createRequire(import.meta.url);
// Same isolated transpilation approach as payroll-employment-eligibility.test.mjs.
// No environment credentials or initialized Supabase client; every remote access throws.
function loader(baseline=false,stubs=new Map()) {
  const cache=new Map();
  function load(file) {
    const path=resolve(file);if(cache.has(path))return cache.get(path).exports;
    const m={exports:{}};cache.set(path,m);
    const relative=path.slice(resolve('.').length+1).replaceAll('\\','/');
    const source=baseline&&['lib/payroll/monthly-run.ts','lib/payroll/overview.ts','lib/payroll/overview-projection.ts'].includes(relative)
      ?execFileSync('git',['show',`0353e568:${relative}`],{encoding:'utf8'}):readFileSync(path,'utf8');
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const require=name=>{
      if(stubs.has(name))return stubs.get(name);
      if(name==='server-only')return {};
      if(name==='@/lib/supabase/server')return {supabaseServer:new Proxy({},{get(){throw Error('Remote database access forbidden')}})};
      if(name.startsWith('.')||name.startsWith('@/')) {
        let child=name.startsWith('@/')?resolve(name.slice(2)):resolve(dirname(path),name);
        if(!existsSync(child))child+='.ts';return load(child);
      }
      return external(name);
    };
    new Function('require','module','exports',code)(require,m,m.exports);return m.exports;
  }
  return load;
}
const load=loader(),oldLoad=loader(true);
const {calendarProration,firstMonthEvidence}=load('lib/payroll/first-month-proration.ts');
const {calculatePayrollBatch}=load('lib/payroll/monthly-run.ts');
const policy={userId:1,policyVersion:'fixed-calendar-v1',hireDate:'2026-11-16',firstContractId:10,status:'active',rehired:false};
const user={id:1,name:'Fixture',username:'fixture',is_active:true,role:'staff',part:'kitchen',position:null,hire_date:'2026-11-16',termination_date:null,is_system_account:false,payroll_eligible_override:null,level_program_enabled:false,level_base_date_override:null};
const contract={id:10,userId:1,payType:'monthly',calculationBasis:'fixed_monthly',baseSalary:8000000,fixedRaiseAmount:0,standardWorkdays:26,standardMinutesPerDay:540,timeBlockMinutes:1,roundingMode:'none',lateAdjustmentMode:'ignore',earlyLeaveAdjustmentMode:'ignore',overtimeMode:'ignore',paidLeaveMode:'unpaid',effectiveFrom:'2026-11-01',effectiveTo:null,revision:1};
function input(extra={}) {return {month:'2026-11',dates:['2026-11-16','2026-11-30'],users:[user],contracts:[contract],attendance:[],schedules:[],settingsByDate:new Map(),extraWorkSettingsByDate:new Map(),holidayPremiumByDate:new Map(),decisionsByAttendanceId:new Map(),lateNormalizedRecordIds:new Set(),insuranceVersionsByUser:new Map(),insuranceGlobal:{employeeRateBp:1050,employerRateBp:2150,directorEnabled:false,directorUserId:null,directorBaseAmount:0,directorRateBp:0,directorEmployeeRateBp:0,settingsUpdatedAt:null},penaltySettings:{lateMajorThresholdMinutes:20,lateMinorPenaltyMinutes:60,lateMajorPenaltyRateBp:5000,unauthorizedAbsencePenaltyDays:2},firstMonthPolicies:new Map([[1,policy]]),...extra};}
const base=raw=>raw.items.find(i=>i.category==='base_work');
test('calendar days, leap year, first/15th/16th/last days, termination inclusive and one final VND rounding',()=>{
  for(const [date,days,total,amount] of [['2026-11-01',30,30,8000000],['2026-11-15',16,30,4266667],['2026-11-16',15,30,4000000],['2026-11-30',1,30,266667],['2026-12-31',1,31,258065],['2027-02-15',14,28,4000000],['2028-02-15',15,29,4137931]]) {
    assert.deepEqual(calendarProration(8000000,date),{employedDays:days,totalDays:total,amount});
  }
  assert.deepEqual(calendarProration(8000000,'2026-11-16','2026-11-25'),{employedDays:10,totalDays:30,amount:2666667});
  assert.equal(firstMonthEvidence(policy,contract,9300000,null).amount,4650000,'monthly amount includes fixed and level raises');
});
test('actual batch pays first month automatically and snapshot records every input without changing contract',()=>{
  const i=input(),before=JSON.stringify(i.contracts),r=calculatePayrollBatch(i)[0],e=base(r).sourceSnapshot.firstMonthProration;
  assert.equal(base(r).amount,4000000);assert.equal(r.reviews.length,0);
  assert.deepEqual(e,{policyVersion:'fixed-calendar-v1',hireDate:'2026-11-16',terminationDate:null,firstContractId:10,contractRevision:1,contractSalary:8000000,fixedRaiseAmount:0,monthlyAmount:8000000,employedDays:15,totalDays:30,amount:4000000});
  assert.equal(JSON.stringify(i.contracts),before);
  assert.equal(base(calculatePayrollBatch(input({users:[{...user,termination_date:'2026-11-25',is_active:false}]}))[0]).amount,2666667);
  assert.equal(base(calculatePayrollBatch(input({dates:['2026-11-15']}))[0]).amount,4000000,'whole-month expected entitlement, not elapsed-day accrual');
  assert.equal(base(calculatePayrollBatch(input({month:'2026-12',dates:['2026-12-01','2026-12-31']}))[0]).amount,8000000);
});
test('fixed raises are included, but absence day-rate and unearned compensation stay on original monthly amount',()=>{
  const c={...contract,fixedRaiseAmount:1000000};
  const attendance=[{id:99,user_id:1,status:'unauthorized_absence',work_date:'2026-11-16'}];
  const r=calculatePayrollBatch(input({contracts:[c],attendance}))[0];
  assert.equal(base(r).amount,4500000);
  const deductions=r.items.filter(i=>i.category==='unauthorized_absence_deduction');assert.equal(deductions.length,1);
  assert.equal(deductions[0].amount,Math.round(9000000/26*2));
  assert.equal(deductions[0].sourceSnapshot.unearnedCompensationAmount,Math.round(9000000/26));
  assert.equal(deductions[0].sourceSnapshot.dayRate,9000000/26);
});
test('actual fixed engine includes the existing level raise before proration',()=>{
  const isolated=loader(false,new Map([['@/lib/employee-level/server',{getEmployeeLevelInfo:()=>({eligible:true,reason:null,level:3,displayLabel:'L3',earnedRaiseCount:2,raiseAmountPerStep:500000})}]]));
  const r=isolated('lib/payroll/monthly-run.ts').calculatePayrollBatch(input({contracts:[{...contract,fixedRaiseAmount:1000000}]}))[0];
  assert.equal(base(r).amount,5000000);assert.equal(base(r).sourceSnapshot.firstMonthProration.monthlyAmount,10000000);
  assert.equal(base(r).sourceSnapshot.appliedLevelRaiseAmount,1000000);
});
test('pending, rehire, date/id/type/period mismatches block only that employee/month and do not fall back to full salary',()=>{
  const cases=[{firstMonthPolicies:new Map([[1,{...policy,status:'pending',firstContractId:null}]])},
    {firstMonthPolicies:new Map([[1,{...policy,rehired:true}]])},{users:[{...user,hire_date:'2026-11-15'}]},
    {contracts:[{...contract,id:11}]},{contracts:[{...contract,calculationBasis:'minute'}]},
    {contracts:[{...contract,effectiveTo:'2026-11-20'},{...contract,id:11,effectiveFrom:'2026-11-20'}]}];
  for(const extra of cases){const i=input(extra);i.users.push({...user,id:2});i.contracts.push({...contract,userId:2,id:20});
    const rows=calculatePayrollBatch(i);assert.equal(base(rows[0]),undefined);assert.equal(rows[0].reviews[0].warningCode,'FIRST_MONTH_POLICY_REVIEW_REQUIRED');
    assert.equal(rows[0].reviews[0].reviewLevel,'blocking');assert.equal(base(rows[1]).amount,8000000);assert.equal(rows[1].reviews.length,0);
  }
});
test('baseline HEAD and new code give byte-identical legacy rows, overview, payment snapshots and hashes',()=>{
  const oldBatch=oldLoad('lib/payroll/monthly-run.ts').calculatePayrollBatch;
  const snapshotHash=load('lib/payroll/payment-snapshot.ts').payrollPaymentSnapshotHash;
  for(const c of [contract,{...contract,calculationBasis:'minute'},{...contract,payType:'hourly',calculationBasis:'minute',baseSalary:30000,standardWorkdays:null}]){
    const i=input({contracts:[c],firstMonthPolicies:new Map(),dates:['2026-11-16'],
      schedules:[{id:1,userId:1,startTime:'09:00',endTime:'18:00',unpaidBreakMinutes:0,effectiveFrom:'2026-11-01',effectiveTo:null,revision:1}],
      attendance:[{id:101,user_id:1,status:'present',work_date:'2026-11-16',check_in_at:'2026-11-16T02:00:00Z',check_out_at:'2026-11-16T11:00:00Z',late_minutes:0,early_leave_minutes:0,work_minutes:540,approval_status:null}],
      settingsByDate:new Map([['2026-11-16',{revision:1,lateGraceMinutes:0,earlyLeaveGraceMinutes:0}]])});
    const actual=calculatePayrollBatch(i)[0],before=oldBatch(i)[0];assert.deepEqual(actual,before);
    assert.ok(base(actual).amount>0);
    const overviewInput={employee:actual,user,contracts:[c],period:{month:'2026-11',asOfDate:'2026-11-30',levelAsOfDate:'2026-11-30',future:false}};
    const a=load('lib/payroll/overview.ts').buildPayrollOverviewEmployee(overviewInput);
    const b=oldLoad('lib/payroll/overview.ts').buildPayrollOverviewEmployee({...overviewInput,employee:before});assert.deepEqual(a,b);
    const make=load('lib/payroll/payment-snapshot.ts').buildEmployeePaymentSnapshot;
    assert.deepEqual(make(a,actual,{}),make(b,before,{}));assert.equal(snapshotHash(make(a,actual,{})),snapshotHash(make(b,before,{})));
    assert.equal('firstMonthProration' in a,false);assert.equal('firstMonthPolicyReview' in a,false);
  }
});
test('first-month forecast uses the same payment base, while contract header/sort and existing employees keep full salary',()=>{
  const raw=calculatePayrollBatch(input())[0];
  const overview=load('lib/payroll/overview.ts').buildPayrollOverviewEmployee({employee:raw,user,contracts:[contract],period:{month:'2026-11',asOfDate:'2026-11-30',levelAsOfDate:'2026-11-30',future:false}});
  // Use a review-free existing tax profile for forecast (tax policy itself is not modified).
  overview.tax={...overview.tax,status:'calculated'};
  assert.equal(load('lib/payroll/payroll-page-display.ts').getPayrollHeaderAmount(overview),8000000);
  assert.equal(overview.amounts.accruedWorkAmount,4000000);
  const projected=load('lib/payroll/overview-projection.ts').buildPayrollOverviewProjectedSummary;
  const legacy={...overview};delete legacy.firstMonthProration;
  const a=projected([overview],0),b=projected([legacy],0);
  assert.equal(a.totalPreInsurancePayoutAmount,4000000);
  assert.equal(b.totalPreInsurancePayoutAmount,8000000);
  assert.deepEqual(projected([legacy],0),oldLoad('lib/payroll/overview-projection.ts').buildPayrollOverviewProjectedSummary([legacy],0));
});
test('pre-deploy missing RPC is compatible only with enrollment OFF; switching OFF never hides existing policies',async()=>{
  const prior=process.env.PAYROLL_FIRST_MONTH_PRORATION_ENABLED;
  let result={data:null,error:{code:'PGRST202'}};
  const local=loader(false,new Map([['@/lib/supabase/server',{supabaseServer:{rpc:async()=>result}}]]));
  const {loadFirstMonthPolicies}=local('lib/payroll/first-month-proration-server.ts');
  try {
    delete process.env.PAYROLL_FIRST_MONTH_PRORATION_ENABLED;
    assert.equal((await loadFirstMonthPolicies([1])).size,0);
    process.env.PAYROLL_FIRST_MONTH_PRORATION_ENABLED='true';await assert.rejects(loadFirstMonthPolicies([1]),/READ_FAILED/);
    delete process.env.PAYROLL_FIRST_MONTH_PRORATION_ENABLED;result={data:[policy],error:null};
    assert.deepEqual((await loadFirstMonthPolicies([1])).get(1),policy);
    result={data:null,error:{code:'permission_denied'}};await assert.rejects(loadFirstMonthPolicies([1]),/READ_FAILED/);
  }finally{if(prior===undefined)delete process.env.PAYROLL_FIRST_MONTH_PRORATION_ENABLED;else process.env.PAYROLL_FIRST_MONTH_PRORATION_ENABLED=prior;}
});
test('paid first-month re-query restores captured employee; cancellation and legacy rows retain their established display path',()=>{
  const {paidFirstMonthEmployee}=load('lib/payroll/first-month-paid.ts');
  const employee={firstMonthProration:{amount:4000000},amounts:{accruedWorkAmount:4000000}};
  assert.deepEqual(paidFirstMonthEmployee('paid',{employee}),employee);
  assert.equal(paidFirstMonthEmployee('unpaid',{employee}),null);
  assert.equal(paidFirstMonthEmployee('paid',{employee:{amounts:{accruedWorkAmount:8000000}}}),null);
});
test('create API activation is explicit: pre-deploy legacy paths still work; new fixed request never silently falls back',async()=>{
  const calls=[];let rpcError=null;
  const query={select(){return this;},eq(){return this;},async maybeSingle(){return {data:null,error:null};}};
  const local=loader(false,new Map([
    ['next/server',{NextResponse:{json:(body,options={})=>new Response(JSON.stringify(body),{status:options.status??200})}}],
    ['@/lib/auth/server-auth',{requireRole:async()=>({ok:true,actor:{id:1,username:'owner'}})}],
    ['@/lib/supabase/server',{supabaseServer:{from:()=>query,rpc:async(name)=>{calls.push(name);return {data:rpcError?null:{id:77},error:rpcError};}}}],
  ]));
  const {POST}=local('app/api/admin/users/create/route.ts');
  const request=enroll=>new Request('http://local.test/api/admin/users/create',{method:'POST',body:JSON.stringify({username:'new',password:'fixture',name:'New',role:'staff',hire_date:'2026-11-16',level_program_enabled:false,attendance_tracking_enabled:false,first_month_proration:enroll})});
  const prior=process.env.PAYROLL_FIRST_MONTH_PRORATION_ENABLED;
  try {
    delete process.env.PAYROLL_FIRST_MONTH_PRORATION_ENABLED;
    assert.equal((await POST(request(false))).status,200);assert.deepEqual(calls,['employee_create_with_schedule_v6']);
    assert.equal((await POST(request(true))).status,409);assert.equal(calls.length,1,'no user created before activation');
    process.env.PAYROLL_FIRST_MONTH_PRORATION_ENABLED='true';
    assert.equal((await POST(request(true))).status,200);assert.equal(calls.at(-1),'employee_create_with_proration_v1');
    rpcError={code:'PGRST202',message:'not installed'};const failed=await POST(request(true));assert.equal(failed.status,409);
    assert.equal((await failed.json()).code,'FIRST_MONTH_POLICY_REVIEW_REQUIRED');
    assert.equal(calls.filter(c=>c==='employee_create_with_schedule_v6').length,1,'never retry as full-pay legacy creation');
  }finally{if(prior===undefined)delete process.env.PAYROLL_FIRST_MONTH_PRORATION_ENABLED;else process.env.PAYROLL_FIRST_MONTH_PRORATION_ENABLED=prior;}
});
