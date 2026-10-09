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
const {calculatePayrollBatch} = load(resolve("lib/payroll/monthly-run.ts"));
const {mapContract,mapSchedule} = load(resolve("lib/payroll/db-mappers.ts"));
const {selectEmployeeLevelProgramVersionsForDates} = load(resolve("lib/employee-level/version-selection.ts"));
const {calculateCompensatedPayrollRates} = load(resolve("lib/payroll/compensation.ts"));
const fixture = JSON.parse(readFileSync("tests/fixtures/payroll-holiday-20260902.json","utf8"));
const DATE = "2026-09-02";
const holiday = date => ({id:6,holidayDate:date,holidayCode:"NATIONAL_DAY",holidayGroup:"NATIONAL_DAY",holidayGroupSize:2,isPaidHoliday:true,isEmployerSelected:false,internalPayMultiplier:2,effectivePayMultiplier:2});
const sum = (employee,category) => employee.items.filter(item=>item.category===category).reduce((total,item)=>total+item.amount,0);
function defaults(dates=[DATE]) {
  return {month:"2026-09",dates,lateNormalizedRecordIds:new Set(),settingsByDate:new Map(),extraWorkSettingsByDate:new Map(),holidayPremiumByDate:new Map(dates.map(date=>[date,holiday(date)])),decisionsByAttendanceId:new Map(),insuranceVersionsByUser:new Map(),insuranceGlobal:{employeeRateBp:0,employerRateBp:0,directorEnabled:false},penaltySettings:{lateMajorThresholdMinutes:20,lateMinorPenaltyMinutes:60,lateMajorPenaltyRateBp:5000,unauthorizedAbsencePenaltyDays:3}};
}
function actualInput() {
  return {...defaults(),users:structuredClone(fixture.users),attendance:structuredClone(fixture.attendance),contracts:fixture.contracts.map(mapContract),schedules:fixture.schedules.map(mapSchedule),levelProgramsByDate:selectEmployeeLevelProgramVersionsForDates(fixture.levels,[DATE])};
}
function synthetic(options={}) {
  const dates=options.dates??[DATE];
  const user={id:1,name:"local",username:"local",role:"staff",is_active:true,hire_date:"2025-11-13",termination_date:null,is_system_account:false,payroll_eligible_override:true,level_program_enabled:true,level_base_date_override:null,...options.user};
  const contract={id:1,userId:1,payType:"monthly",calculationBasis:"minute",baseSalary:11_000_000,fixedRaiseAmount:1_000_000,standardWorkdays:26,standardMinutesPerDay:540,timeBlockMinutes:1,roundingMode:"none",lateAdjustmentMode:"separate",earlyLeaveAdjustmentMode:"separate",overtimeMode:"requires_approval",paidLeaveMode:"unpaid",effectiveFrom:"2026-08-01",effectiveTo:null,revision:1,...options.contract};
  const attendance=dates.map((date,index)=>({id:index+1,user_id:1,status:"done",work_date:date,check_in_at:`${date}T09:00:00+07:00`,check_out_at:`${date}T18:00:00+07:00`,approval_status:"approved",late_minutes:0,early_leave_minutes:0,work_minutes:540,updated_at:null,...options.attendance}));
  const input={...defaults(dates),users:[user],contracts:options.contracts??[contract],attendance,schedules:[{id:1,userId:1,startTime:"09:00",endTime:"18:00",unpaidBreakMinutes:0,effectiveFrom:"2026-08-01",effectiveTo:null,revision:1,...options.schedule}],...options.input};
  return {input,employee:calculatePayrollBatch(input)[0]};
}

// Independent expected amounts from effective APP contracts + fixed + level;
// the manually edited T9 holiday-premium column is deliberately excluded.
for (const [id,name,expected] of [[4,"Quân",519231],[5,"Điệp",384615],[6,"Linh",576923],[7,"Uyên",442308],[8,"Nhơn",442308],[10,"Triêm",365385],[14,"Khôi",326923],[18,"Thành",307692],[23,"Đức",175000],[24,"Thêm",307692],[25,"Thủy",71429],[28,"Thiết",245000]]) {
  test(`September 2 APP source: ${name} base and holiday premium both ${expected}`,()=>{
    const input=actualInput(),before=structuredClone(input);
    const employee=calculatePayrollBatch(input).find(row=>row.userId===id);
    assert.equal(sum(employee,"base_work"),expected);
    assert.equal(sum(employee,"holiday_work_premium"),expected);
    assert.equal(employee.items.filter(item=>item.category==="holiday_work_premium").length,1);
    assert.equal(sum(employee,"base_work")+sum(employee,"holiday_work_premium"),expected*2);
    const premium=employee.items.find(item=>item.category==="holiday_work_premium"),base=employee.items.find(item=>item.category==="base_work");
    assert.equal(premium.sourceSnapshot.premiumCalculationBaseAmount,base.amount);
    for (const key of ["contractSalary","fixedRaiseAmount","levelRaiseAmount","combinedSalary","dayRate","contractId","contractRevision","levelProgramVersionId"]) assert.equal(premium.sourceSnapshot[key],base.sourceSnapshot[key],key);
    assert.equal(premium.sourceSnapshot.compensationBasis,"combined_salary");
    assert.deepEqual(input,before);
  });
}
test("APP holiday-off employees receive no worked-holiday premium",()=>{
  for(const id of [3,19]){const employee=calculatePayrollBatch(actualInput()).find(row=>row.userId===id);assert.equal(sum(employee,"base_work"),0);assert.equal(sum(employee,"holiday_work_premium"),0);}
});
test("daily and hourly contracts retain ordinary rate policy without monthly raises",()=>{
  for(const [payType,baseSalary,expected] of [["daily",500000,500000],["hourly",35000,315000]]){const {employee}=synthetic({contract:{payType,baseSalary,fixedRaiseAmount:4_000_000}});assert.equal(sum(employee,"base_work"),expected);assert.equal(sum(employee,"holiday_work_premium"),expected);}
});
test("fixed monthly receives the compensated monthly amount once without premium",()=>{
  const {employee}=synthetic({contract:{calculationBasis:"fixed_monthly"}});assert.equal(sum(employee,"base_work"),13_500_000);assert.equal(sum(employee,"holiday_work_premium"),0);
});
test("open attendance and invalid checkout cannot earn base or premium",()=>{
  for(const attendance of [{status:"working",check_out_at:null},{check_in_at:null},{check_out_at:`${DATE}T08:00:00+07:00`}]){const {employee}=synthetic({attendance});assert.equal(sum(employee,"base_work"),0);assert.equal(sum(employee,"holiday_work_premium"),0);assert.ok(employee.reviews.some(review=>review.reviewLevel==="blocking"));}
});
test("approved leave, absence, and missing attendance receive no holiday premium",()=>{
  for(const status of ["leave","unauthorized_absence"]){const {employee}=synthetic({attendance:{status,check_in_at:null,check_out_at:null,work_minutes:0}});assert.equal(sum(employee,"holiday_work_premium"),0);}
  const {input}=synthetic();input.attendance=[];assert.equal(sum(calculatePayrollBatch(input)[0],"holiday_work_premium"),0);
});
test("holiday date selects the effective contract and excludes later contracts",()=>{
  const {input}=synthetic({dates:["2026-09-01",DATE]});input.contracts=[{...input.contracts[0],effectiveTo:DATE},{...input.contracts[0],id:2,revision:2,baseSalary:13_000_000,effectiveFrom:DATE,effectiveTo:"2026-09-03"},{...input.contracts[0],id:3,revision:3,baseSalary:20_000_000,effectiveFrom:"2026-09-03"}];
  const premiums=calculatePayrollBatch(input)[0].items.filter(item=>item.category==="holiday_work_premium");assert.deepEqual(premiums.map(item=>item.amount),[519231,596154]);assert.deepEqual(premiums.map(item=>item.sourceSnapshot.contractId),[1,2]);
});
test("overlapping or missing holiday-day contracts block premium",()=>{
  for(const overlap of [false,true]){const {input}=synthetic();input.contracts=overlap?[input.contracts[0],{...input.contracts[0],id:2}]:[];const employee=calculatePayrollBatch(input)[0];assert.equal(sum(employee,"holiday_work_premium"),0);assert.ok(employee.reviews.some(review=>review.warningCode===(overlap?"CONTRACT_OVERLAP":"NO_PAYROLL_CONTRACT")));}
});
test("level anniversary is applied on the work date rather than month-end",()=>{
  const {employee}=synthetic({dates:[DATE,"2026-09-03"],user:{hire_date:"2025-12-03"}});assert.deepEqual(employee.items.filter(item=>item.category==="holiday_work_premium").map(item=>item.amount),[500000,519231]);
});
test("effective level-program change on holiday date is shared by base and premium",()=>{
  const dates=["2026-09-01",DATE],rows=[{id:1,user_id:1,enabled:false,effective_from:"2026-08-01",effective_to:DATE,base_date:null,base_date_mode:"hire_date",revision:1},{id:2,user_id:1,enabled:true,effective_from:DATE,effective_to:null,base_date:"2025-11-13",base_date_mode:"override",revision:2}];
  const {employee}=synthetic({dates,user:{level_program_enabled:false},input:{levelProgramsByDate:selectEmployeeLevelProgramVersionsForDates(rows,dates)}});const premiums=employee.items.filter(item=>item.category==="holiday_work_premium");assert.deepEqual(premiums.map(item=>item.amount),[461538,519231]);assert.deepEqual(premiums.map(item=>item.sourceSnapshot.levelProgramVersionId),[1,2]);
});
test("missing required level base date never falls back to original salary",()=>{
  const rates=calculateCompensatedPayrollRates(synthetic().input.contracts[0],{eligible:false,reason:"MISSING_BASE_DATE"});assert.equal(rates.rates,null);const {employee}=synthetic({user:{hire_date:null}});assert.equal(sum(employee,"holiday_work_premium"),0);assert.ok(employee.reviews.some(review=>review.warningCode==="EMPLOYEE_LEVEL_BASE_DATE_REQUIRED"));
});
test("stored attendance review uses identical compensation without duplicate premium",()=>{
  const {employee}=synthetic({attendance:{work_minutes:500}}),review=employee.reviews.find(row=>row.warningCode==="STORED_WORK_MINUTES_MISMATCH");assert.ok(review);assert.equal(review.sourceSnapshot.storedAutomaticItems.filter(item=>item.category==="holiday_work_premium").length,1);assert.equal(sum(employee,"holiday_work_premium"),519231);assert.equal(review.sourceSnapshot.storedAutomaticItems.find(item=>item.category==="holiday_work_premium").amount,519231);
});
test("late and early-leave deductions do not lower the premium calculation base",()=>{
  const {employee}=synthetic({attendance:{check_in_at:`${DATE}T09:10:00+07:00`,check_out_at:`${DATE}T17:30:00+07:00`,work_minutes:500}});assert.equal(sum(employee,"base_work"),519231);assert.equal(sum(employee,"holiday_work_premium"),519231);assert.ok(sum(employee,"late_deduction")>0);
});
test("unselected holiday multiplier yields ordinary work only",()=>{
  const {employee}=synthetic({input:{holidayPremiumByDate:new Map()}});assert.equal(sum(employee,"base_work"),519231);assert.equal(sum(employee,"holiday_work_premium"),0);
});
