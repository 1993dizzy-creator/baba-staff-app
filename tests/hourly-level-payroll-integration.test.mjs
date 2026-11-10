import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

// Execute the actual engine offline, forbidding every database access.
const nativeRequire = createRequire(import.meta.url), modules = new Map();
function load(path) {
  if (modules.has(path)) return modules.get(path).exports;
  const loadedModule = { exports: {} };
  modules.set(path, loadedModule);
  const code = ts.transpileModule(readFileSync(path,"utf8"), {
    compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText;
  const localRequire = name => {
    if (name === "server-only") return {};
    if (name === "@/lib/supabase/server") return {supabaseServer:new Proxy({}, {get(){throw new Error("Database access forbidden in holiday tests");}})};
    if (name.startsWith("@/")) return load(resolve(name.slice(2)+".ts"));
    if (name.startsWith(".")) return load(resolve(dirname(path),name.endsWith(".ts")?name:name+".ts"));
    return nativeRequire(name);
  };
  new Function("require","module","exports",code)(localRequire,loadedModule,loadedModule.exports);
  return loadedModule.exports;
}

const {calculatePayrollBatch}=load(resolve("lib/payroll/monthly-run.ts"));
const sum=(e,category)=>e.items.filter(i=>i.category===category).reduce((n,i)=>n+i.amount,0);
function input(date,options={}){
 const user={id:1,name:"fixture",username:"fixture",role:"staff",is_active:true,hire_date:"2025-11-03",termination_date:null,is_system_account:false,payroll_eligible_override:true,level_program_enabled:true,level_base_mode:"hire_month",level_base_date_override:"2025-11-01",...options.user};
 const contract={id:1,userId:1,payType:"hourly",calculationBasis:"minute",baseSalary:35000,fixedRaiseAmount:900000,standardWorkdays:26,standardMinutesPerDay:420,timeBlockMinutes:1,roundingMode:"none",lateAdjustmentMode:"separate",earlyLeaveAdjustmentMode:"separate",overtimeMode:"requires_approval",paidLeaveMode:"unpaid",effectiveFrom:"2025-11-01",effectiveTo:null,revision:1,...options.contract};
 const record={id:1,user_id:1,status:"done",work_date:date,check_in_at:date+"T09:00:00+07:00",check_out_at:date+"T16:00:00+07:00",approval_status:"approved",late_minutes:0,early_leave_minutes:0,work_minutes:420,updated_at:null,...options.attendance};
 return {month:date.slice(0,7),dates:[date],users:[user],contracts:[contract],attendance:[record],schedules:[{id:1,userId:1,startTime:"09:00",endTime:"16:00",unpaidBreakMinutes:0,effectiveFrom:"2025-11-01",effectiveTo:null,revision:1,...options.schedule}],lateNormalizedRecordIds:new Set(),settingsByDate:new Map([[date,{revision:1,lateGraceMinutes:0,earlyLeaveGraceMinutes:0}]]),extraWorkSettingsByDate:new Map(),holidayPremiumByDate:new Map([[date,{id:1,holidayDate:date,holidayCode:"FIXTURE",holidayGroup:"FIXTURE",holidayGroupSize:1,isPaidHoliday:true,isEmployerSelected:false,internalPayMultiplier:2,effectivePayMultiplier:2}]]),decisionsByAttendanceId:new Map(),insuranceVersionsByUser:new Map(),insuranceGlobal:{employeeRateBp:0,employerRateBp:0,directorEnabled:false},penaltySettings:{lateMajorThresholdMinutes:20,lateMinorPenaltyMinutes:60,lateMajorPenaltyRateBp:5000,unauthorizedAbsencePenaltyDays:3}};
}
test("actual payroll changes on promotion date and pays holiday premium from the same adjusted hourly base",()=>{
 const beforeInput=input("2026-01-31"),afterInput=input("2026-02-01"),frozen=structuredClone(afterInput);
 const before=calculatePayrollBatch(beforeInput)[0],after=calculatePayrollBatch(afterInput)[0];
 assert.equal(sum(before,"base_work"),245000);assert.equal(sum(after,"base_work"),264229);assert.equal(sum(after,"holiday_work_premium"),264229);
 assert.equal(after.items.find(i=>i.category==="base_work").sourceSnapshot.combinedSalary,37747);assert.deepEqual(afterInput,frozen);
});
test("contract denominator remains 7h x26 when paid schedule is 9h",()=>{
 const data=input("2026-02-01",{schedule:{endTime:"18:00"},attendance:{check_out_at:"2026-02-01T18:00:00+07:00",work_minutes:540}});const e=calculatePayrollBatch(data)[0];
 assert.equal(sum(e,"base_work"),339723);assert.equal(e.items.find(i=>i.category==="base_work").sourceSnapshot.hourlyStandardMonthlyHours,182);
});
test("late and early-leave penalties keep their policies and consistently use the adjusted minute rate",()=>{
 const e=calculatePayrollBatch(input("2026-02-01",{attendance:{status:"late_and_early_leave",check_in_at:"2026-02-01T09:10:00+07:00",check_out_at:"2026-02-01T15:50:00+07:00",late_minutes:10,early_leave_minutes:10,work_minutes:400}}))[0];
 assert.equal(sum(e,"base_work"),264229);assert.equal(sum(e,"late_deduction"),37747);assert.equal(sum(e,"early_leave_deduction"),18874);
 for(const item of e.items.filter(i=>["base_work","late_deduction","early_leave_deduction","holiday_work_premium"].includes(i.category)))assert.equal(item.sourceSnapshot.minuteRate,37747/60);
});
test("approved extra work uses adjusted hourly rate once, with unchanged approval/source-hash rules",()=>{
 const data=input("2026-02-01",{attendance:{check_in_at:"2026-02-01T08:30:00+07:00",check_out_at:"2026-02-01T17:00:00+07:00",work_minutes:510}});
 data.extraWorkSettingsByDate=new Map([["2026-02-01",{id:1,revision:1,openTime:"08:00",closeTime:"20:00"}]]);
 const candidate=calculatePayrollBatch(data)[0].partTimeExtraWork[0];assert.ok(candidate);assert.equal(candidate.hourlyRateAmount,37747);
 data.decisionsByAttendanceId=new Map([[1,{id:1,attendanceRecordId:1,decision:"approved",sourceHash:candidate.sourceHash,decisionReason:null,decidedBy:1,decidedAt:"2026-02-02T00:00:00Z"}]]);
 const e=calculatePayrollBatch(data)[0];assert.equal(sum(e,"part_time_extra_work"),Math.round(37747/60*candidate.candidateMinutes));assert.equal(e.partTimeExtraWork[0].status,"approved");assert.equal(sum(e,"base_work"),264229);
});
test("invalid contract hours return blocking review instead of a fabricated wage",()=>{const e=calculatePayrollBatch(input("2026-02-01",{contract:{standardMinutesPerDay:0}}))[0];assert.ok(e.reviews.some(r=>r.warningCode==="INVALID_HOURLY_STANDARD_HOURS"&&r.reviewLevel==="blocking"));assert.equal(sum(e,"base_work"),0);assert.equal(sum(e,"holiday_work_premium"),0)});
test("OFF and saved salary exclusion preserve old hourly wage; monthly/daily amounts retain existing calculation",()=>{
 for(const user of [{level_program_enabled:false},{level_salary_raise_enabled:false}])assert.equal(sum(calculatePayrollBatch(input("2026-02-01",{user}))[0],"base_work"),245000);
 assert.equal(sum(calculatePayrollBatch(input("2026-02-01",{contract:{payType:"monthly",baseSalary:8000000,fixedRaiseAmount:500000}}))[0],"base_work"),346154);
 assert.equal(sum(calculatePayrollBatch(input("2026-02-01",{contract:{payType:"daily",baseSalary:500000}}))[0],"base_work"),500000);
});
