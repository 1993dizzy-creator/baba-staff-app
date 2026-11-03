import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {runInThisContext} from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const external=createRequire(import.meta.url);const cache=new Map();
// Execute the actual server calculation without initializing a remote Supabase client.
function load(file,stubs=new Map(),moduleCache=cache){
 const path=resolve(file);if(moduleCache.has(path))return moduleCache.get(path).exports;
 const loadedModule={exports:{}};moduleCache.set(path,loadedModule);
 const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const localRequire=name=>{
  if(stubs.has(name))return stubs.get(name);
  if(name==='server-only')return {};
  if(name==='@/lib/supabase/server')return {supabaseServer:new Proxy({},{get(){throw new Error('Remote database access is forbidden in this test')}})};
  if(name.startsWith('.')||name.startsWith('@/')){
   let child=name.startsWith('@/')?resolve(name.slice(2)):resolve(dirname(path),name);
   if(!existsSync(child))child+='.ts';return load(child,stubs,moduleCache);
  }
  return external(name);
 };
 runInThisContext(`(function(require,module,exports){${code}\n})`,{filename:path})(localRequire,loadedModule,loadedModule.exports);
 return loadedModule.exports;
}
const {selectPayrollUsers,calculatePayrollBatch}=load("lib/payroll/monthly-run.ts");
const employee=(id,dates={})=>({id,name:'QA '+id,full_name:null,username:'qa'+id,is_active:true,role:'staff',part:'kitchen',position:null,birth_date:null,hire_date:'2026-06-01',termination_date:null,is_system_account:false,payroll_eligible_override:null,level_program_enabled:false,level_base_date_override:null,...dates});
const contract=id=>({id,userId:id,payType:'monthly',calculationBasis:'fixed_monthly',baseSalary:9100000,fixedRaiseAmount:0,standardWorkdays:26,standardMinutesPerDay:540,timeBlockMinutes:1,roundingMode:'none',lateAdjustmentMode:'separate',earlyLeaveAdjustmentMode:'separate',overtimeMode:'ignore',paidLeaveMode:'unpaid',effectiveFrom:'2026-06-01',effectiveTo:null,revision:1});
const select=(users,month='2026-07',attendance=[])=>selectPayrollUsers({users,month,attendance,contracts:users.map(u=>contract(u.id))}).map(u=>u.id);

test('open contracts and out-of-employment attendance cannot include former or future staff, even with an override',()=>{
 const users=[employee(1,{termination_date:'2026-06-30',is_active:false}),employee(2,{hire_date:'2026-08-01'}),employee(3,{termination_date:'2026-06-30',role:'owner',payroll_eligible_override:true}),employee(4,{hire_date:'2026-08-01',payroll_eligible_override:true}),employee(5)];
 assert.deepEqual(select(users,'2026-07',users.map(u=>({user_id:u.id,work_date:'2026-07-10'}))),[5]);
});

test('termination boundaries are inclusive, historical inactive staff remain eligible, and both sides of a month are respected',()=>{
 const left=employee(1,{hire_date:'2026-05-01',termination_date:'2026-07-10',is_active:false});
 assert.deepEqual(select([left],'2026-06'),[1]);assert.deepEqual(select([left],'2026-07'),[1]);assert.deepEqual(select([left],'2026-08'),[]);
 assert.deepEqual(select([employee(2,{termination_date:'2026-07-01'}),employee(3,{hire_date:'2026-07-31'}),employee(4,{termination_date:'2026-06-30'}),employee(5,{hire_date:'2026-08-01'})]),[2,3]);
});

test('rehire uses the currently stored employment interval, never the stale open contract',()=>{
 const rehired=employee(1,{hire_date:'2026-09-15'});
 assert.deepEqual(select([rehired],'2026-08',[{user_id:1,work_date:'2026-08-01'}]),[]);
 assert.deepEqual(select([rehired],'2026-09'),[1]);assert.deepEqual(select([rehired],'2026-10'),[1]);
 // Prior spells cannot be inferred from an overwritten hire_date. Restoring
 // those dates requires real employment history, not this old contract.
});

test('missing/contradictory dates do not gain eligibility from contracts, and role/system exclusions remain',()=>{
 assert.deepEqual(select([employee(1,{hire_date:null}),employee(2,{hire_date:'2026-07-20',termination_date:'2026-07-10'}),employee(3,{is_system_account:true,payroll_eligible_override:true}),employee(4,{payroll_eligible_override:false}),employee(5,{role:'owner'}),employee(6,{role:'owner',payroll_eligible_override:true})]),[6]);
});

function batch(user,dates,contracts=[contract(user.id)],attendance=[],extra={}){return calculatePayrollBatch({month:'2026-07',dates,users:[user],attendance,contracts,schedules:[],settingsByDate:new Map(),extraWorkSettingsByDate:new Map(),holidayPremiumByDate:new Map(),decisionsByAttendanceId:new Map(),lateNormalizedRecordIds:new Set(),insuranceVersionsByUser:new Map(),insuranceGlobal:{employeeRateBp:1050,employerRateBp:2150,directorEnabled:false,directorUserId:null,directorBaseAmount:0,directorRateBp:0,directorEmployeeRateBp:0,settingsUpdatedAt:null},penaltySettings:{lateMajorThresholdMinutes:20,lateMinorPenaltyMinutes:60,lateMajorPenaltyRateBp:5000,unauthorizedAbsencePenaltyDays:2},...extra})}

test('the actual batch retains the termination-month calculation through the last employed day without changing the amount formula',()=>{
 const user=employee(1,{termination_date:'2026-07-10',is_active:false});
 const expected=batch(user,['2026-07-09','2026-07-10']);const actual=batch(user,['2026-07-09','2026-07-10','2026-07-11','2026-07-31']);
 assert.equal(actual.length,1);assert.equal(actual[0].attendanceSnapshot.calculationDate,'2026-07-10');assert.deepEqual(actual[0].items,expected[0].items);assert.equal(actual[0].items.find(i=>i.category==='base_work').amount,9100000);
 assert.deepEqual(batch(employee(1,{termination_date:'2026-06-30'}),['2026-07-10']),[]);
});

test('minute-based termination-month payroll ignores attendance after termination and preserves all retained work amounts',()=>{
 const user=employee(1,{termination_date:'2026-07-10',is_active:false}),c={...contract(1),calculationBasis:'minute'};
 const record=date=>({id:Number(date.slice(-2)),user_id:1,status:'present',work_date:date,check_in_at:date+'T02:00:00Z',check_out_at:date+'T11:00:00Z',late_minutes:0,early_leave_minutes:0,work_minutes:540,approval_status:null});
 const extra={schedules:[{id:1,userId:1,startTime:'09:00',endTime:'18:00',unpaidBreakMinutes:0,effectiveFrom:'2026-06-01',effectiveTo:null,revision:1,changeReason:null}],settingsByDate:new Map(['2026-07-10','2026-07-11'].map(date=>[date,{revision:1,lateGraceMinutes:0,earlyLeaveGraceMinutes:0}]))};
 const actual=batch(user,['2026-07-10','2026-07-11'],[c],[record('2026-07-10'),record('2026-07-11')],extra)[0];
 const expected=batch(user,['2026-07-10'],[c],[record('2026-07-10')],extra)[0];
 assert.equal(actual.recognizedMinutes,540);assert.deepEqual(actual.items,expected.items);assert.equal(actual.attendanceSnapshot.days.length,1);assert.ok(!actual.reviews.some(r=>r.warningCode==='CALCULATION_FAILED'));
});

test('payment preflight and RPC targets use the same employment selection, and excluded/paid employees cannot create another payment',async()=>{
 const users=[employee(1),employee(2,{termination_date:'2026-06-30',is_active:false}),employee(3,{termination_date:'2026-07-10',is_active:false})];
 const selected=selectPayrollUsers({users,month:'2026-07',attendance:[],contracts:users.map(u=>contract(u.id))});
 const employees=selected.map(u=>({userId:u.id,name:u.name,part:u.part,position:null,calculationStatus:'calculable',amounts:{currentAmount:9100000,netPayoutAmount:9100000},tax:{warningCodes:[]}}));
 const {buildPayrollDashboardSummary,buildPayrollPartTotals}=load('lib/payroll/payroll-dashboard.ts');
 assert.equal(buildPayrollDashboardSummary(employees).target,2);assert.equal(buildPayrollPartTotals(employees,()=>9100000).netTotal,18200000);
 const calls=[];let existingBatch=null;
 const server={from(table){assert.equal(table,'payroll_payment_batches');return{select(){return{eq(){return{maybeSingle:async()=>({data:existingBatch,error:null})}}}}}},rpc:async(name,args)=>{calls.push({name,args});return existingBatch?{data:null,error:{message:'PAYROLL_EMPLOYEE_ALREADY_PAID'}}:{data:{ok:true},error:null}}};
 const api=load('app/api/admin/payroll/payments/route.ts',new Map([
  ['@/lib/supabase/server',{supabaseServer:server}],
  ['@/lib/payroll/monthly-run',{validPayrollMonth:m=>m}],
  ['@/lib/payroll/overview-server',{loadPayrollOverview:async()=>({employees,rawByUser:new Map(selected.map(u=>[u.id,{reviews:[]}])),period:{asOfDate:'2026-07-31'},snapshot:{context:{contracts:users.map(u=>contract(u.id))},sourceSnapshot:{engineVersion:'qa'}},directorInsuranceAmount:0})}],
  ['@/lib/payroll/payment-snapshot',{buildEmployeePaymentSnapshot:e=>({userId:e.userId}),payrollPaymentSnapshotHash:()=> 'qa-hash'}],
  ['@/lib/payroll/server',{requirePayrollActor:async()=>({actor:{id:99}}),payrollJson:(body,status=200)=>({body,status})}],
  ['@/lib/payroll/payment-period',{isClosedPayrollMonth:()=>true}],
 ]),new Map());
 const request=id=>({json:async()=>({month:'2026-07',userId:id,fundAccountId:1,actualPaidAmount:9100000,paymentDate:'2026-08-01',calculationHash:'qa-hash'})});
 const former=await api.POST(request(2));assert.equal(former.status,409);assert.equal(former.body.code,'PAYROLL_EMPLOYEE_NOT_CALCULABLE');assert.equal(calls.length,0);
 const current=await api.POST(request(1));assert.equal(current.status,200);assert.equal(calls[0].name,'payroll_pay_employee_v3');assert.deepEqual(calls[0].args.p_targets.map(t=>t.userId),[1,3]);assert.equal(calls[0].args.p_calculated_net_amount,9100000);
 existingBatch=Object.freeze({id:8});const paid=await api.POST(request(1));assert.equal(paid.status,409);assert.equal(paid.body.code,'PAYROLL_EMPLOYEE_ALREADY_PAID');assert.deepEqual(existingBatch,{id:8});
});

