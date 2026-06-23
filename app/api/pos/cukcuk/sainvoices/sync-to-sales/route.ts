import { NextResponse } from "next/server";
import { loginCukcuk } from "@/lib/pos/cukcuk/auth";
import { requirePosAdminSecret } from "@/lib/pos/api-guard";
import {
  getBusinessDate,
  getBusinessWindowByBusinessDate,
} from "@/lib/common/business-time";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

const CUKCUK_BASE_URL =
  process.env.CUKCUK_BASE_URL || "https://graphapi.cukcuk.vn";

const DEFAULT_BRANCH_ID = "c39228ba-a452-4cf9-bf34-424ffb151fb8";
const SOURCE = "cukcuk";
const SYNC_LOCK_TIMEOUT_MS = 15 * 60 * 1000;
const CUKCUK_LIMIT_REACHED_WARNING =
  "CUKCUK 응답이 limit에 도달했습니다. 해당 businessDate 데이터가 일부 누락됐을 수 있으니 POS 원본 매출과 검산하세요.";

type JsonObject = Record<string, unknown>;

type CukcukInvoice = JsonObject;
type CukcukInvoiceDetail = JsonObject;

type ReceiptRow = {
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

type LineRow = {
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

type ExistingReceiptRow = ReceiptRow & {
  id: number;
  is_modified?: boolean | null;
};

type ExistingLineRow = LineRow & {
  id: number;
  is_excluded: boolean | null;
};

type ExistingLineLookup = {
  rows: ExistingLineRow[];
  byRefDetailKey: Map<string, ExistingLineRow>;
  byFallbackKey: Map<string, ExistingLineRow[]>;
};

type PaymentRow = {
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

type ExistingPaymentRow = PaymentRow & {
  id: number;
};

type SyncContext = {
  businessDate: string;
  branchId: string;
  requestParams: JsonObject;
};

type RunningSyncRun = {
  id: number;
  started_at: string | null;
};

class SyncAlreadyRunningError extends Error {
  businessDate: string;
  runningSyncRunId: number | null;
  startedAt: string | null;

  constructor(params: {
    businessDate: string;
    runningSyncRunId: number | null;
    startedAt: string | null;
  }) {
    super("해당 날짜 동기화가 이미 진행 중입니다.");
    this.name = "SyncAlreadyRunningError";
    this.businessDate = params.businessDate;
    this.runningSyncRunId = params.runningSyncRunId;
    this.startedAt = params.startedAt;
  }
}

function isValidBusinessDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getNextDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + 1);

  return date.toISOString().slice(0, 10);
}

function getCukcukBusinessDateRange(businessDate: string) {
  return {
    fromDate: `${businessDate}T16:00:00+07:00`,
    toDate: `${getNextDateKey(businessDate)}T03:00:00+07:00`,
  };
}

function toTimestamp(value: string | null) {
  if (!value) return null;

  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isInvoiceInRequestedRange(params: {
  invoiceDate: string | null;
  fromDate: string;
  toDate: string;
}) {
  const invoiceTime = toTimestamp(params.invoiceDate);
  const fromTime = toTimestamp(params.fromDate);
  const toTime = toTimestamp(params.toDate);

  if (invoiceTime === null || fromTime === null || toTime === null) {
    return false;
  }

  return invoiceTime >= fromTime && invoiceTime < toTime;
}

function getString(record: JsonObject | null | undefined, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
}

function getNumber(record: JsonObject | null | undefined, keys: string[]) {
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

function getInvoiceRefId(invoice: CukcukInvoice) {
  return getString(invoice, ["RefId", "RefID", "refId", "refID"]) || "";
}

function getInvoiceRefNo(invoice: CukcukInvoice) {
  return getString(invoice, ["RefNo", "refNo"]);
}

function getInvoiceDate(invoice: CukcukInvoice) {
  return getString(invoice, ["RefDate", "PostedDate", "refDate", "postedDate"]);
}

function getPaymentStatus(invoice: CukcukInvoice) {
  return getNumber(invoice, ["PaymentStatus", "paymentStatus"]);
}

function isCanceledPaymentStatus(paymentStatus: number | null) {
  return paymentStatus === 4 || paymentStatus === 5;
}

function getDetailsFromInvoicePayload(payload: JsonObject): CukcukInvoiceDetail[] {
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

function getRefDetailId(detail: CukcukInvoiceDetail) {
  return getString(detail, ["RefDetailID", "RefDetailId", "refDetailID", "refDetailId"]);
}

function getParentRefDetailId(detail: CukcukInvoiceDetail) {
  return getString(detail, ["ParentID", "ParentId", "parentID", "parentId"]);
}

function getRefDetailType(detail: CukcukInvoiceDetail) {
  return getNumber(detail, ["RefDetailType", "refDetailType"]);
}

function getPaymentsFromInvoicePayload(payload: JsonObject): JsonObject[] {
  const candidates = [
    payload.SAInvoicePayments,
    payload.saInvoicePayments,
    payload.Payments,
    payload.payments,
  ];

  const found = candidates.find((item) => Array.isArray(item));

  return Array.isArray(found) ? (found as JsonObject[]) : [];
}

function isCashPayment(payment: JsonObject) {
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

function getPaymentAmount(payment: JsonObject) {
  return getNumber(payment, ["Amount", "amount"]) ?? 0;
}

function getLineFinalAmount(detail: CukcukInvoiceDetail) {
  const amount = getNumber(detail, ["Amount", "amount"]) ?? 0;
  const discountAmount =
    getNumber(detail, ["DiscountAmount", "PromotionAmount", "discountAmount"]) ??
    0;

  return getNumber(detail, ["FinalAmount", "finalAmount"]) ?? amount - discountAmount;
}

function getLineSalesAmount(payload: JsonObject) {
  const details = getDetailsFromInvoicePayload(payload);

  if (details.length === 0) return null;

  return details.reduce((sum, detail) => sum + getLineFinalAmount(detail), 0);
}

function buildCukcukHeaders(accessToken: string, companyCode: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    CompanyCode: companyCode,
  };
}

function getCukcukDataArray(json: JsonObject) {
  const data = json.Data;

  if (Array.isArray(data)) return data as CukcukInvoice[];

  if (data && typeof data === "object") {
    const dataObject = data as JsonObject;

    if (Array.isArray(dataObject.Data)) return dataObject.Data as CukcukInvoice[];
    if (Array.isArray(dataObject.Items)) return dataObject.Items as CukcukInvoice[];
  }

  return [];
}

async function fetchSaInvoicesPaging(params: {
  accessToken: string;
  companyCode: string;
  branchId: string;
  fromDate: string;
  limit: number;
}) {
  const body = {
    Page: 1,
    Limit: params.limit,
    BranchId: params.branchId,
    LastSyncDate: params.fromDate,
  };

  const response = await fetch(`${CUKCUK_BASE_URL}/api/v1/sainvoices/paging`, {
    method: "POST",
    headers: buildCukcukHeaders(params.accessToken, params.companyCode),
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const json = (await response.json()) as JsonObject;

  if (!response.ok || json.Success === false) {
    throw new Error(
      `sainvoices/paging failed: ${JSON.stringify(json).slice(0, 500)}`
    );
  }

  return getCukcukDataArray(json);
}

async function fetchSaInvoiceDetail(params: {
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

function buildReceiptRow(params: {
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

function buildLineRow(params: {
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

function buildPaymentRow(params: {
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
  ].join("\u001f");
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

function stripRawJson<T extends { raw_json?: unknown }>(row: T) {
  const { raw_json, ...rest } = row;
  void raw_json;

  return rest;
}

async function createSyncRun(params: {
  businessDate: string;
  branchId: string;
  requestParams: JsonObject;
}) {
  const { data, error } = await supabaseServer
    .from("pos_sales_sync_runs")
    .insert({
      source: SOURCE,
      business_date: params.businessDate,
      branch_id: params.branchId,
      status: "running",
      request_params: params.requestParams,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to create sales sync run: ${error.message}`);
  }

  return Number(data.id);
}

async function expireStaleSyncRuns(params: {
  businessDate: string;
  branchId: string;
}) {
  const now = new Date();
  const expiresBefore = new Date(
    now.getTime() - SYNC_LOCK_TIMEOUT_MS
  ).toISOString();

  const { error } = await supabaseServer
    .from("pos_sales_sync_runs")
    .update({
      status: "failed",
      finished_at: now.toISOString(),
      error_message: "Sync lock expired before this request started.",
    })
    .eq("source", SOURCE)
    .eq("business_date", params.businessDate)
    .eq("branch_id", params.branchId)
    .eq("status", "running")
    .lt("started_at", expiresBefore);

  if (error) {
    throw new Error(`Failed to expire stale sales sync runs: ${error.message}`);
  }
}

async function getRunningSyncRun(params: {
  businessDate: string;
  branchId: string;
}) {
  const { data, error } = await supabaseServer
    .from("pos_sales_sync_runs")
    .select("id, started_at")
    .eq("source", SOURCE)
    .eq("business_date", params.businessDate)
    .eq("branch_id", params.branchId)
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch running sales sync run: ${error.message}`);
  }

  if (!data) return null;

  return {
    id: Number((data as RunningSyncRun).id),
    started_at: (data as RunningSyncRun).started_at,
  };
}

async function acquireSyncRun(params: {
  businessDate: string;
  branchId: string;
  requestParams: JsonObject;
}) {
  await expireStaleSyncRuns(params);

  try {
    return await createSyncRun(params);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      String(error.message).includes("duplicate key")
    ) {
      const running = await getRunningSyncRun(params);
      throw new SyncAlreadyRunningError({
        businessDate: params.businessDate,
        runningSyncRunId: running?.id ?? null,
        startedAt: running?.started_at ?? null,
      });
    }

    throw error;
  }
}

async function finishSyncRun(params: {
  runId: number;
  status: "success" | "failed";
  receiptCount?: number;
  lineCount?: number;
  createdCount?: number;
  updatedCount?: number;
  canceledCount?: number;
  errorMessage?: string;
}) {
  const { error } = await supabaseServer
    .from("pos_sales_sync_runs")
    .update({
      status: params.status,
      finished_at: new Date().toISOString(),
      receipt_count: params.receiptCount ?? 0,
      line_count: params.lineCount ?? 0,
      created_count: params.createdCount ?? 0,
      updated_count: params.updatedCount ?? 0,
      canceled_count: params.canceledCount ?? 0,
      error_message: params.errorMessage ?? null,
    })
    .eq("id", params.runId);

  if (error) {
    throw new Error(`Failed to update sales sync run: ${error.message}`);
  }
}

async function getExistingReceipts(refIds: string[]) {
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

async function getModifiedReceiptRefIds(receiptRefIds: string[]) {
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

async function getExistingLines(receiptRefIds: string[]): Promise<ExistingLineLookup> {
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

async function getReceiptsWithAppliedDeductions(receiptIds: number[]) {
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

async function excludeStaleLines(params: {
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
    };
  }

  const latestLines = await getExistingLines(receiptRefIds);
  const rowsByReceiptRefId = groupLinesByReceiptRefId(params.rows);
  const activeLinesByReceiptRefId = groupLinesByReceiptRefId(
    latestLines.rows.filter((line) => line.is_excluded !== true)
  );
  const receiptIds = Array.from(params.receiptRows.values()).map((row) => row.id);
  const receiptsWithDeductions = await getReceiptsWithAppliedDeductions(receiptIds);
  let candidateCount = 0;
  let excludedCount = 0;
  let skippedCount = 0;

  for (const receiptRefId of receiptRefIds) {
    const receipt = params.receiptRows.get(receiptRefId);
    const payloadRows = rowsByReceiptRefId.get(receiptRefId) || [];
    const activeLines = activeLinesByReceiptRefId.get(receiptRefId) || [];

    if (!receipt || payloadRows.length === 0 || activeLines.length === 0) {
      continue;
    }

    const { matchedIds, ambiguousCount } = getMatchedActiveLineIds({
      payloadRows,
      activeLines,
    });
    const staleCandidates = activeLines.filter((line) => !matchedIds.has(line.id));

    if (staleCandidates.length === 0) {
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
      continue;
    }

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
  }

  return {
    candidateCount,
    excludedCount,
    skippedCount,
  };
}

function buildReceiptIdMap(existingMap: Map<string, ExistingReceiptRow>) {
  const receiptIdMap = new Map<string, number>();

  existingMap.forEach((row, refId) => {
    receiptIdMap.set(refId, row.id);
  });

  return receiptIdMap;
}

async function getReceiptPaymentSources(receiptRefIds: string[]) {
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

async function getExistingPayments(receiptRefIds: string[]) {
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

async function saveReceipts(rows: ReceiptRow[]) {
  if (rows.length === 0) {
    return {
      receiptIdMap: new Map<string, number>(),
      createdCount: 0,
      updatedCount: 0,
      statusChangedCount: 0,
    };
  }

  const existingMap = await getExistingReceipts(rows.map((row) => row.ref_id));
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

  if (inserts.length > 0) {
    const { error } = await supabaseServer
      .from("pos_sales_receipts")
      .insert(inserts);

    if (error) {
      throw new Error(`Failed to insert sales receipts: ${error.message}`);
    }
  }

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

  const receiptIdMap = await getExistingReceipts(rows.map((row) => row.ref_id));
  const finalReceiptIdMap = buildReceiptIdMap(receiptIdMap);

  return {
    receiptIdMap: finalReceiptIdMap,
    createdCount: inserts.length,
    updatedCount: updates.length,
    statusChangedCount,
  };
}

async function saveLines(rows: LineRow[]) {
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
    };
  }

  const receiptRefIds = Array.from(
    new Set(rows.map((row) => row.receipt_ref_id))
  );
  const existingLines = await getExistingLines(receiptRefIds);
  const receiptRows = await getExistingReceipts(receiptRefIds);
  const modifiedReceiptRefIds = await getModifiedReceiptRefIds(receiptRefIds);
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

  if (inserts.length > 0) {
    const { error } = await supabaseServer
      .from("pos_sales_receipt_lines")
      .insert(inserts);

    if (error) {
      throw new Error(`Failed to insert sales lines: ${error.message}`);
    }
  }

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

  const staleLineResult = await excludeStaleLines({
    rows: editableRows,
    receiptRows,
    skippedFallbackReceiptRefIds,
  });

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
  };
}

async function savePayments(rows: PaymentRow[]) {
  if (rows.length === 0) {
    return {
      createdCount: 0,
      updatedCount: 0,
    };
  }

  const receiptRefIds = Array.from(
    new Set(rows.map((row) => row.receipt_ref_id))
  );
  const existingMap = await getExistingPayments(receiptRefIds);
  const modifiedReceiptRefIds = await getModifiedReceiptRefIds(receiptRefIds);
  const editableRows = rows.filter(
    (row) => !modifiedReceiptRefIds.has(row.receipt_ref_id)
  );
  const inserts = editableRows.filter((row) => !existingMap.has(getPaymentKey(row)));
  const updates = editableRows.filter((row) => {
    const existing = existingMap.get(getPaymentKey(row));
    return existing ? hasPaymentChanged(existing, row) : false;
  });

  if (inserts.length > 0) {
    const { error } = await supabaseServer
      .from("pos_sales_receipt_payments")
      .insert(inserts);

    if (error) {
      throw new Error(`Failed to insert sales payments: ${error.message}`);
    }
  }

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

  return {
    createdCount: inserts.length,
    updatedCount: updates.length,
  };
}

function dedupePaymentRows(rows: PaymentRow[]) {
  const map = new Map<string, PaymentRow>();

  rows.forEach((row) => {
    map.set(getPaymentKey(row), row);
  });

  return Array.from(map.values());
}

export async function POST(req: Request) {
  let syncRunId: number | null = null;
  let syncContext: SyncContext | null = null;

  try {
    const guardResponse = requirePosAdminSecret(req);
    if (guardResponse) return guardResponse;

    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const requestedBusinessDate =
      typeof body.businessDate === "string" ? body.businessDate.trim() : "";
    const businessDate = requestedBusinessDate || getBusinessDate();
    const branchId =
      typeof body.branchId === "string" && body.branchId.trim()
        ? body.branchId.trim()
        : DEFAULT_BRANCH_ID;
    const limit = Math.min(Math.max(Number(body.limit || 100), 1), 100);
    const includeReceipts = body.includeReceipts === true;
    const includeLines = body.includeLines === true;

    if (!isValidBusinessDate(businessDate)) {
      return NextResponse.json(
        {
          ok: false,
          error: "businessDate must use YYYY-MM-DD format.",
          example: {
            businessDate: "2026-05-09",
            branchId: DEFAULT_BRANCH_ID,
            limit: 100,
          },
        },
        { status: 400 }
      );
    }

    const businessWindow = getBusinessWindowByBusinessDate(businessDate);
    const requestRange = getCukcukBusinessDateRange(businessDate);
    const filterFromDate = businessWindow.start.toISOString();
    const filterToDate = businessWindow.end.toISOString();

    const requestParams = {
      businessDate,
      branchId,
      limit,
      cukcukFromDate: requestRange.fromDate,
      cukcukToDate: requestRange.toDate,
      filterFromDate,
      filterToDate,
    };

    syncContext = {
      businessDate,
      branchId,
      requestParams,
    };
    syncRunId = await acquireSyncRun(syncContext);

    const login = await loginCukcuk();

    const invoices = await fetchSaInvoicesPaging({
      accessToken: login.accessToken,
      companyCode: login.companyCode,
      branchId,
      fromDate: requestRange.fromDate,
      limit,
    });
    const warning =
      invoices.length >= limit ? CUKCUK_LIMIT_REACHED_WARNING : undefined;

    const invoicesInRange = invoices.filter((invoice) =>
      isInvoiceInRequestedRange({
        invoiceDate: getInvoiceDate(invoice),
        fromDate: filterFromDate,
        toDate: filterToDate,
      })
    );

    const detailPayloads = await Promise.all(
      invoicesInRange.map(async (invoice) => {
        const refId = getInvoiceRefId(invoice);

        if (!refId) {
          return {
            invoice,
            refId,
            detailPayload: null,
            error: "Missing invoice refId",
          };
        }

        return {
          invoice,
          refId,
          detailPayload: await fetchSaInvoiceDetail({
            accessToken: login.accessToken,
            companyCode: login.companyCode,
            refId,
          }),
          error: null,
        };
      })
    );

    const failedDetails = detailPayloads.filter((item) => item.error);
    const validDetails = detailPayloads.filter(
      (
        item
      ): item is {
        invoice: CukcukInvoice;
        refId: string;
        detailPayload: JsonObject;
        error: null;
      } => Boolean(item.refId && item.detailPayload && !item.error)
    );

    const syncedAt = new Date().toISOString();
    const receiptRows = validDetails.map((item) =>
      buildReceiptRow({
        invoice: item.invoice,
        detailPayload: item.detailPayload,
        businessDate,
        syncedAt,
      })
    );

    const receiptSaveResult = await saveReceipts(receiptRows);

    const lineRows = validDetails.flatMap((item) => {
      const receiptId = receiptSaveResult.receiptIdMap.get(item.refId) ?? null;
      const receiptRow = receiptRows.find((row) => row.ref_id === item.refId);
      const details = getDetailsFromInvoicePayload(item.detailPayload);

      return details.map((detail, index) =>
        buildLineRow({
          receiptId,
          receiptRefId: item.refId,
          detail,
          businessDate,
          refDate: receiptRow?.ref_date ?? null,
          paymentStatus: receiptRow?.payment_status ?? null,
          isCanceled: receiptRow?.is_canceled ?? false,
          sortOrder: index + 1,
          syncedAt,
        })
      );
    });

    const lineSaveResult = await saveLines(lineRows);
    const detailPaymentRows = validDetails.flatMap((item) => {
      const receiptId = receiptSaveResult.receiptIdMap.get(item.refId) ?? null;
      const receiptRow = receiptRows.find((row) => row.ref_id === item.refId);
      const payments = getPaymentsFromInvoicePayload(item.detailPayload);

      return payments.map((payment) =>
        buildPaymentRow({
          receiptId,
          receiptRefId: item.refId,
          businessDate,
          refDate: receiptRow?.ref_date ?? null,
          payment,
          syncedAt,
        })
      );
    });
    const receiptPaymentSources = await getReceiptPaymentSources(
      receiptRows.map((row) => row.ref_id)
    );
    const storedReceiptPaymentRows = Array.from(receiptPaymentSources.values()).flatMap(
      (receipt) => {
        const payments = getPaymentsFromInvoicePayload(receipt.raw_json);

        return payments.map((payment) =>
          buildPaymentRow({
            receiptId: receipt.id,
            receiptRefId: receipt.ref_id,
            businessDate,
            refDate: receipt.ref_date,
            payment,
            syncedAt,
          })
        );
      }
    );
    const paymentRows = dedupePaymentRows([
      ...storedReceiptPaymentRows,
      ...detailPaymentRows,
    ]);
    const paymentSaveResult = await savePayments(paymentRows);
    const changedCount =
      receiptSaveResult.createdCount +
      receiptSaveResult.updatedCount +
      lineSaveResult.createdCount +
      lineSaveResult.updatedCount +
      lineSaveResult.staleExcludedCount +
      paymentSaveResult.createdCount +
      paymentSaveResult.updatedCount;
    const statusChangedCount =
      receiptSaveResult.statusChangedCount + lineSaveResult.statusChangedCount;
    const canceledCount = statusChangedCount;
    const noChange =
      changedCount === 0 && statusChangedCount === 0 && failedDetails.length === 0;

    await finishSyncRun({
      runId: syncRunId,
      status: "success",
      receiptCount: receiptRows.length,
      lineCount: lineRows.length,
      createdCount:
        receiptSaveResult.createdCount +
        lineSaveResult.createdCount +
        paymentSaveResult.createdCount,
      updatedCount:
        receiptSaveResult.updatedCount +
        lineSaveResult.updatedCount +
        lineSaveResult.staleExcludedCount +
        paymentSaveResult.updatedCount,
      canceledCount,
      errorMessage:
        failedDetails.length > 0
          ? `${failedDetails.length} invoice detail payload(s) skipped.`
          : undefined,
    });

    return NextResponse.json({
      ok: true,
      ...(warning ? { warning } : {}),
      request: requestParams,
      result: {
        noChange,
        ...(warning ? { warning } : {}),
        syncRunId,
        fetchedInvoiceCount: invoices.length,
        invoiceCount: receiptRows.length,
        lineCount: lineRows.length,
        skippedDetailCount: failedDetails.length,
        receiptCreatedCount: receiptSaveResult.createdCount,
        receiptUpdatedCount: receiptSaveResult.updatedCount,
        lineCreatedCount: lineSaveResult.createdCount,
        lineUpdatedCount: lineSaveResult.updatedCount,
        lineFallbackMatchedCount: lineSaveResult.fallbackMatchedCount,
        lineFallbackSkippedCount: lineSaveResult.fallbackSkippedCount,
        lineStaleCandidateCount: lineSaveResult.staleCandidateCount,
        lineStaleExcludedCount: lineSaveResult.staleExcludedCount,
        lineStaleSkippedCount: lineSaveResult.staleSkippedCount,
        paymentSourceReceiptCount: receiptPaymentSources.size,
        paymentRowsFromDetailPayloadCount: detailPaymentRows.length,
        paymentRowsFromStoredReceiptCount: storedReceiptPaymentRows.length,
        paymentRowsBuiltCount: paymentRows.length,
        paymentCreatedCount: paymentSaveResult.createdCount,
        paymentUpdatedCount: paymentSaveResult.updatedCount,
        paymentUpsertedCount:
          paymentSaveResult.createdCount + paymentSaveResult.updatedCount,
        taxLineUpdatedCount: lineSaveResult.taxLineChangedCount,
        canceledCount,
        statusChangedCount,
        partial: failedDetails.length > 0,
        ...(includeReceipts ? { receipts: receiptRows.map(stripRawJson) } : {}),
        ...(includeLines ? { lines: lineRows.map(stripRawJson) } : {}),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown sales sync error";

    if (error instanceof SyncAlreadyRunningError) {
      return NextResponse.json(
        {
          ok: false,
          code: "sync_already_running",
          message: error.message,
          error: error.message,
          businessDate: error.businessDate,
          runningSyncRunId: error.runningSyncRunId,
          startedAt: error.startedAt,
        },
        { status: 409 }
      );
    }

    console.error(error);

    try {
      if (syncRunId) {
        await finishSyncRun({
          runId: syncRunId,
          status: "failed",
          errorMessage: message,
        });
      }
    } catch (syncRunError) {
      console.error(syncRunError);
    }

    return NextResponse.json(
      {
        ok: false,
        error: message,
      },
      { status: 500 }
    );
  }
}
