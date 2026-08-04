import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const route = read("app/api/admin/payroll/overview/route.ts");
const overviewServer = read("lib/payroll/overview-server.ts");
const overview = read("lib/payroll/overview.ts");
const monthly = read("lib/payroll/monthly-run.ts");
const page = read("app/(protected)/admin/payroll/page.tsx");
const admin = read("app/(protected)/admin/page.tsx");
const compensation = read("lib/payroll/compensation.ts");
const compensationCard = read("components/payroll/CompensationCard.tsx");

test("admin payroll card opens attendance while payroll remains a real page", () => {
  assert.match(admin, /href: "\/admin\/payroll\/attendance"/);
  assert.doesNotMatch(page, /redirect\(|router\.replace\("\/admin\/payroll\/attendance/);
});

test("overview is one owner-master authenticated monthly endpoint", () => {
  assert.match(route, /requirePayrollActor\(\)/);
  assert.match(route, /validPayrollMonth/);
  assert.match(route, /code: "INVALID_MONTH"[\s\S]*400/);
  assert.match(page, /fetch\(`\/api\/admin\/payroll\/overview\?month=\$\{month\}`/);
  assert.doesNotMatch(page, /payroll\/shadow\?userId/);
});

test("official batch engine receives the overview cutoff without mutating a payroll run", () => {
  assert.match(overviewServer, /loadPayrollMonthSnapshot\(month,\{calculationEndDate:period\.calculationEndDate\}\)/);
  assert.match(monthly, /calculatePayrollBatch\(input\)/);
  assert.doesNotMatch(route, /payroll_create_run|\.rpc\(/);
});

test("contract base salary is distinct from accrued base-work items", () => {
  assert.match(overview, /contractBaseSalary: contract\?\.baseSalary \?\? null/);
  assert.match(overview, /accruedWorkAmount = sum\(items, "base_work", "addition"\)/);
  assert.doesNotMatch(overview, /contractBaseSalary:\s*accruedWorkAmount/);
});

test("missing contracts and future months never masquerade as zero salary", () => {
  assert.match(overview, /const unavailable = period\.future \|\| !contract \|\| compensation\?\.combinedSalary===null/);
  assert.match(overview, /currentAmount: unavailable \? null : netPayoutAmount/);
  assert.match(
    compensationCard,
    /!employee\.contract\s*\?\s*t\.contractUnset/,
  );
});

test("level raise comes only from employee-management level data", () => {
  assert.doesNotMatch(monthly, /level_raise_included_count|levelRaiseIncludedCount/);
  assert.doesNotMatch(compensation, /level_raise_included_count|levelRaiseIncludedCount/);
  assert.match(compensation, /levelInfo\.earnedRaiseCount \* levelInfo\.raiseAmountPerStep/);
  assert.match(overview, /accruedRaiseAmount: compensation\?\.levelRaiseAmount \?\? null/);
  assert.doesNotMatch(overview, /cumulativeRaiseAmount/);
});

test("UI keeps grouped compact cards, non-owner part totals, details, and ledger last", () => {
  assert.match(page, /getPartKey\(employee\.part\)/);
  assert.match(page, /employees\.sort\(comparePayrollEmployees\)/);
  assert.match(page, /sortPayrollEmployeesByHeaderAmount\(employees\.sort\(comparePayrollEmployees\),overview\?\.future===true\)/);
  assert.match(
    compensationCard,
    /gridTemplateColumns:\s*"minmax\(0,1fr\) auto 12px"/,
  );
  assert.match(page, /group\.part!=="owner"/);
  assert.match(page, /<CombinedPartTotal employees=\{group\.employees\}/);
  assert.match(page, /<CompensationCard/);
  assert.ok(page.indexOf("<PaymentBatchCard") > page.indexOf("<CombinedPartTotal"));
});

test("employee detail groups salary, month application, insurance, and adjustment controls", () => {
  assert.match(compensationCard, /salaryComposition: "급여 구성"/);
  assert.match(compensationCard, /monthApplication: "이번 달 반영"/);
  assert.match(compensationCard, /insuranceAndNet: "보험 및 최종 지급"/);
  assert.match(compensationCard, /salaryComposition: "Cấu thành lương"/);
  assert.match(compensationCard, /monthApplication: "Áp dụng tháng này"/);
  assert.match(compensationCard, /insuranceAndNet: "Bảo hiểm và thực nhận"/);
  assert.match(compensationCard, /finalPayout: "최종 지급액"/);
  assert.match(compensationCard, /finalPayout: "Thực nhận"/);
  assert.match(compensationCard, /preInsurancePayoutWithInsurance: "보험 공제 전 금액"/);
  assert.match(compensationCard, /preInsurancePayoutWithInsurance: "Thu nhập trước khấu trừ bảo hiểm"/);
  assert.match(compensationCard, /paddingLeft: 10/);
  assert.match(compensationCard, /fontVariantNumeric: "tabular-nums"/);
  assert.match(compensationCard, /highlight=\{employee\.insuranceEnrolled \? "subtotal" : "net"\}/);
  assert.match(compensationCard, /formatContractRate\(employee\.amounts\.contractSalary/);
  assert.match(compensationCard, /monthlyEquivalent: "월급여 환산"/);
  assert.match(compensationCard, /monthlyEquivalent: "Quy đổi lương tháng"/);
  assert.match(compensationCard, /employee\.contract\.payType === "hourly" \? employee\.amounts\.contractMonthlyEquivalent : null/);
  assert.match(compensationCard, /formatVnd\(monthlyEquivalent\)/);
  assert.match(compensationCard, /expanded \? s\.expandedCard/);
  assert.match(compensationCard, /type="button"[\s\S]*adjustmentButton/);
});

test("overview exposes resolved insurance enrollment and source recognized minutes", () => {
  assert.match(overview, /recognizedMinutes: employee\.recognizedMinutes/);
  assert.match(overview, /contractMonthlyEquivalent: contract && compensation && compensation\.combinedSalary !== null/);
  assert.match(overview, /insuranceEnrolled: employee\.insuranceSnapshot\.isEnrolled/);
  assert.doesNotMatch(compensationCard, /insuranceEnrolled\s*=.*(?:insuranceBaseAmount|InsuranceDeductionAmount|employerInsuranceAmount)/);
  assert.match(compensationCard, /employee\.insuranceEnrolled && <DetailSection icon="🛡️"/);
  assert.match(compensationCard, /!employee\.insuranceEnrolled && employee\.unresolvedAttendanceCount/);
});

test("Korean and Vietnamese payroll overview labels are centralized", () => {
  const labels = read("lib/text/payroll-overview.ts");
  for (const key of ["currentAmount","contractSalary","fixedRaise","combinedSalary","accruedWork","levelRaise","incentive","penalty","paidLeave","overtime","latePenalty","earlyLeavePenalty","otherAddition","otherDeduction","currentTotal","requiresReview","beforeCalculationPeriod","levelBaseRequired","unresolvedAttendance"]) {
    assert.equal((labels.match(new RegExp(`${key}:`, "g")) || []).length, 2, key);
  }
});
