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
const {calculatePayrollBatch}=load('lib/payroll/monthly-run.ts');
const user={id:9,name:'Test',full_name:null,username:'test',is_active:true,role:'staff',part:null,position:null,birth_date:null,hire_date:'2026-08-01',termination_date:null,is_system_account:false,payroll_eligible_override:null,level_program_enabled:false,level_base_date_override:null};
const contract={id:10,userId:9,payType:'monthly',calculationBasis:'minute',baseSalary:9100000,fixedRaiseAmount:0,standardWorkdays:26,standardMinutesPerDay:540,timeBlockMinutes:1,roundingMode:'none',lateAdjustmentMode:'separate',earlyLeaveAdjustmentMode:'separate',overtimeMode:'ignore',paidLeaveMode:'unpaid',effectiveFrom:'2026-08-01',effectiveTo:null,revision:1};
function batch(raw,selection,fixed=false){
 const out=new Date(new Date('2026-09-02T01:00:00+07:00').getTime()-raw*60000).toISOString();const applied=selection==='use_raw'?raw:Math.max(0,raw-60);
 const context={id:1,user_id:9,work_date:'2026-09-01',rawEarlyLeaveMinutes:raw,earlyLeaveGraceMinutes:60,effectiveEarlyLeaveMinutes:Math.max(0,raw-60),normalCheckoutThresholdAt:'2026-09-02T01:00:00+07:00',earlyLeaveSelection:selection,earlyLeaveReviewRequired:raw>60&&!selection};
 const input={month:'2026-09',dates:['2026-09-01'],users:[user],attendance:[{id:1,user_id:9,status:raw>60?'early_leave':'done',work_date:'2026-09-01',check_in_at:'2026-09-01T16:00:00+07:00',check_out_at:out,late_minutes:0,early_leave_minutes:applied,work_minutes:540-raw,approval_status:null,updated_at:out}],lateNormalizedRecordIds:new Set(),earlyLeaveContexts:new Map([[1,context]]),contracts:[fixed?{...contract,calculationBasis:'fixed_monthly'}:contract],schedules:[{id:1,userId:9,startTime:'16:00',endTime:'01:00',unpaidBreakMinutes:0,effectiveFrom:'2026-08-01',effectiveTo:null,revision:1,changeReason:null}],settingsByDate:new Map([['2026-09-01',{revision:1,lateGraceMinutes:0,earlyLeaveGraceMinutes:60}]]),extraWorkSettingsByDate:new Map(),holidayPremiumByDate:new Map(),decisionsByAttendanceId:new Map(),insuranceVersionsByUser:new Map(),insuranceGlobal:{employeeRateBp:1050,employerRateBp:2150,directorEnabled:false,directorUserId:null,directorBaseAmount:0,directorRateBp:0,directorEmployeeRateBp:0,settingsUpdatedAt:null},penaltySettings:{lateMajorThresholdMinutes:20,lateMinorPenaltyMinutes:60,lateMajorPenaltyRateBp:5000,unauthorizedAbsencePenaltyDays:2}};
 return calculatePayrollBatch(input)[0];
}
test('actual monthly payroll blocks pending choices and uses the selected minutes for existing 30-minute deductions',()=>{
 for(const raw of [59,60,61,120]){
  const pending=batch(raw,null);
  assert.equal(pending.reviews.some(r=>r.warningCode==='CALCULATION_FAILED'),false);
  assert.equal(pending.reviews.some(r=>r.warningCode==='EARLY_LEAVE_REVIEW_REQUIRED'&&r.reviewLevel==='blocking'),raw>60);
  if(raw<=60)assert.equal(pending.items.some(i=>i.category==='early_leave_deduction'),false);
  if(raw>60)for(const selection of ['use_raw','use_effective']){
   const employee=batch(raw,selection);assert.equal(employee.reviews.length,0);
   const deduction=employee.items.find(i=>i.category==='early_leave_deduction');
   const applied=selection==='use_raw'?raw:raw-60;
   assert.equal(employee.earlyLeaveMinutes,applied);assert.equal(deduction.sourceSnapshot.penaltyMinutes,Math.ceil(applied/30)*30);
   assert.equal(deduction.amount,Math.round(350000/540*Math.ceil(applied/30)*30));
   assert.equal(deduction.sourceSnapshot.earlyLeaveSelection,selection);
   assert.equal(employee.items.find(i=>i.category==='base_work').amount,350000);
  }
 }
});
test('fixed monthly payroll also blocks unresolved early-leave decisions while preserving its pay policy',()=>{
 assert.equal(batch(61,null,true).reviews.some(r=>r.warningCode==='EARLY_LEAVE_REVIEW_REQUIRED'&&r.reviewLevel==='blocking'),true);
 const decided=batch(61,'use_raw',true);assert.equal(decided.reviews.length,0);assert.equal(decided.items.some(i=>i.category==='early_leave_deduction'),false);
});

test('actual admin action rejects client minutes, applies paid lock, and removes resolved rows from GET',async()=>{
 const record={id:1,user_id:9,work_date:'2026-09-01',status:'early_leave',check_in_at:'2026-09-01T16:00:00+07:00',check_out_at:'2026-09-01T23:59:00+07:00',updated_at:'2026-09-02T01:00:00+07:00'};
 const context={id:1,user_id:9,work_date:'2026-09-01',rawEarlyLeaveMinutes:61,earlyLeaveGraceMinutes:60,effectiveEarlyLeaveMinutes:1,normalCheckoutThresholdAt:'2026-09-02T01:00:00+07:00',earlyLeaveSelection:null,earlyLeaveReviewRequired:true};
 let paid=false;let calls=0;let sent;let admin=true;
 const supabase={from(table){
  const query={select(){return this},eq(){return this},not(){return this},is(){return this},lte(){return this},in(){return this},
   async maybeSingle(){return {data:record,error:null}},async single(){return {data:{work_start_time:'16:00',work_end_time:'01:00'},error:null}},
   async limit(){return {data:paid?[{id:1}]:[],error:null}},async order(){return {data:table==='users'?[{id:9,name:'Test',username:'test',is_active:true}]:[],error:null}}};return query;
 },async rpc(name,args){assert.equal(name,'attendance_admin_resolve_early_leave_v1');sent=args;calls++;context.earlyLeaveReviewRequired=false;context.earlyLeaveSelection=args.p_selection;return {data:{status:'ok',record:{...record,early_leave_minutes:args.p_selection==='use_raw'?61:1}},error:null}}};
 const stubs=new Map([
  ['next/server',{NextResponse:{json:(data,init)=>Response.json(data,init)}}],
  ['@/lib/supabase/server',{supabaseServer:supabase}],
  ['@/lib/attendance/server-api',{requireAttendanceActor:async()=>({ok:true,actor:{id:1,role:admin?'owner':'staff'}}),attendanceAuthFailure:()=>Response.json({ok:false},{status:401})}],
  ['@/lib/attendance/policy-resolution-adapter',{resolveAttendanceRecordPolicy:async()=>({normalCheckoutThresholdAt:context.normalCheckoutThresholdAt,earlyLeaveGraceMinutes:60})}],
  ['@/lib/attendance/early-leave-review-server',{loadEarlyLeaveReviewContexts:async()=>new Map([[1,context]])}],
  ['@/lib/attendance/audit-log',{recordAttendanceAuditLog:async()=>{}}],
 ]);
 const route=load('app/api/attendance/admin/route.ts',stubs,new Map());
 const request=body=>new Request('http://localhost/api/attendance/admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const pending=await (await route.GET(new Request('http://localhost/api/attendance/admin'))).json();assert.equal(pending.earlyLeaveReviewRecords.length,1);assert.deepEqual(pending.unresolvedOpenRecords,[]);
 let response=await route.POST(request({action:'resolve_early_leave',attendance_id:1,selection:'invalid'}));assert.equal(response.status,400);assert.equal(calls,0);
 admin=false;response=await route.POST(request({action:'resolve_early_leave',attendance_id:1,selection:'use_raw'}));assert.equal(response.status,403);admin=true;
 response=await route.POST(request({action:'resolve_early_leave',attendance_id:1,selection:'use_raw',rawEarlyLeaveMinutes:9999,effectiveEarlyLeaveMinutes:9999,earlyLeaveGraceMinutes:0}));
 assert.equal(response.status,200);assert.equal((await response.json()).record.early_leave_minutes,61);
 assert.equal(sent.p_expected_grace_minutes,60);assert.equal(sent.p_expected_threshold_at,context.normalCheckoutThresholdAt);assert.equal(sent.rawEarlyLeaveMinutes,undefined);assert.equal(sent.effectiveEarlyLeaveMinutes,undefined);
 const resolved=await (await route.GET(new Request('http://localhost/api/attendance/admin'))).json();assert.equal(resolved.earlyLeaveReviewRecords.length,0);
 paid=true;response=await route.POST(request({action:'resolve_early_leave',attendance_id:1,selection:'use_effective'}));assert.equal(response.status,409);assert.equal((await response.json()).code,'PAYROLL_PAID_LOCKED');assert.equal(calls,1);
});
