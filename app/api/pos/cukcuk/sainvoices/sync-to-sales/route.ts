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
  ref_detail_type: number | null;
  inventory_item_type: number | null;
  is_option: boolean;
  payment_status: number | null;
  is_canceled: boolean;
  raw_json: CukcukInvoiceDetail;
  synced_at: string;
  updated_at: string;
};

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

  const totalAmount =
    getNumber(detailPayload, ["TotalAmount", "totalAmount"]) ??
    getNumber(invoice, ["TotalAmount", "totalAmount"]) ??
    0;
  const discountAmount =
    getNumber(detailPayload, ["DiscountAmount", "SaleAmount", "PromotionAmount"]) ??
    getNumber(invoice, ["DiscountAmount", "SaleAmount", "PromotionAmount"]) ??
    0;
  const vatAmount =
    getNumber(detailPayload, ["VATAmount", "VatAmount", "TaxAmount"]) ??
    getNumber(invoice, ["VATAmount", "VatAmount", "TaxAmount"]) ??
    0;
  const finalAmount =
    getNumber(detailPayload, ["FinalAmount", "Amount", "TotalAmount"]) ??
    getNumber(invoice, ["FinalAmount", "Amount", "TotalAmount"]) ??
    totalAmount;

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
  const finalAmount =
    getNumber(detail, ["FinalAmount", "finalAmount"]) ?? amount - discountAmount;
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
  if (refIds.length === 0) return new Map<string, number>();

  const { data, error } = await supabaseServer
    .from("pos_sales_receipts")
    .select("id, ref_id")
    .eq("source", SOURCE)
    .in("ref_id", refIds);

  if (error) {
    throw new Error(`Failed to fetch existing sales receipts: ${error.message}`);
  }

  const map = new Map<string, number>();

  (data || []).forEach((row: { id: number; ref_id: string }) => {
    map.set(row.ref_id, Number(row.id));
  });

  return map;
}

async function getExistingLines(receiptRefIds: string[]) {
  if (receiptRefIds.length === 0) return new Map<string, number>();

  const { data, error } = await supabaseServer
    .from("pos_sales_receipt_lines")
    .select("id, receipt_ref_id, ref_detail_id")
    .eq("source", SOURCE)
    .in("receipt_ref_id", receiptRefIds);

  if (error) {
    throw new Error(`Failed to fetch existing sales lines: ${error.message}`);
  }

  const map = new Map<string, number>();

  (data || []).forEach(
    (row: { id: number; receipt_ref_id: string; ref_detail_id: string | null }) => {
      if (!row.ref_detail_id) return;
      map.set(`${row.receipt_ref_id}::${row.ref_detail_id}`, Number(row.id));
    }
  );

  return map;
}

async function saveReceipts(rows: ReceiptRow[]) {
  if (rows.length === 0) {
    return {
      receiptIdMap: new Map<string, number>(),
      createdCount: 0,
      updatedCount: 0,
    };
  }

  const existingMap = await getExistingReceipts(rows.map((row) => row.ref_id));
  const inserts = rows.filter((row) => !existingMap.has(row.ref_id));
  const updates = rows.filter((row) => existingMap.has(row.ref_id));

  if (inserts.length > 0) {
    const { error } = await supabaseServer
      .from("pos_sales_receipts")
      .insert(inserts);

    if (error) {
      throw new Error(`Failed to insert sales receipts: ${error.message}`);
    }
  }

  for (const row of updates) {
    const id = existingMap.get(row.ref_id);
    const { error } = await supabaseServer
      .from("pos_sales_receipts")
      .update(row)
      .eq("id", id);

    if (error) {
      throw new Error(`Failed to update sales receipt ${row.ref_id}: ${error.message}`);
    }
  }

  const receiptIdMap = await getExistingReceipts(rows.map((row) => row.ref_id));

  return {
    receiptIdMap,
    createdCount: inserts.length,
    updatedCount: updates.length,
  };
}

async function saveLines(rows: LineRow[]) {
  if (rows.length === 0) {
    return {
      createdCount: 0,
      updatedCount: 0,
    };
  }

  const receiptRefIds = Array.from(
    new Set(rows.map((row) => row.receipt_ref_id))
  );
  const existingMap = await getExistingLines(receiptRefIds);

  const inserts = rows.filter((row) => {
    if (!row.ref_detail_id) return false;
    return !existingMap.has(`${row.receipt_ref_id}::${row.ref_detail_id}`);
  });
  const updates = rows.filter((row) => {
    if (!row.ref_detail_id) return false;
    return existingMap.has(`${row.receipt_ref_id}::${row.ref_detail_id}`);
  });

  if (inserts.length > 0) {
    const { error } = await supabaseServer
      .from("pos_sales_receipt_lines")
      .insert(inserts);

    if (error) {
      throw new Error(`Failed to insert sales lines: ${error.message}`);
    }
  }

  for (const row of updates) {
    const id = existingMap.get(`${row.receipt_ref_id}::${row.ref_detail_id}`);
    const { error } = await supabaseServer
      .from("pos_sales_receipt_lines")
      .update(row)
      .eq("id", id);

    if (error) {
      throw new Error(
        `Failed to update sales line ${row.receipt_ref_id}/${row.ref_detail_id}: ${error.message}`
      );
    }
  }

  return {
    createdCount: inserts.length,
    updatedCount: updates.length,
  };
}

export async function POST(req: Request) {
  let syncRunId: number | null = null;

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
    const limit = Math.min(Math.max(Number(body.limit || 100), 1), 500);
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

    syncRunId = await createSyncRun({
      businessDate,
      branchId,
      requestParams,
    });

    const login = await loginCukcuk();

    const invoices = await fetchSaInvoicesPaging({
      accessToken: login.accessToken,
      companyCode: login.companyCode,
      branchId,
      fromDate: requestRange.fromDate,
      limit,
    });

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
    const canceledCount = receiptRows.filter((row) => row.is_canceled).length;

    await finishSyncRun({
      runId: syncRunId,
      status: "success",
      receiptCount: receiptRows.length,
      lineCount: lineRows.length,
      createdCount: receiptSaveResult.createdCount + lineSaveResult.createdCount,
      updatedCount: receiptSaveResult.updatedCount + lineSaveResult.updatedCount,
      canceledCount,
    });

    return NextResponse.json({
      ok: true,
      request: requestParams,
      result: {
        syncRunId,
        fetchedInvoiceCount: invoices.length,
        invoiceCount: receiptRows.length,
        lineCount: lineRows.length,
        skippedDetailCount: failedDetails.length,
        receiptCreatedCount: receiptSaveResult.createdCount,
        receiptUpdatedCount: receiptSaveResult.updatedCount,
        lineCreatedCount: lineSaveResult.createdCount,
        lineUpdatedCount: lineSaveResult.updatedCount,
        canceledCount,
        ...(includeReceipts ? { receipts: receiptRows } : {}),
        ...(includeLines ? { lines: lineRows } : {}),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown sales sync error";

    console.error(error);

    if (syncRunId) {
      try {
        await finishSyncRun({
          runId: syncRunId,
          status: "failed",
          errorMessage: message,
        });
      } catch (syncRunError) {
        console.error(syncRunError);
      }
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
