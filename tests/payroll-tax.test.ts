import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
// @ts-expect-error Node test execution requires the explicit TypeScript extension.
import { calculateEmployeePit, calculateProgressivePit, calculateTaxableCompensationAmount, grossUpNetTaxableIncome, payrollTaxReviewCodeForItem, payrollTaxTreatmentForItem, selectEmployeeTaxSetting, selectTaxPolicy, validateTaxBrackets } from "../lib/payroll/tax.ts";
// @ts-expect-error Node test execution requires the explicit TypeScript extension.
import { calculatePayrollPayoutAmounts } from "../lib/payroll/adjustments.ts";
// @ts-expect-error Node test execution requires the explicit TypeScript extension.
import { calculatePayrollInsuranceTotals } from "../lib/payroll/insurance.ts";
// @ts-expect-error Node test execution requires the explicit TypeScript extension.
import { calculatePayrollRates } from "../lib/payroll/work-policy.ts";

const brackets = [
  { lowerBoundAmount: 0, upperBoundAmount: 10_000_000, rateBp: 500 },
  { lowerBoundAmount: 10_000_000, upperBoundAmount: 30_000_000, rateBp: 1_000 },
  { lowerBoundAmount: 30_000_000, upperBoundAmount: 60_000_000, rateBp: 2_000 },
  { lowerBoundAmount: 60_000_000, upperBoundAmount: 100_000_000, rateBp: 3_000 },
  { lowerBoundAmount: 100_000_000, upperBoundAmount: null, rateBp: 3_500 },
] as const;

const policy = {
  id: 109,
  effectiveMonth: "2026-01-01",
  personalDeductionAmount: 15_500_000,
  dependentDeductionAmount: 6_200_000,
  brackets: [...brackets],
  revision: 3,
  createdBy: 1,
  createdAt: "2026-01-01T00:00:00Z",
  note: "2026 fixture",
};

function profile(overrides: Partial<Parameters<typeof calculateEmployeePit>[0]["profile"] & {}> = {}) {
  return {
    id: 20,
    userId: 7,
    effectiveMonth: "2026-01-01",
    taxMode: "resident_progressive" as const,
    dependentCount: 0,
    burdenMode: "employee_deducted" as const,
    accountingName: "Employee Seven",
    insuranceDeductionMode: "payroll" as const,
    manualInsuranceDeductionAmount: 0,
    revision: 2,
    createdBy: 1,
    createdAt: "2026-01-01T00:00:00Z",
    note: null,
    ...overrides,
  };
}

function pit(input: { compensation: number; insurance?: number; profile?: ReturnType<typeof profile> }) {
  return calculateEmployeePit({
    taxableCompensationAmount: input.compensation,
    employeeInsuranceDeductionAmount: input.insurance ?? 0,
    policy,
    profile: input.profile ?? profile(),
  });
}

test("2026 resident progressive engine calculates every statutory example", () => {
  assert.equal(calculateProgressivePit(0, brackets), 0);
  assert.equal(calculateProgressivePit(10_000_000, brackets), 500_000);
  assert.equal(calculateProgressivePit(20_000_000, brackets), 1_500_000);
  assert.equal(calculateProgressivePit(40_000_000, brackets), 4_500_000);
  assert.equal(calculateProgressivePit(80_000_000, brackets), 14_500_000);
  assert.equal(calculateProgressivePit(120_000_000, brackets), 27_500_000);
});

test("all progressive boundaries use integer half-up VND rounding", () => {
  const cases = [
    [9_999_999, 500_000], [10_000_000, 500_000], [10_000_001, 500_000],
    [30_000_000, 2_500_000], [30_000_001, 2_500_000],
    [60_000_000, 8_500_000], [60_000_001, 8_500_000],
    [100_000_000, 20_500_000], [100_000_001, 20_500_000],
  ] as const;
  for (const [income, expected] of cases) assert.equal(calculateProgressivePit(income, brackets), expected, String(income));
  assert.equal(calculateProgressivePit(9, brackets), 0);
  assert.equal(calculateProgressivePit(10, brackets), 1);
  assert.equal(calculateProgressivePit(-1, brackets), 0);
  assert.throws(() => calculateProgressivePit(1.5, brackets), /INVALID_TAXABLE_INCOME/);
});

test("bracket validation rejects gaps, overlaps, decimals, invalid rates, and closed final brackets", () => {
  assert.equal(validateTaxBrackets(brackets), true);
  assert.equal(validateTaxBrackets([{ lowerBoundAmount: 1, upperBoundAmount: null, rateBp: 500 }]), false);
  assert.equal(validateTaxBrackets([{ lowerBoundAmount: 0, upperBoundAmount: 10, rateBp: 500 }, { lowerBoundAmount: 11, upperBoundAmount: null, rateBp: 1_000 }]), false);
  assert.equal(validateTaxBrackets([{ lowerBoundAmount: 0, upperBoundAmount: 10, rateBp: 500 }, { lowerBoundAmount: 9, upperBoundAmount: null, rateBp: 1_000 }]), false);
  assert.equal(validateTaxBrackets([{ lowerBoundAmount: 0, upperBoundAmount: null, rateBp: 10_000 }]), false);
  assert.equal(validateTaxBrackets([{ lowerBoundAmount: 0.5, upperBoundAmount: null, rateBp: 500 }]), false);
  assert.equal(validateTaxBrackets([{ lowerBoundAmount: 0, upperBoundAmount: 10, rateBp: 500 }]), false);
});

test("personal, dependent, and tax-only insurance deductions remain separate", () => {
  assert.equal(pit({ compensation: 30_000_000 }).taxableIncomeAmount, 14_500_000);
  assert.equal(pit({ compensation: 30_000_000, profile: profile({ dependentCount: 1 }) }).taxableIncomeAmount, 8_300_000);
  assert.equal(pit({ compensation: 30_000_000, profile: profile({ dependentCount: 2 }) }).taxableIncomeAmount, 2_100_000);
  assert.equal(pit({ compensation: 30_000_000, profile: profile({ insuranceDeductionMode: "none" }) }).deductibleInsuranceAmount, 0);
  assert.equal(pit({ compensation: 30_000_000, insurance: 1_050_000 }).deductibleInsuranceAmount, 1_050_000);
  const manual = pit({ compensation: 30_000_000, insurance: 1_050_000, profile: profile({ insuranceDeductionMode: "manual", manualInsuranceDeductionAmount: 900_000, note: "tax-only insurance" }) });
  assert.equal(manual.deductibleInsuranceAmount, 900_000);
});

test("employee deducted PIT enters final net after insurance and before advance reconciliation", () => {
  const tax = pit({ compensation: 40_000_000, insurance: 1_000_000 });
  assert.equal(tax.taxableIncomeAmount, 23_500_000);
  assert.equal(tax.employeePitDeductionAmount, 1_850_000);
  const payout = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: 40_000_000, manualIncentiveAmount: 0, manualPenaltyAmount: 0, employeeInsuranceDeductionAmount: 1_000_000, employeePitDeductionAmount: tax.employeePitDeductionAmount, advanceAmount: 2_000_000 });
  assert.equal(payout.preInsurancePayoutAmount, 40_000_000);
  assert.equal(payout.netPayoutAmount, 35_150_000);
});

test("advance never changes taxable income or PIT, only final payout", () => {
  const tax = pit({ compensation: 25_675_300, insurance: 525_000 });
  const withoutAdvance = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: 25_000_000, manualIncentiveAmount: 675_300, manualPenaltyAmount: 0, employeeInsuranceDeductionAmount: 525_000, employeePitDeductionAmount: tax.employeePitDeductionAmount, advanceAmount: 0 });
  const withAdvance = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: 25_000_000, manualIncentiveAmount: 675_300, manualPenaltyAmount: 0, employeeInsuranceDeductionAmount: 525_000, employeePitDeductionAmount: tax.employeePitDeductionAmount, advanceAmount: 2_000_000 });
  assert.equal(withoutAdvance.preInsurancePayoutAmount, withAdvance.preInsurancePayoutAmount);
  assert.equal(withoutAdvance.netPayoutAmount - withAdvance.netPayoutAmount, 2_000_000);
  assert.equal(tax.taxableCompensationAmount, 25_675_300);
});

test("manual discipline penalty reduces payout without reducing taxable compensation or PIT", () => {
  assert.equal(payrollTaxTreatmentForItem("penalty", "deduction"), "payout_deduction");
  assert.equal(payrollTaxTreatmentForItem("damage", "deduction"), "payout_deduction");
  assert.equal(payrollTaxTreatmentForItem("late_deduction", "deduction"), "payout_deduction");
  assert.equal(payrollTaxTreatmentForItem("unauthorized_absence_deduction", "deduction"), "payout_deduction");
  assert.equal(payrollTaxTreatmentForItem("insurance_employee_deduction", "deduction"), "statutory_deduction");
  assert.equal(payrollTaxTreatmentForItem("advance", "deduction"), "advance_settlement");
  const taxableCompensationAmount = calculateTaxableCompensationAmount([
    { amount: 25_000_000, taxTreatment: "taxable_compensation" },
  ]);
  const tax = pit({ compensation: taxableCompensationAmount });
  const withoutPenalty = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: 25_000_000, manualIncentiveAmount: 0, manualPenaltyAmount: 0, employeeInsuranceDeductionAmount: 0, employeePitDeductionAmount: tax.employeePitDeductionAmount, advanceAmount: 0 });
  const withPenalty = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: 25_000_000, manualIncentiveAmount: 0, manualPenaltyAmount: 500_000, employeeInsuranceDeductionAmount: 0, employeePitDeductionAmount: tax.employeePitDeductionAmount, advanceAmount: 0 });
  assert.equal(taxableCompensationAmount, 25_000_000);
  assert.equal(pit({ compensation: taxableCompensationAmount }).taxableIncomeAmount, tax.taxableIncomeAmount);
  assert.equal(pit({ compensation: taxableCompensationAmount }).calculatedPitAmount, tax.calculatedPitAmount);
  assert.notEqual(tax.calculatedPitAmount, pit({ compensation: 24_500_000 }).calculatedPitAmount);
  assert.equal(withoutPenalty.netPayoutAmount - withPenalty.netPayoutAmount, 500_000);
});

test("damage and other payout deductions never become statutory tax deductions", () => {
  const taxableCompensationAmount = calculateTaxableCompensationAmount([
    { amount: 25_000_000, taxTreatment: "taxable_compensation" },
    { amount: 500_000, taxTreatment: "payout_deduction" },
  ]);
  const tax = pit({ compensation: taxableCompensationAmount });
  const payout = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: 24_500_000, manualIncentiveAmount: 0, manualPenaltyAmount: 0, employeeInsuranceDeductionAmount: 0, employeePitDeductionAmount: tax.employeePitDeductionAmount, advanceAmount: 0 });
  assert.equal(taxableCompensationAmount, 25_000_000);
  assert.equal(tax.calculatedPitAmount, pit({ compensation: 25_000_000 }).calculatedPitAmount);
  assert.equal(payout.preInsurancePayoutAmount, 24_500_000);
});

test("unauthorized absence excludes only unearned work while the three-day disciplinary penalty stays outside the tax base", () => {
  const dayRate = 1_000_000;
  const earnedWorkAmount = 25 * dayRate;
  const disciplinaryPenalty = 3 * dayRate;
  const taxableCompensationAmount = calculateTaxableCompensationAmount([
    { amount: earnedWorkAmount, taxTreatment: "taxable_compensation" },
    { amount: disciplinaryPenalty, taxTreatment: "payout_deduction" },
  ]);
  assert.equal(taxableCompensationAmount, 25_000_000);
  assert.notEqual(taxableCompensationAmount, earnedWorkAmount - disciplinaryPenalty);
  assert.notEqual(pit({ compensation: taxableCompensationAmount }).calculatedPitAmount, pit({ compensation: earnedWorkAmount - disciplinaryPenalty }).calculatedPitAmount);
  const payout = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: earnedWorkAmount - disciplinaryPenalty, manualIncentiveAmount: 0, manualPenaltyAmount: 0, employeeInsuranceDeductionAmount: 0, employeePitDeductionAmount: pit({ compensation: taxableCompensationAmount }).employeePitDeductionAmount, advanceAmount: 0 });
  assert.equal(payout.preInsurancePayoutAmount, 22_000_000);
});

test("late major multiplier does not reduce taxable compensation beyond actually unearned minutes", () => {
  const otherEarnedCompensation = 25_000_000;
  const earnedAfterTwentyMissingMinutes = 280_000;
  const majorPolicyPenalty = 150_000;
  const taxableCompensationAmount = calculateTaxableCompensationAmount([
    { amount: otherEarnedCompensation, taxTreatment: "taxable_compensation" },
    { amount: earnedAfterTwentyMissingMinutes, taxTreatment: "taxable_compensation" },
    { amount: majorPolicyPenalty, taxTreatment: "payout_deduction" },
  ]);
  const payoutCompensationAmount = otherEarnedCompensation + earnedAfterTwentyMissingMinutes - majorPolicyPenalty;
  assert.equal(taxableCompensationAmount, 25_280_000);
  assert.notEqual(pit({ compensation: taxableCompensationAmount }).calculatedPitAmount, pit({ compensation: payoutCompensationAmount }).calculatedPitAmount);
  const payout = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: payoutCompensationAmount, manualIncentiveAmount: 0, manualPenaltyAmount: 0, employeeInsuranceDeductionAmount: 0, advanceAmount: 0 });
  assert.equal(payout.preInsurancePayoutAmount, 25_130_000);
});

test("taxable incentive, disciplinary penalty, and advance remain independent in one fixture", () => {
  const taxableCompensationAmount = calculateTaxableCompensationAmount([
    { amount: 25_000_000, taxTreatment: "taxable_compensation" },
    { amount: 675_300, taxTreatment: "taxable_compensation" },
    { amount: 500_000, taxTreatment: "payout_deduction" },
    { amount: 2_000_000, taxTreatment: "advance_settlement" },
  ]);
  const tax = pit({ compensation: taxableCompensationAmount });
  const baseTax = pit({ compensation: 25_000_000 });
  const payout = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: 25_000_000, manualIncentiveAmount: 675_300, manualPenaltyAmount: 500_000, employeeInsuranceDeductionAmount: 0, employeePitDeductionAmount: tax.employeePitDeductionAmount, advanceAmount: 2_000_000 });
  assert.equal(taxableCompensationAmount, 25_675_300);
  assert.ok(tax.taxableIncomeAmount > baseTax.taxableIncomeAmount);
  assert.ok(tax.calculatedPitAmount > baseTax.calculatedPitAmount);
  assert.equal(payout.preInsurancePayoutAmount, 25_175_300);
  assert.equal(payout.netPayoutAmount, payout.preInsurancePayoutAmount - tax.employeePitDeductionAmount - 2_000_000);
});

const eligibleOvertimeEvidence = {
  taxExemptionStatus: "eligible" as const,
  legalOvertimeClassification: "overtime" as const,
  overtimeMinutes: 120,
  businessDate: "2026-08-15",
  normalHourlyEquivalentAmount: 600_000,
  actualOvertimeAmount: 1_000_000,
  legallyExemptAmount: 1_000_000,
  withinLegalWorkingTimeLimits: true,
  laborConditionsDocumented: true,
};

test("legally evidenced overtime increases payout but not taxable compensation or PIT", () => {
  const treatment = payrollTaxTreatmentForItem("overtime", "addition", 1_000_000, eligibleOvertimeEvidence);
  assert.equal(treatment, "tax_exempt_compensation");
  assert.equal(payrollTaxReviewCodeForItem("overtime", "addition", 1_000_000, eligibleOvertimeEvidence), null);
  const taxableCompensationAmount = calculateTaxableCompensationAmount([
    { amount: 25_000_000, taxTreatment: "taxable_compensation" },
    { amount: 1_000_000, taxTreatment: treatment },
  ]);
  const tax = pit({ compensation: taxableCompensationAmount });
  const baseTax = pit({ compensation: 25_000_000 });
  const basePayout = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: 25_000_000, manualIncentiveAmount: 0, manualPenaltyAmount: 0, employeeInsuranceDeductionAmount: 0, employeePitDeductionAmount: baseTax.employeePitDeductionAmount, advanceAmount: 0 });
  const overtimePayout = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: 26_000_000, manualIncentiveAmount: 0, manualPenaltyAmount: 0, employeeInsuranceDeductionAmount: 0, employeePitDeductionAmount: tax.employeePitDeductionAmount, advanceAmount: 0 });
  assert.equal(taxableCompensationAmount, 25_000_000);
  assert.equal(tax.calculatedPitAmount, baseTax.calculatedPitAmount);
  assert.equal(overtimePayout.netPayoutAmount - basePayout.netPayoutAmount, 1_000_000);
});

test("taxable incentive and exempt overtime remain separate", () => {
  const taxableCompensationAmount = calculateTaxableCompensationAmount([
    { amount: 25_000_000, taxTreatment: "taxable_compensation" },
    { amount: 675_300, taxTreatment: "taxable_compensation" },
    { amount: 1_000_000, taxTreatment: "tax_exempt_compensation" },
  ]);
  assert.equal(taxableCompensationAmount, 25_675_300);
  assert.ok(pit({ compensation: taxableCompensationAmount }).calculatedPitAmount > pit({ compensation: 25_000_000 }).calculatedPitAmount);
});

test("advance does not change exempt overtime or PIT", () => {
  const taxableCompensationAmount = calculateTaxableCompensationAmount([
    { amount: 25_000_000, taxTreatment: "taxable_compensation" },
    { amount: 1_000_000, taxTreatment: "tax_exempt_compensation" },
    { amount: 2_000_000, taxTreatment: "advance_settlement" },
  ]);
  const tax = pit({ compensation: taxableCompensationAmount });
  const withoutAdvance = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: 26_000_000, manualIncentiveAmount: 0, manualPenaltyAmount: 0, employeeInsuranceDeductionAmount: 0, employeePitDeductionAmount: tax.employeePitDeductionAmount, advanceAmount: 0 });
  const withAdvance = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: 26_000_000, manualIncentiveAmount: 0, manualPenaltyAmount: 0, employeeInsuranceDeductionAmount: 0, employeePitDeductionAmount: tax.employeePitDeductionAmount, advanceAmount: 2_000_000 });
  assert.equal(taxableCompensationAmount, 25_000_000);
  assert.equal(withoutAdvance.netPayoutAmount - withAdvance.netPayoutAmount, 2_000_000);
});

test("unproven overtime remains taxable and explicitly requires tax review", () => {
  const incomplete = { ...eligibleOvertimeEvidence, withinLegalWorkingTimeLimits: false };
  assert.equal(payrollTaxTreatmentForItem("overtime", "addition", 1_000_000, incomplete), "taxable_compensation");
  assert.equal(payrollTaxReviewCodeForItem("overtime", "addition", 1_000_000, incomplete), "OVERTIME_TAX_EXEMPTION_REQUIRES_REVIEW");
  const reviewed = calculateEmployeePit({ taxableCompensationAmount: 26_000_000, employeeInsuranceDeductionAmount: 0, policy, profile: profile(), reviewWarningCodes: ["OVERTIME_TAX_EXEMPTION_REQUIRES_REVIEW"] });
  assert.equal(reviewed.status, "requires_review");
});

test("fixed monthly unauthorized absence removes one unearned day from tax, not the full three-day payout deduction", () => {
  const contract = { id:1,userId:7,payType:"monthly" as const,calculationBasis:"fixed_monthly" as const,baseSalary:9_000_000,fixedRaiseAmount:0,standardWorkdays:30,standardMinutesPerDay:480,timeBlockMinutes:60,roundingMode:"nearest" as const,lateAdjustmentMode:"separate" as const,earlyLeaveAdjustmentMode:"separate" as const,overtimeMode:"requires_approval" as const,paidLeaveMode:"manual_review" as const,effectiveFrom:"2026-01-01",effectiveTo:null,revision:1 };
  const dayRate = calculatePayrollRates(contract, 9_000_000).dayRate;
  const threeDayPayoutDeduction = dayRate * 3;
  const taxableCompensationAmount = calculateTaxableCompensationAmount([
    { amount: 9_000_000, taxTreatment: "taxable_compensation" },
    { amount: dayRate, taxTreatment: "unearned_compensation" },
    { amount: threeDayPayoutDeduction, taxTreatment: "payout_deduction" },
  ]);
  const payout = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: 9_000_000 - threeDayPayoutDeduction, manualIncentiveAmount: 0, manualPenaltyAmount: 0, employeeInsuranceDeductionAmount: 0, advanceAmount: 0 });
  assert.equal(dayRate, 300_000);
  assert.equal(taxableCompensationAmount, 8_700_000);
  assert.equal(payout.preInsurancePayoutAmount, 8_100_000);
  assert.notEqual(taxableCompensationAmount, 9_000_000);
  assert.notEqual(taxableCompensationAmount, payout.preInsurancePayoutAmount);
});

test("company bears uses an exact finite progressive gross-up across brackets", () => {
  const lowest = grossUpNetTaxableIncome(1_000_000, brackets);
  assert.deepEqual(lowest, { grossTaxableIncomeAmount: 1_052_632, pitAmount: 52_632 });
  assert.notEqual(lowest.pitAmount, 50_000);
  for (const grossBoundary of [10_000_000, 30_000_000, 60_000_000, 100_000_000, 120_000_000]) {
    const target = grossBoundary - calculateProgressivePit(grossBoundary, brackets);
    for (const delta of [-1, 0, 1]) {
      const grossed = grossUpNetTaxableIncome(target + delta, brackets);
      assert.ok(Math.abs(grossed.grossTaxableIncomeAmount - grossed.pitAmount - (target + delta)) <= 1);
    }
  }
  const company = pit({ compensation: 20_000_000, profile: profile({ burdenMode: "company_bears" }) });
  assert.equal(company.employeePitDeductionAmount, 0);
  assert.ok(company.companyPitAmount > 0);
  const payout = calculatePayrollPayoutAmounts({ automaticPreInsuranceAmount: 20_000_000, manualIncentiveAmount: 0, manualPenaltyAmount: 0, employeeInsuranceDeductionAmount: 0, employeePitDeductionAmount: 0, advanceAmount: 2_000_000 });
  assert.equal(payout.netPayoutAmount, 18_000_000);
  const totals = calculatePayrollInsuranceTotals({ preInsurancePayoutAmounts: [20_000_000], employeeDeductionAmounts: [0], employeePitDeductionAmounts: [0], companyPitAmounts: [company.companyPitAmount], advanceAmounts: [2_000_000], employerAmounts: [0], directorAmount: 0 });
  assert.equal(totals.totalNetAmount, 18_000_000);
  assert.equal(totals.totalCompanyCostAmount, 20_000_000 + company.companyPitAmount);
});

test("policy and profile selection reproduce past months and ignore future revisions", () => {
  const policies = [policy, { ...policy, id: 110, effectiveMonth: "2026-08-01", revision: 4 }, { ...policy, id: 111, effectiveMonth: "2026-10-01", revision: 5 }];
  assert.equal(selectTaxPolicy(policies, "2026-07")?.id, 109);
  assert.equal(selectTaxPolicy(policies, "2026-08")?.id, 110);
  const settings = [profile({ id: 1, effectiveMonth: "2026-01-01", revision: 1 }), profile({ id: 2, effectiveMonth: "2026-08-01", revision: 2 }), profile({ id: 3, effectiveMonth: "2026-10-01", revision: 3 })];
  assert.equal(selectEmployeeTaxSetting(settings, "2026-07")?.id, 1);
  assert.equal(selectEmployeeTaxSetting(settings, "2026-08")?.id, 2);
});

test("missing settings are review states while explicit not-applicable is a valid zero", () => {
  assert.deepEqual(calculateEmployeePit({ taxableCompensationAmount: 20_000_000, employeeInsuranceDeductionAmount: 0, policy, profile: null }).warningCodes, ["TAX_PROFILE_REQUIRES_REVIEW"]);
  assert.deepEqual(calculateEmployeePit({ taxableCompensationAmount: 20_000_000, employeeInsuranceDeductionAmount: 0, policy: null, profile: profile() }).warningCodes, ["TAX_POLICY_MISSING"]);
  const disabled = calculateEmployeePit({ taxableCompensationAmount: 100_000_000, employeeInsuranceDeductionAmount: 0, policy: null, profile: profile({ taxMode: "not_applicable", dependentCount: 0, burdenMode: "employee_deducted", insuranceDeductionMode: "none", manualInsuranceDeductionAmount: 0 }) });
  assert.equal(disabled.status, "not_applicable");
  assert.equal(disabled.calculatedPitAmount, 0);
});

test("accounting alias is hashed metadata and never replaces the internal user identity", () => {
  const employee = { userId: 7, name: "Vương", tax: pit({ compensation: 23_000_000, profile: profile({ accountingName: "KIM MIN JAE" }) }) };
  assert.equal(employee.userId, 7);
  assert.equal(employee.name, "Vương");
  assert.equal(employee.tax.accountingName, "KIM MIN JAE");
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  assert.notEqual(hash(employee), hash({ ...employee, tax: { ...employee.tax, dependentCount: 1 } }));
  assert.notEqual(hash(employee), hash({ ...employee, tax: { ...employee.tax, accountingName: "KIM" } }));
  const taxableOvertimeSnapshot = { employee: { amounts: { overtimeAmount: 1_000_000, taxableOvertimeAmount: 1_000_000, taxExemptOvertimeAmount: 0 }, tax: pit({ compensation: 26_000_000 }) } };
  const exemptOvertimeSnapshot = { employee: { amounts: { overtimeAmount: 1_000_000, taxableOvertimeAmount: 0, taxExemptOvertimeAmount: 1_000_000 }, tax: pit({ compensation: 25_000_000 }) } };
  assert.notEqual(hash(taxableOvertimeSnapshot), hash(exemptOvertimeSnapshot));
  assert.notEqual(hash(exemptOvertimeSnapshot), hash({ ...exemptOvertimeSnapshot, employee: { ...exemptOvertimeSnapshot.employee, amounts: { ...exemptOvertimeSnapshot.employee.amounts, overtimeAmount: 1_000_001, taxExemptOvertimeAmount: 1_000_001 } } }));
});
