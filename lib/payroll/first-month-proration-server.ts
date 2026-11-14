import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import type { FirstMonthPolicy } from "./first-month-proration";

export const firstMonthEnrollmentEnabled = () => process.env.PAYROLL_FIRST_MONTH_PRORATION_ENABLED === "true";

// Reading remains enabled after enrollment is switched off: existing policies must
// never silently revert to full salary. Only a genuinely absent pre-deploy RPC is compatible.
export async function loadFirstMonthPolicies(userIds: number[]) {
  if (!userIds.length) return new Map<number, FirstMonthPolicy>();
  const { data, error } = await supabaseServer.rpc("payroll_first_month_policies_v1", { p_user_ids: userIds });
  if (error) {
    if (!firstMonthEnrollmentEnabled() && error.code === "PGRST202") return new Map<number, FirstMonthPolicy>();
    throw new Error("FIRST_MONTH_POLICY_READ_FAILED");
  }
  return new Map<number, FirstMonthPolicy>(((data ?? []) as FirstMonthPolicy[]).map(row => [Number(row.userId), row]));
}
