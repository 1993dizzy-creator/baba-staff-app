import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's strip-types test runner requires the explicit extension.
import { calculateHolidayWorkPremiumAmount } from "../lib/payroll/holiday-premium.ts";
// @ts-expect-error Node's strip-types test runner requires the explicit extension.
import { payrollTaxTreatmentForItem } from "../lib/payroll/tax.ts";
// @ts-expect-error Node's strip-types test runner requires the explicit extension.
import { getEffectiveHolidayMultiplier } from "../lib/store-settings/holidays-policy.ts";

const read=(path:string)=>readFileSync(join(process.cwd(),path),"utf8");
const monthlyRun=read("lib/payroll/monthly-run.ts");
const premiumSource=read("lib/payroll/holiday-premium.ts");
const overview=read("lib/payroll/overview.ts");
const projection=read("lib/payroll/overview-projection.ts");
const card=read("components/payroll/CompensationCard.tsx");
const labels=read("lib/payroll/ui-labels.ts");
const copy=read("lib/text/payroll-overview.ts");
const holidayServer=read("lib/store-settings/holidays-server.ts");
const exportTypes=read("lib/payroll/source-export/types.ts");
const exportBuilder=read("lib/payroll/source-export/build-export.ts");

function premium(payType:"monthly"|"daily"|"hourly",baseWorkAmount:number,effectiveMultiplier:number|null,calculationBasis:"minute"|"hour"|"fixed_monthly"="minute"){
  return calculateHolidayWorkPremiumAmount({payType,calculationBasis,baseWorkAmount,effectiveMultiplier});
}

test("monthly premium keeps base work and adds only the extra 100 percent",()=>{
  const baseWorkAmount=1_000_000;
  const premiumAmount=premium("monthly",baseWorkAmount,2);
  assert.equal(premiumAmount,1_000_000);
  assert.equal(baseWorkAmount+premiumAmount,2_000_000);
  assert.equal(premium("monthly",baseWorkAmount,null),0);
});

test("daily and hourly premiums reuse the finalized recognized base-work amount",()=>{
  assert.equal(premium("daily",500_000,2),500_000);
  assert.equal(premium("hourly",210_000,2),210_000);
});

test("late, early-leave, and approved extra work remain independent amounts",()=>{
  const baseWorkAmount=500_000;
  const holidayPremiumAmount=premium("daily",baseWorkAmount,2);
  const approvedExtraWorkAmount=100_000;
  const lateDeductionAmount=50_000;
  const earlyLeaveDeductionAmount=20_000;
  assert.equal(holidayPremiumAmount,500_000);
  assert.equal(baseWorkAmount+holidayPremiumAmount+approvedExtraWorkAmount-lateDeductionAmount-earlyLeaveDeductionAmount,1_030_000);
});

test("fixed monthly is explicitly excluded even on an effective premium holiday",()=>{
  assert.equal(premium("monthly",23_000_000,2,"fixed_monthly"),0);
});

test("paid holiday policy is not interpreted directly and null selection is non-blocking",()=>{
  const automaticSingleDay=getEffectiveHolidayMultiplier({holidayGroup:"NEW_YEAR",internalPayMultiplier:null},1);
  const selectedMultiDay=getEffectiveHolidayMultiplier({holidayGroup:"NATIONAL_DAY",internalPayMultiplier:2},2);
  const unselectedMultiDay=getEffectiveHolidayMultiplier({holidayGroup:"NATIONAL_DAY",internalPayMultiplier:null},2);
  assert.equal(automaticSingleDay,2);
  assert.equal(selectedMultiDay,2);
  assert.equal(unselectedMultiDay,null);
  assert.equal(premium("daily",500_000,unselectedMultiDay),0);
});

test("holiday premium is an ordinary taxable addition",()=>{
  assert.equal(payrollTaxTreatmentForItem("holiday_work_premium","addition",500_000,{}),"taxable_compensation");
});

test("monthly snapshot loads effective holiday policy once and reuses a date map for every employee",()=>{
  assert.equal((monthlyRun.match(/loadPayrollHolidayPremiumPoliciesForMonth\(month\)/g)??[]).length,1);
  assert.match(monthlyRun,/const holidayPremiumByDate=new Map\(holidayPremiumPolicies\.map\(holiday=>\[holiday\.holidayDate,holiday\]\)\)/);
  assert.match(monthlyRun,/holidayPremiumByDate:Map<string,PayrollHolidayPremiumPolicy>/);
  assert.match(holidayServer,/getEffectiveHolidayMultiplier\(holiday, holidayGroupSize\)/);
  assert.doesNotMatch(monthlyRun,/is_paid_holiday|internal_pay_multiplier/);
});

test("engine creates independent base, holiday, extra-work, late, and early-leave items",()=>{
  assert.match(monthlyRun,/const baseWorkItem=item\("base_work","addition"/);
  assert.match(monthlyRun,/item\("holiday_work_premium","addition"/);
  assert.match(monthlyRun,/item\("part_time_extra_work","addition"/);
  assert.match(monthlyRun,/item\("late_deduction","deduction"/);
  assert.match(monthlyRun,/item\("early_leave_deduction","deduction"/);
  assert.match(monthlyRun,/if\(blocking\|\|facts\.actualMinutes===null\).*continue/);
  assert.match(premiumSource,/calculationBasis === "fixed_monthly" \|\| input\.effectiveMultiplier === null/);
  assert.match(monthlyRun,/monthly-payroll-v11/);
});

test("premium item snapshot captures the reproducible holiday and calculation inputs",()=>{
  for(const key of ["holidayId","holidayDate","holidayCode","holidayGroup","holidayGroupSize","isPaidHoliday","isEmployerSelected","internalPayMultiplier","effectiveMultiplier","premiumCalculationBaseAmount","premiumAmount","attendanceRecordId","recognizedMinutes","contractRevision","scheduleRevision","engineVersion"]) assert.match(monthlyRun,new RegExp(`${key}(?::|,)`),key);
});

test("overview, projection, UI, and source export expose premium separately exactly once",()=>{
  assert.match(overview,/const holidayWorkPremiumAmount = sum\(items, "holiday_work_premium", "addition"\)/);
  assert.match(overview,/"part_time_extra_work", "holiday_work_premium", "attendance_bonus"/);
  assert.match(projection,/\+ employee\.amounts\.holidayWorkPremiumAmount/);
  assert.match(card,/employee\.amounts\.holidayWorkPremiumAmount > 0/);
  for(const phrase of ["공휴일 추가수당","Phụ cấp làm việc ngày lễ","holiday_work_premium"]) assert.ok(labels.includes(phrase)||copy.includes(phrase),phrase);
  assert.match(exportTypes,/payroll-source-export-v2/);
  assert.match(exportTypes,/holidayWorkPremium:/);
  assert.match(exportBuilder,/item\.category==="holiday_work_premium"/);
  assert.match(exportBuilder,/holidayWorkPremium:\{referenceAmount:Number\(employee\.amounts\.holidayWorkPremiumAmount\?\?0\),items:holidayPremiumItems\}/);
});
