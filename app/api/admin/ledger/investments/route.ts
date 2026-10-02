import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { OWNER_INVESTMENT_MONTH } from "@/lib/ledger/investments";
import { loadOwnerInvestmentMonth, loadOwnerInvestmentMonthSummary } from "@/lib/ledger/investments-server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  ownerInvestmentCashEventErrorStatus,
  parseOwnerInvestmentCashEventInput,
} from "@/lib/ledger/investment-cash-event";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response) return auth.response;
  const params = new URL(request.url).searchParams;
  const month = params.get("month") ?? "";
  if (!OWNER_INVESTMENT_MONTH.test(month)) return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
  try {
    // mode=summary: collapsed header only (configured + this month's net change).
    if (params.get("mode") === "summary") return ledgerJson({ ok: true, mode: "summary", ...await loadOwnerInvestmentMonthSummary(month) });
    const data = await loadOwnerInvestmentMonth(month);
    return ledgerJson({ ok: true, ...data });
  } catch (error) {
    console.error("[LEDGER_INVESTMENTS_GET_FAILED]", error);
    return ledgerJson({ ok: false, code: "INVESTMENTS_LOAD_FAILED" }, 500);
  }
}

export async function POST(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const input = parseOwnerInvestmentCashEventInput(await request.json().catch(() => null));
  if (!input) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("ledger_create_owner_investment_cash_event_v1", {
      p_participant_id: input.participantId,
      p_action: input.action,
      p_amount: input.amount,
      p_occurred_at: input.occurredAt,
      p_fund_account_id: input.fundAccountId,
      p_reason: input.reason,
      p_memo: input.memo,
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "created") {
      const status = String(result.status ?? "INVESTMENT_CASH_EVENT_FAILED");
      return ledgerJson({ ok: false, code: status.toUpperCase(), result }, ownerInvestmentCashEventErrorStatus(status));
    }
    return ledgerJson({ ok: true, result }, 201);
  } catch (error) {
    console.error("[LEDGER_INVESTMENTS_POST_FAILED]", error);
    return ledgerJson({ ok: false, code: "INVESTMENT_CASH_EVENT_FAILED" }, 500);
  }
}
