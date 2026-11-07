import { rankCardReceiptCandidates, type CandidatePayment, type CandidateReceipt } from "@/lib/ledger/card-fee-receipt-candidates";
import { loadCardRows, loadCardSales } from "@/lib/ledger/card-settlement-data";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { ledgerMonthRange } from "@/lib/ledger/pos-sales";
import { supabaseServer } from "@/lib/supabase/server";
export const dynamic = "force-dynamic";
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_TARGET = 10_000_000_000;

// Read-only: POS receipts whose card payment is close to a fee difference. Loaded only
// when the review panel is opened, so the card settlement page itself stays light.
export async function GET(request: Request) {
  const auth = await requireLedgerActor(); if (auth.response) return auth.response;
  const params = new URL(request.url).searchParams;
  const month = params.get("month") ?? "", target = Number(params.get("amount"));
  if (!MONTH.test(month)) return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
  if (!Number.isSafeInteger(target) || target <= 0 || target > MAX_TARGET) return ledgerJson({ ok: false, code: "INVALID_AMOUNT" }, 400);
  try {
    const { fromDate, toDate } = ledgerMonthRange(month);
    const payments = await loadCardRows((from, to) => supabaseServer.from("pos_sales_receipt_payments")
      .select("id,receipt_id,business_date,payment_type,payment_name,card_name,amount")
      .gte("business_date", fromDate).lte("business_date", toDate).order("id").range(from, to)) as CandidatePayment[];
    const receiptIds = [...new Set(payments.map(row => Number(row.receipt_id)).filter(id => Number.isSafeInteger(id) && id > 0))];
    const receipts: CandidateReceipt[] = [];
    for (let i = 0; i < receiptIds.length; i += 200) {
      const chunk = receiptIds.slice(i, i + 200);
      receipts.push(...await loadCardRows((from, to) => supabaseServer.from("pos_sales_receipts")
        .select("id,ref_no,business_date,ref_date,payment_status,is_canceled,final_amount").in("id", chunk).order("id").range(from, to)) as CandidateReceipt[]);
    }
    const end = new Date(`${toDate}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1);
    const ledgerDays = await loadCardSales(fromDate, end.toISOString().slice(0, 10));
    const candidates = rankCardReceiptCandidates({ target, receipts, payments, ledgerDays });
    return ledgerJson({ ok: true, month, target, candidates });
  } catch (error) {
    console.error("[LEDGER_CARD_FEE_RECEIPT_CANDIDATES_FAILED]", error);
    return ledgerJson({ ok: false, code: "CARD_FEE_RECEIPT_CANDIDATES_FAILED" }, 500);
  }
}
