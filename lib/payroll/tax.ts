export type PayrollTaxMode = "not_applicable" | "resident_progressive";
export type PayrollTaxBurdenMode = "employee_deducted" | "company_bears";
export type PayrollTaxInsuranceDeductionMode = "payroll" | "manual" | "none";
export type PayrollTaxTreatment = "taxable_compensation" | "tax_exempt_compensation" | "unearned_compensation" | "payout_deduction" | "statutory_deduction" | "advance_settlement";

export type PayrollOvertimeTaxEvidence = {
  taxExemptionStatus?: "eligible" | "not_eligible" | "requires_review";
  legalOvertimeClassification?: "overtime" | "night_work" | "overtime_night_work";
  overtimeMinutes?: number;
  businessDate?: string;
  normalHourlyEquivalentAmount?: number;
  actualOvertimeAmount?: number;
  legallyExemptAmount?: number;
  withinLegalWorkingTimeLimits?: boolean;
  laborConditionsDocumented?: boolean;
};

function hasCompleteOvertimeTaxExemptionEvidence(amount: number, evidence: PayrollOvertimeTaxEvidence) {
  return evidence.taxExemptionStatus === "eligible"
    && ["overtime", "night_work", "overtime_night_work"].includes(String(evidence.legalOvertimeClassification))
    && Number.isSafeInteger(evidence.overtimeMinutes) && Number(evidence.overtimeMinutes) > 0
    && typeof evidence.businessDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(evidence.businessDate)
    && Number.isSafeInteger(evidence.normalHourlyEquivalentAmount) && Number(evidence.normalHourlyEquivalentAmount) >= 0
    && evidence.actualOvertimeAmount === amount
    && evidence.legallyExemptAmount === amount
    && evidence.withinLegalWorkingTimeLimits === true
    && evidence.laborConditionsDocumented === true;
}

export function payrollTaxTreatmentForItem(
  category: string,
  direction: "addition" | "deduction",
  amount = 0,
  evidence: PayrollOvertimeTaxEvidence = {},
): PayrollTaxTreatment {
  if (category === "advance") return "advance_settlement";
  if (category === "insurance_employee_deduction") return "statutory_deduction";
  if (category === "overtime" && direction === "addition") {
    return hasCompleteOvertimeTaxExemptionEvidence(amount, evidence) ? "tax_exempt_compensation" : "taxable_compensation";
  }
  return direction === "addition" ? "taxable_compensation" : "payout_deduction";
}

export function payrollTaxReviewCodeForItem(
  category: string,
  direction: "addition" | "deduction",
  amount = 0,
  evidence: PayrollOvertimeTaxEvidence = {},
) {
  if (category !== "overtime" || direction !== "addition" || evidence.taxExemptionStatus === "not_eligible") return null;
  return hasCompleteOvertimeTaxExemptionEvidence(amount, evidence) ? null : "OVERTIME_TAX_EXEMPTION_REQUIRES_REVIEW";
}

export function calculateTaxableCompensationAmount(
  components: readonly { amount: number; taxTreatment: PayrollTaxTreatment }[],
) {
  let total = 0;
  for (const component of components) {
    if (!Number.isSafeInteger(component.amount) || component.amount < 0) {
      throw new RangeError("INVALID_TAXABLE_COMPENSATION_COMPONENT");
    }
    if (component.taxTreatment === "taxable_compensation") total += component.amount;
    if (component.taxTreatment === "unearned_compensation") total -= component.amount;
    if (!Number.isSafeInteger(total)) throw new RangeError("TAXABLE_COMPENSATION_OVERFLOW");
  }
  return Math.max(0, total);
}

export function calculateAccountingTaxableCompensationAmount(input: {
  preInsurancePayoutAmount: number;
  taxExemptCompensationAmount: number;
  companyPaidInsuranceTaxableAmount: number;
}) {
  if (!Number.isSafeInteger(input.preInsurancePayoutAmount)
    || !isNonNegativeInteger(input.taxExemptCompensationAmount)
    || !isNonNegativeInteger(input.companyPaidInsuranceTaxableAmount)) {
    throw new RangeError("INVALID_ACCOUNTING_TAXABLE_COMPENSATION_INPUT");
  }
  const amount = input.preInsurancePayoutAmount
    - input.taxExemptCompensationAmount
    + input.companyPaidInsuranceTaxableAmount;
  if (!Number.isSafeInteger(amount)) throw new RangeError("TAXABLE_COMPENSATION_OVERFLOW");
  return Math.max(0, amount);
}

export type PayrollTaxBracket = {
  lowerBoundAmount: number;
  upperBoundAmount: number | null;
  rateBp: number;
};

export type PayrollTaxPolicyVersion = {
  id: number;
  effectiveMonth: string;
  personalDeductionAmount: number;
  dependentDeductionAmount: number;
  brackets: PayrollTaxBracket[];
  revision: number;
  createdBy: number;
  createdAt: string;
  note: string | null;
};

export type PayrollTaxSettingVersion = {
  id: number;
  userId: number;
  effectiveMonth: string;
  taxMode: PayrollTaxMode;
  dependentCount: number;
  burdenMode: PayrollTaxBurdenMode;
  accountingName: string | null;
  insuranceDeductionMode: PayrollTaxInsuranceDeductionMode;
  manualInsuranceDeductionAmount: number;
  revision: number;
  createdBy: number;
  createdAt: string;
  note: string | null;
};

export type PayrollEmployeeTaxCalculation = {
  status: "not_applicable" | "calculated" | "requires_review";
  warningCodes: string[];
  taxMode: PayrollTaxMode | null;
  taxBurdenMode: PayrollTaxBurdenMode | null;
  taxPolicyId: number | null;
  taxPolicyRevision: number | null;
  taxProfileId: number | null;
  taxProfileRevision: number | null;
  personalDeductionAmount: number;
  dependentCount: number;
  dependentDeductionAmount: number;
  taxableCompensationAmount: number;
  deductibleInsuranceAmount: number;
  taxableIncomeBeforeGrossUpAmount: number;
  taxableIncomeAmount: number;
  calculatedPitAmount: number;
  employeePitDeductionAmount: number;
  companyPitAmount: number;
  accountingName: string | null;
  insuranceDeductionMode: PayrollTaxInsuranceDeductionMode | null;
  manualInsuranceDeductionAmount: number;
  policySnapshot: PayrollTaxPolicyVersion | null;
  profileSnapshot: PayrollTaxSettingVersion | null;
};

function isNonNegativeInteger(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateTaxBrackets(brackets: readonly PayrollTaxBracket[]) {
  if (brackets.length === 0) return false;
  let expectedLower = 0;
  for (let index = 0; index < brackets.length; index++) {
    const bracket = brackets[index];
    if (!isNonNegativeInteger(bracket.lowerBoundAmount) || bracket.lowerBoundAmount !== expectedLower) return false;
    if (!Number.isInteger(bracket.rateBp) || bracket.rateBp < 0 || bracket.rateBp >= 10_000) return false;
    const last = index === brackets.length - 1;
    if (last) return bracket.upperBoundAmount === null;
    if (!isNonNegativeInteger(bracket.upperBoundAmount ?? -1) || (bracket.upperBoundAmount as number) <= bracket.lowerBoundAmount) return false;
    expectedLower = bracket.upperBoundAmount as number;
  }
  return false;
}

function requireValidBrackets(brackets: readonly PayrollTaxBracket[]) {
  if (!validateTaxBrackets(brackets)) throw new RangeError("INVALID_TAX_BRACKETS");
}

function roundBasisPointNumerator(numerator: bigint) {
  return Number((numerator + BigInt(5_000)) / BigInt(10_000));
}

export function calculateProgressivePit(
  taxableIncomeAmount: number,
  brackets: readonly PayrollTaxBracket[],
) {
  if (!Number.isSafeInteger(taxableIncomeAmount)) throw new RangeError("INVALID_TAXABLE_INCOME");
  requireValidBrackets(brackets);
  const taxableIncome = Math.max(0, taxableIncomeAmount);
  let numerator = BigInt(0);
  for (const bracket of brackets) {
    if (taxableIncome <= bracket.lowerBoundAmount) break;
    const segmentUpper = bracket.upperBoundAmount === null
      ? taxableIncome
      : Math.min(taxableIncome, bracket.upperBoundAmount);
    const segmentAmount = segmentUpper - bracket.lowerBoundAmount;
    numerator += BigInt(segmentAmount) * BigInt(bracket.rateBp);
    if (bracket.upperBoundAmount === null || taxableIncome <= bracket.upperBoundAmount) break;
  }
  return roundBasisPointNumerator(numerator);
}

export function grossUpNetTaxableIncome(
  netTaxableIncomeAmount: number,
  brackets: readonly PayrollTaxBracket[],
) {
  if (!Number.isSafeInteger(netTaxableIncomeAmount)) throw new RangeError("INVALID_NET_TAXABLE_INCOME");
  requireValidBrackets(brackets);
  const target = Math.max(0, netTaxableIncomeAmount);
  if (target === 0) return { grossTaxableIncomeAmount: 0, pitAmount: 0 };
  const maxRate = Math.max(...brackets.map((bracket) => bracket.rateBp));
  const upperNumerator = BigInt(target) * BigInt(10_000);
  let low = target;
  let high = Number((upperNumerator + BigInt(9_999 - maxRate)) / BigInt(10_000 - maxRate)) + 2;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const afterTax = middle - calculateProgressivePit(middle, brackets);
    if (afterTax >= target) high = middle;
    else low = middle + 1;
  }
  const pitAmount = calculateProgressivePit(low, brackets);
  return { grossTaxableIncomeAmount: low, pitAmount };
}

export function selectTaxPolicy(
  versions: readonly PayrollTaxPolicyVersion[],
  payrollMonth: string,
) {
  const monthStart = `${payrollMonth.slice(0, 7)}-01`;
  return versions
    .filter((version) => version.effectiveMonth <= monthStart)
    .toSorted((left, right) => right.effectiveMonth.localeCompare(left.effectiveMonth) || right.revision - left.revision)[0] ?? null;
}

export function selectEmployeeTaxSetting(
  versions: readonly PayrollTaxSettingVersion[],
  payrollMonth: string,
) {
  const monthStart = `${payrollMonth.slice(0, 7)}-01`;
  return versions
    .filter((version) => version.effectiveMonth <= monthStart)
    .toSorted((left, right) => right.effectiveMonth.localeCompare(left.effectiveMonth) || right.revision - left.revision)[0] ?? null;
}

function reviewTax(
  taxableCompensationAmount: number,
  profile: PayrollTaxSettingVersion | null,
  policy: PayrollTaxPolicyVersion | null,
  warningCode: string,
): PayrollEmployeeTaxCalculation {
  return {
    status: "requires_review",
    warningCodes: [warningCode],
    taxMode: profile?.taxMode ?? null,
    taxBurdenMode: profile?.burdenMode ?? null,
    taxPolicyId: policy?.id ?? null,
    taxPolicyRevision: policy?.revision ?? null,
    taxProfileId: profile?.id ?? null,
    taxProfileRevision: profile?.revision ?? null,
    personalDeductionAmount: policy?.personalDeductionAmount ?? 0,
    dependentCount: profile?.dependentCount ?? 0,
    dependentDeductionAmount: policy && profile ? policy.dependentDeductionAmount * profile.dependentCount : 0,
    taxableCompensationAmount,
    deductibleInsuranceAmount: 0,
    taxableIncomeBeforeGrossUpAmount: 0,
    taxableIncomeAmount: 0,
    calculatedPitAmount: 0,
    employeePitDeductionAmount: 0,
    companyPitAmount: 0,
    accountingName: profile?.accountingName ?? null,
    insuranceDeductionMode: profile?.insuranceDeductionMode ?? null,
    manualInsuranceDeductionAmount: profile?.manualInsuranceDeductionAmount ?? 0,
    policySnapshot: policy,
    profileSnapshot: profile,
  };
}

export function calculateEmployeePit(input: {
  taxableCompensationAmount: number;
  employeeInsuranceDeductionAmount: number;
  policy: PayrollTaxPolicyVersion | null;
  profile: PayrollTaxSettingVersion | null;
  reviewWarningCodes?: string[];
}): PayrollEmployeeTaxCalculation {
  if (!Number.isSafeInteger(input.taxableCompensationAmount) || !isNonNegativeInteger(input.employeeInsuranceDeductionAmount)) {
    throw new RangeError("INVALID_EMPLOYEE_TAX_INPUT");
  }
  const taxableCompensationAmount = Math.max(0, input.taxableCompensationAmount);
  const profile = input.profile;
  if (!profile) return reviewTax(taxableCompensationAmount, null, input.policy, "TAX_PROFILE_REQUIRES_REVIEW");
  if (profile.taxMode === "not_applicable") {
    return {
      ...reviewTax(taxableCompensationAmount, profile, null, ""),
      status: "not_applicable",
      warningCodes: [],
      taxableCompensationAmount,
      accountingName: profile.accountingName,
    };
  }
  const policy = input.policy;
  if (!policy) return reviewTax(taxableCompensationAmount, profile, null, "TAX_POLICY_MISSING");
  if (!validateTaxBrackets(policy.brackets)) return reviewTax(taxableCompensationAmount, profile, policy, "TAX_POLICY_INVALID");
  if (!profile.accountingName?.trim()) return reviewTax(taxableCompensationAmount, profile, policy, "TAX_PROFILE_REQUIRES_REVIEW");

  const deductibleInsuranceAmount = profile.insuranceDeductionMode === "payroll"
    ? input.employeeInsuranceDeductionAmount
    : profile.insuranceDeductionMode === "manual"
      ? profile.manualInsuranceDeductionAmount
      : 0;
  if (!isNonNegativeInteger(deductibleInsuranceAmount) || !Number.isSafeInteger(profile.dependentCount) || profile.dependentCount < 0) {
    return reviewTax(taxableCompensationAmount, profile, policy, "TAX_PROFILE_REQUIRES_REVIEW");
  }
  const dependentDeductionAmount = policy.dependentDeductionAmount * profile.dependentCount;
  if (!Number.isSafeInteger(dependentDeductionAmount)) throw new RangeError("TAX_DEDUCTION_OVERFLOW");
  const taxableIncomeBeforeGrossUpAmount = Math.max(
    0,
    taxableCompensationAmount
      - deductibleInsuranceAmount
      - policy.personalDeductionAmount
      - dependentDeductionAmount,
  );
  const calculatedPitAmount = calculateProgressivePit(taxableIncomeBeforeGrossUpAmount, policy.brackets);
  const employeePitDeductionAmount = profile.burdenMode === "employee_deducted" ? calculatedPitAmount : 0;
  const companyPitAmount = profile.burdenMode === "company_bears" ? calculatedPitAmount : 0;
  const reviewWarningCodes = [...new Set(input.reviewWarningCodes ?? [])];
  return {
    status: reviewWarningCodes.length > 0 ? "requires_review" : "calculated",
    warningCodes: reviewWarningCodes,
    taxMode: profile.taxMode,
    taxBurdenMode: profile.burdenMode,
    taxPolicyId: policy.id,
    taxPolicyRevision: policy.revision,
    taxProfileId: profile.id,
    taxProfileRevision: profile.revision,
    personalDeductionAmount: policy.personalDeductionAmount,
    dependentCount: profile.dependentCount,
    dependentDeductionAmount,
    taxableCompensationAmount,
    deductibleInsuranceAmount,
    taxableIncomeBeforeGrossUpAmount,
    taxableIncomeAmount: taxableIncomeBeforeGrossUpAmount,
    calculatedPitAmount,
    employeePitDeductionAmount,
    companyPitAmount,
    accountingName: profile.accountingName.trim(),
    insuranceDeductionMode: profile.insuranceDeductionMode,
    manualInsuranceDeductionAmount: profile.manualInsuranceDeductionAmount,
    policySnapshot: policy,
    profileSnapshot: profile,
  };
}
