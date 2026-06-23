import { NextResponse } from "next/server";
import { getBusinessDate } from "@/lib/common/business-time";
import { supabaseServer } from "@/lib/supabase/server";

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
  receipt_id: number | null;
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

function buildPaymentSummary(payments: PaymentRow[]) {
  return payments.reduce(
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

      return sum + Math.max(0, adjustedTaxAmount - originalTaxAmount);
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
  try {
    const { searchParams } = new URL(req.url);
    const businessDate = searchParams.get("businessDate") || getBusinessDate();

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

    const { data: receipts, error: receiptsError } = await supabaseServer
      .from("pos_sales_receipts")
      .select(
        "id, ref_id, business_date, ref_date, payment_status, is_canceled, total_amount, final_amount, vat_amount, is_modified, original_tax_summary, original_amount_summary"
      )
      .eq("business_date", businessDate);

    if (receiptsError) {
      throw new Error(`Failed to fetch sales receipts: ${receiptsError.message}`);
    }

    const { data: lines, error: linesError } = await supabaseServer
      .from("pos_sales_receipt_lines")
      .select(
        "id, receipt_id, business_date, payment_status, is_canceled, is_option, is_excluded, mapping_status, item_code, item_name, quantity, amount, final_amount, tax_rate, tax_amount"
      )
      .eq("business_date", businessDate);

    if (linesError) {
      throw new Error(`Failed to fetch sales lines: ${linesError.message}`);
    }

    const { data: payments, error: paymentsError } = await supabaseServer
      .from("pos_sales_receipt_payments")
      .select("receipt_id, payment_type, payment_name, card_name, amount")
      .eq("business_date", businessDate);

    if (paymentsError) {
      throw new Error(`Failed to fetch sales payments: ${paymentsError.message}`);
    }

    const receiptRows = (receipts || []) as ReceiptRow[];
    const lineRows = (lines || []) as LineRow[];
    const paymentRows = (payments || []) as PaymentRow[];

    const paidReceipts = receiptRows.filter((receipt) =>
      isPaid(receipt.payment_status)
    );
    const paidReceiptIds = new Set(paidReceipts.map((receipt) => receipt.id));
    const paidPaymentRows = paymentRows.filter(
      (payment) => payment.receipt_id !== null && paidReceiptIds.has(payment.receipt_id)
    );
    const canceledReceipts = receiptRows.filter(isCanceled);
    const totalSales = paidReceipts.reduce(
      (sum, receipt) => sum + toNumber(receipt.total_amount),
      0
    );
    const paidReceiptCount = paidReceipts.length;
    const paidActiveLines = lineRows.filter((line) =>
      isPaidReceiptLine(line, paidReceiptIds)
    );
    const summary = {
      totalSales,
      receiptCount: paidReceiptCount,
      paidReceiptCount,
      canceledReceiptCount: canceledReceipts.length,
      lineCount: paidActiveLines.length,
      salesLineCount: paidActiveLines.filter(isSalesLine).length,
      optionLineCount: paidActiveLines.filter(isOptionLine).length,
      averageReceiptAmount:
        paidReceiptCount > 0 ? Math.round(totalSales / paidReceiptCount) : 0,
      deductionTargetLineCount: paidActiveLines.filter(isDeductionTargetLine).length,
    };

    return NextResponse.json({
      ok: true,
      businessDate,
      summary,
      status: {
        paid: paidReceiptCount,
        canceled: canceledReceipts.length,
      },
      paymentSummary: buildPaymentSummary(paidPaymentRows),
      taxSummary: buildTaxSummary(receiptRows, lineRows),
      hourlySales: buildHourlySales(receiptRows),
      topItems: buildTopItems(lineRows, paidReceiptIds),
    });
  } catch (error) {
    console.error("[SALES_TODAY_GET_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch today's sales.",
      },
      { status: 500 }
    );
  }
}
