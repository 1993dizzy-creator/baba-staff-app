export type PayrollRpcVersion = "v3" | "v4" | null;

export function payrollRpcVersion(engineVersion: unknown): PayrollRpcVersion {
  if (engineVersion === "monthly-payroll-v6") return "v4";
  if (engineVersion === "monthly-payroll-v5") return "v3";
  return null;
}

export type PayrollRunActionGuard =
  | "PAYROLL_LEGACY_RUN_RECALC_UNSUPPORTED"
  | "PAYROLL_LEGACY_RUN_UNFINALIZE_UNSUPPORTED"
  | "PAYROLL_ENGINE_VERSION_UNSUPPORTED"
  | null;

export function payrollRunActionGuard(engineVersion: unknown, action: string): PayrollRunActionGuard {
  if (action === "recalculate") {
    if (engineVersion === "monthly-payroll-v5") return "PAYROLL_LEGACY_RUN_RECALC_UNSUPPORTED";
    if (engineVersion !== "monthly-payroll-v6") return "PAYROLL_ENGINE_VERSION_UNSUPPORTED";
  }
  if (engineVersion === "monthly-payroll-v5" && action === "cancel_finalization") return "PAYROLL_LEGACY_RUN_UNFINALIZE_UNSUPPORTED";
  if (!payrollRpcVersion(engineVersion)) return "PAYROLL_ENGINE_VERSION_UNSUPPORTED";
  return null;
}
