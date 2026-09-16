import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;

  const { data, error } = await supabaseServer.from("ledger_fund_accounts")
    .select("id,code,display_name")
    .eq("is_active", true)
    .neq("code", "card_clearing")
    .order("sort_order")
    .order("id");
  if (error) {
    console.error("[PAYROLL_FUND_ACCOUNTS_READ_FAILED]", error);
    return payrollJson({ ok: false, code: "PAYROLL_FUND_ACCOUNTS_READ_FAILED" }, 500);
  }
  const accounts = data ?? [];
  const defaultAccount = accounts.find(account => account.code === "baba_corporate_bank") ?? accounts[0];
  return payrollJson({ ok: true, accounts, defaultFundAccountId: defaultAccount?.id ?? null });
}
