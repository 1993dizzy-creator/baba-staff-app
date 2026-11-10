import { requireRole } from "@/lib/auth/server-auth";
import { NextResponse } from "next/server";
import { calculateModifiedReceiptTaxSaving } from "@/lib/sales/tax-saving";
import { resolveAdminSalesBusinessDate } from "@/lib/sales/admin-sales-business-time";
import { findOldestPendingCloseHoldDate } from "@/lib/sales/pos-pending-payment";
import { supabaseServer } from "@/lib/supabase/server";
import { buildPaymentSummary } from "@/lib/sales/payment-summary";
import {
  buildDailyPaymentSales,
  compareDailyCloseSnapshot,
  fetchAllExactPages,
  type DailyCloseSnapshotRow,
} from "@/lib/sales/daily-sales-summary";
import { getOpenOrdersReadDiagnostic, loadOpenOrderKpi } from "@/lib/sales/open-orders-read-server";

type ReceiptRow = {
  id: number;
  ref_id: string;
  business_date: string;
  ref_date: string | null;
  payment_status: number | null;
  is_canceled: boolean | null;
  total_amount: number | string | null;
  final_amount: number | string | null;
  vat_amount: number | string | null;
  is_modified: boolean | null;
  original_tax_summary: unknown | null;
  original_amount_summary: unknown | null;
  tax_override_mode: "apply" | "exclude_all" | null;
};

type LineRow = {
  id: number;
  receipt_id: number | null;
  business_date: string;
  payment_status: number | null;
  is_canceled: boolean | null;
  is_option: boolean | null;
  is_excluded: boolean | null;
  mapping_status: string | null;
  item_code: string | null;
  item_name: string | null;
  quantity: number | string | null;
  amount: number | string | null;
  final_amount: number | string | null;
  tax_rate: number | string | null;
  tax_amount: number | string | null;
};

type PaymentRow = {
  id: number | null;
  receipt_id: number | null;
  business_date: string;
  payment_type: number | null;
  payment_name: string | null;
  card_name: string | null;
  amount: number | string | null;
};

type HourlyBucket = {
  hour: string;
  amount: number;
  receiptCount: number;
};

type TopItemBucket = {
  itemCode: string;
  itemName: string;
  quantity: number;
  amount: number;
};

type TaxBucket = {
  taxRate: number;
  taxAmount: number;
  lineCount: number;
};

type TaxSummarySnapshot = {
  totalTaxAmount: number;
  taxByRate: TaxBucket[];
};

type AmountSummarySnapshot = {
  totalAmount: number;
  vatAmount: number;
  finalAmount: number;
  paymentTotalAmount: number;
};

const PAID_PAYMENT_STATUS = 3;
const CANCELED_PAYMENT_STATUSES = new Set([4, 5]);
const DEDUCTION_TARGET_MAPPING_STATUSES = new Set([
  "unmapped",
  "direct",
  "manual",
  "recipe",
]);

const businessHourOrder = [
  "16:00",
  "17:00",
  "18:00",
  "19:00",
  "20:00",
  "21:00",
  "22:00",
  "23:00",
  "00:00",
  "01:00",
  "02:00",
  "03:00",
];

const vietnamHourFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Ho_Chi_Minh",
  hour: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

function isValidBusinessDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toNumber(value: number | string | null | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function isPaid(paymentStatus: number | null) {
  return paymentStatus === PAID_PAYMENT_STATUS;
}

function isCanceled(row: Pick<ReceiptRow | LineRow, "payment_status" | "is_canceled">) {
  return (
    row.is_canceled === true ||
    CANCELED_PAYMENT_STATUSES.has(Number(row.payment_status))
  );
}

function isOptionLine(row: Pick<LineRow, "is_option" | "mapping_status">) {
  return row.is_option === true || row.mapping_status === "option";
}

function isDeductionTargetLine(row: LineRow) {
  return (
    isPaid(row.payment_status) &&
    !isOptionLine(row) &&
    row.is_excluded !== true &&
    DEDUCTION_TARGET_MAPPING_STATUSES.has(row.mapping_status || "")
  );
}

function isPaidReceiptLine(line: LineRow, paidReceiptIds: Set<number>) {
  return (
    line.receipt_id !== null &&
    paidReceiptIds.has(line.receipt_id) &&
    isPaid(line.payment_status) &&
    !isCanceled(line) &&
    line.is_excluded !== true
  );
}

function isSalesLine(line: LineRow) {
  return !isOptionLine(line);
}

function getVietnamHourLabel(value: string | null) {
  if (!value) return null;

  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  const hour = vietnamHourFormatter.format(date).padStart(2, "0");
  return `${hour}:00`;
}

function buildHourlySales(receipts: ReceiptRow[]) {
  const map = new Map<string, HourlyBucket>();

  receipts
    .filter((receipt) => isPaid(receipt.payment_status))
    .forEach((receipt) => {
      const hour = getVietnamHourLabel(receipt.ref_date);

      if (!hour) return;

      const current =
        map.get(hour) ||
        ({
          hour,
          amount: 0,
          receiptCount: 0,
        } satisfies HourlyBucket);

      current.amount += toNumber(receipt.total_amount);
      current.receiptCount += 1;
      map.set(hour, current);
    });

  return Array.from(map.values()).sort((a, b) => {
    const aIndex = businessHourOrder.indexOf(a.hour);
    const bIndex = businessHourOrder.indexOf(b.hour);

    if (aIndex === -1 && bIndex === -1) return a.hour.localeCompare(b.hour);
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;

    return aIndex - bIndex;
  });
}

function buildTopItems(lines: LineRow[], paidReceiptIds: Set<number>) {
  const map = new Map<string, TopItemBucket>();

  lines
    .filter((line) => {
      return (
        isPaidReceiptLine(line, paidReceiptIds) &&
        isSalesLine(line) &&
        Boolean(line.item_code)
      );
    })
    .forEach((line) => {
      const itemCode = line.item_code || "";
      const itemName = line.item_name || "";
      const key = `${itemCode}::${itemName}`;
      const current =
        map.get(key) ||
        ({
          itemCode,
          itemName,
          quantity: 0,
          amount: 0,
        } satisfies TopItemBucket);

      current.quantity += toNumber(line.quantity);
      current.amount += toNumber(line.final_amount) || toNumber(line.amount);
      map.set(key, current);
    });

  return Array.from(map.values())
    .sort((a, b) => {
      if (b.quantity !== a.quantity) return b.quantity - a.quantity;
      return b.amount - a.amount;
    })
    .slice(0, 5);
}

function normalizeTaxSummary(value: unknown): TaxSummarySnapshot | null {
  if (!value || typeof value !== "object") return null;

  const summary = value as {
    totalTaxAmount?: unknown;
    taxByRate?: unknown;
  };

  if (!Array.isArray(summary.taxByRate)) return null;

  return {
    totalTaxAmount: toNumber(summary.totalTaxAmount as number | string | null),
    taxByRate: summary.taxByRate.map((item) => {
      const row = item as {
        taxRate?: unknown;
        taxAmount?: unknown;
        lineCount?: unknown;
      };

      return {
        taxRate: toNumber(row.taxRate as number | string | null),
        taxAmount: toNumber(row.taxAmount as number | string | null),
        lineCount: toNumber(row.lineCount as number | string | null),
      };
    }),
  };
}

function normalizeAmountSummary(value: unknown): AmountSummarySnapshot | null {
  if (!value || typeof value !== "object") return null;

  const summary = value as {
    totalAmount?: unknown;
    vatAmount?: unknown;
    finalAmount?: unknown;
    paymentTotalAmount?: unknown;
  };

  return {
    totalAmount: toNumber(summary.totalAmount as number | string | null),
    vatAmount: toNumber(summary.vatAmount as number | string | null),
    finalAmount: toNumber(summary.finalAmount as number | string | null),
    paymentTotalAmount: toNumber(
      summary.paymentTotalAmount as number | string | null
    ),
  };
}

function getReceiptTaxAmount(receipt: ReceiptRow) {
  const originalTaxSummary = normalizeTaxSummary(receipt.original_tax_summary);

  if (receipt.tax_override_mode === "exclude_all") return 0;
  if (receipt.tax_override_mode === "apply") {
    return originalTaxSummary?.totalTaxAmount ?? toNumber(receipt.vat_amount);
  }

  if (receipt.is_modified && originalTaxSummary) {
    return originalTaxSummary.totalTaxAmount;
  }

  return toNumber(receipt.vat_amount);
}

function getOriginalFinalAmount(receipt: ReceiptRow) {
  const originalAmountSummary = normalizeAmountSummary(
    receipt.original_amount_summary
  );

  if (originalAmountSummary) {
    return (
      originalAmountSummary.finalAmount ||
      originalAmountSummary.paymentTotalAmount ||
      0
    );
  }

  return toNumber(receipt.final_amount);
}

function getOriginalTaxAmount(receipt: ReceiptRow) {
  const originalTaxSummary = normalizeTaxSummary(receipt.original_tax_summary);
  return originalTaxSummary?.totalTaxAmount || toNumber(receipt.vat_amount);
}

function getAdjustedTaxAmount(lines: LineRow[]) {
  return lines.reduce((sum, line) => sum + toNumber(line.tax_amount), 0);
}

function addTaxBucket(
  map: Map<number, TaxBucket>,
  taxRate: number,
  taxAmount: number,
  lineCount: number
) {
  if (taxRate === 0 && taxAmount === 0) return;

  const current =
    map.get(taxRate) ||
    ({
      taxRate,
      taxAmount: 0,
      lineCount: 0,
    } satisfies TaxBucket);

  current.taxAmount += taxAmount;
  current.lineCount += lineCount;
  map.set(taxRate, current);
}

function buildTaxSummary(receipts: ReceiptRow[], lines: LineRow[]) {
  const map = new Map<number, TaxBucket>();
  const paidReceiptIds = new Set(
    receipts
      .filter((receipt) => isPaid(receipt.payment_status))
      .map((receipt) => receipt.id)
  );
  const linesByReceiptId = new Map<number, LineRow[]>();

  lines.forEach((line) => {
    if (
      line.receipt_id === null ||
      !paidReceiptIds.has(line.receipt_id) ||
      line.is_excluded === true
    ) {
      return;
    }

    const current = linesByReceiptId.get(line.receipt_id) || [];
    current.push(line);
    linesByReceiptId.set(line.receipt_id, current);
  });

  receipts
    .filter((receipt) => isPaid(receipt.payment_status))
    .forEach((receipt) => {
      const originalTaxSummary = normalizeTaxSummary(receipt.original_tax_summary);

      if (receipt.is_modified) {
        if (receipt.tax_override_mode === "exclude_all") return;
        if (originalTaxSummary) {
          originalTaxSummary.taxByRate.forEach((tax) => {
            addTaxBucket(map, tax.taxRate, tax.taxAmount, tax.lineCount);
          });
        }
        return;
      }

      (linesByReceiptId.get(receipt.id) || []).forEach((line) => {
        addTaxBucket(
          map,
          toNumber(line.tax_rate),
          toNumber(line.tax_amount),
          1
        );
      });
    });

  const taxByRate = Array.from(map.values()).sort(
    (a, b) => a.taxRate - b.taxRate
  );

  return {
    totalTaxAmount: receipts.reduce(
      (sum, receipt) =>
        isPaid(receipt.payment_status) ? sum + getReceiptTaxAmount(receipt) : sum,
      0
    ),
    taxByRate,
    taxSavingAmount: buildTaxSavingAmount(receipts, linesByReceiptId),
    amountDifferenceAmount: buildAmountDifferenceAmount(receipts),
  };
}

function buildTaxSavingAmount(
  receipts: ReceiptRow[],
  linesByReceiptId: Map<number, LineRow[]>
) {
  return receipts
    .filter((receipt) => isPaid(receipt.payment_status) && receipt.is_modified)
    .reduce((sum, receipt) => {
      const receiptLines = linesByReceiptId.get(receipt.id) || [];
      const originalTaxAmount = getOriginalTaxAmount(receipt);
      const adjustedTaxAmount = getAdjustedTaxAmount(receiptLines);

      return sum + calculateModifiedReceiptTaxSaving({
        taxOverrideMode: receipt.tax_override_mode,
        originalTaxAmount,
        adjustedTaxAmount,
        appliedTaxAmount: getReceiptTaxAmount(receipt),
      });
    }, 0);
}

function buildAmountDifferenceAmount(receipts: ReceiptRow[]) {
  return receipts
    .filter((receipt) => isPaid(receipt.payment_status) && receipt.is_modified)
    .reduce((sum, receipt) => {
      const originalFinalAmount = getOriginalFinalAmount(receipt);
      const adjustedFinalAmount = toNumber(receipt.final_amount);

      return sum + (adjustedFinalAmount - originalFinalAmount);
    }, 0);
}

export async function GET(req: Request) {
    const auth = await requireRole(["owner", "master", "manager"]);
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code }, { status: auth.status });

  const openOrdersReadDiagnostic = getOpenOrdersReadDiagnostic();
  try {
    const { searchParams } = new URL(req.url);
    const explicitBusinessDate = searchParams.get("businessDate");
    const resolved = await resolveAdminSalesBusinessDate(explicitBusinessDate);
    // A day whose close is held by pending POS payments stays the default until closed.
    const businessDate = explicitBusinessDate
      ? resolved.businessDate
      : (await findOldestPendingCloseHoldDate(resolved.businessDate)) ?? resolved.businessDate;

    if (!isValidBusinessDate(businessDate)) {
      return NextResponse.json(
        {
          ok: false,
          error: "businessDate must use YYYY-MM-DD format.",
          example: "/api/admin/sales/today?businessDate=2026-05-09",
        },
        { status: 400 }
      );
    }

    // Latest confirmed close (read-only), started alongside the three source reads.
    // Promise.resolve starts the lazy query builder now instead of at the later await.
    const closurePromise = Promise.resolve(
      supabaseServer
        .from("pos_sales_business_day_closures")
        .select("revision, closed_at, source_snapshot")
        .eq("business_date", businessDate)
        .order("revision", { ascending: false })
        .limit(1)
        .maybeSingle()
    );

    const [
      { data: receipts, error: receiptsError },
      { data: lines, error: linesError },
      { data: payments, error: paymentsError },
    ] = await Promise.all([
      // Paged with exact counts: an incomplete read fails instead of showing a partial total.
      fetchAllExactPages<ReceiptRow>((from, to) =>
        supabaseServer
          .from("pos_sales_receipts")
          .select(
            "id, ref_id, business_date, ref_date, payment_status, is_canceled, total_amount, final_amount, vat_amount, is_modified, original_tax_summary, original_amount_summary, tax_override_mode",
            { count: "exact" }
          )
          .eq("business_date", businessDate)
          .order("id", { ascending: true })
          .range(from, to)
      ),
      fetchAllExactPages<LineRow>((from, to) =>
        supabaseServer
          .from("pos_sales_receipt_lines")
          .select(
            "id, receipt_id, business_date, payment_status, is_canceled, is_option, is_excluded, mapping_status, item_code, item_name, quantity, amount, final_amount, tax_rate, tax_amount",
            { count: "exact" }
          )
          .eq("business_date", businessDate)
          .order("id", { ascending: true })
          .range(from, to)
      ),
      fetchAllExactPages<PaymentRow>((from, to) =>
        supabaseServer
          .from("pos_sales_receipt_payments")
          .select("id, receipt_id, business_date, payment_type, payment_name, card_name, amount", {
            count: "exact",
          })
          .eq("business_date", businessDate)
          .order("id", { ascending: true })
          .range(from, to)
      ),
    ]);

    if (receiptsError) {
      throw new Error(`Failed to fetch sales receipts: ${receiptsError.message}`);
    }

    if (linesError) {
      throw new Error(`Failed to fetch sales lines: ${linesError.message}`);
    }

    if (paymentsError) {
      throw new Error(`Failed to fetch sales payments: ${paymentsError.message}`);
    }

    const receiptRows = receipts ?? [];
    const lineRows = lines ?? [];
    const paymentRows = payments ?? [];

    // Total sales = POS payments of paid, non-canceled receipts; split payments count once per payment id.
    const dailySales = buildDailyPaymentSales(receiptRows, paymentRows);
    // Sold-item counts and top items use the same paid, non-canceled receipts as totals and receipt count.
    const paidReceiptIds = new Set(dailySales.paidReceipts.map((receipt) => receipt.id));
    const paidPaymentRows = dailySales.paidPaymentRows;
    const canceledReceipts = receiptRows.filter(isCanceled);
    const totalSales = dailySales.totalSales;
    const paidReceiptCount = dailySales.paidReceiptCount;
    const paidActiveLines = lineRows.filter((line) =>
      isPaidReceiptLine(line, paidReceiptIds)
    );

    const { data: closure, error: closureError } = await closurePromise;
    if (closureError) {
      throw new Error(`Failed to fetch sales close: ${closureError.message}`);
    }

    const summary = {
      totalSales,
      receiptCount: paidReceiptCount,
      paidReceiptCount,
      canceledReceiptCount: canceledReceipts.length,
      lineCount: paidActiveLines.length,
      salesLineCount: paidActiveLines.filter(isSalesLine).length,
      optionLineCount: paidActiveLines.filter(isOptionLine).length,
      averageReceiptAmount: dailySales.averageReceiptAmount,
      deductionTargetLineCount: paidActiveLines.filter(isDeductionTargetLine).length,
    };
    const closeCheck = compareDailyCloseSnapshot(
      (closure as DailyCloseSnapshotRow | null) ?? null,
      totalSales
    );
    // Separate from summary: paid KPIs above never include open-order estimates.
    // Returns status "not_enabled" (no extra reads) until POS_OPEN_ORDERS_READ_ENABLED=true.
    const openOrders = await loadOpenOrderKpi({
      businessDate,
      isClosed: closeCheck.status !== "not_closed",
      paid: { amount: totalSales, receiptCount: paidReceiptCount },
    });

    return NextResponse.json({
      ok: true,
      businessDate,
      summary,
      status: {
        paid: paidReceiptCount,
        canceled: canceledReceipts.length,
      },
      paymentSummary: buildPaymentSummary(paidPaymentRows),
      paymentReconciliation: dailySales.reconciliation,
      closeCheck,
      openOrders,
      openOrdersReadDiagnostic,
      taxSummary: buildTaxSummary(receiptRows, lineRows),
      hourlySales: buildHourlySales(receiptRows),
      topItems: buildTopItems(lineRows, paidReceiptIds),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[SALES_TODAY_GET_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        openOrdersReadDiagnostic,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch today's sales.",
      },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
