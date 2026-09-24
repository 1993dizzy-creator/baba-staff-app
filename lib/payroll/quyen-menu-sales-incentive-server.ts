import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import {
  buildMenuSales,
  type MenuSalesLineRow,
  type MenuSalesReceiptRow,
} from "@/lib/sales/menu-sales";
import {
  calculateQuyenMenuSalesIncentive,
  syncQuyenMenuSalesIncentive,
  type QuyenMenuSalesIncentiveRepository,
  type SalesMenuIncentiveAdjustmentInput,
} from "@/lib/payroll/quyen-menu-sales-incentive";

const PAGE_SIZE = 1000;

function monthRange(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { fromDate: `${month}-01`, toDate: `${month}-${String(lastDay).padStart(2, "0")}` };
}

async function loadMonthlyMenuSales(month: string) {
  const { fromDate, toDate } = monthRange(month);
  const receiptsPromise = supabaseServer
    .from("pos_sales_receipts")
    .select("id,ref_no,business_date,ref_date,payment_status,is_canceled")
    .gte("business_date", fromDate)
    .lte("business_date", toDate);
  const lines: MenuSalesLineRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabaseServer
      .from("pos_sales_receipt_lines")
      .select("id,receipt_id,ref_detail_id,parent_ref_detail_id,business_date,payment_status,is_canceled,item_id,item_code,item_name,quantity,final_amount,is_option,ref_detail_type,mapping_status,is_excluded,raw_json")
      .gte("business_date", fromDate)
      .lte("business_date", toDate)
      .order("business_date", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`QUYEN_MENU_INCENTIVE_LINES_READ_FAILED:${error.message}`);
    const page = (data || []) as MenuSalesLineRow[];
    lines.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  const { data: receipts, error: receiptsError } = await receiptsPromise;
  if (receiptsError) throw new Error(`QUYEN_MENU_INCENTIVE_RECEIPTS_READ_FAILED:${receiptsError.message}`);

  // Category metadata does not change item quantity/amount. Empty category
  // inputs intentionally reuse the exact monthly menu-sales eligibility and
  // option-parent calculation without issuing unrelated category queries.
  return buildMenuSales((receipts || []) as MenuSalesReceiptRow[], lines, [], []);
}

function adjustmentValues(input: SalesMenuIncentiveAdjustmentInput) {
  return {
    user_id: input.userId,
    payroll_month: input.payrollMonth,
    kind: input.kind,
    category: input.category,
    amount: input.amount,
    business_date: input.businessDate,
    reason: input.reason,
    note: input.note,
    source_type: input.sourceType,
    source_key: input.sourceKey,
    created_by: input.createdBy,
    cancelled_at: null,
    cancelled_by: null,
    cancellation_reason: null,
  };
}

const repository: QuyenMenuSalesIncentiveRepository = {
  async resolveUserId(username, systemAccount) {
    const { data, error } = await supabaseServer
      .from("users")
      .select("id")
      .eq("username", username)
      .eq("is_system_account", systemAccount)
      .maybeSingle();
    if (error) throw error;
    return data?.id ? Number(data.id) : null;
  },
  async isPayrollPaid(month, userId) {
    const { data: batch, error: batchError } = await supabaseServer
      .from("payroll_payment_batches")
      .select("id")
      .eq("payroll_month", `${month}-01`)
      .maybeSingle();
    if (batchError) throw batchError;
    if (!batch) return false;
    const { data, error } = await supabaseServer
      .from("payroll_employee_payments")
      .select("id")
      .eq("payroll_batch_id", batch.id)
      .eq("user_id", userId)
      .eq("payment_status", "paid")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  },
  async findAdjustment(sourceType, sourceKey) {
    const { data, error } = await supabaseServer
      .from("payroll_monthly_adjustments")
      .select("id,amount,business_date,reason,note,cancelled_at")
      .eq("source_type", sourceType)
      .eq("source_key", sourceKey)
      .maybeSingle();
    if (error) throw error;
    return data ? {
      id: Number(data.id),
      amount: Number(data.amount),
      businessDate: String(data.business_date),
      reason: String(data.reason),
      note: data.note ? String(data.note) : null,
      cancelledAt: data.cancelled_at ? String(data.cancelled_at) : null,
    } : null;
  },
  async createAdjustment(input) {
    const { error } = await supabaseServer.from("payroll_monthly_adjustments").insert(adjustmentValues(input));
    // The partial unique index is the final concurrency guard. A concurrent
    // retry may win after our read; that is still a successful idempotent run.
    if (error && error.code !== "23505") throw error;
  },
  async updateAdjustment(id, input) {
    const { error } = await supabaseServer
      .from("payroll_monthly_adjustments")
      .update(adjustmentValues(input))
      .eq("id", id)
      .eq("source_type", input.sourceType);
    if (error) throw error;
  },
};

export async function runQuyenMenuSalesIncentive(month: string) {
  const menuSales = await loadMonthlyMenuSales(month);
  const calculation = calculateQuyenMenuSalesIncentive(month, menuSales.items);
  try {
    return await syncQuyenMenuSalesIncentive({ calculation, repository });
  } catch (error) {
    if (error instanceof Error && error.message.includes("PAYROLL_ADJUSTMENT_LOCKED_FOR_PAID_EMPLOYEE")) {
      return { status: "locked" as const, month };
    }
    throw error;
  }
}
