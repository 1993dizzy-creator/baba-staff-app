import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  calculateReceiptFinancials,
  MAX_VND_RECEIPT_AMOUNT,
} from "@/lib/sales/receipt-financials";

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
  original_amount_summary: unknown | null;
  tax_override_mode: "apply" | "exclude_all" | null;
  calculated_vat_amount: number | string | null;
  calculated_final_amount: number | string | null;
  final_amount_override: number | string | null;
  revision: number | string;
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
  raw_json: unknown;
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
  item_type: number | null;
  raw_json: unknown;
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
  taxOverrideMode?: unknown;
  finalAmountOverride?: unknown;
  expectedRevision?: unknown;
  requestId?: unknown;
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
  taxRate?: unknown;
  clientId?: unknown;
  parentClientId?: unknown;
  isOption?: unknown;
  refDetailType?: unknown;
  inventoryItemType?: unknown;
  additionId?: unknown;
  optionGroupName?: unknown;
  rawJson?: unknown;
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
    clientId: string;
    parentClientId: string | null;
    productId: number | null;
    itemCode: string | null;
    itemName: string;
    unitName: string | null;
    unitPrice: number;
    quantity: number;
    taxRate: number | null;
    isOption: boolean;
    refDetailType: number;
    inventoryItemType: number | null;
    additionId: string | null;
    optionGroupName: string | null;
    rawJson: Record<string, unknown> | null;
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
  taxSavingAmount?: number;
  amountDifferenceAmount?: number;
};

type AmountSummarySnapshot = {
  totalAmount: number;
  vatAmount: number;
  finalAmount: number;
  paymentTotalAmount: number;
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

function normalizeAmountSummary(value: unknown): AmountSummarySnapshot | null {
  if (!value || typeof value !== "object") return null;

  const summary = value as {
    totalAmount?: unknown;
    vatAmount?: unknown;
    finalAmount?: unknown;
    paymentTotalAmount?: unknown;
  };

  return {
    totalAmount: toNumber(summary.totalAmount),
    vatAmount: toNumber(summary.vatAmount),
    finalAmount: toNumber(summary.finalAmount),
    paymentTotalAmount: toNumber(summary.paymentTotalAmount),
  };
}

function getOriginalFinalAmount(
  receipt: Pick<ReceiptRow, "final_amount" | "original_amount_summary">
) {
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

function parseReceiptId(value: string) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function canManageSalesReceipt(role: unknown) {
  return role === "owner" || role === "master" || role === "manager";
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

  if (!canManageSalesReceipt(data?.role)) {
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
    const clientId =
      typeof item.clientId === "string" ? item.clientId.trim() : "";
    const parentClientId =
      typeof item.parentClientId === "string" && item.parentClientId.trim()
        ? item.parentClientId.trim()
        : null;
    const isOption = item.isOption === true;
    const refDetailType = Number(item.refDetailType);
    const inventoryItemType = Number(item.inventoryItemType);
    const additionId =
      typeof item.additionId === "string" && item.additionId.trim()
        ? item.additionId.trim()
        : null;
    const optionGroupName =
      typeof item.optionGroupName === "string" && item.optionGroupName.trim()
        ? item.optionGroupName.trim()
        : null;
    const rawJson =
      item.rawJson &&
      typeof item.rawJson === "object" &&
      !Array.isArray(item.rawJson)
        ? (item.rawJson as Record<string, unknown>)
        : null;
    const taxRateValue = Number(item.taxRate);

    if (!Number.isFinite(quantity) || quantity <= 0) return null;
    if (!clientId) return null;
    if (isOption && (!parentClientId || !additionId)) return null;
    if (!isOption && parentClientId) return null;
    if (
      (!Number.isInteger(productId) || productId <= 0) &&
      ((!isOption && !itemCode) ||
        !itemName ||
        !Number.isFinite(unitPrice) ||
        unitPrice < 0)
    ) {
      return null;
    }

    normalized.push({
      mode,
      clientId,
      parentClientId,
      productId: Number.isInteger(productId) && productId > 0 ? productId : null,
      itemCode,
      itemName,
      unitName,
      unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
      quantity,
      taxRate: Number.isFinite(taxRateValue) ? taxRateValue : null,
      isOption,
      refDetailType:
        Number.isInteger(refDetailType) && refDetailType > 0
          ? refDetailType
          : isOption
            ? 2
            : 1,
      inventoryItemType: Number.isInteger(inventoryItemType)
        ? inventoryItemType
        : null,
      additionId,
      optionGroupName,
      rawJson,
    });
  }

  return normalized;
}

function normalizePaymentMethod(value: unknown): PaymentMethod | null {
  if (value === "cash" || value === "other") return value;
  return null;
}

function getRawParentRefDetailId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const parentId = (value as Record<string, unknown>).ParentID;
  if (typeof parentId === "string" && parentId.trim()) return parentId.trim();
  if (typeof parentId === "number" && Number.isFinite(parentId)) {
    return String(parentId);
  }

  return null;
}

function getParentRefDetailId(
  line: Pick<LineRow, "parent_ref_detail_id" | "raw_json">
) {
  return line.parent_ref_detail_id || getRawParentRefDetailId(line.raw_json);
}

function isOptionLine(
  line: Pick<
    LineRow,
    | "is_option"
    | "parent_ref_detail_id"
    | "ref_detail_type"
    | "mapping_status"
    | "raw_json"
  >
) {
  return (
    line.is_option === true ||
    Boolean(line.parent_ref_detail_id) ||
    line.ref_detail_type !== 1 ||
    hasRawOptionReference(line.raw_json) ||
    line.mapping_status === "option"
  );
}

function hasRawOptionReference(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const raw = value as Record<string, unknown>;
  return Boolean(raw.ParentID || raw.InventoryItemAdditionID);
}

async function getProductsById(productIds: number[]) {
  if (productIds.length === 0) return new Map<number, ProductRow>();

  const { data, error } = await supabaseServer
    .from("pos_products")
    .select("id, pos_item_id, item_id, item_code, item_name, unit_name, unit_price, tax_rate, tax_amount, item_type, raw_json")
    .eq("is_active", true)
    .in("id", productIds);

  if (error) {
    throw new Error(`Failed to fetch POS products: ${error.message}`);
  }

  return new Map(((data || []) as ProductRow[]).map((product) => [product.id, product]));
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asObjectArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(asObject)
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function findProductAddition(product: ProductRow, additionId: string) {
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

    return {
      name:
        (typeof option.Description === "string" && option.Description.trim()) ||
        (typeof option.Name === "string" && option.Name.trim()) ||
        "Option",
      code:
        typeof option.Code === "string" && option.Code.trim()
          ? option.Code.trim()
          : null,
      unitPrice: toNumber(option.Price ?? option.UnitPrice),
      raw: option,
    };
  }

  return null;
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
        "id, ref_id, ref_no, business_date, ref_date, payment_status, is_canceled, total_amount, discount_amount, vat_amount, final_amount, receive_amount, return_amount, customer_name, table_name, is_modified, modified_at, modified_by, modification_note, review_status, admin_note, original_tax_summary, original_amount_summary, tax_override_mode, calculated_vat_amount, calculated_final_amount, final_amount_override, revision"
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
        "id, ref_detail_id, parent_ref_detail_id, sort_order, item_code, item_name, unit_name, quantity, unit_price, amount, discount_amount, final_amount, tax_rate, tax_amount, pre_tax_amount, tax_reduction_amount, ref_detail_type, inventory_item_type, is_option, mapping_status, is_excluded, admin_note, raw_json"
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
    const activeLineRows = lineRows.filter((line) => line.is_excluded !== true);
    const paymentRows = (payments || []) as PaymentRow[];

    const adjustedTaxSummary = buildTaxSummary(activeLineRows);
    const savedOriginalTaxSummary = normalizeTaxSummary(
      receiptRow.original_tax_summary
    );

    const hasExplicitTaxMode = receiptRow.tax_override_mode !== null;
    const isVatExcluded = receiptRow.tax_override_mode === "exclude_all";
    const originalTaxAmount =
      savedOriginalTaxSummary?.totalTaxAmount ?? toNumber(receiptRow.vat_amount);
    const appliedTaxAmount = isVatExcluded
      ? 0
      : hasExplicitTaxMode
        ? originalTaxAmount
        : originalTaxAmount;
    const taxSummary = {
      totalTaxAmount: appliedTaxAmount,
      taxByRate: isVatExcluded
        ? []
        : savedOriginalTaxSummary?.taxByRate || adjustedTaxSummary.taxByRate,
      taxSavingAmount:
        receiptRow.is_modified === true
          ? hasExplicitTaxMode
            ? Math.max(0, originalTaxAmount - appliedTaxAmount)
            : Math.max(0, adjustedTaxSummary.totalTaxAmount - originalTaxAmount)
          : 0,
      amountDifferenceAmount:
        receiptRow.is_modified === true
          ? toNumber(receiptRow.final_amount) - getOriginalFinalAmount(receiptRow)
          : 0,
    };
    const originalAmountSummary = normalizeAmountSummary(
      receiptRow.original_amount_summary
    );

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
        originalAmountSummary,
        taxOverrideMode: receiptRow.tax_override_mode,
        calculatedVatAmount:
          receiptRow.calculated_vat_amount === null
            ? null
            : toNumber(receiptRow.calculated_vat_amount),
        calculatedFinalAmount:
          receiptRow.calculated_final_amount === null
            ? null
            : toNumber(receiptRow.calculated_final_amount),
        finalAmountOverride:
          receiptRow.final_amount_override === null
            ? null
            : toNumber(receiptRow.final_amount_override),
        revision: toNumber(receiptRow.revision),
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
      hasOptionLines: activeLineRows.some(isOptionLine),
      lines: activeLineRows.map((line) => ({
        id: line.id,
        refDetailId: line.ref_detail_id,
        parentRefDetailId: getParentRefDetailId(line),
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
  if (req.method === "PATCH") {
    return handleAtomicReceiptPatch(req, context);
  }
  let receiptId: number | null = null;
  let pauseAcquired = false;
  try {
    const { id } = await context.params;
    receiptId = parseReceiptId(id);

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
        "id, ref_id, business_date, ref_date, payment_status, is_canceled, total_amount, vat_amount, final_amount, original_tax_summary, original_amount_summary"
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
        | "total_amount"
        | "vat_amount"
        | "final_amount"
        | "original_tax_summary"
        | "original_amount_summary"
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
        "id, ref_detail_id, parent_ref_detail_id, sort_order, item_code, item_name, unit_name, quantity, unit_price, amount, discount_amount, final_amount, tax_rate, tax_amount, pre_tax_amount, tax_reduction_amount, ref_detail_type, inventory_item_type, is_option, is_excluded, mapping_status, raw_json"
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
    const activeCurrentLineRows = currentLineRows.filter(
      (line) => line.is_excluded !== true
    );

    const currentLineById = new Map(
      activeCurrentLineRows.map((line) => [line.id, line])
    );
    const currentLineByRefDetailId = new Map(
      activeCurrentLineRows
        .filter((line) => Boolean(line.ref_detail_id))
        .map((line) => [line.ref_detail_id as string, line])
    );
    const existingOriginalTaxSummary = normalizeTaxSummary(
      receiptRow.original_tax_summary
    );
    const existingOriginalAmountSummary = normalizeAmountSummary(
      receiptRow.original_amount_summary
    );

    const originalTaxSummaryForSave =
      existingOriginalTaxSummary || {
        totalTaxAmount: toNumber(receiptRow.vat_amount),
        taxByRate: buildTaxSummary(activeCurrentLineRows).taxByRate,
      };
    const { data: currentPayments, error: currentPaymentsError } =
      await supabaseServer
        .from("pos_sales_receipt_payments")
        .select("amount")
        .eq("receipt_id", receiptId);

    if (currentPaymentsError) {
      throw new Error(
        `Failed to fetch sales receipt payments: ${currentPaymentsError.message}`
      );
    }

    const originalPaymentTotalAmount = (currentPayments || []).reduce(
      (sum, payment) => sum + toNumber(payment.amount),
      0
    );
    const originalAmountSummaryForSave =
      existingOriginalAmountSummary || {
        totalAmount: toNumber(receiptRow.total_amount),
        vatAmount: toNumber(receiptRow.vat_amount),
        finalAmount: toNumber(receiptRow.final_amount),
        paymentTotalAmount:
          originalPaymentTotalAmount || toNumber(receiptRow.final_amount),
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
    const createLineByClientId = new Map(
      createLines.map((line) => [line.clientId, line])
    );

    if (createLineByClientId.size !== createLines.length) {
      return NextResponse.json(
        { ok: false, error: "Duplicate create line clientId." },
        { status: 400 }
      );
    }

    const resolvedOptions = new Map<
      string,
      ReturnType<typeof findProductAddition>
    >();

    for (const line of createLines) {
      if (!line.isOption) {
        if (!line.productId || !productMap.has(line.productId)) {
          return NextResponse.json(
            { ok: false, error: "Selected POS product was not found." },
            { status: 400 }
          );
        }
        continue;
      }

      const parentLine = line.parentClientId
        ? createLineByClientId.get(line.parentClientId)
        : null;
      const parentProduct =
        parentLine?.productId ? productMap.get(parentLine.productId) : null;
      const option =
        parentProduct && line.additionId
          ? findProductAddition(parentProduct, line.additionId)
          : null;

      if (!parentLine || parentLine.isOption || !parentProduct || !option) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Selected POS product option was not found. Refresh the product catalog.",
          },
          { status: 400 }
        );
      }

      resolvedOptions.set(line.clientId, option);
    }

    const inventoryContentChanged = nextLines.some((line) => {
      if (line.mode === "create" || line.mode === "delete") return true;
      const currentLine = currentLineById.get(line.id);
      return !currentLine || toNumber(currentLine.quantity) !== line.quantity;
    });

    const { error: pauseDeductionError } = await supabaseServer
      .from("pos_sales_receipts")
      .update({
        inventory_deduction_auto_eligible_at: null,
        inventory_deduction_processing_paused: true,
        inventory_deduction_processing_paused_at: now,
        inventory_deduction_processing_error: null,
        updated_at: now,
      })
      .eq("id", receiptId);
    if (pauseDeductionError) {
      throw new Error(
        `Failed to pause automatic inventory deduction: ${pauseDeductionError.message}`
      );
    }
    pauseAcquired = true;

    const deletedIds = new Set(
      nextLines
        .filter((line) => line.mode === "delete")
        .map((line) => line.id)
    );

    const deleteIds = new Set<number>(deletedIds);
    const deletedRefDetailIds = new Set(
      activeCurrentLineRows
        .filter((line) => deletedIds.has(line.id) && line.ref_detail_id)
        .map((line) => line.ref_detail_id as string)
    );

    let foundLinkedOption = true;
    while (foundLinkedOption) {
      foundLinkedOption = false;

      activeCurrentLineRows.forEach((line) => {
        const parentRefDetailId = getParentRefDetailId(line);
        if (
          !deleteIds.has(line.id) &&
          parentRefDetailId &&
          deletedRefDetailIds.has(parentRefDetailId)
        ) {
          deleteIds.add(line.id);
          if (line.ref_detail_id) deletedRefDetailIds.add(line.ref_detail_id);
          foundLinkedOption = true;
        }
      });
    }

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

    const requestedQuantityByLineId = new Map(
      nextLines
        .filter(
          (
            line
          ): line is Extract<NormalizedLineInput, { mode: "update" }> =>
            line.mode === "update"
        )
        .map((line) => [line.id, line.quantity])
    );

    for (const optionLine of activeCurrentLineRows.filter(isOptionLine)) {
      if (deleteIds.has(optionLine.id) || updatedLineIds.has(optionLine.id)) {
        continue;
      }

      const parentRefDetailId = getParentRefDetailId(optionLine);
      const parentLine = parentRefDetailId
        ? currentLineByRefDetailId.get(parentRefDetailId)
        : null;
      const quantity = parentLine
        ? requestedQuantityByLineId.get(parentLine.id) ??
          toNumber(parentLine.quantity)
        : toNumber(optionLine.quantity);
      const unitPrice = toNumber(optionLine.unit_price);
      const discountAmount = toNumber(optionLine.discount_amount);
      const taxRate = toNumber(optionLine.tax_rate);
      const amount = quantity * unitPrice;
      const finalAmount = amount - discountAmount;
      const taxAmount = calculateTaxAmount(finalAmount, taxRate);
      const preTaxAmount = calculatePreTaxAmount(finalAmount, taxAmount);

      const { error: updateOptionLineError } = await supabaseServer
        .from("pos_sales_receipt_lines")
        .update({
          quantity,
          amount,
          final_amount: finalAmount,
          tax_amount: taxAmount,
          pre_tax_amount: preTaxAmount,
          updated_at: now,
        })
        .eq("id", optionLine.id)
        .eq("receipt_id", receiptId);

      if (updateOptionLineError) {
        throw new Error(
          `Failed to update sales receipt option line ${optionLine.id}: ${updateOptionLineError.message}`
        );
      }

      updatedLineIds.add(optionLine.id);
      calculatedLines.push({
        id: optionLine.id,
        itemName: optionLine.item_name || "",
        unitName: optionLine.unit_name,
        quantity,
        unitPrice,
        amount,
        discountAmount,
        finalAmount,
        taxAmount,
      });
    }

    const createdRefDetailIds = new Map(
      createLines.map((line, index) => [
        line.clientId,
        `manual-${receiptId}-${Date.now()}-${index + 1}`,
      ])
    );
    const orderedCreateLines = createLines
      .filter((line) => !line.isOption)
      .flatMap((parentLine) => [
        parentLine,
        ...createLines.filter(
          (line) => line.parentClientId === parentLine.clientId
        ),
      ]);

    for (const line of orderedCreateLines) {
      const product = line.productId ? productMap.get(line.productId) : null;
      const parentLine = line.parentClientId
        ? createLineByClientId.get(line.parentClientId)
        : null;
      const parentProduct =
        parentLine?.productId ? productMap.get(parentLine.productId) : null;
      const option = line.isOption
        ? resolvedOptions.get(line.clientId) || null
        : null;
      const itemName = option?.name || product?.item_name || line.itemName;
      const itemCode = option?.code || product?.item_code || line.itemCode;
      const unitName =
        product?.unit_name || parentProduct?.unit_name || line.unitName;
      const unitPrice = option
        ? option.unitPrice
        : product
          ? toNumber(product.unit_price)
          : line.unitPrice;
      const quantity =
        line.isOption && parentLine ? parentLine.quantity : line.quantity;
      const taxRate = product
        ? toNumber(product.tax_rate)
        : parentProduct
          ? toNumber(parentProduct.tax_rate)
          : toNumber(line.taxRate);
      const amount = quantity * unitPrice;
      const taxAmount = calculateTaxAmount(amount, taxRate);
      const preTaxAmount = calculatePreTaxAmount(amount, taxAmount);
      const refDetailId = createdRefDetailIds.get(line.clientId) as string;
      const parentRefDetailId = line.parentClientId
        ? createdRefDetailIds.get(line.parentClientId) || null
        : null;

      const { data: insertedLine, error: insertLineError } = await supabaseServer
        .from("pos_sales_receipt_lines")
        .insert({
          source: "manual",
          receipt_id: receiptId,
          receipt_ref_id: receiptRow.ref_id,
          ref_detail_id: refDetailId,
          parent_ref_detail_id: parentRefDetailId,
          business_date: receiptRow.business_date,
          ref_date: receiptRow.ref_date,
          sort_order: nextSortOrder,
          item_id: line.isOption
            ? null
            : product?.pos_item_id || product?.item_id || null,
          item_code: itemCode,
          item_name: itemName,
          unit_id: null,
          unit_name: unitName,
          quantity,
          unit_price: unitPrice,
          amount,
          discount_amount: 0,
          final_amount: amount,
          tax_rate: taxRate > 0 ? taxRate : null,
          tax_amount: taxAmount,
          pre_tax_amount: preTaxAmount,
          tax_reduction_amount: 0,
          ref_detail_type: line.isOption ? 2 : 1,
          inventory_item_type: line.isOption
            ? line.inventoryItemType ?? 6
            : product?.item_type ?? line.inventoryItemType,
          is_option: line.isOption,
          is_excluded: false,
          mapping_status: line.isOption ? "option" : "manual",
          payment_status: receiptRow.payment_status,
          is_canceled: false,
          raw_json: {
            source: "manual-receipt-edit",
            productId: product?.id ?? null,
            ID: refDetailId,
            ClientID: line.clientId,
            ParentID: parentRefDetailId,
            InventoryItemID:
              product?.pos_item_id ||
              product?.item_id ||
              parentProduct?.pos_item_id ||
              parentProduct?.item_id ||
              null,
            InventoryItemAdditionID: line.additionId,
            OptionGroupName: line.optionGroupName,
            RefDetailType: line.isOption ? 2 : 1,
            InventoryItemType: line.isOption
              ? line.inventoryItemType ?? 6
              : product?.item_type ?? line.inventoryItemType,
            CukcukOption: option?.raw ?? line.rawJson,
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
        quantity,
        unitPrice,
        amount,
        discountAmount: 0,
        finalAmount: amount,
        taxAmount,
      });
      nextSortOrder += 1;
    }

    activeCurrentLineRows.forEach((line) => {
      if (deleteIds.has(line.id) || updatedLineIds.has(line.id)) {
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

    const completedAt = new Date().toISOString();
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
      inventory_deduction_auto_eligible_at: completedAt,
      inventory_deduction_processing_paused: false,
      inventory_deduction_processing_paused_at: null,
      inventory_deduction_processing_error: null,
      inventory_deduction_reprocess_required: inventoryContentChanged,
      inventory_deduction_last_checked_at: null,
      inventory_deduction_pending_fingerprint: null,
      inventory_deduction_pending_status: null,
      updated_at: completedAt,
    };

    if (!existingOriginalTaxSummary) {
      receiptUpdate.original_tax_summary = originalTaxSummaryForSave;
    }

    if (!existingOriginalAmountSummary) {
      receiptUpdate.original_amount_summary = originalAmountSummaryForSave;
    }

    const { error } = await supabaseServer
      .from("pos_sales_receipts")
      .update(receiptUpdate)
      .eq("id", receiptId);

    if (error) {
      throw new Error(`Failed to update sales receipt: ${error.message}`);
    }
    pauseAcquired = false;

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

    if (pauseAcquired && receiptId) {
      const { error: cleanupError } = await supabaseServer
        .from("pos_sales_receipts")
        .update({
          inventory_deduction_auto_eligible_at: null,
          inventory_deduction_processing_paused: false,
          inventory_deduction_processing_paused_at: null,
          inventory_deduction_processing_error: "admin_edit_failed",
        })
        .eq("id", receiptId);
      if (cleanupError) {
        console.error("[ADMIN_SALES_RECEIPT_PAUSE_CLEANUP_ERROR]", {
          receiptId,
          error: cleanupError.message,
        });
      }
    }

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

async function handleAtomicReceiptPatch(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const receiptId = parseReceiptId(id);
    if (!receiptId) return NextResponse.json({ ok: false, error: "Invalid receipt id" }, { status: 400 });
    const body = (await req.json().catch(() => null)) as UpdateReceiptBody | null;
    if (!body) return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
    const actor = await getAdminActor(body.actorUsername);
    if (!actor) return NextResponse.json({ ok: false, error: "No permission" }, { status: 403 });
    const inputs = normalizeEditableLines(body.lines);
    const paymentMethod = normalizePaymentMethod(body.paymentMethod);
    const taxMode = body.taxOverrideMode === "apply" || body.taxOverrideMode === "exclude_all"
      ? body.taxOverrideMode : null;
    const expectedRevision = Number(body.expectedRevision);
    const requestId = typeof body.requestId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)
      ? body.requestId : null;
    const override = body.finalAmountOverride === null || body.finalAmountOverride === undefined
      ? null : Number(body.finalAmountOverride);
    const hasEmptyOverride = body.finalAmountOverride === "";
    if (!inputs?.length || !paymentMethod || !taxMode || !requestId ||
        !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        hasEmptyOverride ||
        (override !== null && (!Number.isSafeInteger(override) || override < 0 || override > MAX_VND_RECEIPT_AMOUNT))) {
      return NextResponse.json({ ok: false, error: "Invalid receipt edit input." }, { status: 400 });
    }

    const { data: receipt, error: receiptError } = await supabaseServer
      .from("pos_sales_receipts")
      .select("id,source,ref_id,business_date,ref_date,payment_status,is_canceled,revision")
      .eq("id", receiptId).maybeSingle();
    if (receiptError) throw receiptError;
    if (!receipt) return NextResponse.json({ ok: false, error: "Receipt not found" }, { status: 404 });
    if (receipt.payment_status !== 3 || receipt.is_canceled === true) {
      return NextResponse.json({ ok: false, error: "Only paid, active receipts can be edited." }, { status: 400 });
    }
    if (receipt.source !== "cukcuk" && receipt.source !== "manual") {
      return NextResponse.json({ ok: false, error: "Receipt source cannot be edited." }, { status: 400 });
    }

    const { data: current, error: linesError } = await supabaseServer
      .from("pos_sales_receipt_lines")
      .select("id,ref_detail_id,parent_ref_detail_id,sort_order,item_id,item_code,item_name,unit_name,quantity,unit_price,amount,discount_amount,final_amount,tax_rate,tax_amount,pre_tax_amount,tax_reduction_amount,ref_detail_type,inventory_item_type,is_option,is_excluded,mapping_status,raw_json")
      .eq("receipt_id", receiptId).order("sort_order").order("id");
    if (linesError) throw linesError;
    const active = ((current || []) as (LineRow & { item_id?: string | null })[])
      .filter((line) => line.is_excluded !== true);
    const byId = new Map(active.map((line) => [line.id, line]));
    const requested = new Map(inputs.filter((line) => line.mode !== "create").map((line) => [line.id, line]));
    if ([...requested.keys()].some((lineId) => !byId.has(lineId))) {
      return NextResponse.json({ ok: false, error: "Receipt line changed. Reload the receipt." }, { status: 409 });
    }
    if ([...requested.keys()].some((lineId) => isOptionLine(byId.get(lineId)!))) {
      return NextResponse.json({ ok: false, error: "Option lines cannot be edited directly." }, { status: 400 });
    }

    const creates = inputs.filter((line): line is Extract<NormalizedLineInput, { mode: "create" }> => line.mode === "create");
    const products = await getProductsById(creates.map((line) => line.productId).filter((value): value is number => Boolean(value)));
    const createByClientId = new Map(creates.map((line) => [line.clientId, line]));
    const resolvedOptions = new Map<string, ReturnType<typeof findProductAddition>>();
    for (const line of creates) {
      if (!line.isOption) {
        if (!line.productId || !products.has(line.productId))
          return NextResponse.json({ ok: false, error: "Selected POS product was not found." }, { status: 400 });
      } else {
        const parent = line.parentClientId ? createByClientId.get(line.parentClientId) : null;
        const product = parent?.productId ? products.get(parent.productId) : null;
        const option = product && line.additionId ? findProductAddition(product, line.additionId) : null;
        if (!parent || parent.isOption || !option)
          return NextResponse.json({ ok: false, error: "Selected POS product option was not found." }, { status: 400 });
        resolvedOptions.set(line.clientId, option);
      }
    }

    const deletedParents = new Set(inputs.filter((line) => line.mode === "delete")
      .map((line) => byId.get(line.id)?.ref_detail_id).filter(Boolean));
    const quantityByRef = new Map<string, number>();
    const rpcLines: Record<string, unknown>[] = [];
    let sortOrder = 1;
    const appendExisting = (line: (typeof active)[number], quantity: number) => {
      const unitPrice = toNumber(line.unit_price);
      const discount = toNumber(line.discount_amount);
      const amount = Math.round(unitPrice * quantity);
      const finalAmount = Math.max(0, amount - discount);
      const rate = toNumber(line.tax_rate);
      const tax = calculateTaxAmount(finalAmount, rate);
      rpcLines.push({
        id: line.id, sort_order: sortOrder++, ref_detail_id: line.ref_detail_id,
        parent_ref_detail_id: getParentRefDetailId(line), item_id: line.item_id ?? null,
        item_code: line.item_code, item_name: line.item_name || "", unit_name: line.unit_name,
        quantity, unit_price: unitPrice, amount, discount_amount: discount,
        final_amount: finalAmount, tax_rate: rate || null, tax_amount: tax,
        pre_tax_amount: calculatePreTaxAmount(finalAmount, tax),
        tax_reduction_amount: toNumber(line.tax_reduction_amount),
        ref_detail_type: line.ref_detail_type ?? 1, inventory_item_type: line.inventory_item_type,
        is_option: isOptionLine(line), mapping_status: line.mapping_status || (isOptionLine(line) ? "option" : "unmapped"),
        raw_json: line.raw_json || {},
      });
    };
    for (const line of active.filter((candidate) => !isOptionLine(candidate))) {
      const input = requested.get(line.id);
      if (input?.mode === "delete") continue;
      const quantity = input?.mode === "update" ? input.quantity : toNumber(line.quantity);
      if (line.ref_detail_id) quantityByRef.set(line.ref_detail_id, quantity);
      appendExisting(line, quantity);
    }
    for (const line of active.filter(isOptionLine)) {
      const parentRef = getParentRefDetailId(line);
      if (parentRef && deletedParents.has(parentRef)) continue;
      appendExisting(line, parentRef ? quantityByRef.get(parentRef) ?? toNumber(line.quantity) : toNumber(line.quantity));
    }

    const generatedRefs = new Map(creates.map((line, index) => [line.clientId, `manual-${receiptId}-${requestId.slice(0, 8)}-${index + 1}`]));
    const orderedCreates = creates.filter((line) => !line.isOption).flatMap((parent) => [parent, ...creates.filter((line) => line.parentClientId === parent.clientId)]);
    for (const line of orderedCreates) {
      const parent = line.parentClientId ? createByClientId.get(line.parentClientId) : null;
      const product = line.productId ? products.get(line.productId) : parent?.productId ? products.get(parent.productId) : null;
      const option = line.isOption ? resolvedOptions.get(line.clientId) : null;
      const unitPrice = option?.unitPrice ?? (line.isOption ? line.unitPrice : toNumber(product?.unit_price ?? line.unitPrice));
      const quantity = line.isOption && parent ? parent.quantity : line.quantity;
      const rate = toNumber(line.isOption ? line.taxRate ?? product?.tax_rate : product?.tax_rate ?? line.taxRate);
      const amount = Math.round(unitPrice * quantity);
      const tax = calculateTaxAmount(amount, rate);
      rpcLines.push({
        id: null, sort_order: sortOrder++, ref_detail_id: generatedRefs.get(line.clientId),
        parent_ref_detail_id: line.parentClientId ? generatedRefs.get(line.parentClientId) : null,
        item_id: line.isOption ? null : product?.pos_item_id || product?.item_id || null,
        item_code: option?.code || product?.item_code || line.itemCode,
        item_name: option?.name || product?.item_name || line.itemName,
        unit_name: product?.unit_name || line.unitName, quantity, unit_price: unitPrice,
        amount, discount_amount: 0, final_amount: amount, tax_rate: rate || null,
        tax_amount: tax, pre_tax_amount: calculatePreTaxAmount(amount, tax), tax_reduction_amount: 0,
        ref_detail_type: line.isOption ? 2 : 1,
        inventory_item_type: line.isOption ? line.inventoryItemType ?? 6 : product?.item_type ?? line.inventoryItemType,
        is_option: line.isOption, mapping_status: line.isOption ? "option" : "manual",
        raw_json: { source: "manual-receipt-edit", productId: product?.id ?? null,
          InventoryItemAdditionID: line.additionId, OptionGroupName: line.optionGroupName },
      });
    }
    if (!rpcLines.length) return NextResponse.json({ ok: false, error: "At least one sales line must remain." }, { status: 400 });

    const financials = calculateReceiptFinancials({
      lines: rpcLines.map((line) => ({
        finalAmount: Number(line.final_amount),
        taxRate: line.tax_rate === null ? null : Number(line.tax_rate),
      })),
      taxMode,
      originalTaxAmount: 0,
      finalAmountOverride: override,
    });
    const normalizedOverride = financials.finalAmountOverride;
    const finalAmount = financials.finalAmount;
    const cash = paymentMethod === "cash" ? Number(body.cashReceivedAmount) : finalAmount;
    if (paymentMethod === "cash" && (!Number.isSafeInteger(cash) || cash < finalAmount || cash > MAX_VND_RECEIPT_AMOUNT))
      return NextResponse.json({ ok: false, error: "Cash received must cover the final amount." }, { status: 400 });

    const note = typeof body.note === "string" ? body.note.trim() || null : null;
    const { data, error } = await supabaseServer.rpc("admin_update_paid_sales_receipt", {
      p_receipt_id: receiptId, p_expected_revision: expectedRevision, p_request_id: requestId,
      p_actor_username: actor.username, p_modification_note: note,
      p_tax_override_mode: taxMode, p_final_amount_override: normalizedOverride,
      p_payment_method: paymentMethod, p_cash_received_amount: cash, p_lines: rpcLines,
    });
    if (error) {
      if (error.message.includes("receipt_revision_conflict"))
        return NextResponse.json({ ok: false, code: "receipt_revision_conflict", error: "Receipt was modified by another user." }, { status: 409 });
      throw error;
    }
    const saved = data as Record<string, unknown>;
    return NextResponse.json({ ok: true, receipt: {
      id: receiptId, totalAmount: toNumber(saved.totalAmount), vatAmount: toNumber(saved.vatAmount),
      calculatedVatAmount: toNumber(saved.calculatedVatAmount), calculatedFinalAmount: toNumber(saved.calculatedFinalAmount),
      finalAmountOverride: saved.finalAmountOverride === null ? null : toNumber(saved.finalAmountOverride),
      taxOverrideMode: taxMode, finalAmount: toNumber(saved.finalAmount),
      receiveAmount: toNumber(saved.receiveAmount), returnAmount: toNumber(saved.returnAmount),
      revision: toNumber(saved.revision), isModified: true, modifiedAt: saved.modifiedAt,
      modifiedBy: actor.username, modificationNote: note,
    }});
  } catch (error) {
    console.error("[ADMIN_SALES_RECEIPT_ATOMIC_PATCH_ERROR]", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Failed to update receipt." }, { status: 500 });
  }
}
