import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

type ReceiptRow = {
  id: number;
  ref_id: string;
  ref_no: string | null;
  business_date: string;
  ref_date: string | null;
  payment_status: number | null;
  is_canceled: boolean | null;
  total_amount: number | string | null;
  discount_amount: number | string | null;
  vat_amount: number | string | null;
  final_amount: number | string | null;
  receive_amount: number | string | null;
  return_amount: number | string | null;
  customer_name: string | null;
  table_name: string | null;
  is_modified: boolean | null;
  modified_at: string | null;
  modified_by: string | null;
  modification_note: string | null;
  review_status: string | null;
  admin_note: string | null;
  original_tax_summary: unknown | null;
};

type LineRow = {
  id: number;
  ref_detail_id: string | null;
  parent_ref_detail_id: string | null;
  sort_order: number | null;
  item_code: string | null;
  item_name: string | null;
  unit_name: string | null;
  quantity: number | string | null;
  unit_price: number | string | null;
  amount: number | string | null;
  discount_amount: number | string | null;
  final_amount: number | string | null;
  tax_rate: number | string | null;
  tax_amount: number | string | null;
  pre_tax_amount: number | string | null;
  tax_reduction_amount: number | string | null;
  ref_detail_type: number | null;
  inventory_item_type: number | null;
  is_option: boolean | null;
  mapping_status: string | null;
  is_excluded: boolean | null;
  admin_note: string | null;
};

type PaymentRow = {
  id: number;
  payment_type: number | null;
  payment_name: string | null;
  card_name: string | null;
  amount: number | string | null;
};

type ProductRow = {
  id: number;
  pos_item_id: string | null;
  item_id: string | null;
  item_code: string | null;
  item_name: string;
  unit_name: string | null;
  unit_price: number | string | null;
  tax_rate: number | string | null;
  tax_amount: number | string | null;
};

type TaxBucket = {
  taxRate: number;
  taxAmount: number;
  lineCount: number;
};

type UpdateReceiptBody = {
  actorUsername?: unknown;
  paymentMethod?: unknown;
  cashReceivedAmount?: unknown;
  note?: unknown;
  lines?: unknown;
};

type EditableLineInput = {
  mode?: unknown;
  id?: unknown;
  productId?: unknown;
  itemCode?: unknown;
  itemName?: unknown;
  unitName?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
};

type NormalizedLineInput =
  | {
    mode: "update";
    id: number;
    quantity: number;
  }
  | {
    mode: "delete";
    id: number;
  }
  | {
    mode: "create";
    productId: number | null;
    itemCode: string | null;
    itemName: string;
    unitName: string | null;
    unitPrice: number;
    quantity: number;
  };

type CalculatedLine = {
  id: number;
  itemName: string;
  unitName: string | null;
  quantity: number;
  unitPrice: number;
  amount: number;
  discountAmount: number;
  finalAmount: number;
  taxAmount: number;
};

type PaymentMethod = "cash" | "other";

function toNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : 0;
  }

  return 0;
}

function calculateTaxAmount(finalAmount: number, taxRate: number | string | null | undefined) {
  const rate = toNumber(taxRate);

  if (!Number.isFinite(finalAmount) || finalAmount <= 0 || rate <= 0) {
    return 0;
  }

  return Math.round((finalAmount * rate) / 100);
}

function calculatePreTaxAmount(finalAmount: number, taxAmount: number) {
  return Math.max(0, finalAmount - taxAmount);
}

function buildTaxSummary(lines: LineRow[]) {
  const map = new Map<number, TaxBucket>();

  lines.forEach((line) => {
    const taxRate = toNumber(line.tax_rate);
    const taxAmount = toNumber(line.tax_amount);

    if (taxRate === 0 && taxAmount === 0) {
      return;
    }

    const current =
      map.get(taxRate) ||
      ({
        taxRate,
        taxAmount: 0,
        lineCount: 0,
      } satisfies TaxBucket);

    current.taxAmount += taxAmount;
    current.lineCount += 1;
    map.set(taxRate, current);
  });

  const taxByRate = Array.from(map.values()).sort(
    (a, b) => a.taxRate - b.taxRate
  );

  return {
    totalTaxAmount: taxByRate.reduce((sum, item) => sum + item.taxAmount, 0),
    taxByRate,
  };
}

type TaxSummary = {
  totalTaxAmount: number;
  taxByRate: TaxBucket[];
};

function normalizeTaxSummary(value: unknown): TaxSummary | null {
  if (!value || typeof value !== "object") return null;

  const summary = value as {
    totalTaxAmount?: unknown;
    taxByRate?: unknown;
  };

  if (!Array.isArray(summary.taxByRate)) return null;

  return {
    totalTaxAmount: toNumber(summary.totalTaxAmount),
    taxByRate: summary.taxByRate
      .map((item) => {
        const row = item as {
          taxRate?: unknown;
          taxAmount?: unknown;
          lineCount?: unknown;
        };

        return {
          taxRate: toNumber(row.taxRate),
          taxAmount: toNumber(row.taxAmount),
          lineCount: toNumber(row.lineCount),
        };
      })
      .filter((item) => item.taxAmount > 0 || item.lineCount > 0),
  };
}

function parseReceiptId(value: string) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function getAdminActor(actorUsername: unknown) {
  if (typeof actorUsername !== "string" || !actorUsername.trim()) {
    return null;
  }

  const { data, error } = await supabaseServer
    .from("users")
    .select("id, username, name, role, is_active")
    .eq("username", actorUsername.trim())
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to verify admin actor: ${error.message}`);
  }

  if (data?.role !== "owner" && data?.role !== "master") {
    return null;
  }

  return data;
}

function normalizeEditableLines(value: unknown): NormalizedLineInput[] | null {
  if (!Array.isArray(value)) return null;

  const normalized: NormalizedLineInput[] = [];

  for (const item of value as EditableLineInput[]) {
    if (!item || typeof item !== "object") return null;

    const mode = item.mode === "delete" || item.mode === "create" ? item.mode : "update";
    const id = Number(item.id);
    const quantity = Number(item.quantity);

    if (mode === "delete") {
      if (!Number.isInteger(id) || id <= 0) return null;
      normalized.push({ mode, id });
      continue;
    }

    if (mode === "update") {
      if (!Number.isInteger(id) || id <= 0) return null;
      if (!Number.isFinite(quantity) || quantity <= 0) return null;
      normalized.push({ mode, id, quantity });
      continue;
    }

    const productId = Number(item.productId);
    const itemCode =
      typeof item.itemCode === "string" && item.itemCode.trim()
        ? item.itemCode.trim()
        : null;
    const itemName =
      typeof item.itemName === "string" ? item.itemName.trim() : "";
    const unitName =
      typeof item.unitName === "string" && item.unitName.trim()
        ? item.unitName.trim()
        : null;
    const unitPrice = Number(item.unitPrice);

    if (!Number.isFinite(quantity) || quantity <= 0) return null;
    if (
      (!Number.isInteger(productId) || productId <= 0) &&
      (!itemCode || !itemName || !Number.isFinite(unitPrice) || unitPrice < 0)
    ) {
      return null;
    }

    normalized.push({
      mode,
      productId: Number.isInteger(productId) && productId > 0 ? productId : null,
      itemCode,
      itemName,
      unitName,
      unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
      quantity,
    });
  }

  return normalized;
}

function normalizePaymentMethod(value: unknown): PaymentMethod | null {
  if (value === "cash" || value === "other") return value;
  return null;
}

function isOptionLine(line: Pick<LineRow, "is_option" | "parent_ref_detail_id" | "mapping_status">) {
  return (
    line.is_option === true ||
    Boolean(line.parent_ref_detail_id) ||
    line.mapping_status === "option"
  );
}

async function getProductsById(productIds: number[]) {
  if (productIds.length === 0) return new Map<number, ProductRow>();

  const { data, error } = await supabaseServer
    .from("pos_products")
    .select("id, pos_item_id, item_id, item_code, item_name, unit_name, unit_price, tax_rate, tax_amount")
    .eq("is_active", true)
    .in("id", productIds);

  if (error) {
    throw new Error(`Failed to fetch POS products: ${error.message}`);
  }

  return new Map(((data || []) as ProductRow[]).map((product) => [product.id, product]));
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const receiptId = parseReceiptId(id);

    if (!receiptId) {
      return NextResponse.json(
        { ok: false, error: "Invalid receipt id" },
        { status: 400 }
      );
    }

    const { data: receipt, error: receiptError } = await supabaseServer
      .from("pos_sales_receipts")
      .select(
        "id, ref_id, ref_no, business_date, ref_date, payment_status, is_canceled, total_amount, discount_amount, vat_amount, final_amount, receive_amount, return_amount, customer_name, table_name, is_modified, modified_at, modified_by, modification_note, review_status, admin_note, original_tax_summary"
      )
      .eq("id", receiptId)
      .maybeSingle();

    if (receiptError) {
      throw new Error(`Failed to fetch sales receipt: ${receiptError.message}`);
    }

    if (!receipt) {
      return NextResponse.json(
        { ok: false, error: "Receipt not found" },
        { status: 404 }
      );
    }

    const { data: lines, error: linesError } = await supabaseServer
      .from("pos_sales_receipt_lines")
      .select(
        "id, ref_detail_id, parent_ref_detail_id, sort_order, item_code, item_name, unit_name, quantity, unit_price, amount, discount_amount, final_amount, tax_rate, tax_amount, pre_tax_amount, tax_reduction_amount, ref_detail_type, inventory_item_type, is_option, mapping_status, is_excluded, admin_note"
      )
      .eq("receipt_id", receiptId)
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });

    if (linesError) {
      throw new Error(`Failed to fetch sales receipt lines: ${linesError.message}`);
    }

    const { data: payments, error: paymentsError } = await supabaseServer
      .from("pos_sales_receipt_payments")
      .select("id, payment_type, payment_name, card_name, amount")
      .eq("receipt_id", receiptId)
      .order("id", { ascending: true });

    if (paymentsError) {
      throw new Error(`Failed to fetch sales receipt payments: ${paymentsError.message}`);
    }

    const receiptRow = receipt as ReceiptRow;
    const lineRows = (lines || []) as LineRow[];
    const paymentRows = (payments || []) as PaymentRow[];

    const adjustedTaxSummary = buildTaxSummary(lineRows);
    const savedOriginalTaxSummary = normalizeTaxSummary(
      receiptRow.original_tax_summary
    );

    const taxSummary = {
      totalTaxAmount: toNumber(receiptRow.vat_amount),
      taxByRate: savedOriginalTaxSummary?.taxByRate || adjustedTaxSummary.taxByRate,
    };

    return NextResponse.json({
      ok: true,
      receipt: {
        id: receiptRow.id,
        refId: receiptRow.ref_id,
        refNo: receiptRow.ref_no,
        businessDate: receiptRow.business_date,
        refDate: receiptRow.ref_date,
        paymentStatus: receiptRow.payment_status,
        isCanceled: receiptRow.is_canceled === true,
        totalAmount: toNumber(receiptRow.total_amount),
        discountAmount: toNumber(receiptRow.discount_amount),
        vatAmount: toNumber(receiptRow.vat_amount),
        finalAmount: toNumber(receiptRow.final_amount),
        receiveAmount: toNumber(receiptRow.receive_amount),
        returnAmount: toNumber(receiptRow.return_amount),
        customerName: receiptRow.customer_name,
        tableName: receiptRow.table_name,
        isModified: receiptRow.is_modified === true,
        modifiedAt: receiptRow.modified_at,
        modifiedBy: receiptRow.modified_by,
        modificationNote: receiptRow.modification_note,
        reviewStatus: receiptRow.review_status,
        adminNote: receiptRow.admin_note,
      },
      payments: paymentRows.map((payment) => ({
        id: payment.id,
        paymentType: payment.payment_type,
        paymentName: payment.payment_name,
        cardName: payment.card_name,
        amount: toNumber(payment.amount),
      })),
      taxSummary,
      adjustedTaxSummary,
      lines: lineRows.map((line) => ({
        id: line.id,
        refDetailId: line.ref_detail_id,
        parentRefDetailId: line.parent_ref_detail_id,
        sortOrder: line.sort_order,
        itemCode: line.item_code,
        itemName: line.item_name,
        unitName: line.unit_name,
        quantity: toNumber(line.quantity),
        unitPrice: toNumber(line.unit_price),
        amount: toNumber(line.amount),
        discountAmount: toNumber(line.discount_amount),
        finalAmount: toNumber(line.final_amount),
        taxRate: toNumber(line.tax_rate),
        taxAmount: toNumber(line.tax_amount),
        preTaxAmount: toNumber(line.pre_tax_amount),
        taxReductionAmount: toNumber(line.tax_reduction_amount),
        refDetailType: line.ref_detail_type,
        inventoryItemType: line.inventory_item_type,
        isOption: line.is_option === true,
        mappingStatus: line.mapping_status,
        isExcluded: line.is_excluded === true,
        adminNote: line.admin_note,
      })),
    });
  } catch (error) {
    console.error("[ADMIN_SALES_RECEIPT_DETAIL_GET_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch sales receipt detail.",
      },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const receiptId = parseReceiptId(id);

    if (!receiptId) {
      return NextResponse.json(
        { ok: false, error: "Invalid receipt id" },
        { status: 400 }
      );
    }

    const body = (await req.json().catch(() => null)) as UpdateReceiptBody | null;

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { ok: false, error: "Invalid request body" },
        { status: 400 }
      );
    }

    const actor = await getAdminActor(body.actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    const nextLines = normalizeEditableLines(body.lines);
    const paymentMethod = normalizePaymentMethod(body.paymentMethod);
    const note =
      typeof body.note === "string" && body.note.trim()
        ? body.note.trim()
        : null;

    if (!nextLines || nextLines.length === 0) {
      return NextResponse.json(
        { ok: false, error: "At least one receipt line is required." },
        { status: 400 }
      );
    }

    if (!paymentMethod) {
      return NextResponse.json(
        { ok: false, error: "paymentMethod must be cash or other." },
        { status: 400 }
      );
    }

    const { data: receipt, error: receiptError } = await supabaseServer
      .from("pos_sales_receipts")
      .select(
        "id, ref_id, business_date, ref_date, payment_status, is_canceled, vat_amount, original_tax_summary"
      )
      .eq("id", receiptId)
      .maybeSingle();

    if (receiptError) {
      throw new Error(`Failed to fetch sales receipt: ${receiptError.message}`);
    }

    const receiptRow = receipt as
      | Pick<
        ReceiptRow,
        | "id"
        | "ref_id"
        | "business_date"
        | "ref_date"
        | "payment_status"
        | "is_canceled"
        | "vat_amount"
        | "original_tax_summary"
      >
      | null;

    if (!receiptRow) {
      return NextResponse.json(
        { ok: false, error: "Receipt not found" },
        { status: 404 }
      );
    }

    if (receiptRow.is_canceled === true) {
      return NextResponse.json(
        { ok: false, error: "Canceled receipt cannot be edited." },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    const { data: currentLines, error: currentLinesError } = await supabaseServer
      .from("pos_sales_receipt_lines")
      .select(
        "id, ref_detail_id, parent_ref_detail_id, sort_order, item_code, item_name, unit_name, quantity, unit_price, amount, discount_amount, final_amount, tax_rate, tax_amount, pre_tax_amount, tax_reduction_amount, ref_detail_type, inventory_item_type, is_option, mapping_status"
      )
      .eq("receipt_id", receiptId)
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });

    if (currentLinesError) {
      throw new Error(
        `Failed to fetch sales receipt lines: ${currentLinesError.message}`
      );
    }

    const currentLineRows = (currentLines || []) as LineRow[];
    const currentLineById = new Map(
      currentLineRows.map((line) => [line.id, line])
    );
    const existingOriginalTaxSummary = normalizeTaxSummary(
      receiptRow.original_tax_summary
    );

    const originalTaxSummaryForSave =
      existingOriginalTaxSummary || {
        totalTaxAmount: toNumber(receiptRow.vat_amount),
        taxByRate: buildTaxSummary(currentLineRows).taxByRate,
      };
    const existingLineInputs = nextLines.filter(
      (line): line is Extract<NormalizedLineInput, { id: number }> =>
        line.mode === "update" || line.mode === "delete"
    );
    const unknownLineIds = existingLineInputs
      .map((line) => line.id)
      .filter((id) => !currentLineById.has(id));

    const optionLineIds = existingLineInputs
      .map((line) => currentLineById.get(line.id))
      .filter((line): line is LineRow => Boolean(line))
      .filter(isOptionLine)
      .map((line) => line.id);

    const createLines = nextLines.filter(
      (
        line
      ): line is Extract<NormalizedLineInput, { mode: "create" }> =>
        line.mode === "create"
    );

    if (unknownLineIds.length > 0) {
      return NextResponse.json(
        { ok: false, error: "Receipt line does not belong to this receipt." },
        { status: 400 }
      );
    }

    if (optionLineIds.length > 0) {
      return NextResponse.json(
        { ok: false, error: "Option lines cannot be edited." },
        { status: 400 }
      );
    }

    const productMap = await getProductsById(
      createLines
        .map((line) => line.productId)
        .filter((id): id is number => typeof id === "number")
    );

    const deletedIds = new Set(
      nextLines
        .filter((line) => line.mode === "delete")
        .map((line) => line.id)
    );

    const deleteIds = new Set<number>();
    currentLineRows.forEach((line) => {
      if (deletedIds.has(line.id)) {
        deleteIds.add(line.id);
        if (line.ref_detail_id) {
          currentLineRows.forEach((candidate) => {
            if (candidate.parent_ref_detail_id === line.ref_detail_id) {
              deleteIds.add(candidate.id);
            }
          });
        }
      }
    });

    if (deleteIds.size > 0) {
      const { error: deleteError } = await supabaseServer
        .from("pos_sales_receipt_lines")
        .delete()
        .eq("receipt_id", receiptId)
        .in("id", Array.from(deleteIds));

      if (deleteError) {
        throw new Error(`Failed to delete sales receipt lines: ${deleteError.message}`);
      }
    }

    const updatedLineIds = new Set<number>();
    const calculatedLines: CalculatedLine[] = [];
    let nextSortOrder = 1;

    for (const line of nextLines) {
      if (line.mode !== "update") continue;

      const currentLine = currentLineById.get(line.id);
      if (!currentLine || deleteIds.has(line.id)) continue;

      const unitPrice = toNumber(currentLine.unit_price);
      const discountAmount = toNumber(currentLine.discount_amount);
      const taxRate = toNumber(currentLine.tax_rate);
      const amount = line.quantity * unitPrice;
      const finalAmount = amount - discountAmount;
      const taxAmount = calculateTaxAmount(finalAmount, taxRate);
      const preTaxAmount = calculatePreTaxAmount(finalAmount, taxAmount);

      const { error: updateLineError } = await supabaseServer
        .from("pos_sales_receipt_lines")
        .update({
          sort_order: nextSortOrder,
          quantity: line.quantity,
          amount,
          final_amount: finalAmount,
          tax_amount: taxAmount,
          pre_tax_amount: preTaxAmount,
          updated_at: now,
        })
        .eq("id", line.id)
        .eq("receipt_id", receiptId);

      if (updateLineError) {
        throw new Error(
          `Failed to update sales receipt line ${line.id}: ${updateLineError.message}`
        );
      }

      updatedLineIds.add(line.id);
      calculatedLines.push({
        id: line.id,
        itemName: currentLine.item_name || "",
        unitName: currentLine.unit_name,
        quantity: line.quantity,
        unitPrice,
        amount,
        discountAmount,
        finalAmount,
        taxAmount,
      });
      nextSortOrder += 1;
    }

    for (const line of createLines) {
      const product = line.productId ? productMap.get(line.productId) : null;

      if (line.productId && !product) {
        return NextResponse.json(
          { ok: false, error: "Selected POS product was not found." },
          { status: 400 }
        );
      }

      const itemName = product?.item_name || line.itemName;
      const itemCode = product?.item_code || line.itemCode;
      const unitName = product?.unit_name || line.unitName;
      const unitPrice = product ? toNumber(product.unit_price) : line.unitPrice;
      const taxRate = product ? toNumber(product.tax_rate) : 0;
      const amount = line.quantity * unitPrice;
      const taxAmount = calculateTaxAmount(amount, taxRate);
      const preTaxAmount = calculatePreTaxAmount(amount, taxAmount);

      const { data: insertedLine, error: insertLineError } = await supabaseServer
        .from("pos_sales_receipt_lines")
        .insert({
          source: "manual",
          receipt_id: receiptId,
          receipt_ref_id: receiptRow.ref_id,
          ref_detail_id: `manual-${receiptId}-${Date.now()}-${nextSortOrder}`,
          parent_ref_detail_id: null,
          business_date: receiptRow.business_date,
          ref_date: receiptRow.ref_date,
          sort_order: nextSortOrder,
          item_id: product?.pos_item_id || product?.item_id || null,
          item_code: itemCode,
          item_name: itemName,
          unit_id: null,
          unit_name: unitName,
          quantity: line.quantity,
          unit_price: unitPrice,
          amount,
          discount_amount: 0,
          final_amount: amount,
          tax_rate: taxRate > 0 ? taxRate : null,
          tax_amount: taxAmount,
          pre_tax_amount: preTaxAmount,
          tax_reduction_amount: 0,
          ref_detail_type: 1,
          inventory_item_type: null,
          is_option: false,
          is_excluded: false,
          mapping_status: "manual",
          payment_status: receiptRow.payment_status,
          is_canceled: false,
          raw_json: {
            source: "manual-receipt-edit",
            productId: product?.id ?? null,
          },
          synced_at: now,
          updated_at: now,
        })
        .select("id")
        .single();

      if (insertLineError) {
        throw new Error(`Failed to insert sales receipt line: ${insertLineError.message}`);
      }

      calculatedLines.push({
        id: Number(insertedLine.id),
        itemName,
        unitName,
        quantity: line.quantity,
        unitPrice,
        amount,
        discountAmount: 0,
        finalAmount: amount,
        taxAmount,
      });
      nextSortOrder += 1;
    }

    currentLineRows.forEach((line) => {
      if (isOptionLine(line) || deleteIds.has(line.id) || updatedLineIds.has(line.id)) {
        return;
      }

      calculatedLines.push({
        id: line.id,
        itemName: line.item_name || "",
        unitName: line.unit_name,
        quantity: toNumber(line.quantity),
        unitPrice: toNumber(line.unit_price),
        amount: toNumber(line.amount),
        discountAmount: toNumber(line.discount_amount),
        finalAmount: toNumber(line.final_amount),
        taxAmount: toNumber(line.tax_amount),
      });
    });

    if (calculatedLines.length === 0) {
      return NextResponse.json(
        { ok: false, error: "At least one sales line must remain." },
        { status: 400 }
      );
    }

    const nextReceiptSalesSubtotal = calculatedLines.reduce(
      (sum, line) => sum + line.finalAmount,
      0
    );
    const nextReceiptDiscount = calculatedLines.reduce(
      (sum, line) => sum + line.discountAmount,
      0
    );
    const nextReceiptAdjustedTaxAmount = calculatedLines.reduce(
      (sum, line) => sum + line.taxAmount,
      0
    );
    const nextReceiptFinal =
      nextReceiptSalesSubtotal + nextReceiptAdjustedTaxAmount;

    const cashReceivedAmount =
      paymentMethod === "cash" ? Number(body.cashReceivedAmount) : nextReceiptFinal;

    if (
      paymentMethod === "cash" &&
      (!Number.isFinite(cashReceivedAmount) ||
        cashReceivedAmount < nextReceiptFinal)
    ) {
      return NextResponse.json(
        { ok: false, error: "cashReceivedAmount must be greater than or equal to final amount." },
        { status: 400 }
      );
    }

    const returnAmount =
      paymentMethod === "cash"
        ? Math.max(0, cashReceivedAmount - nextReceiptFinal)
        : 0;

    const { error: deletePaymentsError } = await supabaseServer
      .from("pos_sales_receipt_payments")
      .delete()
      .eq("receipt_id", receiptId);

    if (deletePaymentsError) {
      throw new Error(`Failed to delete sales receipt payments: ${deletePaymentsError.message}`);
    }

    const { error: insertPaymentError } = await supabaseServer
      .from("pos_sales_receipt_payments")
      .insert({
        source: "manual",
        receipt_id: receiptId,
        receipt_ref_id: receiptRow.ref_id,
        business_date: receiptRow.business_date,
        ref_date: receiptRow.ref_date,
        payment_type: null,
        payment_name: paymentMethod === "cash" ? "Tiền mặt" : "Khác",
        card_id: null,
        card_name: null,
        amount: nextReceiptFinal,
        raw_json: {
          source: "manual-receipt-edit",
          paymentMethod,
        },
        synced_at: now,
        updated_at: now,
      });

    if (insertPaymentError) {
      throw new Error(`Failed to insert sales receipt payment: ${insertPaymentError.message}`);
    }

    const receiptUpdate: Record<string, unknown> = {
      total_amount: nextReceiptSalesSubtotal,
      discount_amount: nextReceiptDiscount,
      final_amount: nextReceiptFinal,
      receive_amount: paymentMethod === "cash" ? cashReceivedAmount : nextReceiptFinal,
      return_amount: returnAmount,
      is_modified: true,
      modified_at: now,
      modified_by: actor.username,
      modification_note: note,
      updated_at: now,
    };

    if (!existingOriginalTaxSummary) {
      receiptUpdate.original_tax_summary = originalTaxSummaryForSave;
    }

    console.log("[RECEIPT_EDIT_PATCH_DEBUG]", {
      receiptId,
      paymentMethod,
      rawCashReceivedAmount: body.cashReceivedAmount,
      nextReceiptSalesSubtotal,
      nextReceiptAdjustedTaxAmount,
      nextReceiptFinal,
      cashReceivedAmount,
      returnAmount,
      receiptUpdate,
    });

    const { error } = await supabaseServer
      .from("pos_sales_receipts")
      .update(receiptUpdate)
      .eq("id", receiptId);

    if (error) {
      throw new Error(`Failed to update sales receipt: ${error.message}`);
    }

    return NextResponse.json({
      ok: true,
      receipt: {
        id: receiptId,
        totalAmount: nextReceiptSalesSubtotal,
        finalAmount: nextReceiptFinal,
        receiveAmount: paymentMethod === "cash" ? cashReceivedAmount : nextReceiptFinal,
        returnAmount,
        isModified: true,
        modifiedAt: now,
        modifiedBy: actor.username,
        modificationNote: note,
      },
    });
  } catch (error) {
    console.error("[ADMIN_SALES_RECEIPT_DETAIL_PATCH_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update sales receipt.",
      },
      { status: 500 }
    );
  }
}
