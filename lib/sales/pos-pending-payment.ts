import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { addStoreDays } from "@/lib/store-settings/business-time-core";
import {
  getPendingPaymentSince,
  isPendingPaymentReviewDue,
  POS_PENDING_HOLD_FAILURE_CODE,
  selectPendingCloseHoldDates,
} from "./pos-pending-payment-policy";

export type PendingPaymentReceipt = {
  id: number; refNo: string | null; tableName: string | null; finalAmount: number;
  pendingSince: string | null; reviewDue: boolean;
};
export type PendingPaymentSummary = { count: number; totalAmount: number; receipts: PendingPaymentReceipt[] };

export async function loadPendingPaymentReceipts(businessDate: string, now = new Date()): Promise<PendingPaymentSummary> {
  const { data, error } = await supabaseServer.from("pos_sales_receipts")
    .select("id,ref_no,table_name,final_amount,ref_date,status_changed_at")
    .eq("business_date", businessDate).eq("source", "cukcuk").eq("payment_status", 1).not("is_canceled", "is", true)
    .order("ref_date", { ascending: true, nullsFirst: true }).order("id", { ascending: true });
  if (error) throw error;
  const receipts = (data ?? []).map((row) => {
    const state = { paymentStatus: 1, isCanceled: false, statusChangedAt: row.status_changed_at, refDate: row.ref_date };
    return { id: Number(row.id), refNo: row.ref_no, tableName: row.table_name, finalAmount: Number(row.final_amount ?? 0),
      pendingSince: getPendingPaymentSince(state), reviewDue: isPendingPaymentReviewDue(state, now) };
  });
  return { count: receipts.length, totalAmount: receipts.reduce((sum, row) => sum + row.finalAmount, 0), receipts };
}

// Evidence is the existing 03:05 final check row (failureCode = pending_payment);
// a later closure of that date releases the hold. No separate hold state is stored.
// previousBusinessDate (optional) also counts while it is unclosed and still has active
// pending receipts: covers 03:00-03:05 and a manual close held before the 03:05 record.
export async function loadPendingCloseHoldDates(previousBusinessDate?: string): Promise<string[]> {
  const [{ data: checks, error }, previous] = await Promise.all([
    supabaseServer.from("pos_sales_business_day_close_checks")
      .select("business_date").is("closure_id", null)
      .eq("detail_snapshot->>failureCode", POS_PENDING_HOLD_FAILURE_CODE)
      .order("business_date", { ascending: false }).limit(200),
    previousBusinessDate
      ? supabaseServer.from("pos_sales_receipts").select("id", { count: "exact", head: true })
        .eq("business_date", previousBusinessDate).eq("source", "cukcuk").eq("payment_status", 1).not("is_canceled", "is", true)
      : Promise.resolve({ count: 0, error: null }),
  ]);
  if (error) throw error;
  if (previous.error) throw previous.error;
  const dates = [...new Set([...(checks ?? []).map((row) => String(row.business_date)),
    ...(previousBusinessDate && Number(previous.count) > 0 ? [previousBusinessDate] : [])])];
  if (dates.length === 0) return [];
  const { data: closures, error: closureError } = await supabaseServer.from("pos_sales_business_day_closures")
    .select("business_date").in("business_date", dates);
  if (closureError) throw closureError;
  return selectPendingCloseHoldDates(dates, (closures ?? []).map((row) => String(row.business_date)));
}

export async function findOldestPendingCloseHoldDate(currentBusinessDate: string) {
  try {
    return (await loadPendingCloseHoldDates(addStoreDays(currentBusinessDate, -1)))[0] ?? null;
  } catch (error) {
    // Fall back to the normal business date; the close panel still blocks the close.
    console.error("[SALES_PENDING_HOLD_LOOKUP_FAILED]", error instanceof Error ? error.message : String(error));
    return null;
  }
}
