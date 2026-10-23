import { reserveCurrentAmount } from "@/lib/ledger/reserve-balances";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Read-only history of one reserve plan for the ledger reserve detail sheet.
// Scoped to this plan id, so other plans' entries never mix in.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireLedgerActor();
  if (auth.response) return auth.response;
  const { id: raw } = await context.params;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) return ledgerJson({ ok: false, code: "INVALID_RESERVE_PLAN" }, 400);
  try {
    const [planResult, entryResult] = await Promise.all([
      supabaseServer.from("ledger_reserve_plans").select("id,name,fund_account_id").eq("id", id).maybeSingle(),
      supabaseServer.from("ledger_reserve_entries").select("id,reserve_plan_id,entry_type,amount,occurred_at,memo").eq("reserve_plan_id", id)
        .order("occurred_at", { ascending: false }).order("id", { ascending: false }),
    ]);
    if (planResult.error || entryResult.error) throw planResult.error ?? entryResult.error;
    if (!planResult.data) return ledgerJson({ ok: false, code: "RESERVE_PLAN_NOT_FOUND" }, 404);
    const plan = planResult.data;
    const accountResult = plan.fund_account_id == null ? null
      : await supabaseServer.from("ledger_fund_accounts").select("display_name").eq("id", plan.fund_account_id).maybeSingle();
    if (accountResult?.error) throw accountResult.error;
    const entries = (entryResult.data ?? [])
      .filter((entry) => Number(entry.reserve_plan_id) === id)
      .map((entry) => ({ id: Number(entry.id), reserve_plan_id: id, entry_type: entry.entry_type, amount: Number(entry.amount), occurred_at: entry.occurred_at, memo: entry.memo ?? null }));
    return ledgerJson({
      ok: true,
      plan: { id, name: plan.name, fundAccountName: accountResult?.data?.display_name ?? null },
      entries,
      currentAmount: reserveCurrentAmount(entries),
    });
  } catch (error) {
    console.error("[LEDGER_RESERVE_HISTORY_FAILED]", error);
    return ledgerJson({ ok: false, code: "RESERVE_HISTORY_FAILED" }, 500);
  }
}
