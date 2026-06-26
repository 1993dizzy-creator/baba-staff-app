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
  is_excluded: boolean | null;
  mapping_status: string | null;
};

type PaymentRow = {
  receipt_id: number;
  payment_name: string | null;
  card_name: string | null;
  amount: number | string | null;
};

type CreateManualReceiptBody = {
  actorUsername?: unknown;
  businessDate?: unknown;
  saleTime?: unknown;
  tableName?: unknown;
  note?: unknown;
  vatEnabled?: unknown;
  paymentMethod?: unknown;
  cashReceivedAmount?: unknown;
  manualFinalAmount?: unknown;
  lines?: unknown;
};

type ManualLineInput = {
  clientId?: unknown;
  parentClientId?: unknown;
  productId?: unknown;
  itemCode?: unknown;
  itemName?: unknown;
  unitName?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  discountAmount?: unknown;
  taxRate?: unknown;
  isOption?: unknown;
  refDetailType?: unknown;
  inventoryItemType?: unknown;
  additionId?: unknown;
  optionGroupName?: unknown;
  rawJson?: unknown;
};

type ManualProductRow = {
  id: number;
  pos_item_id: string | null;
  item_id: string | null;
  item_code: string | null;
  item_name: string;
  unit_name: string | null;
  unit_price: number | string | null;
  tax_rate: number | string | null;
  item_type: number | null;
  raw_json: unknown;
};

type ResolvedManualLine = {
  clientId: string;
  parentClientId: string | null;
  productId: number | null;
  itemId: string | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  quantity: number;
  unitPrice: number;
  lineSubtotal: number;
  discountAmount: number;
  lineFinalAmount: number;
  taxRate: number | null;
  lineTaxAmount: number;
  preTaxAmount: number;
  inventoryItemType: number | null;
  isOption: boolean;
  refDetailType: number;
  additionId: string | null;
  optionGroupName: string | null;
  rawJson: Record<string, unknown> | null;
  isAdjustment: boolean;
};

const VIETNAM_TIMEZONE_OFFSET = "+07:00";
const MANUAL_REF_NO_RETRY_COUNT = 5;

function isValidBusinessDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getManualRefNoPrefix(businessDate: string) {
  return `M-${businessDate.slice(2).replace(/-/g, "")}-`;
}

function getManualRefNo(prefix: string, sequence: number) {
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

function parseManualSaleTime(value: unknown, businessDate: string) {
  if (typeof value !== "string" || !value.trim()) return null;

  const rawValue = value.trim();
  const timeOnlyMatch = rawValue.match(/^(\d{2}):(\d{2})$/);
  const localDateTimeMatch = rawValue.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/
  );

  if (!timeOnlyMatch && !localDateTimeMatch) return null;

  const datePart = localDateTimeMatch?.[1] || businessDate;
  const hour = Number(localDateTimeMatch?.[2] || timeOnlyMatch?.[1]);
  const minute = Number(localDateTimeMatch?.[3] || timeOnlyMatch?.[2]);

  if (
    datePart !== businessDate ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour > 23 ||
    minute > 59
  ) {
    return null;
  }

  const localDateTime = [
    `${businessDate}T${String(hour).padStart(2, "0")}`,
    `${String(minute).padStart(2, "0")}:00${VIETNAM_TIMEZONE_OFFSET}`,
  ].join(":");
  const date = new Date(localDateTime);
  if (!Number.isFinite(date.getTime())) return null;

  return date.toISOString();
}

function isUniqueViolation(
  error: { code?: string; message?: string } | null | undefined
) {
  return error?.code === "23505" || /duplicate key/i.test(error?.message || "");
}

async function getNextManualRefNoSequence(businessDate: string, prefix: string) {
  const { data, error } = await supabaseServer
    .from("pos_sales_receipts")
    .select("ref_no")
    .eq("source", "manual")
    .eq("business_date", businessDate)
    .like("ref_no", `${prefix}%`);

  if (error) {
    throw new Error(`Failed to fetch manual receipt numbers: ${error.message}`);
  }

  const maxSequence = ((data || []) as { ref_no: string | null }[]).reduce(
    (max, row) => {
      const suffix = row.ref_no?.slice(prefix.length);
      return /^\d+$/.test(suffix || "")
        ? Math.max(max, Number(suffix))
        : max;
    },
    0
  );

  return maxSequence + 1;
}

function canManageManualReceipt(role: unknown) {
  return role === "owner" || role === "master" || role === "manager";
}

async function getManualReceiptActor(actorUsername: unknown) {
  if (typeof actorUsername !== "string" || !actorUsername.trim()) return null;
  const { data, error } = await supabaseServer
    .from("users")
    .select("id, username, name, role, is_active")
    .eq("username", actorUsername.trim())
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`Failed to verify admin actor: ${error.message}`);
  if (!canManageManualReceipt(data?.role)) return null;
  return data;
}

function calcManualTax(finalAmount: number, taxRate: number | null) {
  if (!taxRate || taxRate <= 0 || finalAmount <= 0) return 0;
  return Math.round((finalAmount * taxRate) / 100);
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

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asObjectArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(asObject).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function findProductAddition(product: ManualProductRow, additionId: string) {
  const raw = asObject(product.raw_json);
  const detail = asObject(raw?.Detail);
  const categories = asObjectArray(
    raw?.AdditionCategories ?? detail?.AdditionCategories
  );

  for (const category of categories) {
    const option = asObjectArray(category.Additions).find(
      (candidate) => String(candidate.Id || "") === additionId
    );

    if (!option) continue;
    if (option.InActive === true || option.Inactive === true) return null;
    return option;
  }

  return null;
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
        .select("receipt_ref_id, is_option, is_excluded, mapping_status")
        .eq("business_date", businessDate)
        .in("receipt_ref_id", receiptRefIds);

      if (linesError) {
        throw new Error(`Failed to fetch sales receipt lines: ${linesError.message}`);
      }

      ((lines || []) as LineRow[]).forEach((line) => {
        if (line.is_excluded === true) return;

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

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as CreateManualReceiptBody | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
    }

    const actor = await getManualReceiptActor(body.actorUsername);
    if (!actor) {
      return NextResponse.json({ ok: false, error: "Permission denied." }, { status: 403 });
    }

    if (!isValidBusinessDate(body.businessDate)) {
      return NextResponse.json({ ok: false, error: "businessDate must use YYYY-MM-DD format." }, { status: 400 });
    }
    const businessDate = body.businessDate as string;

    const vatEnabled = body.vatEnabled === true;

    const paymentMethod =
      body.paymentMethod === "cash" || body.paymentMethod === "other"
        ? (body.paymentMethod as "cash" | "other")
        : null;
    if (!paymentMethod) {
      return NextResponse.json({ ok: false, error: "paymentMethod must be 'cash' or 'other'." }, { status: 400 });
    }

    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      return NextResponse.json({ ok: false, error: "At least one line is required." }, { status: 400 });
    }

    const rawLines = body.lines as ManualLineInput[];

    const productIds = rawLines
      .map((l) => Number(l.productId))
      .filter((id) => Number.isInteger(id) && id > 0);

    let productMap = new Map<number, ManualProductRow>();
    if (productIds.length > 0) {
      const { data: products, error: productsError } = await supabaseServer
        .from("pos_products")
        .select("id, pos_item_id, item_id, item_code, item_name, unit_name, unit_price, tax_rate, item_type, raw_json")
        .eq("is_active", true)
        .in("id", productIds);

      if (productsError) {
        throw new Error(`Failed to fetch products: ${productsError.message}`);
      }

      productMap = new Map(
        ((products || []) as ManualProductRow[]).map((p) => [p.id, p])
      );
    }

    const resolvedLines: ResolvedManualLine[] = [];
    for (const [rawIndex, raw] of rawLines.entries()) {
      const productId = Number(raw.productId);
      const isProductLine = Number.isInteger(productId) && productId > 0;
      const clientId =
        typeof raw.clientId === "string" && raw.clientId.trim()
          ? raw.clientId.trim()
          : `manual-line-${rawIndex + 1}`;
      const parentClientId =
        typeof raw.parentClientId === "string" && raw.parentClientId.trim()
          ? raw.parentClientId.trim()
          : null;
      const isOption = raw.isOption === true;
      const additionId =
        typeof raw.additionId === "string" && raw.additionId.trim()
          ? raw.additionId.trim()
          : null;
      const optionGroupName =
        typeof raw.optionGroupName === "string" && raw.optionGroupName.trim()
          ? raw.optionGroupName.trim()
          : null;
      const rawJson =
        raw.rawJson &&
        typeof raw.rawJson === "object" &&
        !Array.isArray(raw.rawJson)
          ? (raw.rawJson as Record<string, unknown>)
          : null;
      const rawInventoryItemType = Number(raw.inventoryItemType);
      const rawRefDetailType = Number(raw.refDetailType);

      if (isOption && (!parentClientId || !additionId)) {
        return NextResponse.json(
          { ok: false, error: "parentClientId and additionId are required for option lines." },
          { status: 400 }
        );
      }
      if (!isOption && parentClientId) {
        return NextResponse.json(
          { ok: false, error: "parentClientId is only allowed for option lines." },
          { status: 400 }
        );
      }

      let itemId: string | null = null;
      let itemCode: string | null = null;
      let itemName = "";
      let unitName: string | null = null;
      let unitPrice = 0;
      let taxRate: number | null = null;
      let inventoryItemType: number | null = null;

      if (isProductLine) {
        const product = productMap.get(productId);
        if (!product) {
          return NextResponse.json(
            { ok: false, error: `Product ${productId} not found or inactive.` },
            { status: 400 }
          );
        }
        itemId = product.pos_item_id || product.item_id || null;
        itemCode = product.item_code;
        itemName = product.item_name;
        unitName = product.unit_name;
        unitPrice = toNumber(product.unit_price);
        taxRate = vatEnabled ? (toNumber(product.tax_rate) || null) : null;
        inventoryItemType = product.item_type;
      } else {
        const rawName = typeof raw.itemName === "string" ? raw.itemName.trim() : "";
        if (!rawName) {
          return NextResponse.json(
            { ok: false, error: "itemName is required for free-text lines." },
            { status: 400 }
          );
        }
        itemCode =
          typeof raw.itemCode === "string" && raw.itemCode.trim()
            ? raw.itemCode.trim()
            : null;
        itemName = rawName;
        unitName =
          typeof raw.unitName === "string" && raw.unitName.trim()
            ? raw.unitName.trim()
            : null;
        const rawPrice = Number(raw.unitPrice);
        if (!Number.isFinite(rawPrice) || rawPrice < 0) {
          return NextResponse.json(
            { ok: false, error: "unitPrice must be a non-negative number." },
            { status: 400 }
          );
        }
        unitPrice = rawPrice;
        const rawTax = Number(raw.taxRate);
        taxRate = vatEnabled && Number.isFinite(rawTax) && rawTax > 0 ? rawTax : null;
      }

      const quantity = Number(raw.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return NextResponse.json(
          { ok: false, error: "quantity must be a positive number." },
          { status: 400 }
        );
      }

      const rawDiscount = Number(raw.discountAmount);
      const discountAmount =
        Number.isFinite(rawDiscount) && rawDiscount >= 0 ? Math.round(rawDiscount) : 0;

      const lineSubtotal = Math.round(unitPrice * quantity);
      const lineFinalAmount = Math.max(0, lineSubtotal - discountAmount);
      const lineTaxAmount = calcManualTax(lineFinalAmount, taxRate);
      const preTaxAmount = Math.max(0, lineFinalAmount - lineTaxAmount);

      resolvedLines.push({
        clientId,
        parentClientId,
        productId: isProductLine ? productId : null,
        itemId,
        itemCode,
        itemName,
        unitName,
        quantity,
        unitPrice,
        lineSubtotal,
        discountAmount,
        lineFinalAmount,
        taxRate: taxRate && taxRate > 0 ? taxRate : null,
        lineTaxAmount,
        preTaxAmount,
        inventoryItemType: isOption
          ? Number.isInteger(rawInventoryItemType)
            ? rawInventoryItemType
            : 6
          : inventoryItemType,
        isOption,
        refDetailType:
          Number.isInteger(rawRefDetailType) && rawRefDetailType > 0
            ? rawRefDetailType
            : isOption
              ? 2
              : 1,
        additionId,
        optionGroupName,
        rawJson,
        isAdjustment: false,
      });
    }

    const resolvedLineByClientId = new Map(
      resolvedLines.map((line) => [line.clientId, line])
    );
    for (const line of resolvedLines) {
      if (!line.isOption) continue;
      const parent = line.parentClientId
        ? resolvedLineByClientId.get(line.parentClientId)
        : null;
      if (!parent || parent.isOption) {
        return NextResponse.json(
          { ok: false, error: "Option line parent was not found." },
          { status: 400 }
        );
      }
      const parentProduct = parent.productId
        ? productMap.get(parent.productId)
        : null;
      const addition = parentProduct && line.additionId
        ? findProductAddition(parentProduct, line.additionId)
        : null;
      if (!parentProduct || !addition) {
        return NextResponse.json(
          { ok: false, error: "Option line must reference an Addition of the parent product." },
          { status: 400 }
        );
      }
      line.quantity = parent.quantity;
      line.lineSubtotal = Math.round(line.unitPrice * line.quantity);
      line.lineFinalAmount = Math.max(0, line.lineSubtotal - line.discountAmount);
      line.lineTaxAmount = calcManualTax(line.lineFinalAmount, line.taxRate);
      line.preTaxAmount = Math.max(0, line.lineFinalAmount - line.lineTaxAmount);
    }

    const productLineTotalAmount = resolvedLines.reduce((s, l) => s + l.lineSubtotal, 0);
    const receiptVatAmount = resolvedLines.reduce((s, l) => s + l.lineTaxAmount, 0);
    let receiptTotalAmount = productLineTotalAmount;
    let receiptFinalAmount = productLineTotalAmount + receiptVatAmount;

    if (!vatEnabled && body.manualFinalAmount !== undefined && body.manualFinalAmount !== null) {
      const rawManualFinalAmount = Number(body.manualFinalAmount);
      if (!Number.isFinite(rawManualFinalAmount) || rawManualFinalAmount < 0) {
        return NextResponse.json(
          { ok: false, error: "manualFinalAmount must be a non-negative number." },
          { status: 400 }
        );
      }

      const manualFinalAmount = Math.round(rawManualFinalAmount);
      const adjustmentAmount = manualFinalAmount - productLineTotalAmount;

      if (adjustmentAmount !== 0) {
        resolvedLines.push({
          clientId: "manual-payment-adjustment",
          parentClientId: null,
          productId: null,
          itemId: null,
          itemCode: null,
          itemName: "수동 금액 조정",
          unitName: null,
          quantity: 1,
          unitPrice: adjustmentAmount,
          lineSubtotal: adjustmentAmount,
          discountAmount: 0,
          lineFinalAmount: adjustmentAmount,
          taxRate: null,
          lineTaxAmount: 0,
          preTaxAmount: adjustmentAmount,
          inventoryItemType: null,
          isOption: false,
          refDetailType: 1,
          additionId: null,
          optionGroupName: null,
          rawJson: {
            source: "manual-receipt-payment-adjustment",
            productLineTotalAmount,
            manualFinalAmount,
            adjustmentAmount,
          },
          isAdjustment: true,
        });
      }

      receiptTotalAmount = manualFinalAmount;
      receiptFinalAmount = manualFinalAmount;
    }

    const cashReceivedAmount =
      paymentMethod === "cash" ? Number(body.cashReceivedAmount) : receiptFinalAmount;

    if (paymentMethod === "cash") {
      if (!Number.isFinite(cashReceivedAmount) || cashReceivedAmount < receiptFinalAmount) {
        return NextResponse.json(
          { ok: false, error: "cashReceivedAmount must be >= finalAmount." },
          { status: 400 }
        );
      }
    }

    const returnAmount =
      paymentMethod === "cash" ? Math.max(0, cashReceivedAmount - receiptFinalAmount) : 0;

    const now = new Date().toISOString();
    const YYYYMMDD = businessDate.replace(/-/g, "");
    const refId = `manual-${YYYYMMDD}-${crypto.randomUUID()}`;
    const refNoPrefix = getManualRefNoPrefix(businessDate);

    const refDate = parseManualSaleTime(body.saleTime, businessDate);
    if (!refDate) {
      return NextResponse.json(
        { ok: false, error: "saleTime must use HH:mm for the selected businessDate." },
        { status: 400 }
      );
    }
    const tableName =
      typeof body.tableName === "string" && body.tableName.trim()
        ? body.tableName.trim()
        : null;
    const note =
      typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

    let receiptId: number | null = null;
    let refNo = "";
    let nextRefNoSequence = await getNextManualRefNoSequence(businessDate, refNoPrefix);

    for (let attempt = 0; attempt < MANUAL_REF_NO_RETRY_COUNT; attempt += 1) {
      refNo = getManualRefNo(refNoPrefix, nextRefNoSequence + attempt);

      const { data: insertedReceipt, error: insertReceiptError } = await supabaseServer
        .from("pos_sales_receipts")
        .insert({
          source: "manual",
          ref_id: refId,
          ref_no: refNo,
          business_date: businessDate,
          ref_date: refDate,
          payment_status: 3,
          is_canceled: false,
          total_amount: receiptTotalAmount,
          discount_amount: 0,
          vat_amount: receiptVatAmount,
          final_amount: receiptFinalAmount,
          receive_amount: paymentMethod === "cash" ? cashReceivedAmount : receiptFinalAmount,
          return_amount: returnAmount,
          table_name: tableName,
          is_modified: false,
          modification_note: note,
          admin_note: `created_by:${actor.username}`,
          raw_json: { source: "manual-receipt-create", createdBy: actor.username, vatEnabled },
          synced_at: now,
          updated_at: now,
        })
        .select("id")
        .single();

      if (!insertReceiptError && insertedReceipt) {
        receiptId = Number(insertedReceipt.id);
        break;
      }

      if (!isUniqueViolation(insertReceiptError) || attempt === MANUAL_REF_NO_RETRY_COUNT - 1) {
        throw new Error(
          `Failed to insert receipt: ${insertReceiptError?.message ?? "no data returned"}`
        );
      }

      nextRefNoSequence = await getNextManualRefNoSequence(businessDate, refNoPrefix);
    }

    if (!receiptId) {
      throw new Error("Failed to insert receipt: no data returned");
    }

    const orderedResolvedLines = resolvedLines
      .filter((line) => !line.isOption)
      .flatMap((parentLine) => [
        parentLine,
        ...resolvedLines.filter(
          (line) => line.parentClientId === parentLine.clientId
        ),
      ]);
    const refDetailIdsByClientId = new Map(
      orderedResolvedLines.map((line, index) => [
        line.clientId,
        `manual-receipt-${receiptId}-${index + 1}-${crypto.randomUUID().slice(0, 8)}`,
      ])
    );

    const lineInserts = orderedResolvedLines.map((line, index) => {
      const refDetailId = refDetailIdsByClientId.get(line.clientId) as string;
      const parentRefDetailId = line.parentClientId
        ? refDetailIdsByClientId.get(line.parentClientId) || null
        : null;

      return {
      source: "manual",
      receipt_id: receiptId,
      receipt_ref_id: refId,
      ref_detail_id: refDetailId,
      parent_ref_detail_id: parentRefDetailId,
      business_date: businessDate,
      ref_date: refDate,
      sort_order: index + 1,
      item_id: line.isOption || line.isAdjustment ? null : line.itemId,
      item_code: line.itemCode,
      item_name: line.itemName,
      unit_name: line.unitName,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      amount: line.lineSubtotal,
      discount_amount: line.discountAmount,
      final_amount: line.lineFinalAmount,
      tax_rate: line.taxRate,
      tax_amount: line.lineTaxAmount,
      pre_tax_amount: line.preTaxAmount,
      tax_reduction_amount: 0,
      ref_detail_type: line.isOption ? 2 : line.refDetailType,
      inventory_item_type: line.inventoryItemType,
      is_option: line.isOption,
      is_excluded: line.isAdjustment,
      payment_status: 3,
      is_canceled: false,
      mapping_status: line.isAdjustment
        ? "unmapped"
        : line.isOption
          ? "option"
          : line.productId !== null
            ? "manual"
            : "unmapped",
      raw_json: line.isAdjustment ? {
        ...(line.rawJson || {}),
        ID: refDetailId,
        ClientID: line.clientId,
        RefDetailType: line.refDetailType,
      } : {
        source: "manual-receipt-create",
        productId: line.productId,
        vatEnabled,
        ID: refDetailId,
        ClientID: line.clientId,
        ParentID: parentRefDetailId,
        InventoryItemID: line.itemId,
        InventoryItemAdditionID: line.additionId,
        OptionGroupName: line.optionGroupName,
        RefDetailType: line.isOption ? 2 : line.refDetailType,
        InventoryItemType: line.inventoryItemType,
        CukcukOption: line.rawJson,
      },
      synced_at: now,
      updated_at: now,
      };
    });

    const { error: insertLinesError } = await supabaseServer
      .from("pos_sales_receipt_lines")
      .insert(lineInserts);

    if (insertLinesError) {
      await supabaseServer.from("pos_sales_receipts").delete().eq("id", receiptId);
      throw new Error(`Failed to insert receipt lines: ${insertLinesError.message}`);
    }

    const { error: insertPaymentError } = await supabaseServer
      .from("pos_sales_receipt_payments")
      .insert({
        source: "manual",
        receipt_id: receiptId,
        receipt_ref_id: refId,
        business_date: businessDate,
        ref_date: refDate,
        payment_type: null,
        payment_name: paymentMethod === "cash" ? "Tiền mặt" : "Khác",
        card_id: null,
        card_name: null,
        amount: receiptFinalAmount,
        raw_json: { source: "manual-receipt-create", paymentMethod },
        synced_at: now,
        updated_at: now,
      });

    if (insertPaymentError) {
      await supabaseServer.from("pos_sales_receipt_lines").delete().eq("receipt_id", receiptId);
      await supabaseServer.from("pos_sales_receipts").delete().eq("id", receiptId);
      throw new Error(`Failed to insert receipt payment: ${insertPaymentError.message}`);
    }

    return NextResponse.json({
      ok: true,
      receipt: { id: receiptId, refId, refNo, businessDate, finalAmount: receiptFinalAmount },
    });
  } catch (error) {
    console.error("[ADMIN_SALES_RECEIPTS_POST_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Failed to create manual receipt.",
      },
      { status: 500 }
    );
  }
}
