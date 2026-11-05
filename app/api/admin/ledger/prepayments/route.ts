import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";
import { unusedPrepaymentAmount, type UnusedPrepayment } from "@/lib/ledger/supplier-prepayments";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const dynamic = "force-dynamic";

// Unused supplier prepayments (선결제 잔액), optionally for one ledger party.
export async function GET(request: Request) {
  const auth = await requireLedgerActor(); if (auth.response) return auth.response;
  const partyParam = new URL(request.url).searchParams.get("partyId");
  const partyId = partyParam === null ? null : Number(partyParam);
  if (partyId !== null && (!Number.isSafeInteger(partyId) || partyId <= 0)) return ledgerJson({ ok: false, code: "INVALID_PARTY" }, 400);
  const rows: Array<{ id: number; party_id: number; business_date: string; amount: number | string; memo: string | null; allocations: { allocated_amount: number | string }[] | null }> = [];
  for (let from = 0; ; from += 1000) {
    let query = supabaseServer.from("ledger_transactions")
      .select("id,party_id,business_date,amount,memo,allocations:ledger_payable_allocations!payment_transaction_id(allocated_amount)")
      .eq("type", "payable_payment").eq("status", "confirmed").eq("source_snapshot->>prepayment", "true");
    if (partyId !== null) query = query.eq("party_id", partyId);
    const { data, error } = await query.order("business_date", { ascending: true }).order("id", { ascending: true }).range(from, from + 999);
    if (error) { console.error("[LEDGER_PREPAYMENTS_GET_FAILED]", { code: error.code }); return ledgerJson({ ok: false, code: "PREPAYMENTS_LOAD_FAILED" }, 500); }
    rows.push(...(data ?? []) as typeof rows);
    if ((data?.length ?? 0) < 1000) break;
  }
  const prepayments: UnusedPrepayment[] = rows.map(row => ({
    id: Number(row.id), partyId: Number(row.party_id), businessDate: row.business_date, amount: Number(row.amount),
    unusedAmount: unusedPrepaymentAmount(row.amount, row.allocations), memo: row.memo,
  })).filter(row => row.unusedAmount > 0);
  return ledgerJson({ ok: true, prepayments });
}

// Registers a prepayment paid before receipt: one outflow, no expense, no allocation.
export async function POST(request: Request) {
  const auth = await requireLedgerActor(); if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const allowed = new Set(["requestId", "partyId", "fundAccountId", "occurredAt", "amount", "memo"]);
  if (!body || Object.keys(body).some(key => !allowed.has(key)) || !Number.isSafeInteger(Number(body.partyId)) || !Number.isSafeInteger(Number(body.fundAccountId))
    || typeof body.occurredAt !== "string" || !Number.isFinite(Number(body.amount))) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  if (typeof body.requestId !== "string" || !UUID.test(body.requestId)) return ledgerJson({ ok: false, code: "INVALID_REQUEST_ID" }, 400);
  const { data, error } = await supabaseServer.rpc("ledger_create_supplier_prepayment_v1", {
    p_request_id: body.requestId, p_party_id: Number(body.partyId), p_fund_account_id: Number(body.fundAccountId),
    p_occurred_at: body.occurredAt, p_amount: Number(body.amount), p_memo: typeof body.memo === "string" ? body.memo : null, p_actor_user_id: auth.actor.id,
  });
  if (error) {
    if (String(error.message ?? "").includes("LEDGER_MONTH_CLOSED")) return ledgerJson({ ok: false, code: "LEDGER_MONTH_CLOSED" }, 409);
    console.error("[LEDGER_PREPAYMENT_CREATE_FAILED]", { code: error.code });
    return ledgerJson({ ok: false, code: "PREPAYMENT_CREATE_FAILED" }, 500);
  }
  const result = data as { status?: string } | null;
  if (result?.status !== "created") {
    const status = result?.status ?? "PREPAYMENT_CREATE_FAILED";
    return ledgerJson({ ok: false, code: status.toUpperCase() }, status === "forbidden" ? 403 : status.startsWith("idempotency") ? 409 : 400);
  }
  return ledgerJson({ ok: true, result }, 201);
}
