import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { OWNER_INVESTMENT_MONTH } from "@/lib/ledger/investments";
import { loadOwnerInvestmentMonth } from "@/lib/ledger/investments-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response) return auth.response;
  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!OWNER_INVESTMENT_MONTH.test(month)) return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
  try {
    const data = await loadOwnerInvestmentMonth(month);
    return ledgerJson({ ok: true, ...data });
  } catch (error) {
    console.error("[LEDGER_INVESTMENTS_GET_FAILED]", error);
    return ledgerJson({ ok: false, code: "INVESTMENTS_LOAD_FAILED" }, 500);
  }
}
