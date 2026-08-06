import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const payrollPage = read("app/(protected)/admin/payroll/page.tsx");
const settingsPage = read("app/(protected)/admin/payroll/settings/page.tsx");
const commonSettings = read("components/payroll/PayrollCommonSettings.tsx");
const employeeMealSettings = read("components/payroll/EmployeeMealAllowanceSettings.tsx");
const overviewText = read("lib/text/payroll-overview.ts");

// ---------------------------------------------------------------------------
// 급여관리 비용표
// ---------------------------------------------------------------------------

test("cost table: meal allowance row is placed inside companyGroup (회사지출), before employerInsurance (회사 보험부담)", () => {
  const companyGroupIndex = payrollPage.indexOf('<CostGroup title={table.companyGroup}/>');
  const mealRowIndex = payrollPage.indexOf('<CostRow label={table.mealAllowance}');
  const employerInsuranceRowIndex = payrollPage.indexOf('<CostRow label={table.employerInsurance}');
  assert.ok(companyGroupIndex > -1 && mealRowIndex > -1 && employerInsuranceRowIndex > -1);
  assert.ok(companyGroupIndex < mealRowIndex, "meal row must come after the 회사지출 group header");
  assert.ok(mealRowIndex < employerInsuranceRowIndex, "meal row must come before 회사 보험부담");
});

test("cost table: meal allowance row reads mealAllowanceAmount for both current and projected columns", () => {
  assert.match(
    payrollPage,
    /<CostRow label=\{table\.mealAllowance\} fullLabel=\{t\.mealAllowance\} current=\{amount\(current,"mealAllowanceAmount"\)\} projected=\{amount\(projected,"mealAllowanceAmount"\)\}\/>/,
  );
});

test("cost table: totalCompanyCostAmount row (총인건비) is unchanged in the UI — the meal allowance is baked into the value server-side, not re-added in JSX", () => {
  assert.match(
    payrollPage,
    /<CostRow label=\{table\.companyCost\} fullLabel=\{t\.companyCost\} current=\{amount\(current,"totalCompanyCostAmount"\)\} projected=\{amount\(projected,"totalCompanyCostAmount"\)\} emphasis="total"\/>/,
  );
});

test("cost table: InsuranceSummary and the projected summary type both declare mealAllowanceAmount", () => {
  assert.match(payrollPage, /type InsuranceSummary = \{[^}]*mealAllowanceAmount:number[^}]*\}/);
  assert.match(payrollPage, /type ProjectedSummaryWithMeal = PayrollOverviewProjectedSummary & \{ mealAllowanceAmount:number \}/);
});

test("cost table: a policy-missing warning banner is rendered conditionally, driven by a server-provided flag (not guessed client-side)", () => {
  assert.match(payrollPage, /mealAllowancePolicyMissing\?<small role="alert"/);
  assert.match(payrollPage, /mealAllowancePolicyMissing:boolean/);
});

test("cost table: help text row explains the current/projected methodology and never claims actual cash payment status", () => {
  assert.match(overviewText, /mealAllowanceProjectionHelp:"현재 식대비용은 실제 출근일을 기준으로 계산합니다\./);
  assert.match(overviewText, /mealAllowanceProjectionHelp:"Chi phí ăn hiện tại được tính theo ngày đi làm thực tế\./);
  assert.doesNotMatch(overviewText, /식대 지급 완료|지급된 식대|식대 실지급액/);
  assert.doesNotMatch(overviewText, /đã được chi trả xong|trợ cấp đã trả/);
});

// ---------------------------------------------------------------------------
// 급여 공통설정 — 식대(1일 기본 식대·적용일)가 PayrollCommonSettings 내부로 통합되고,
// 저장 버튼이 "공통 설정 저장" 하나로 단일화된 구조를 검증한다.
// ---------------------------------------------------------------------------

test("common settings: there is no separate MealAllowancePolicySettings component and no separate 식대 설정 저장 button — everything lives in the single exported component", () => {
  assert.doesNotMatch(commonSettings, /function MealAllowancePolicySettings/);
  assert.doesNotMatch(commonSettings, /Lưu trợ cấp ăn|식대 설정 저장/);
  // "공통 설정 저장"/"Lưu cài đặt chung" 버튼 텍스트는 정확히 한 번만 등장해야 한다(버튼 단일화).
  assert.equal((commonSettings.match(/공통 설정 저장/g) ?? []).length, 1);
  assert.equal((commonSettings.match(/Lưu cài đặt chung/g) ?? []).length, 1);
});

test("common settings: the 🍚 식대 group is inside the exported component's own JSX (not a child component), positioned after 패널티", () => {
  const penaltyGroupIndex = commonSettings.indexOf('title={`⚠️ ${vi ? "Phạt" : "패널티"}`}');
  const mealGroupIndex = commonSettings.indexOf('title={`🍚 ${vi ? "Trợ cấp ăn" : "식대"}`}');
  const buttonIndex = commonSettings.indexOf('disabled={!dirty || !valid || saving}');
  assert.ok(penaltyGroupIndex > -1 && mealGroupIndex > -1 && buttonIndex > -1);
  assert.ok(penaltyGroupIndex < mealGroupIndex, "식대 group must come after 패널티");
  assert.ok(mealGroupIndex < buttonIndex, "식대 group must come before the single save button");
});

test("common settings: unset policy is shown as 미설정/Chưa thiết lập, not a guessed default amount", () => {
  assert.match(commonSettings, /vi\s*\?\s*"Chưa thiết lập"\s*\n?\s*:\s*"미설정"/);
});

test("common settings: meal daily amount input reuses the existing formatIntegerInput/integerInputDigits helpers (VND, thousands-comma, no decimals)", () => {
  assert.match(commonSettings, /formatIntegerInput\(mealAmountDraft\)/);
  assert.match(commonSettings, /setMealAmountDraft\(integerInputDigits\(event\.target\.value\)\)/);
});

test("common settings: one PUT request saves payroll_settings and meal policy together — no sequential PATCH-then-POST client calls", () => {
  assert.match(commonSettings, /method: "PUT"/);
  assert.match(commonSettings, /mealDailyAmount: mealBothFilled \? mealAmountNumber : null/);
  assert.match(commonSettings, /mealEffectiveFrom: mealBothFilled \? mealEffectiveFromDraft : null/);
  // save() 안에 별도의 두 번째 fetch(POST /meal-allowance/policy)가 없어야 한다(순차 호출 금지).
  const saveFn = commonSettings.slice(commonSettings.indexOf("async function save()"), commonSettings.indexOf("return (\n    <section style={s.card}>"));
  assert.equal((saveFn.match(/fetch\(/g) ?? []).length, 1, "save()는 fetch를 정확히 한 번만 호출해야 한다");
  assert.doesNotMatch(saveFn, /method: "POST"/);
  assert.doesNotMatch(saveFn, /method: "PATCH"/);
});

test("common settings: save button is disabled while saving (duplicate-save prevention) and reloads (재조회) both settings and meal policy after a successful save", () => {
  assert.match(commonSettings, /disabled=\{!dirty \|\| !valid \|\| saving\}/);
  const saveFn = commonSettings.slice(commonSettings.indexOf("async function save()"), commonSettings.indexOf("return (\n    <section style={s.card}>"));
  assert.match(saveFn, /await load\(\);/);
});

test("common settings: failure keeps the draft untouched and shows exactly one error message (no duplicate alert)", () => {
  const saveFn = commonSettings.slice(commonSettings.indexOf("async function save()"), commonSettings.indexOf("return (\n    <section style={s.card}>"));
  assert.match(saveFn, /if \(!response\.ok\) \{/);
  const failureBranch = saveFn.slice(saveFn.indexOf("if (!response.ok) {"), saveFn.indexOf("// 성공"));
  assert.doesNotMatch(failureBranch, /setDraft\(|setMealAmountDraft\(|setMealEffectiveFromDraft\(/);
  assert.match(failureBranch, /setError\("save"\)/);
  // 성공 메시지(message state)는 실패 분기에서 설정되지 않는다 — 오류·성공 메시지가 동시에 뜨지 않음.
  assert.doesNotMatch(failureBranch, /setMessage\(/);
});

test("common settings: mismatched meal amount/date (only one filled) blocks the whole save via mealValid, with an inline bilingual warning", () => {
  assert.match(commonSettings, /const mealPairValid = mealBothBlank \|\| mealBothFilled;/);
  assert.match(commonSettings, /const valid = payload !== null && mealValid;/);
  assert.match(commonSettings, /금액과 적용일을 함께 입력하거나, 둘 다 비워두세요\./);
  assert.match(commonSettings, /Vui lòng nhập cả số tiền và ngày áp dụng, hoặc để trống cả hai\./);
});

test("common settings: history/version list is still rendered via the same <details> pattern already used by insurance settings", () => {
  const mealGroup = commonSettings.slice(
    commonSettings.indexOf('title={`🍚 ${vi ? "Trợ cấp ăn" : "식대"}`}'),
    commonSettings.indexOf("{error ? <p role=\"alert\""),
  );
  assert.match(mealGroup, /<details style=\{s\.details\}>/);
});

// ---------------------------------------------------------------------------
// 직원별 식대 대상 설정
// ---------------------------------------------------------------------------

test("settings page: EmployeeMealAllowanceSettings is wired in for every selected employee, independent of the insurance mjk special-case branch", () => {
  assert.match(settingsPage, /import EmployeeMealAllowanceSettings from "@\/components\/payroll\/EmployeeMealAllowanceSettings";/);
  const afterInsuranceBranch = settingsPage.slice(settingsPage.indexOf("selected.username !== \"mjk\" ?"));
  assert.match(afterInsuranceBranch, /<EmployeeMealAllowanceSettings key=\{`meal-allowance-\$\{selected\.id\}`\} userId=\{selected\.id\} vi=\{vi\} \/>/);
});

test("employee meal settings: eligibility select is disabled for attendance-tracking-disabled employees, with a visible reason", () => {
  assert.match(employeeMealSettings, /disabled=\{disabledByAttendanceTracking && !isEligible\}/);
  assert.match(employeeMealSettings, /option value="eligible" disabled=\{disabledByAttendanceTracking\}/);
  assert.match(employeeMealSettings, /근태 기록을 사용하지 않아 식대 대상으로 설정할 수 없습니다/);
});

test("employee meal settings: standard_workdays and projected meal allowance are shown read-only, and a missing-setup case shows 월 근무일수 설정 필요 without blocking anything (no disabled prop tied to it)", () => {
  assert.match(employeeMealSettings, /한 달 기준 근무일수/);
  assert.match(employeeMealSettings, /월 근무일수 설정 필요/);
  assert.match(employeeMealSettings, /1일 기본 식대 미설정/);
});

test("employee meal settings: shows the exact bilingual MEAL_ALLOWANCE_REQUIRES_ATTENDANCE_TRACKING message on the documented server error code", () => {
  assert.match(employeeMealSettings, /blockedCode === "MEAL_ALLOWANCE_REQUIRES_ATTENDANCE_TRACKING"/);
  assert.match(employeeMealSettings, /식대비용은 실제 출근 기록을 기준으로 계산하므로 근태 기록 사용이 필요합니다\./);
  assert.match(employeeMealSettings, /Chi phí ăn được tính theo dữ liệu chấm công thực tế, vì vậy nhân viên phải sử dụng chấm công\./);
});

test("employee meal settings: never claims actual cash payment status", () => {
  assert.doesNotMatch(employeeMealSettings, /식대 지급 완료|지급된 식대|식대 실지급액/);
});

// ---------------------------------------------------------------------------
// 모바일 폭 넘침 방지 — 기존 프로젝트의 minWidth:0 / boxSizing:border-box 패턴 재사용
// ---------------------------------------------------------------------------

test("mobile safety: meal allowance UI blocks reuse minWidth:0 / boxSizing:border-box on their card/input containers, matching the rest of the payroll UI", () => {
  assert.match(commonSettings, /dateInput: \{ boxSizing: "border-box", width: "100%", minWidth: 0/);
  assert.match(commonSettings, /group: \{ padding: "10px 11px", border: "1px solid #e5e7eb", borderRadius: 11, background: "#f8fafc", minWidth: 0 \}/);
  assert.match(employeeMealSettings, /input: \{ width: "100%", minWidth: 0, boxSizing: "border-box"/);
  assert.match(employeeMealSettings, /select: \{ minWidth: 0/);
});
