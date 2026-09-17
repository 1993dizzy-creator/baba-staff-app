import type { PayrollOverviewEmployee } from "./overview";
import type { PartTimeExtraWorkCandidate } from "./part-time-extra-work";

type PaymentSnapshot = Record<string, unknown> | null;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function paidExtraWorkRows(snapshot: PaymentSnapshot): PartTimeExtraWorkCandidate[] {
  const rows = snapshot?.partTimeExtraWorkSnapshot;
  if (!Array.isArray(rows)) return [];
  // Paid months display decisions captured when payment was made. A later
  // calculation cannot introduce pending or stale review rows here.
  return rows.filter((row) => record(row) &&
    (row.status === "approved" || row.status === "rejected") && record(row.decision)) as PartTimeExtraWorkCandidate[];
}

export function paidExtraWorkAmount(snapshot: PaymentSnapshot): number {
  const employee = snapshot?.employee;
  if (record(employee) && record(employee.amounts) && typeof employee.amounts.partTimeExtraWorkAmount === "number") {
    return employee.amounts.partTimeExtraWorkAmount;
  }
  return paidExtraWorkRows(snapshot).reduce((sum, row) =>
    sum + (row.status === "approved" ? row.candidateAmount : 0), 0);
}

export function lockPaidExtraWorkReview(employee: PayrollOverviewEmployee, snapshot: PaymentSnapshot): PayrollOverviewEmployee {
  const removedReviews = employee.partTimeExtraWork.filter((row) =>
    row.status === "review_required" || row.status === "stale").length;
  const reviewCount = Math.max(0, employee.reviewCount - removedReviews);
  const blockingCount = Math.max(0, employee.blockingCount - removedReviews);
  const calculationStatus = employee.calculationStatus === "requires_review" && reviewCount === 0 &&
    employee.levelApplication.status !== "requires_review" && employee.tax.status !== "requires_review"
    ? "calculable" : employee.calculationStatus;
  return {
    ...employee,
    partTimeExtraWork: paidExtraWorkRows(snapshot),
    reviewCount,
    blockingCount,
    warningCodes: employee.warningCodes.filter((code) =>
      code !== "PART_TIME_EXTRA_WORK_REVIEW_REQUIRED" && code !== "PART_TIME_EXTRA_WORK_DECISION_STALE"),
    calculationStatus,
  };
}
