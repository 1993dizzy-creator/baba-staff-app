import { getBusinessDate, getBusinessMonthEndBoundary } from "@/lib/common/business-time";
import { fundAccountLogRowsFromMovements, type FundAccountMovementSourceRow } from "@/lib/ledger/fund-account-log";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const PAGE_SIZE = 1000;

// Read-only: one fund account's confirmed ledger_movements for a month, by
// business date (03:00 business day). The window matches the balance read in
// /api/admin/ledger: the live month stops at now, other months at month end.
// Opening seed rows are excluded; they are already the card's opening balance.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireLedgerActor();
  if (auth.response) return auth.response;
  const { id: raw } = await context.params;
  const accountId = Number(raw);
  if (!Number.isSafeInteger(accountId) || accountId < 1) return ledgerJson({ ok: false, code: "INVALID_FUND_ACCOUNT" }, 400);
  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!MONTH.test(month)) return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
  const monthStart = `${month}-01`;
  const { businessDateExclusive: nextMonth } = getBusinessMonthEndBoundary(month);
  const now = new Date();
  const live = month === getBusinessDate(now).slice(0, 7);
  try {
    const accountResult = await supabaseServer.from("ledger_fund_accounts").select("id,code,display_name").eq("id", accountId).maybeSingle();
    if (accountResult.error) throw accountResult.error;
    if (!accountResult.data) return ledgerJson({ ok: false, code: "FUND_ACCOUNT_NOT_FOUND" }, 404);
    const rows: FundAccountMovementSourceRow[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      let query = supabaseServer.from("ledger_movements")
        .select("id,fund_account_id,amount,transaction:ledger_transactions!inner(id,type,status,business_date,occurred_at,memo,party:ledger_parties(name),category:ledger_categories(name),movements:ledger_movements(id,fund_account_id,amount,fund_account:ledger_fund_accounts(display_name)))")
        .eq("fund_account_id", accountId)
        .eq("transaction.status", "confirmed")
        .neq("transaction.type", "opening")
        .gte("transaction.business_date", monthStart)
        .lt("transaction.business_date", nextMonth);
      if (live) query = query.lte("transaction.occurred_at", now.toISOString());
      const { data, error } = await query.order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...((data ?? []) as unknown as FundAccountMovementSourceRow[]));
      if ((data?.length ?? 0) < PAGE_SIZE) break;
    }
    return ledgerJson({
      ok: true,
      month,
      account: { id: accountId, code: accountResult.data.code, displayName: accountResult.data.display_name },
      asOf: live ? now.toISOString() : null,
      rows: fundAccountLogRowsFromMovements(rows, accountId),
    });
  } catch (error) {
    console.error("[LEDGER_FUND_ACCOUNT_LOG_FAILED]", error);
    return ledgerJson({ ok: false, code: "FUND_ACCOUNT_LOG_FAILED" }, 500);
  }
}
