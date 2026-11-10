import { hireMonthBase } from "./month.ts";
import type { EmployeeLevelBaseMode } from "./types.ts";

/** Candidate only: callers must explicitly apply and save a new policy version. */
export function employeeLevelMonthCandidate(input: {
  mode: EmployeeLevelBaseMode;
  baseDate: string | null;
  hireDate: string | null;
}) {
  const mode = input.mode === "override" || input.mode === "override_month"
    ? "override_month" as const : "hire_month" as const;
  return {
    mode,
    baseMonth: mode === "override_month" ? input.baseDate?.slice(0, 7) ?? "" : hireMonthBase(input.hireDate) ?? "",
  };
}
