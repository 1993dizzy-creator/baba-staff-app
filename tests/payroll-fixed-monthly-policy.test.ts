import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { calculateFixedMonthlyPayroll } from "../lib/payroll/fixed-monthly.ts";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const settings = read("app/(protected)/admin/payroll/settings/page.tsx");
const usersRoute = read("app/api/admin/payroll/users/route.ts");
const contractsRoute = read("app/api/admin/payroll/contracts/route.ts");
const correctRoute = read("app/api/admin/payroll/contracts/correct/route.ts");
const monthly = read("lib/payroll/monthly-run.ts");
const fixed = read("lib/payroll/fixed-monthly.ts");
const migration = read("supabase/migrations/202608010003_add_fixed_monthly_payroll_basis.sql");

test("fixed monthly formula pays contract, fixed raise, and current level raise exactly once", () => {
  const result = calculateFixedMonthlyPayroll(
    { payType: "monthly", calculationBasis: "fixed_monthly", baseSalary: 20_000_000, fixedRaiseAmount: 2_000_000 } as never,
    { eligible: true, reason: null, level: 2, displayLabel: "Lv.2", earnedRaiseCount: 2, raiseAmountPerStep: 500_000 } as never,
    "2026-08-20",
  );
  assert.equal(result?.amount, 23_000_000);
  assert.deepEqual(result?.levelSnapshot, {
    level: 2,
    displayLabel: "Lv.2",
    earnedRaiseCount: 2,
    raiseAmountPerStep: 500_000,
    appliedLevelRaiseAmount: 1_000_000,
    calculationDate: "2026-08-20",
  });
});

test("employee list loads active users once per tab/language and restores URL selection separately", () => {
  assert.match(usersRoute, /\.eq\("is_active",true\)/);
  assert.match(settings, /\}, \[activeTab, vi\]\);/);
  assert.match(settings, /users\.some\(\(user\) => user\.id === requested\)/);
  assert.match(settings, /useState\(true\).*employeeListOpen|employeeListOpen, setEmployeeListOpen/);
  assert.match(settings, /aria-expanded=\{employeeListOpen\}/);
  assert.match(settings, /aria-controls="payroll-employee-list"/);
  assert.match(settings, /setEmployeeListOpen\(false\)/);
  assert.equal((settings.match(/fetch\("\/api\/admin\/payroll\/users"/g) ?? []).length, 1);
});

test("employee clicks wait for collapsed layout and both detail requests before one scroll", () => {
  assert.match(settings, /pendingScrollUserIdRef/);
  assert.match(settings, /employeeListOpen \|\| contractsLoading \|\| selectedInsuranceLoading/);
  assert.match(settings, /pendingScrollUserIdRef\.current = null/);
  assert.equal((settings.match(/scrollIntoView\(/g) ?? []).length, 1);
});

test("contract money fields share formatting and zero-only focus convenience", () => {
  assert.match(settings, /function MoneyInputField/);
  assert.match(settings, /value=\{formatIntegerInput\(value\)\}/);
  assert.match(settings, /change\(integerInputDigits\(event\.target\.value\)\)/);
  assert.match(settings, /value === "0"\) change\(""\)/);
  assert.match(settings, /value === ""\) change\("0"\)/);
  assert.match(settings, /fixedRaiseAmount: Number\(form\.fixedRaiseAmount\)/);
  assert.match(settings, /baseSalary: Number\(form\.baseSalary\)/);
});

test("owner (and now attendance-tracking-disabled) contract UI stays fixed monthly while regular contracts use one hidden basis", () => {
  assert.match(settings, /isPayrollOwnerRole\(selected\?\.role \?\? null\)/);
  assert.match(settings, /requiresFixedMonthlyContract\(selected\?\.role \?\? null, selected\?\.attendanceTrackingEnabled \?\? true\)/);
  assert.match(settings, /calculationBasis: "fixed_monthly"/);
  assert.match(settings, /payrollLabel\(l, "fixed_monthly"\)/);
  assert.match(settings, /!selectedRequiresFixedMonthly && form\.payType === "monthly"/);
  assert.match(settings, /calculationBasis: selectedRequiresFixedMonthly \? "fixed_monthly" : "minute"/);
  assert.doesNotMatch(settings, /options=\{\s*form\.payType === "hourly"/);
  assert.match(settings, /isMonthFirstDate\(form\.effectiveFrom\)/);
  assert.match(settings, /매월 고정 지급 계약은 매월 1일부터 적용할 수 있습니다/);
  assert.match(settings, /Hợp đồng trả cố định hàng tháng chỉ có thể áp dụng từ ngày đầu tiên của tháng/);
});

test("save button disables only when a work schedule is genuinely required and missing, and the same reason is shown inline (no silent no-op)", () => {
  assert.match(settings, /disabled=\{saving \|\| \(selectedRequiresWorkSchedule && automaticStandardMinutes === null\)\}/);
  assert.match(
    settings,
    /\{selectedRequiresWorkSchedule && automaticStandardMinutes === null \? \(\s*\n\s*<p role="alert" style=\{s\.error\}>\s*\n\s*\{payrollContractErrorMessage\(l, effectiveSchedules\.length > 1 \? "WORK_SCHEDULE_OVERLAP" : effectiveSchedule \? "INVALID_WORK_SCHEDULE" : "WORK_SCHEDULE_NOT_FOUND"\)\}/,
  );
});

test("attendance-tracking-disabled employees get a 근태 미사용 · 월 고정급 notice instead of the schedule history box (owners keep the existing no-notice hidden state)", () => {
  assert.match(settings, /selectedRequiresWorkSchedule \? \(/);
  assert.match(settings, /<ScheduleHistory current=\{currentSchedule\} monthSchedules=\{effectiveMonthSchedules\} month=\{form\.effectiveFrom\.slice\(0, 7\)\} vi=\{vi\} \/>/);
  assert.match(settings, /\) : selectedIsOwner \? null : \(/);
  assert.match(settings, /근태 미사용 · 월 고정급/);
  assert.match(settings, /Không sử dụng chấm công · Lương cố định hàng tháng/);
});

test("contract API validates role AND attendance_tracking_enabled (not position) and uses the schedule-aware private v6 RPC", () => {
  assert.match(contractsRoute, /select\("id,role,is_active,attendance_tracking_enabled"\)/);
  assert.match(contractsRoute, /from "@\/lib\/payroll\/eligibility"/);
  assert.match(contractsRoute, /targetUsesFixedMonthly = requiresFixedMonthlyContract\(target\.role, target\.attendance_tracking_enabled\)/);
  assert.match(contractsRoute, /!targetUsesFixedMonthly && body\.calculationBasis === "fixed_monthly"/);
  assert.match(contractsRoute, /payroll_create_contract_version_v6/);
  assert.doesNotMatch(contractsRoute, /payroll_create_contract_version_v5|payroll_create_contract_version_v4/);
  assert.match(contractsRoute, /scheduledMinutesPerDay/);
  assert.match(contractsRoute, /!isMonthFirstDate\(body\.effectiveFrom\)/);
  assert.match(contractsRoute, /INVALID_FIXED_MONTHLY_EFFECTIVE_DATE/);
  assert.ok(contractsRoute.indexOf("INVALID_FIXED_MONTHLY_EFFECTIVE_DATE") < contractsRoute.indexOf('rpc("payroll_create_contract_version_v6"'));
});

test("/api/admin/payroll/users exposes attendanceTrackingEnabled so the settings UI can compute requiresFixedMonthlyContract client-side", () => {
  assert.match(usersRoute, /attendance_tracking_enabled/);
  assert.match(usersRoute, /attendanceTrackingEnabled: user\.attendance_tracking_enabled !== false/);
});

test("correction API applies the exact same fixed-monthly-target policy (role or attendance_tracking_enabled=false) and calls the schedule-aware private v4-correct RPC", () => {
  assert.match(correctRoute, /select\("id,role,is_active,attendance_tracking_enabled"\)/);
  assert.match(correctRoute, /from "@\/lib\/payroll\/eligibility"/);
  assert.match(correctRoute, /targetUsesFixedMonthly = requiresFixedMonthlyContract\(target\.role, target\.attendance_tracking_enabled\)/);
  assert.match(correctRoute, /!targetUsesFixedMonthly && body\.calculationBasis === "fixed_monthly"/);
  assert.match(correctRoute, /targetUsesFixedMonthly && !isMonthFirstDate\(body\.effectiveFrom\)/);
  assert.match(correctRoute, /payroll_correct_latest_unused_contract_v4/);
  assert.doesNotMatch(correctRoute, /payroll_correct_latest_unused_contract_v3|payroll_correct_latest_unused_contract_v2/);
});

test("fixed monthly payroll creates one month item before attendance processing", () => {
  assert.match(fixed, /contract\.baseSalary \+ contract\.fixedRaiseAmount \+ levelRaiseAmount/);
  assert.match(monthly, /fixedContractMatches/);
  assert.match(monthly, /item\("base_work","addition",fixed\.amount,null,"월 고정급여 \/ Lương cố định hàng tháng"/);
  assert.match(monthly, /calculationBasis:"fixed_monthly"/);
  assert.match(monthly, /levelSnapshot:fixed\?\.levelSnapshot/);
  assert.match(monthly, /days:\[\]/);
  assert.ok(monthly.indexOf("fixedContractMatches") < monthly.indexOf("for(const date of eligibleDates)"));
  const fixedBranch = monthly.slice(monthly.indexOf("if(calculationDate&&fixedContractMatches.length===1)"), monthly.indexOf("for(const date of eligibleDates)"));
  assert.doesNotMatch(fixedBranch, /normalizeAttendanceDayFacts|scheduleMatches|calculateLatePenalty|applyPayrollWorkPolicy/);
  assert.match(fixedBranch, /insurance_employee_deduction/);
});

test("fixed monthly migration extends only the basis check and adds a locked v3 wrapper", () => {
  assert.match(migration, /'fixed_monthly'/);
  assert.match(migration, /payroll_create_contract_version_v3/);
  assert.match(migration, /v_position = 'owner'/);
  assert.match(migration, /fixed_monthly_owner_only/);
  assert.match(migration, /security definer set search_path = public/);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/);
  assert.doesNotMatch(migration, /update public\.payroll_contract_versions|delete from public\.payroll_contract_versions/);
});
