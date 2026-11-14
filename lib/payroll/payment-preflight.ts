import type { PayrollOverviewEmployee } from "./overview";
import type { PayrollRunEmployeeInput } from "./monthly-run";

// Read-only assessment, shared by initial and already-started batch payments.
export function paymentFailureCodes(employee: PayrollOverviewEmployee, raw: PayrollRunEmployeeInput | undefined, activeContractCount: number) {
  const codes: string[] = [];
  if (!raw) codes.push("MISSING_SNAPSHOT");
  if (!employee.contract || activeContractCount === 0) codes.push("MISSING_CONTRACT");
  if (activeContractCount > 1) codes.push("CONTRACT_OVERLAP");
  if (employee.contract && raw && !raw.contractSnapshot.some(c => c.id === employee.contract!.id)) codes.push("CONTRACT_SNAPSHOT_MISMATCH");
  if (employee.amounts.currentAmount === null || employee.calculationStatus !== "calculable"
    || !Number.isSafeInteger(employee.amounts.netPayoutAmount) || employee.amounts.netPayoutAmount < 0) codes.push("NET_AMOUNT_UNAVAILABLE");
  const blocking = raw?.reviews.filter(review => review.reviewLevel === "blocking").map(review => review.warningCode) ?? [];
  codes.push(...blocking);
  if (employee.blockingCount > 0 && blocking.length === 0) codes.push("BLOCKING_REVIEW");
  if (!["calculated", "not_applicable"].includes(employee.tax.status)) codes.push("TAX_REQUIRES_REVIEW");
  codes.push(...employee.tax.warningCodes);
  return [...new Set(codes)];
}

export function validPaymentTargetIds(ids: number[], selectedId: number) {
  return ids.length > 0 && ids.every(id => Number.isSafeInteger(id) && id > 0)
    && new Set(ids).size === ids.length && ids.includes(selectedId);
}
