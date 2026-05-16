import { NextResponse } from "next/server";
import { getBusinessDate } from "@/lib/common/business-time";
import { supabaseServer } from "@/lib/supabase/server";

type ReceiptRow = {
  id: number;
  business_date: string;
  payment_status: number | null;
  is_canceled: boolean | null;
  total_amount: number | string | null;
  final_amount: number | string | null;
  vat_amount: number | string | null;
  is_modified: boolean | null;
  original_tax_summary: unknown | null;
};

type LineRow = {
  id: number;
  receipt_id: number | null;
  business_date: string;
  payment_status: number | null;
  is_canceled: boolean | null;
  tax_rate: number | string | null;
  tax_amount: number | string | null;
};

type PaymentRow = {
  receipt_id: number | null;
  business_date: string;
  payment_type: number | null;
  payment_name: string | null;
  card_name: string | null;
  amount: number | string | null;
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

type PaymentSummary = {
  cashAmount: number;
  transferAmount: number;
  cardAmount: number;
  otherAmount: number;
  paymentTotalAmount: number;
};

const PAID_PAYMENT_STATUS = 3;
const CANCELED_PAYMENT_STATUSES = new Set([4, 5]);

function isValidMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}$/.test(value);
}

function getMonthRange(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();

  return {
    fromDate: `${month}-01`,
    toDate: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

function getMonthDays(month: string) {
  const { fromDate, toDate } = getMonthRange(month);
  const days: string[] = [];
  const current = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);

  while (current <= end) {
    days.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return days;
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

function normalizePaymentName(value: string | null | undefined) {
  return (value || "").trim().toLowerCase();
}

function isCashPayment(paymentName: string, cardName: string) {
  return paymentName === "tiền mặt" || cardName === "tiền mặt";
}

function isTransferPayment(paymentName: string, cardName: string) {
  return paymentName === "chuyển khoản" || cardName === "chuyển khoản";
}

function isCardLikePayment(payment: PaymentRow, paymentName: string, cardName: string) {
  if (isCashPayment(paymentName, cardName) || isTransferPayment(paymentName, cardName)) {
    return false;
  }

  return (
    payment.payment_type === 2 ||
    Boolean(cardName) ||
    paymentName.includes("visa") ||
    paymentName.includes("master") ||
    paymentName.includes("card") ||
    cardName.includes("visa") ||
    cardName.includes("master") ||
    cardName.includes("card")
  );
}

function isOtherPayment(paymentName: string, cardName: string) {
  return (
    paymentName === "khác" ||
    paymentName === "khac" ||
    cardName === "khác" ||
    cardName === "khac"
  );
}

function buildPaymentSummary(payments: PaymentRow[]): PaymentSummary {
  return payments.reduce<PaymentSummary>(
    (summary, payment) => {
      const amount = toNumber(payment.amount);
      const paymentName = normalizePaymentName(payment.payment_name);
      const cardName = normalizePaymentName(payment.card_name);

      summary.paymentTotalAmount += amount;

      if (isCashPayment(paymentName, cardName)) {
        summary.cashAmount += amount;
      } else if (isTransferPayment(paymentName, cardName)) {
        summary.transferAmount += amount;
      } else if (isCardLikePayment(payment, paymentName, cardName)) {
        summary.cardAmount += amount;
      } else if (isOtherPayment(paymentName, cardName)) {
        summary.otherAmount += amount;
      }

      return summary;
    },
    {
      cashAmount: 0,
      transferAmount: 0,
      cardAmount: 0,
      otherAmount: 0,
      paymentTotalAmount: 0,
    }
  );
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

function buildLinesByReceiptId(receipts: ReceiptRow[], lines: LineRow[]) {
  const paidReceiptIds = new Set(
    receipts
      .filter((receipt) => isPaid(receipt.payment_status))
      .map((receipt) => receipt.id)
  );
  const linesByReceiptId = new Map<number, LineRow[]>();

  lines.forEach((line) => {
    if (line.receipt_id === null || !paidReceiptIds.has(line.receipt_id)) return;

    const current = linesByReceiptId.get(line.receipt_id) || [];
    current.push(line);
    linesByReceiptId.set(line.receipt_id, current);
  });

  return linesByReceiptId;
}

function buildTaxSavingAmount(
  receipts: ReceiptRow[],
  linesByReceiptId: Map<number, LineRow[]>
) {
  return receipts
    .filter((receipt) => isPaid(receipt.payment_status) && receipt.is_modified)
    .reduce((sum, receipt) => {
      const adjustedTax = (linesByReceiptId.get(receipt.id) || []).reduce(
        (lineSum, line) => lineSum + toNumber(line.tax_amount),
        0
      );
      const originalTaxSummary = normalizeTaxSummary(receipt.original_tax_summary);
      const originalTax =
        originalTaxSummary?.totalTaxAmount || toNumber(receipt.vat_amount);

      return sum + Math.max(0, adjustedTax - originalTax);
    }, 0);
}

function buildTaxSummary(receipts: ReceiptRow[], lines: LineRow[]) {
  const map = new Map<number, TaxBucket>();
  const linesByReceiptId = buildLinesByReceiptId(receipts, lines);

  receipts
    .filter((receipt) => isPaid(receipt.payment_status))
    .forEach((receipt) => {
      const originalTaxSummary = normalizeTaxSummary(receipt.original_tax_summary);

      if (receipt.is_modified) {
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

  return {
    totalTaxAmount: receipts.reduce(
      (sum, receipt) =>
        isPaid(receipt.payment_status) ? sum + toNumber(receipt.vat_amount) : sum,
      0
    ),
    taxByRate: Array.from(map.values()).sort((a, b) => a.taxRate - b.taxRate),
    taxSavingAmount: buildTaxSavingAmount(receipts, linesByReceiptId),
  };
}

function buildMonthlySummary(receipts: ReceiptRow[]) {
  const paidReceipts = receipts.filter((receipt) => isPaid(receipt.payment_status));
  const totalSales = paidReceipts.reduce(
    (sum, receipt) => sum + toNumber(receipt.total_amount),
    0
  );
  const receiptCount = paidReceipts.length;

  return {
    totalSales,
    receiptCount,
    totalReceiptCount: receipts.length,
    canceledReceiptCount: receipts.filter(isCanceled).length,
    averageReceiptAmount:
      receiptCount > 0 ? Math.round(totalSales / receiptCount) : 0,
  };
}

function filterPaidPayments(receipts: ReceiptRow[], payments: PaymentRow[]) {
  const paidReceiptIds = new Set(
    receipts
      .filter((receipt) => isPaid(receipt.payment_status))
      .map((receipt) => receipt.id)
  );

  return payments.filter(
    (payment) => payment.receipt_id !== null && paidReceiptIds.has(payment.receipt_id)
  );
}

function buildDays(params: {
  month: string;
  receipts: ReceiptRow[];
  lines: LineRow[];
  payments: PaymentRow[];
}) {
  return getMonthDays(params.month).map((businessDate) => {
    const receipts = params.receipts.filter(
      (receipt) => receipt.business_date === businessDate
    );
    const lines = params.lines.filter((line) => line.business_date === businessDate);
    const paidReceipts = receipts.filter((receipt) => isPaid(receipt.payment_status));
    const payments = filterPaidPayments(
      receipts,
      params.payments.filter((payment) => payment.business_date === businessDate)
    );
    const paymentSummary = buildPaymentSummary(payments);
    const taxSummary = buildTaxSummary(receipts, lines);

    return {
      businessDate,
      receiptCount: paidReceipts.length,
      salesAmount: paidReceipts.reduce(
        (sum, receipt) => sum + toNumber(receipt.total_amount),
        0
      ),
      totalFinalAmount: paidReceipts.reduce(
        (sum, receipt) => sum + toNumber(receipt.total_amount),
        0
      ),
      paymentTotalAmount: paymentSummary.paymentTotalAmount,
      cashAmount: paymentSummary.cashAmount,
      transferAmount: paymentSummary.transferAmount,
      cardAmount: paymentSummary.cardAmount,
      otherAmount: paymentSummary.otherAmount,
      taxAmount: taxSummary.totalTaxAmount,
      taxSavingAmount: taxSummary.taxSavingAmount,
    };
  });
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const month = searchParams.get("month") || getBusinessDate().slice(0, 7);

    if (!isValidMonth(month)) {
      return NextResponse.json(
        {
          ok: false,
          error: "month must use YYYY-MM format.",
          example: "/api/admin/sales/monthly?month=2026-05",
        },
        { status: 400 }
      );
    }

    const { fromDate, toDate } = getMonthRange(month);

    const { data: receipts, error: receiptsError } = await supabaseServer
      .from("pos_sales_receipts")
      .select(
        "id, business_date, payment_status, is_canceled, total_amount, final_amount, vat_amount, is_modified, original_tax_summary"
      )
      .gte("business_date", fromDate)
      .lte("business_date", toDate);

    if (receiptsError) {
      throw new Error(`Failed to fetch monthly sales receipts: ${receiptsError.message}`);
    }

    const { data: lines, error: linesError } = await supabaseServer
      .from("pos_sales_receipt_lines")
      .select(
        "id, receipt_id, business_date, payment_status, is_canceled, tax_rate, tax_amount"
      )
      .gte("business_date", fromDate)
      .lte("business_date", toDate);

    if (linesError) {
      throw new Error(`Failed to fetch monthly sales lines: ${linesError.message}`);
    }

    const { data: payments, error: paymentsError } = await supabaseServer
      .from("pos_sales_receipt_payments")
      .select("receipt_id, business_date, payment_type, payment_name, card_name, amount")
      .gte("business_date", fromDate)
      .lte("business_date", toDate);

    if (paymentsError) {
      throw new Error(`Failed to fetch monthly sales payments: ${paymentsError.message}`);
    }

    const receiptRows = (receipts || []) as ReceiptRow[];
    const lineRows = (lines || []) as LineRow[];
    const paymentRows = (payments || []) as PaymentRow[];

    return NextResponse.json({
      ok: true,
      month,
      range: {
        fromDate,
        toDate,
      },
      summary: buildMonthlySummary(receiptRows),
      paymentSummary: buildPaymentSummary(filterPaidPayments(receiptRows, paymentRows)),
      taxSummary: buildTaxSummary(receiptRows, lineRows),
      days: buildDays({
        month,
        receipts: receiptRows,
        lines: lineRows,
        payments: paymentRows,
      }),
    });
  } catch (error) {
    console.error("[SALES_MONTHLY_GET_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch monthly sales.",
      },
      { status: 500 }
    );
  }
}
