import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");
const migration = read("supabase/migrations/20260908115312_add_payroll_tax_versions.sql");
const directorMigration = read("supabase/migrations/20260911102823_add_director_insurance_tax_mapping.sql");
const overview = read("lib/payroll/overview.ts");
const overviewServer = read("lib/payroll/overview-server.ts");
const projection = read("lib/payroll/overview-projection.ts");
const monthlyRun = read("lib/payroll/monthly-run.ts");
const insurance = read("lib/payroll/insurance.ts");
const snapshot = read("lib/payroll/payment-snapshot.ts");
const payments = read("app/api/admin/payroll/payments/route.ts");
const profileApi = read("app/api/admin/payroll/tax-settings/route.ts");
const policyApi = read("app/api/admin/payroll/tax-policy/route.ts");
const card = read("components/payroll/CompensationCard.tsx");
const settings = read("components/payroll/EmployeeTaxSettings.tsx");
const attendance = read("app/(protected)/attendance/page.tsx");

test("migration is append-only, versioned, private, transaction-safe, and seed-free", () => {
  assert.match(migration, /^begin;/);
  assert.match(migration, /commit;\s*$/);
  assert.match(migration, /create table public\.payroll_tax_policy_versions/);
  assert.match(migration, /create table public\.payroll_tax_setting_versions/);
  assert.match(migration, /unique \(user_id, revision\)/);
  assert.match(migration, /enable row level security/g);
  assert.match(migration, /grant select, insert on table public\.payroll_tax_policy_versions, public\.payroll_tax_setting_versions to service_role/);
  assert.doesNotMatch(migration, /grant[^;]*(update|delete)[^;]*payroll_tax_(?:policy|setting)_versions/i);
  assert.doesNotMatch(migration, /\bdo\s+\$\$/i);
  assert.doesNotMatch(migration, /KIM MIN JAE|Vương|15500000|6200000/);
});

test("database validates brackets and protects policy/profile versions after payment", () => {
  assert.match(migration, /payroll_validate_tax_brackets_v1/);
  assert.match(migration, /v_lower <> v_expected_lower/);
  assert.match(migration, /v_index = v_count - 1[\s\S]*upperBoundAmount'[\s\S]*'null'::jsonb/);
  assert.match(migration, /v_rate < 0 or v_rate >= 10000/);
  assert.match(migration, /PAYROLL_TAX_POLICY_LOCKED_FOR_PAID_MONTH/);
  assert.match(migration, /PAYROLL_TAX_SETTING_LOCKED_FOR_PAID_EMPLOYEE/);
  assert.match(migration, /before insert or update on public\.payroll_tax_policy_versions/);
  assert.match(migration, /before insert or update on public\.payroll_tax_setting_versions/);
});

test("tax mutations reuse owner/master authorization and private security-definer RPCs", () => {
  for (const api of [profileApi, policyApi]) assert.match(api, /requirePayrollActor\(\)/);
  assert.match(migration, /perform public\.payroll_assert_actor_v2\(p_actor_user_id\)/g);
  assert.match(migration, /security definer\s*set search_path=pg_catalog, public/g);
  assert.match(migration, /revoke all on function public\.payroll_create_tax_setting_version_v1[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.payroll_create_tax_setting_version_v1[\s\S]*to service_role/);
});

test("overview and projection share the Bảng J-based taxable compensation formula", () => {
  assert.match(overviewServer, /loadPayrollTaxVersions\(month,options\?\.userId\)/);
  assert.match(overview, /calculateAccountingTaxableCompensationAmount\(\{preInsurancePayoutAmount,taxExemptCompensationAmount,companyPaidInsuranceTaxableAmount\}\)/);
  assert.match(overview, /employeePitDeductionAmount:tax\.employeePitDeductionAmount/);
  assert.match(overview, /entry\.direction==="addition"&&entry\.taxTreatment==="tax_exempt_compensation"/);
  assert.match(monthlyRun, /payrollTaxTreatmentForItem\(category,direction,normalizedAmount,sourceSnapshot\)/);
  assert.match(monthlyRun, /unearnedCompensationAmount:vnd\(rate\.dayRate\)/);
  assert.match(overviewServer, /category:"attendance_bonus"[\s\S]*taxTreatment:"taxable_compensation"/);
  assert.match(projection, /calculateEmployeePit\(\{/);
  assert.match(projection, /calculateAccountingTaxableCompensationAmount\(\{/);
  assert.match(projection, /taxExemptCompensationAmount: employee\.amounts\.taxExemptCompensationAmount/);
  assert.match(projection, /companyPaidInsuranceTaxableAmount: employee\.amounts\.companyPaidInsuranceTaxableAmount/);
  assert.match(projection, /employeePitDeductionAmounts/);
  assert.match(projection, /companyPitAmounts/);
});

test("director insurance mapping migration is mirrored locally without touching payment history", () => {
  assert.match(directorMigration, /director_insurance_user_id bigint/);
  assert.match(directorMigration, /director_employee_insurance_rate_bp smallint not null default 0/);
  assert.match(directorMigration, /director_insurance_user_id = 2/);
  assert.match(directorMigration, /director_employee_insurance_rate_bp = 950/);
  assert.match(directorMigration, /foreign key \(director_insurance_user_id\)[\s\S]*references public\.users\(id\)[\s\S]*on delete restrict/);
  assert.doesNotMatch(directorMigration, /payroll_employee_payments|payroll_payment_batches/);
});

test("director mapping and employee rate are captured in calculation source and hash inputs", () => {
  assert.match(monthlyRun, /director_insurance_user_id/);
  assert.match(monthlyRun, /director_employee_insurance_rate_bp/);
  assert.match(monthlyRun, /userId:insuranceGlobal\.directorUserId/);
  assert.match(monthlyRun, /employeeRateBp:insuranceGlobal\.directorEmployeeRateBp/);
  assert.match(monthlyRun, /companyPaidInsuranceTaxableAmount:calculateDirectorEmployeeInsurance/);
  assert.match(insurance, /userId === global\.directorUserId/);
  assert.doesNotMatch(insurance, /KIM|Vuong|Vương|owner/);
  assert.match(snapshot, /insuranceSnapshot:raw\.insuranceSnapshot/);
  assert.match(snapshot, /sourceSnapshot/);
});

test("payment snapshot/hash and v2 payment totals carry every tax input and final net", () => {
  assert.match(snapshot, /taxSnapshot:employee\.tax/);
  assert.match(snapshot, /return \{employee,/);
  assert.match(payments, /payrollPaymentSnapshotHash\(calculationSnapshot\)/);
  assert.match(payments, /p_calculated_net_amount:employee\.amounts\.netPayoutAmount/);
  assert.match(payments, /payroll_pay_employee_v2/);
  assert.match(migration, /employee_pit_total/);
  assert.match(migration, /company_pit_total/);
  assert.match(migration, /calculation_snapshot #>> '\{employee,tax,employeePitDeductionAmount\}'/);
  assert.match(migration, /x\.actual \+ x\.employee_insurance \+ x\.employee_pit \+ x\.advance/);
});

test("admin and attendance expose exact Korean/Vietnamese PIT labels without identity mutation", () => {
  for (const phrase of ["개인소득세(TNCN)", "과세소득", "본인공제", "부양가족", "직원 공제", "회사 부담", "회계 명의", "Thuế TNCN", "Thu nhập tính thuế", "Giảm trừ bản thân", "Số người phụ thuộc", "Nhân viên chịu", "Công ty chịu", "Tên kế toán"]) assert.ok(card.includes(phrase), phrase);
  for (const phrase of ["TNCN 적용 여부", "부양가족 수", "부담 방식", "세금 보험공제 방식", "회계/TNCN 명의", "적용 시작월", "Áp dụng TNCN", "Số người phụ thuộc", "Tên kế toán/TNCN"]) assert.ok(settings.includes(phrase), phrase);
  assert.match(settings, /employeeName/);
  assert.match(settings, /accountingName/);
  assert.doesNotMatch(settings, /users\.(?:name|username)|update\(/);
  assert.ok(attendance.includes("TNCN 예상 공제"));
  assert.ok(attendance.includes("TNCN 회사 부담"));
  assert.ok(attendance.includes("Khấu trừ TNCN dự kiến"));
  assert.ok(attendance.includes("TNCN công ty chịu"));
});

test("admin PIT UI hides not-applicable tax and keeps only taxable income plus the actual burden on the default calculated view", () => {
  assert.match(card, /employee\.tax\.status === "requires_review" \|\| employee\.tax\.taxMode === "resident_progressive"/);
  assert.doesNotMatch(card, /taxText\.(?:mode|notApplicable|resident)/);
  assert.match(card, /taxText\.taxableIncome[\s\S]*employee\.tax\.taxableIncomeAmount/);
  assert.match(card, /employee\.tax\.taxBurdenMode === "company_bears" \? taxText\.company : taxText\.employee/);
  assert.match(card, /employee\.tax\.taxBurdenMode === "company_bears" \? employee\.tax\.companyPitAmount : employee\.tax\.employeePitDeductionAmount/);
});

test("admin PIT UI keeps review warnings visible and moves secondary calculated fields into bilingual details", () => {
  assert.match(card, /employee\.tax\.status === "requires_review" \? <>\s*<p role="alert"/);
  assert.match(card, /employee\.tax\.warningCodes\.join\(", "\)/);
  assert.match(card, /\/admin\/payroll\/settings\?tab=employee&userId=/);
  assert.match(card, /<details style=\{s\.taxDetails\}>/);
  assert.match(card, /계산 상세/);
  assert.match(card, /Chi tiết tính thuế/);
  for (const field of ["dependentCount", "personalDeductionAmount", "dependentDeductionAmount", "deductibleInsuranceAmount", "taxableCompensationAmount", "accountingName", "taxPolicyRevision"]) assert.ok(card.includes(`employee.tax.${field}`), field);
});
