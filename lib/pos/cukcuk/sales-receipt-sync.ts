import { supabaseServer } from "@/lib/supabase/server";

export const CUKCUK_BASE_URL =
  process.env.CUKCUK_BASE_URL || "https://graphapi.cukcuk.vn";

export const SOURCE = "cukcuk";

export type JsonObject = Record<string, unknown>;

export type CukcukInvoice = JsonObject;
export type CukcukInvoiceDetail = JsonObject;

export type ReceiptRow = {
  id?: number;
  source: string;
  branch_id: string | null;
  branch_code: string | null;
  branch_name: string | null;
  ref_id: string;
  ref_no: string | null;
  business_date: string;
  ref_date: string | null;
  payment_status: number | null;
  is_canceled: boolean;
  total_amount: number;
  discount_amount: number;
  vat_amount: number;
  final_amount: number;
  receive_amount: number;
  return_amount: number;
  customer_name: string | null;
  table_name: string | null;
  raw_json: CukcukInvoice;
  synced_at: string;
  updated_at: string;
};

export type LineRow = {
  id?: number;
  source: string;
  receipt_id: number | null;
  receipt_ref_id: string;
  ref_detail_id: string | null;
  parent_ref_detail_id: string | null;
  business_date: string;
  ref_date: string | null;
  sort_order: number;
  item_id: string | null;
  item_code: string | null;
  item_name: string | null;
  unit_id: string | null;
  unit_name: string | null;
  quantity: number;
  unit_price: number;
  amount: number;
  discount_amount: number;
  final_amount: number;
  tax_rate: number | null;
  tax_amount: number;
  pre_tax_amount: number;
  tax_reduction_amount: number;
  ref_detail_type: number | null;
  inventory_item_type: number | null;
  is_option: boolean;
  payment_status: number | null;
  is_canceled: boolean;
  raw_json: CukcukInvoiceDetail;
  synced_at: string;
  updated_at: string;
};

export type ExistingReceiptRow = ReceiptRow & {
  id: number;
  is_modified?: boolean | null;
};

export type ExistingLineRow = LineRow & {
  id: number;
  is_excluded: boolean | null;
};

export type ExistingLineLookup = {
  rows: ExistingLineRow[];
  byRefDetailKey: Map<string, ExistingLineRow>;
  byFallbackKey: Map<string, ExistingLineRow[]>;
};

export type PaymentRow = {
  id?: number;
  source: string;
  receipt_id: number | null;
  receipt_ref_id: string;
  business_date: string;
  ref_date: string | null;
  payment_type: number | null;
  payment_name: string | null;
  card_id: string | null;
  card_name: string | null;
  amount: number;
  raw_json: JsonObject;
  synced_at: string;
  updated_at: string;
};

export type ExistingPaymentRow = PaymentRow & {
  id: number;
};

export function getString(record: JsonObject | null | undefined, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
}

export function getNumber(record: JsonObject | null | undefined, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return null;
}

export function getInvoiceRefId(invoice: CukcukInvoice) {
  return getString(invoice, ["RefId", "RefID", "refId", "refID"]) || "";
}

export function getInvoiceRefNo(invoice: CukcukInvoice) {
  return getString(invoice, ["RefNo", "refNo"]);
}

export function getInvoiceDate(invoice: CukcukInvoice) {
  return getString(invoice, ["RefDate", "PostedDate", "refDate", "postedDate"]);
}

export function getPaymentStatus(invoice: CukcukInvoice) {
  return getNumber(invoice, ["PaymentStatus", "paymentStatus"]);
}

export function isCanceledPaymentStatus(paymentStatus: number | null) {
  return paymentStatus === 4 || paymentStatus === 5;
}

export function getDetailsFromInvoicePayload(payload: JsonObject): CukcukInvoiceDetail[] {
  const candidates = [
    payload.SAInvoiceDetails,
    payload.saInvoiceDetails,
    payload.Details,
    payload.details,
    payload.InvoiceDetails,
    payload.invoiceDetails,
  ];

  const found = candidates.find((item) => Array.isArray(item));

  return Array.isArray(found) ? (found as CukcukInvoiceDetail[]) : [];
}

export function getRefDetailId(detail: CukcukInvoiceDetail) {
  return getString(detail, ["RefDetailID", "RefDetailId", "refDetailID", "refDetailId"]);
}

export function getParentRefDetailId(detail: CukcukInvoiceDetail) {
  return getString(detail, ["ParentID", "ParentId", "parentID", "parentId"]);
}

export function getRefDetailType(detail: CukcukInvoiceDetail) {
  return getNumber(detail, ["RefDetailType", "refDetailType"]);
}

export function getPaymentsFromInvoicePayload(payload: JsonObject): JsonObject[] {
  const candidates = [
    payload.SAInvoicePayments,
    payload.saInvoicePayments,
    payload.Payments,
    payload.payments,
  ];

  const found = candidates.find((item) => Array.isArray(item));

  return Array.isArray(found) ? (found as JsonObject[]) : [];
}

export function isCashPayment(payment: JsonObject) {
  const paymentType = getNumber(payment, ["PaymentType", "paymentType"]);
  const paymentName = (
    getString(payment, ["PaymentName", "paymentName"]) || ""
  ).toLowerCase();

  return (
    paymentType === 1 ||
    paymentName.includes("tiền mặt") ||
    paymentName.includes("tien mat") ||
    paymentName.includes("cash")
  );
}

export function getPaymentAmount(payment: JsonObject) {
  return getNumber(payment, ["Amount", "amount"]) ?? 0;
}

export function getLineFinalAmount(detail: CukcukInvoiceDetail) {
  const amount = getNumber(detail, ["Amount", "amount"]) ?? 0;
  const discountAmount =
    getNumber(detail, ["DiscountAmount", "PromotionAmount", "discountAmount"]) ??
    0;

  return getNumber(detail, ["FinalAmount", "finalAmount"]) ?? amount - discountAmount;
}

export function getLineSalesAmount(payload: JsonObject) {
  const details = getDetailsFromInvoicePayload(payload);

  if (details.length === 0) return null;

  return details.reduce((sum, detail) => sum + getLineFinalAmount(detail), 0);
}

export function buildCukcukHeaders(accessToken: string, companyCode: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    CompanyCode: companyCode,
  };
}

export async function fetchSaInvoiceDetail(params: {
  accessToken: string;
  companyCode: string;
  refId: string;
}) {
  const response = await fetch(
    `${CUKCUK_BASE_URL}/api/v1/sainvoices/${encodeURIComponent(params.refId)}`,
    {
      method: "GET",
      headers: buildCukcukHeaders(params.accessToken, params.companyCode),
      cache: "no-store",
    }
  );

  const json = (await response.json()) as JsonObject;

  if (!response.ok || json.Success === false) {
    throw new Error(
      `sainvoices/${params.refId} failed: ${JSON.stringify(json).slice(0, 500)}`
    );
  }

  const data = json.Data;
  return data && typeof data === "object" ? (data as JsonObject) : json;
}

export function buildReceiptRow(params: {
  invoice: CukcukInvoice;
  detailPayload: JsonObject;
  businessDate: string;
  syncedAt: string;
}): ReceiptRow {
  const invoice = params.invoice;
  const detailPayload = params.detailPayload;
  const paymentStatus =
    getPaymentStatus(detailPayload) ?? getPaymentStatus(invoice);

  const discountAmount =
    getNumber(detailPayload, ["DiscountAmount", "SaleAmount", "PromotionAmount"]) ??
    getNumber(invoice, ["DiscountAmount", "SaleAmount", "PromotionAmount"]) ??
    0;
  const vatAmount =
    getNumber(detailPayload, ["VATAmount", "VatAmount", "TaxAmount"]) ??
    getNumber(invoice, ["VATAmount", "VatAmount", "TaxAmount"]) ??
    0;
  const finalAmount =
    getNumber(detailPayload, ["FinalAmount", "TotalAmount", "SaleAmount", "Amount"]) ??
    getNumber(invoice, ["FinalAmount", "TotalAmount", "SaleAmount", "Amount"]) ??
    0;
  const lineSalesAmount = getLineSalesAmount(detailPayload);
  const rawAmount =
    getNumber(detailPayload, ["Amount", "amount"]) ??
    getNumber(invoice, ["Amount", "amount"]);
  const totalAmount =
    lineSalesAmount ??
    rawAmount ??
    Math.max(0, finalAmount - vatAmount);
  const rawReceiveAmount =
    getNumber(detailPayload, [
      "ReceiveAmount",
      "ReceivedAmount",
      "CustomerPaidAmount",
      "TotalReceiveAmount",
      "CashReceivedAmount",
      "receiveAmount",
      "receivedAmount",
      "customerPaidAmount",
      "totalReceiveAmount",
      "cashReceivedAmount",
    ]) ??
    getNumber(invoice, [
      "ReceiveAmount",
      "ReceivedAmount",
      "CustomerPaidAmount",
      "TotalReceiveAmount",
      "CashReceivedAmount",
      "receiveAmount",
      "receivedAmount",
      "customerPaidAmount",
      "totalReceiveAmount",
      "cashReceivedAmount",
    ]) ??
    0;
  const returnAmount =
    getNumber(detailPayload, ["ReturnAmount", "ChangeAmount", "returnAmount", "changeAmount"]) ??
    getNumber(invoice, ["ReturnAmount", "ChangeAmount", "returnAmount", "changeAmount"]) ??
    0;
  const payments = getPaymentsFromInvoicePayload(detailPayload);
  const paymentAmount = payments.reduce(
    (sum, payment) => sum + getPaymentAmount(payment),
    0
  );
  const hasCashPayment = payments.some(isCashPayment);
  // CUKCUK 원본에 실제 받은금액이 없어 현금 결제만 결제액 + 거스름돈으로 보정한다.
  const receiveAmount =
    rawReceiveAmount > 0
      ? rawReceiveAmount
      : hasCashPayment && returnAmount > 0
        ? paymentAmount + returnAmount
        : rawReceiveAmount;

  return {
    source: SOURCE,
    branch_id:
      getString(detailPayload, ["BranchId", "BranchID", "branchId"]) ??
      getString(invoice, ["BranchId", "BranchID", "branchId"]),
    branch_code:
      getString(detailPayload, ["BranchCode", "branchCode"]) ??
      getString(invoice, ["BranchCode", "branchCode"]),
    branch_name:
      getString(detailPayload, ["BranchName", "branchName"]) ??
      getString(invoice, ["BranchName", "branchName"]),
    ref_id: getInvoiceRefId(invoice),
    ref_no: getInvoiceRefNo(detailPayload) ?? getInvoiceRefNo(invoice),
    business_date: params.businessDate,
    ref_date: getInvoiceDate(detailPayload) ?? getInvoiceDate(invoice),
    payment_status: paymentStatus,
    is_canceled: isCanceledPaymentStatus(paymentStatus),
    total_amount: totalAmount,
    discount_amount: discountAmount,
    vat_amount: vatAmount,
    final_amount: finalAmount,
    receive_amount: receiveAmount,
    return_amount: returnAmount,
    customer_name:
      getString(detailPayload, ["CustomerName", "customerName"]) ??
      getString(invoice, ["CustomerName", "customerName"]),
    table_name:
      getString(detailPayload, ["TableName", "tableName"]) ??
      getString(invoice, ["TableName", "tableName"]),
    raw_json: detailPayload,
    synced_at: params.syncedAt,
    updated_at: params.syncedAt,
  };
}

export function buildLineRow(params: {
  receiptId: number | null;
  receiptRefId: string;
  detail: CukcukInvoiceDetail;
  businessDate: string;
  refDate: string | null;
  paymentStatus: number | null;
  isCanceled: boolean;
  sortOrder: number;
  syncedAt: string;
}): LineRow {
  const detail = params.detail;
  const amount = getNumber(detail, ["Amount", "amount"]) ?? 0;
  const discountAmount =
    getNumber(detail, ["DiscountAmount", "PromotionAmount", "discountAmount"]) ??
    0;
  const finalAmount = getLineFinalAmount(detail);
  const taxRate = getNumber(detail, ["TaxRate", "taxRate"]);
  const taxAmount = getNumber(detail, ["TaxAmount", "taxAmount"]) ?? 0;
  const preTaxAmount = getNumber(detail, ["PreTaxAmount", "preTaxAmount"]) ?? amount;
  const taxReductionAmount =
    getNumber(detail, ["TaxReductionAmount", "taxReductionAmount"]) ?? 0;
  const refDetailType = getRefDetailType(detail);

  return {
    source: SOURCE,
    receipt_id: params.receiptId,
    receipt_ref_id: params.receiptRefId,
    ref_detail_id: getRefDetailId(detail),
    parent_ref_detail_id: getParentRefDetailId(detail),
    business_date: params.businessDate,
    ref_date: params.refDate,
    sort_order: params.sortOrder,
    item_id: getString(detail, ["ItemID", "ItemId", "itemID", "itemId"]),
    item_code: getString(detail, ["ItemCode", "itemCode"]),
    item_name: getString(detail, ["ItemName", "itemName"]),
    unit_id: getString(detail, ["UnitID", "UnitId", "unitID", "unitId"]),
    unit_name: getString(detail, ["UnitName", "unitName"]),
    quantity: getNumber(detail, ["Quantity", "quantity"]) ?? 0,
    unit_price: getNumber(detail, ["UnitPrice", "Price", "unitPrice", "price"]) ?? 0,
    amount,
    discount_amount: discountAmount,
    final_amount: finalAmount,
    tax_rate: taxRate,
    tax_amount: taxAmount,
    pre_tax_amount: preTaxAmount,
    tax_reduction_amount: taxReductionAmount,
    ref_detail_type: refDetailType,
    inventory_item_type: getNumber(detail, [
      "InventoryItemType",
      "inventoryItemType",
    ]),
    is_option: refDetailType === 2 || Boolean(getParentRefDetailId(detail)),
    payment_status: params.paymentStatus,
    is_canceled: params.isCanceled,
    raw_json: detail,
    synced_at: params.syncedAt,
    updated_at: params.syncedAt,
  };
}

export function buildPaymentRow(params: {
  receiptId: number | null;
  receiptRefId: string;
  businessDate: string;
  refDate: string | null;
  payment: JsonObject;
  syncedAt: string;
}): PaymentRow {
  const payment = params.payment;

  return {
    source: SOURCE,
    receipt_id: params.receiptId,
    receipt_ref_id: params.receiptRefId,
    business_date: params.businessDate,
    ref_date: params.refDate,
    payment_type: getNumber(payment, ["PaymentType", "paymentType"]),
    payment_name: getString(payment, ["PaymentName", "paymentName"]),
    card_id: getString(payment, ["CardID", "CardId", "cardID", "cardId"]),
    card_name: getString(payment, ["CardName", "cardName"]),
    amount: getNumber(payment, ["Amount", "amount"]) ?? 0,
    raw_json: payment,
    synced_at: params.syncedAt,
    updated_at: params.syncedAt,
  };
}

function normalizeForCompare(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForCompare);
  }

  if (value && typeof value === "object") {
    return Object.keys(value as JsonObject)
      .sort()
      .reduce<JsonObject>((acc, key) => {
        acc[key] = normalizeForCompare((value as JsonObject)[key]);
        return acc;
      }, {});
  }

  return value;
}

function getComparableTime(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(value.trim())) return null;

  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isEqualValue(left: unknown, right: unknown) {
  const leftTime = getComparableTime(left);
  const rightTime = getComparableTime(right);

  if (leftTime !== null && rightTime !== null) {
    return leftTime === rightTime;
  }

  if (
    (typeof left === "number" || typeof right === "number") &&
    (typeof left === "number" || typeof left === "string") &&
    (typeof right === "number" || typeof right === "string")
  ) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);

    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return leftNumber === rightNumber;
    }
  }

  return JSON.stringify(normalizeForCompare(left)) === JSON.stringify(normalizeForCompare(right));
}

function hasReceiptChanged(existing: ExistingReceiptRow, next: ReceiptRow) {
  const compareKeys: (keyof ReceiptRow)[] = [
    "source",
    "branch_id",
    "branch_code",
    "branch_name",
    "ref_id",
    "ref_no",
    "business_date",
    "ref_date",
    "payment_status",
    "is_canceled",
    "total_amount",
    "discount_amount",
    "vat_amount",
    "final_amount",
    "receive_amount",
    "return_amount",
    "customer_name",
    "table_name",
    "raw_json",
  ];

  return compareKeys.some((key) => !isEqualValue(existing[key], next[key]));
}

function hasLineChanged(existing: ExistingLineRow, next: LineRow) {
  const compareKeys: (keyof LineRow)[] = [
    "source",
    "receipt_id",
    "receipt_ref_id",
    "ref_detail_id",
    "parent_ref_detail_id",
    "business_date",
    "ref_date",
    "sort_order",
    "item_id",
    "item_code",
    "item_name",
    "unit_id",
    "unit_name",
    "quantity",
    "unit_price",
    "amount",
    "discount_amount",
    "final_amount",
    "tax_rate",
    "tax_amount",
    "pre_tax_amount",
    "tax_reduction_amount",
    "ref_detail_type",
    "inventory_item_type",
    "is_option",
    "payment_status",
    "is_canceled",
    "raw_json",
  ];

  return compareKeys.some((key) => !isEqualValue(existing[key], next[key]));
}

function getLineRefDetailKey(
  row: Pick<LineRow, "receipt_ref_id" | "ref_detail_id">
) {
  return `${row.receipt_ref_id}::${row.ref_detail_id}`;
}

function getLineFallbackKey(
  row: Pick<
    LineRow,
    | "receipt_ref_id"
    | "sort_order"
    | "item_id"
    | "item_code"
    | "item_name"
    | "quantity"
    | "unit_price"
    | "final_amount"
    | "is_option"
    | "parent_ref_detail_id"
  >
) {
  return [
    row.receipt_ref_id,
    row.sort_order,
    row.item_id || row.item_code || "",
    row.item_name || "",
    row.quantity,
    row.unit_price,
    row.final_amount,
    row.is_option ? "option" : "normal",
    row.parent_ref_detail_id || "",
  ].join("");
}

function getPaymentKey(row: Pick<PaymentRow, "receipt_ref_id" | "payment_type" | "payment_name" | "card_name">) {
  return [
    row.receipt_ref_id,
    row.payment_type ?? -1,
    row.payment_name || "",
    row.card_name || "",
  ].join("::");
}

function hasPaymentChanged(existing: ExistingPaymentRow, next: PaymentRow) {
  const compareKeys: (keyof PaymentRow)[] = [
    "source",
    "receipt_id",
    "receipt_ref_id",
    "business_date",
    "ref_date",
    "payment_type",
    "payment_name",
    "card_id",
    "card_name",
    "amount",
    "raw_json",
  ];

  return compareKeys.some((key) => !isEqualValue(existing[key], next[key]));
}

export function stripRawJson<T extends { raw_json?: unknown }>(row: T) {
  const { raw_json, ...rest } = row;
  void raw_json;

  return rest;
}

export async function getExistingReceipts(refIds: string[]) {
  if (refIds.length === 0) return new Map<string, ExistingReceiptRow>();

  const { data, error } = await supabaseServer
    .from("pos_sales_receipts")
    .select(
      "id, source, branch_id, branch_code, branch_name, ref_id, ref_no, business_date, ref_date, payment_status, is_canceled, total_amount, discount_amount, vat_amount, final_amount, receive_amount, return_amount, customer_name, table_name, raw_json, synced_at, updated_at, is_modified"
    )
    .eq("source", SOURCE)
    .in("ref_id", refIds);

  if (error) {
    throw new Error(`Failed to fetch existing sales receipts: ${error.message}`);
  }

  const map = new Map<string, ExistingReceiptRow>();

  ((data || []) as ExistingReceiptRow[]).forEach((row) => {
    map.set(row.ref_id, {
      ...row,
      id: Number(row.id),
    });
  });

  return map;
}

export async function getModifiedReceiptRefIds(receiptRefIds: string[]) {
  if (receiptRefIds.length === 0) return new Set<string>();

  const { data, error } = await supabaseServer
    .from("pos_sales_receipts")
    .select("ref_id")
    .eq("source", SOURCE)
    .eq("is_modified", true)
    .in("ref_id", receiptRefIds);

  if (error) {
    throw new Error(`Failed to fetch modified sales receipts: ${error.message}`);
  }

  return new Set(((data || []) as { ref_id: string }[]).map((row) => row.ref_id));
}

export async function getExistingLines(receiptRefIds: string[]): Promise<ExistingLineLookup> {
  if (receiptRefIds.length === 0) {
    return {
      rows: [],
      byRefDetailKey: new Map<string, ExistingLineRow>(),
      byFallbackKey: new Map<string, ExistingLineRow[]>(),
    };
  }

  const { data, error } = await supabaseServer
    .from("pos_sales_receipt_lines")
    .select(
      "id, source, receipt_id, receipt_ref_id, ref_detail_id, parent_ref_detail_id, business_date, ref_date, sort_order, item_id, item_code, item_name, unit_id, unit_name, quantity, unit_price, amount, discount_amount, final_amount, tax_rate, tax_amount, pre_tax_amount, tax_reduction_amount, ref_detail_type, inventory_item_type, is_option, is_excluded, payment_status, is_canceled, raw_json, synced_at, updated_at"
    )
    .eq("source", SOURCE)
    .in("receipt_ref_id", receiptRefIds);

  if (error) {
    throw new Error(`Failed to fetch existing sales lines: ${error.message}`);
  }

  const byRefDetailKey = new Map<string, ExistingLineRow>();
  const byFallbackKey = new Map<string, ExistingLineRow[]>();

  const rows = ((data || []) as ExistingLineRow[]).map((row) => ({
    ...row,
    id: Number(row.id),
  }));

  rows
    .filter((line) => line.is_excluded !== true)
    .forEach((line) => {
      const fallbackKey = getLineFallbackKey(line);
      const fallbackRows = byFallbackKey.get(fallbackKey) || [];

      fallbackRows.push(line);
      byFallbackKey.set(fallbackKey, fallbackRows);

      if (!line.ref_detail_id) return;
      byRefDetailKey.set(getLineRefDetailKey(line), line);
    });

  return {
    rows,
    byRefDetailKey,
    byFallbackKey,
  };
}

export async function getReceiptsWithAppliedDeductions(receiptIds: number[]) {
  const safeReceiptIds = receiptIds.filter(
    (id) => Number.isInteger(id) && id > 0
  );
  if (safeReceiptIds.length === 0) return new Set<number>();

  const [deductions, deductionReceipts] = await Promise.all([
    supabaseServer
      .from("pos_inventory_deductions")
      .select("receipt_id")
      .in("receipt_id", safeReceiptIds),
    supabaseServer
      .from("pos_inventory_deduction_receipts")
      .select("receipt_id")
      .in("receipt_id", safeReceiptIds),
  ]);

  if (deductions.error) {
    throw new Error(
      `Failed to fetch sales inventory deductions: ${deductions.error.message}`
    );
  }
  if (deductionReceipts.error) {
    throw new Error(
      `Failed to fetch sales inventory deduction receipts: ${deductionReceipts.error.message}`
    );
  }

  return new Set(
    [
      ...((deductions.data || []) as { receipt_id: number | null }[]).map(
        (row) => Number(row.receipt_id)
      ),
      ...((deductionReceipts.data || []) as { receipt_id: number | null }[]).map(
        (row) => Number(row.receipt_id)
      ),
    ].filter((id) => Number.isInteger(id) && id > 0)
  );
}

function isOptionOrLinkedLine(
  row: Pick<
    LineRow,
    "is_option" | "parent_ref_detail_id" | "ref_detail_type"
  >
) {
  return (
    row.is_option === true ||
    Boolean(row.parent_ref_detail_id) ||
    (row.ref_detail_type !== null && row.ref_detail_type !== 1)
  );
}

function sumLineFinalAmount(
  rows: Pick<LineRow, "final_amount">[]
) {
  return rows.reduce((sum, row) => sum + Number(row.final_amount || 0), 0);
}

function isSameAmount(left: number, right: number) {
  return Math.abs(left - right) < 0.01;
}

function groupLinesByReceiptRefId<T extends Pick<LineRow, "receipt_ref_id">>(
  rows: T[]
) {
  const map = new Map<string, T[]>();

  rows.forEach((row) => {
    const current = map.get(row.receipt_ref_id) || [];
    current.push(row);
    map.set(row.receipt_ref_id, current);
  });

  return map;
}

function getMatchedActiveLineIds(params: {
  payloadRows: LineRow[];
  activeLines: ExistingLineRow[];
}) {
  const byRefDetailKey = new Map<string, ExistingLineRow>();
  const byFallbackKey = new Map<string, ExistingLineRow[]>();

  params.activeLines.forEach((line) => {
    const fallbackKey = getLineFallbackKey(line);
    const fallbackRows = byFallbackKey.get(fallbackKey) || [];

    fallbackRows.push(line);
    byFallbackKey.set(fallbackKey, fallbackRows);

    if (line.ref_detail_id) {
      byRefDetailKey.set(getLineRefDetailKey(line), line);
    }
  });

  const matchedIds = new Set<number>();
  let ambiguousCount = 0;

  params.payloadRows.forEach((row) => {
    if (!row.ref_detail_id) return;

    const primaryExisting = byRefDetailKey.get(getLineRefDetailKey(row));
    if (primaryExisting) {
      matchedIds.add(primaryExisting.id);
      return;
    }

    const fallbackRows = (byFallbackKey.get(getLineFallbackKey(row)) || []).filter(
      (line) => !matchedIds.has(line.id)
    );

    if (fallbackRows.length === 1) {
      matchedIds.add(fallbackRows[0].id);
      return;
    }

    if (fallbackRows.length > 1) {
      ambiguousCount += 1;
    }
  });

  return {
    matchedIds,
    ambiguousCount,
  };
}

export async function excludeStaleLines(params: {
  rows: LineRow[];
  receiptRows: Map<string, ExistingReceiptRow>;
  skippedFallbackReceiptRefIds: Set<string>;
}) {
  const receiptRefIds = Array.from(
    new Set(params.rows.map((row) => row.receipt_ref_id))
  );

  if (receiptRefIds.length === 0) {
    return {
      candidateCount: 0,
      excludedCount: 0,
      skippedCount: 0,
      timing: {
        initialQueriesMs: 0,
        staleCandidateBuildMs: 0,
        staleUpdateMs: 0,
      },
    };
  }

  // Note: this MUST be a fresh read, not the `existingLines` saveLines
  // already fetched earlier — saveLines' insert/update writes happen
  // between that fetch and this one, and the stale-line sum checks below
  // depend on seeing each line's just-written final_amount. Reusing the
  // pre-write snapshot here would silently change stale-line outcomes,
  // which is explicitly out of scope for this change.
  //
  // Perf: this read and the deduction-lookup below are independent of each
  // other, so they can run concurrently.
  const initialQueriesStartedAt = Date.now();
  const receiptIds = Array.from(params.receiptRows.values()).map((row) => row.id);
  const [latestLines, receiptsWithDeductions] = await Promise.all([
    getExistingLines(receiptRefIds),
    getReceiptsWithAppliedDeductions(receiptIds),
  ]);
  const initialQueriesMs = Date.now() - initialQueriesStartedAt;
  const rowsByReceiptRefId = groupLinesByReceiptRefId(params.rows);
  const activeLinesByReceiptRefId = groupLinesByReceiptRefId(
    latestLines.rows.filter((line) => line.is_excluded !== true)
  );
  let candidateCount = 0;
  let excludedCount = 0;
  let skippedCount = 0;
  let staleCandidateBuildMs = 0;
  let staleUpdateMs = 0;

  for (const receiptRefId of receiptRefIds) {
    const buildStepStartedAt = Date.now();
    const receipt = params.receiptRows.get(receiptRefId);
    const payloadRows = rowsByReceiptRefId.get(receiptRefId) || [];
    const activeLines = activeLinesByReceiptRefId.get(receiptRefId) || [];

    if (!receipt || payloadRows.length === 0 || activeLines.length === 0) {
      staleCandidateBuildMs += Date.now() - buildStepStartedAt;
      continue;
    }

    const { matchedIds, ambiguousCount } = getMatchedActiveLineIds({
      payloadRows,
      activeLines,
    });
    const staleCandidates = activeLines.filter((line) => !matchedIds.has(line.id));

    if (staleCandidates.length === 0) {
      staleCandidateBuildMs += Date.now() - buildStepStartedAt;
      continue;
    }

    candidateCount += staleCandidates.length;

    const payloadSum = sumLineFinalAmount(payloadRows);
    const activeLineSum = sumLineFinalAmount(activeLines);
    const staleCandidateSum = sumLineFinalAmount(staleCandidates);
    const overageAmount = activeLineSum - receipt.total_amount;
    const skipReason = (() => {
      if (receipt.is_modified === true) return "receipt_modified";
      if (receipt.is_canceled === true) return "receipt_canceled";
      if (receiptsWithDeductions.has(receipt.id)) return "deduction_linked";
      if (ambiguousCount > 0) return "ambiguous_payload_match";
      if (params.skippedFallbackReceiptRefIds.has(receiptRefId)) {
        return "fallback_match_skipped";
      }
      if (
        payloadRows.some(isOptionOrLinkedLine) ||
        activeLines.some(isOptionOrLinkedLine)
      ) {
        return "option_or_parent_lines_present";
      }
      if (!isSameAmount(payloadSum, receipt.total_amount)) {
        return "payload_sum_mismatch";
      }
      if (overageAmount <= 0 || !isSameAmount(staleCandidateSum, overageAmount)) {
        return "stale_sum_mismatch";
      }
      return null;
    })();

    if (skipReason) {
      skippedCount += staleCandidates.length;
      console.warn("[SALES_SYNC_STALE_LINES_SKIPPED]", {
        receiptRefId,
        receiptId: receipt.id,
        reason: skipReason,
        staleCandidateLineIds: staleCandidates.map((line) => line.id),
        payloadSum,
        receiptTotalAmount: receipt.total_amount,
        activeLineSum,
        overageAmount,
        staleCandidateSum,
      });
      staleCandidateBuildMs += Date.now() - buildStepStartedAt;
      continue;
    }
    staleCandidateBuildMs += Date.now() - buildStepStartedAt;

    const updateStepStartedAt = Date.now();
    const staleLineIds = staleCandidates.map((line) => line.id);
    const { error } = await supabaseServer
      .from("pos_sales_receipt_lines")
      .update({
        is_excluded: true,
        updated_at: new Date().toISOString(),
      })
      .in("id", staleLineIds);

    if (error) {
      throw new Error(
        `Failed to exclude stale sales lines for ${receiptRefId}: ${error.message}`
      );
    }

    excludedCount += staleLineIds.length;
    console.warn("[SALES_SYNC_STALE_LINES_EXCLUDED]", {
      receiptRefId,
      receiptId: receipt.id,
      staleLineIds,
      payloadSum,
      receiptTotalAmount: receipt.total_amount,
      activeLineSum,
      staleCandidateSum,
    });
    staleUpdateMs += Date.now() - updateStepStartedAt;
  }

  return {
    candidateCount,
    excludedCount,
    skippedCount,
    timing: {
      initialQueriesMs,
      staleCandidateBuildMs,
      staleUpdateMs,
    },
  };
}

function buildReceiptIdMap(existingMap: Map<string, ExistingReceiptRow>) {
  const receiptIdMap = new Map<string, number>();

  existingMap.forEach((row, refId) => {
    receiptIdMap.set(refId, row.id);
  });

  return receiptIdMap;
}

export async function getReceiptPaymentSources(receiptRefIds: string[]) {
  if (receiptRefIds.length === 0) return new Map<string, ExistingReceiptRow>();

  const { data, error } = await supabaseServer
    .from("pos_sales_receipts")
    .select(
      "id, source, branch_id, branch_code, branch_name, ref_id, ref_no, business_date, ref_date, payment_status, is_canceled, total_amount, discount_amount, vat_amount, final_amount, receive_amount, return_amount, customer_name, table_name, raw_json, synced_at, updated_at"
    )
    .eq("source", SOURCE)
    .in("ref_id", receiptRefIds);

  if (error) {
    throw new Error(`Failed to fetch receipt payment sources: ${error.message}`);
  }

  const map = new Map<string, ExistingReceiptRow>();

  ((data || []) as ExistingReceiptRow[]).forEach((row) => {
    map.set(row.ref_id, {
      ...row,
      id: Number(row.id),
    });
  });

  return map;
}

export async function getExistingPayments(receiptRefIds: string[]) {
  if (receiptRefIds.length === 0) return new Map<string, ExistingPaymentRow>();

  const { data, error } = await supabaseServer
    .from("pos_sales_receipt_payments")
    .select(
      "id, source, receipt_id, receipt_ref_id, business_date, ref_date, payment_type, payment_name, card_id, card_name, amount, raw_json, synced_at, updated_at"
    )
    .eq("source", SOURCE)
    .in("receipt_ref_id", receiptRefIds);

  if (error) {
    throw new Error(`Failed to fetch existing sales payments: ${error.message}`);
  }

  const map = new Map<string, ExistingPaymentRow>();

  ((data || []) as ExistingPaymentRow[]).forEach((row) => {
    map.set(getPaymentKey(row), {
      ...row,
      id: Number(row.id),
    });
  });

  return map;
}

export async function saveReceipts(rows: ReceiptRow[]) {
  const emptyTiming = {
    getExistingReceiptsMs: 0,
    compareReceiptsMs: 0,
    insertReceiptsMs: 0,
    updateReceiptsMs: 0,
    buildReceiptIdMapMs: 0,
  };

  if (rows.length === 0) {
    return {
      receiptIdMap: new Map<string, number>(),
      createdCount: 0,
      updatedCount: 0,
      statusChangedCount: 0,
      timing: emptyTiming,
    };
  }

  const getExistingStartedAt = Date.now();
  const existingMap = await getExistingReceipts(rows.map((row) => row.ref_id));
  const getExistingReceiptsMs = Date.now() - getExistingStartedAt;

  const compareStartedAt = Date.now();
  const inserts = rows.filter((row) => !existingMap.has(row.ref_id));
  const updates = rows.filter((row) => {
    const existing = existingMap.get(row.ref_id);
    return existing && !existing.is_modified ? hasReceiptChanged(existing, row) : false;
  });
  const statusChangedCount =
    inserts.filter((row) => row.is_canceled).length +
    updates.filter((row) => {
      const existing = existingMap.get(row.ref_id);
      return (
        existing &&
        (existing.payment_status !== row.payment_status ||
          existing.is_canceled !== row.is_canceled)
      );
    }).length;
  const compareReceiptsMs = Date.now() - compareStartedAt;

  // Perf: the receipt ID for every ref_id we already had (whether updated or
  // left unchanged) is already known from existingMap — no need to re-fetch
  // it. Only brand-new inserts need their DB-generated id, which we get
  // straight from the insert's own response instead of a follow-up SELECT.
  const buildMapStartedAt = Date.now();
  const finalReceiptIdMap = buildReceiptIdMap(existingMap);
  let buildReceiptIdMapMs = Date.now() - buildMapStartedAt;

  let insertReceiptsMs = 0;
  if (inserts.length > 0) {
    const insertStartedAt = Date.now();
    const { data: insertedRows, error } = await supabaseServer
      .from("pos_sales_receipts")
      .insert(inserts)
      .select("id, ref_id");
    insertReceiptsMs = Date.now() - insertStartedAt;

    if (error) {
      throw new Error(`Failed to insert sales receipts: ${error.message}`);
    }

    const mapMergeStartedAt = Date.now();
    (insertedRows || []).forEach((row) => {
      finalReceiptIdMap.set(row.ref_id, Number(row.id));
    });
    buildReceiptIdMapMs += Date.now() - mapMergeStartedAt;
  }

  let updateReceiptsMs = 0;
  if (updates.length > 0) {
    const updateStartedAt = Date.now();
    for (const row of updates) {
      const id = existingMap.get(row.ref_id)?.id;
      const { error } = await supabaseServer
        .from("pos_sales_receipts")
        .update(row)
        .eq("id", id);

      if (error) {
        throw new Error(`Failed to update sales receipt ${row.ref_id}: ${error.message}`);
      }
    }
    updateReceiptsMs = Date.now() - updateStartedAt;
  }

  return {
    receiptIdMap: finalReceiptIdMap,
    createdCount: inserts.length,
    updatedCount: updates.length,
    statusChangedCount,
    timing: {
      getExistingReceiptsMs,
      compareReceiptsMs,
      insertReceiptsMs,
      updateReceiptsMs,
      buildReceiptIdMapMs,
    },
  };
}

export async function saveLines(rows: LineRow[]) {
  const emptyTiming = {
    initialQueriesMs: 0,
    compareLinesMs: 0,
    insertLinesMs: 0,
    updateLinesMs: 0,
    excludeStaleLinesMs: 0,
    excludeStaleLinesDetail: {
      initialQueriesMs: 0,
      staleCandidateBuildMs: 0,
      staleUpdateMs: 0,
    },
  };

  if (rows.length === 0) {
    return {
      createdCount: 0,
      updatedCount: 0,
      statusChangedCount: 0,
      taxLineChangedCount: 0,
      fallbackMatchedCount: 0,
      fallbackSkippedCount: 0,
      staleCandidateCount: 0,
      staleExcludedCount: 0,
      staleSkippedCount: 0,
      timing: emptyTiming,
    };
  }

  const receiptRefIds = Array.from(
    new Set(rows.map((row) => row.receipt_ref_id))
  );
  // Perf: these three reads are independent of each other (different
  // tables/conditions, none depends on another's result) — running them
  // concurrently instead of sequentially doesn't change what any of them
  // return.
  const initialQueriesStartedAt = Date.now();
  const [existingLines, receiptRows, modifiedReceiptRefIds] = await Promise.all([
    getExistingLines(receiptRefIds),
    getExistingReceipts(receiptRefIds),
    getModifiedReceiptRefIds(receiptRefIds),
  ]);
  const initialQueriesMs = Date.now() - initialQueriesStartedAt;

  const compareStartedAt = Date.now();
  const editableRows = rows.filter(
    (row) => !modifiedReceiptRefIds.has(row.receipt_ref_id)
  );

  const inserts: LineRow[] = [];
  const updates: { row: LineRow; existing: ExistingLineRow }[] = [];
  const usedExistingLineIds = new Set<number>();
  const skippedFallbackReceiptRefIds = new Set<string>();
  let fallbackMatchedCount = 0;
  let fallbackSkippedCount = 0;

  editableRows.forEach((row) => {
    if (!row.ref_detail_id) return;
    const primaryKey = getLineRefDetailKey(row);
    const primaryExisting = existingLines.byRefDetailKey.get(primaryKey);

    if (primaryExisting) {
      usedExistingLineIds.add(primaryExisting.id);
      if (hasLineChanged(primaryExisting, row)) {
        updates.push({ row, existing: primaryExisting });
      }
      return;
    }

    const fallbackRows = (
      existingLines.byFallbackKey.get(getLineFallbackKey(row)) || []
    ).filter((line) => !usedExistingLineIds.has(line.id));

    if (fallbackRows.length === 1) {
      const fallbackExisting = fallbackRows[0];
      usedExistingLineIds.add(fallbackExisting.id);
      fallbackMatchedCount += 1;

      if (hasLineChanged(fallbackExisting, row)) {
        updates.push({ row, existing: fallbackExisting });
      }
      return;
    }

    if (fallbackRows.length > 1) {
      fallbackSkippedCount += 1;
      skippedFallbackReceiptRefIds.add(row.receipt_ref_id);
      console.warn(
        `[SALES_SYNC_LINE_FALLBACK_AMBIGUOUS] ${row.receipt_ref_id}/${row.ref_detail_id}: ${fallbackRows.length} candidate lines`
      );
      return;
    }

    inserts.push(row);
  });
  const statusChangedCount =
    inserts.filter((row) => row.is_canceled).length +
    updates.filter(({ row, existing }) => {
      return (
        existing &&
        (existing.payment_status !== row.payment_status ||
          existing.is_canceled !== row.is_canceled)
      );
    }).length;
  const taxLineChangedCount = [
    ...inserts,
    ...updates.map(({ row }) => row),
  ].filter(
    (row) =>
      row.tax_rate !== null ||
      row.tax_amount !== 0 ||
      row.pre_tax_amount !== 0 ||
      row.tax_reduction_amount !== 0
  ).length;
  const compareLinesMs = Date.now() - compareStartedAt;

  let insertLinesMs = 0;
  if (inserts.length > 0) {
    const insertStartedAt = Date.now();
    const { error } = await supabaseServer
      .from("pos_sales_receipt_lines")
      .insert(inserts);
    insertLinesMs = Date.now() - insertStartedAt;

    if (error) {
      throw new Error(`Failed to insert sales lines: ${error.message}`);
    }
  }

  let updateLinesMs = 0;
  if (updates.length > 0) {
    const updateStartedAt = Date.now();
    for (const { row, existing } of updates) {
      const { error } = await supabaseServer
        .from("pos_sales_receipt_lines")
        .update(row)
        .eq("id", existing.id);

      if (error) {
        throw new Error(
          `Failed to update sales line ${row.receipt_ref_id}/${row.ref_detail_id}: ${error.message}`
        );
      }
    }
    updateLinesMs = Date.now() - updateStartedAt;
  }

  const excludeStaleLinesStartedAt = Date.now();
  const staleLineResult = await excludeStaleLines({
    rows: editableRows,
    receiptRows,
    skippedFallbackReceiptRefIds,
  });
  const excludeStaleLinesMs = Date.now() - excludeStaleLinesStartedAt;

  return {
    createdCount: inserts.length,
    updatedCount: updates.length,
    statusChangedCount,
    taxLineChangedCount,
    fallbackMatchedCount,
    fallbackSkippedCount,
    staleCandidateCount: staleLineResult.candidateCount,
    staleExcludedCount: staleLineResult.excludedCount,
    staleSkippedCount: staleLineResult.skippedCount,
    timing: {
      initialQueriesMs,
      compareLinesMs,
      insertLinesMs,
      updateLinesMs,
      excludeStaleLinesMs,
      excludeStaleLinesDetail: staleLineResult.timing,
    },
  };
}

export async function savePayments(rows: PaymentRow[]) {
  const emptyTiming = {
    initialQueriesMs: 0,
    insertPaymentsMs: 0,
    updatePaymentsMs: 0,
  };

  if (rows.length === 0) {
    return {
      createdCount: 0,
      updatedCount: 0,
      timing: emptyTiming,
    };
  }

  const receiptRefIds = Array.from(
    new Set(rows.map((row) => row.receipt_ref_id))
  );
  // Perf: independent reads, safe to run concurrently (see saveLines above).
  const initialQueriesStartedAt = Date.now();
  const [existingMap, modifiedReceiptRefIds] = await Promise.all([
    getExistingPayments(receiptRefIds),
    getModifiedReceiptRefIds(receiptRefIds),
  ]);
  const initialQueriesMs = Date.now() - initialQueriesStartedAt;
  const editableRows = rows.filter(
    (row) => !modifiedReceiptRefIds.has(row.receipt_ref_id)
  );
  const inserts = editableRows.filter((row) => !existingMap.has(getPaymentKey(row)));
  const updates = editableRows.filter((row) => {
    const existing = existingMap.get(getPaymentKey(row));
    return existing ? hasPaymentChanged(existing, row) : false;
  });

  let insertPaymentsMs = 0;
  if (inserts.length > 0) {
    const insertStartedAt = Date.now();
    const { error } = await supabaseServer
      .from("pos_sales_receipt_payments")
      .insert(inserts);
    insertPaymentsMs = Date.now() - insertStartedAt;

    if (error) {
      throw new Error(`Failed to insert sales payments: ${error.message}`);
    }
  }

  let updatePaymentsMs = 0;
  if (updates.length > 0) {
    const updateStartedAt = Date.now();
    for (const row of updates) {
      const id = existingMap.get(getPaymentKey(row))?.id;
      const { error } = await supabaseServer
        .from("pos_sales_receipt_payments")
        .update(row)
        .eq("id", id);

      if (error) {
        throw new Error(
          `Failed to update sales payment ${row.receipt_ref_id}: ${error.message}`
        );
      }
    }
    updatePaymentsMs = Date.now() - updateStartedAt;
  }

  return {
    createdCount: inserts.length,
    updatedCount: updates.length,
    timing: {
      initialQueriesMs,
      insertPaymentsMs,
      updatePaymentsMs,
    },
  };
}

export function dedupePaymentRows(rows: PaymentRow[]) {
  const map = new Map<string, PaymentRow>();

  rows.forEach((row) => {
    map.set(getPaymentKey(row), row);
  });

  return Array.from(map.values());
}
