import type { PayrollOverviewEmployee } from "./overview";

// Scope the frozen display to the new policy. Legacy paid-row display stays unchanged.
export function paidFirstMonthEmployee(paymentStatus: string | undefined, snapshot: unknown): PayrollOverviewEmployee | null {
  if (paymentStatus !== "paid" || !snapshot || typeof snapshot !== "object") return null;
  const employee = (snapshot as {employee?: PayrollOverviewEmployee}).employee;
  return employee?.firstMonthProration ? employee : null;
}
