import { NextResponse } from "next/server";
import { getBusinessDate } from "@/lib/common/business-time";
import { supabaseServer } from "@/lib/supabase/server";

type ReceiptRow = {
  id: number;
  ref_id: string;
  ref_no: string | null;
  table_name: string | null;
  ref_date: string | null;
  payment_status: number | null;
  is_canceled: boolean | null;
  total_amount: number | string | null;
  final_amount: number | string | null;
  is_modified: boolean | null;
  review_status: string | null;
  admin_note: string | null;
};

type LineRow = {
  receipt_ref_id: string;
  is_option: boolean | null;
  mapping_status: string | null;
};

type PaymentRow = {
  receipt_id: number;
  payment_name: string | null;
  card_name: string | null;
  amount: number | string | null;
};

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

function isOptionLine(row: Pick<LineRow, "is_option" | "mapping_status">) {
  return row.is_option === true || row.mapping_status === "option";
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
          example: "/api/admin/sales/receipts?businessDate=2026-05-09",
        },
        { status: 400 }
      );
    }

    const { data: receipts, error: receiptsError } = await supabaseServer
      .from("pos_sales_receipts")
      .select(
        "id, ref_id, ref_no, table_name, ref_date, payment_status, is_canceled, total_amount, final_amount, is_modified, review_status, admin_note"
      )
      .eq("business_date", businessDate)
      .order("ref_date", { ascending: false });

    if (receiptsError) {
      throw new Error(`Failed to fetch sales receipts: ${receiptsError.message}`);
    }

    const receiptRows = (receipts || []) as ReceiptRow[];
    const receiptIds = receiptRows.map((receipt) => receipt.id);
    const receiptRefIds = receiptRows.map((receipt) => receipt.ref_id);
    const lineCountsByReceiptRefId = new Map<
      string,
      { lineCount: number; optionLineCount: number }
    >();
    const paymentsByReceiptId = new Map<number, PaymentRow[]>();

    if (receiptRefIds.length > 0) {
      const { data: lines, error: linesError } = await supabaseServer
        .from("pos_sales_receipt_lines")
        .select("receipt_ref_id, is_option, mapping_status")
        .eq("business_date", businessDate)
        .in("receipt_ref_id", receiptRefIds);

      if (linesError) {
        throw new Error(`Failed to fetch sales receipt lines: ${linesError.message}`);
      }

      ((lines || []) as LineRow[]).forEach((line) => {
        const current =
          lineCountsByReceiptRefId.get(line.receipt_ref_id) || {
            lineCount: 0,
            optionLineCount: 0,
          };

        current.lineCount += 1;

        if (isOptionLine(line)) {
          current.optionLineCount += 1;
        }

        lineCountsByReceiptRefId.set(line.receipt_ref_id, current);
      });

      const { data: payments, error: paymentsError } = await supabaseServer
        .from("pos_sales_receipt_payments")
        .select("receipt_id, payment_name, card_name, amount")
        .eq("business_date", businessDate)
        .in("receipt_id", receiptIds)
        .order("id", { ascending: true });

      if (paymentsError) {
        throw new Error(`Failed to fetch sales receipt payments: ${paymentsError.message}`);
      }

      ((payments || []) as PaymentRow[]).forEach((payment) => {
        const current = paymentsByReceiptId.get(payment.receipt_id) || [];
        current.push(payment);
        paymentsByReceiptId.set(payment.receipt_id, current);
      });
    }

    return NextResponse.json({
      ok: true,
      businessDate,
      receipts: receiptRows.map((receipt) => {
        const counts = lineCountsByReceiptRefId.get(receipt.ref_id) || {
          lineCount: 0,
          optionLineCount: 0,
        };

        return {
          id: receipt.id,
          refId: receipt.ref_id,
          refNo: receipt.ref_no,
          tableName: receipt.table_name,
          refDate: receipt.ref_date,
          paymentStatus: receipt.payment_status,
          isCanceled: receipt.is_canceled === true,
          totalAmount: toNumber(receipt.total_amount),
          finalAmount: toNumber(receipt.final_amount),
          isModified: receipt.is_modified === true,
          reviewStatus: receipt.review_status,
          adminNote: receipt.admin_note,
          lineCount: counts.lineCount,
          optionLineCount: counts.optionLineCount,
          payments: (paymentsByReceiptId.get(receipt.id) || []).map((payment) => ({
            paymentName: payment.payment_name,
            cardName: payment.card_name,
            amount: toNumber(payment.amount),
          })),
        };
      }),
    });
  } catch (error) {
    console.error("[ADMIN_SALES_RECEIPTS_GET_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch sales receipts.",
      },
      { status: 500 }
    );
  }
}
