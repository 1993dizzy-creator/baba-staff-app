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
  final_amount: number | string | null;
  review_status: string | null;
};

type LineRow = {
  id: number;
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
    row.is_excluded === false &&
    DEDUCTION_TARGET_MAPPING_STATUSES.has(row.mapping_status || "")
  );
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

      current.amount += toNumber(receipt.final_amount);
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

function buildTopItems(lines: LineRow[]) {
  const map = new Map<string, TopItemBucket>();

  lines
    .filter((line) => {
      return (
        isPaid(line.payment_status) &&
        !isOptionLine(line) &&
        line.is_excluded === false &&
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
        "id, ref_id, business_date, ref_date, payment_status, is_canceled, final_amount, review_status"
      )
      .eq("business_date", businessDate);

    if (receiptsError) {
      throw new Error(`Failed to fetch sales receipts: ${receiptsError.message}`);
    }

    const { data: lines, error: linesError } = await supabaseServer
      .from("pos_sales_receipt_lines")
      .select(
        "id, business_date, payment_status, is_canceled, is_option, is_excluded, mapping_status, item_code, item_name, quantity, amount, final_amount"
      )
      .eq("business_date", businessDate);

    if (linesError) {
      throw new Error(`Failed to fetch sales lines: ${linesError.message}`);
    }

    const receiptRows = (receipts || []) as ReceiptRow[];
    const lineRows = (lines || []) as LineRow[];

    const paidReceipts = receiptRows.filter((receipt) =>
      isPaid(receipt.payment_status)
    );
    const canceledReceipts = receiptRows.filter(isCanceled);
    const totalSales = paidReceipts.reduce(
      (sum, receipt) => sum + toNumber(receipt.final_amount),
      0
    );
    const paidReceiptCount = paidReceipts.length;
    const uncheckedCount = receiptRows.filter(
      (receipt) => receipt.review_status === "unchecked"
    ).length;
    const checkedCount = receiptRows.filter(
      (receipt) => receipt.review_status === "checked"
    ).length;
    const needsReviewCount = receiptRows.filter(
      (receipt) => receipt.review_status === "needs_review"
    ).length;

    const summary = {
      totalSales,
      receiptCount: receiptRows.length,
      paidReceiptCount,
      canceledReceiptCount: canceledReceipts.length,
      lineCount: lineRows.length,
      salesLineCount: lineRows.filter((line) => line.is_option === false).length,
      optionLineCount: lineRows.filter(isOptionLine).length,
      averageReceiptAmount:
        paidReceiptCount > 0 ? Math.round(totalSales / paidReceiptCount) : 0,
      deductionTargetLineCount: lineRows.filter(isDeductionTargetLine).length,
    };

    return NextResponse.json({
      ok: true,
      businessDate,
      summary,
      status: {
        paid: paidReceiptCount,
        canceled: canceledReceipts.length,
        needsReview: needsReviewCount,
        unchecked: uncheckedCount,
        checked: checkedCount,
      },
      hourlySales: buildHourlySales(receiptRows),
      topItems: buildTopItems(lineRows),
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
