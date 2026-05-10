import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { getBusinessWindowByBusinessDate } from "@/lib/common/business-time";
import { requirePosAdminSecret } from "@/lib/pos/api-guard";

export const runtime = "nodejs";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CUKCUK_BASE_URL =
  process.env.CUKCUK_BASE_URL || "https://graphapi.cukcuk.vn";

const CUKCUK_DOMAIN = process.env.CUKCUK_DOMAIN || "nhbaba";
const CUKCUK_APP_ID = process.env.CUKCUK_APP_ID || "CUKCUKOpenPlatform";
const CUKCUK_SECRET_KEY = process.env.CUKCUK_SECRET_KEY || "";

const DEFAULT_BRANCH_ID = "c39228ba-a452-4cf9-bf34-424ffb151fb8";

type MappingType =
  | "direct"
  | "recipe"
  | "manual"
  | "ignore"
  | "option"
  | "unmapped";

type ProcessStatus = "dry_run" | "applied" | "skipped" | "failed";

type PosItemMapping = {
  id: number;
  pos_item_code: string;
  pos_item_name: string | null;
  pos_unit_name: string | null;
  mapping_type: "direct" | "recipe" | "manual" | "ignore";
  inventory_item_id: number | null;
  quantity_multiplier: number;
  is_active: boolean;
};

type PosItemMappingRecipe = {
  id: number;
  mapping_id: number;
  inventory_item_id: number;
  quantity_per_pos_unit: number;
  is_active: boolean;
};

type CukcukInvoice = {
  RefId?: string;
  RefID?: string;
  RefNo?: string;
  RefDate?: string;
  PostedDate?: string;
  [key: string]: any;
};

type CukcukInvoiceDetail = {
  RefDetailId?: string;
  RefDetailID?: string;
  OrderDetailID?: string;
  ParentID?: string;
  ParentId?: string;
  RefDetailType?: number;
  ItemCode?: string | null;
  ItemName?: string | null;
  Quantity?: number;
  UnitName?: string | null;
  Amount?: number;
  [key: string]: any;
};

function buildJsonString(value: Record<string, unknown>) {
  return JSON.stringify(value);
}

function buildSignature(payloadString: string) {
  return crypto
    .createHmac("sha256", CUKCUK_SECRET_KEY)
    .update(payloadString)
    .digest("hex");
}

async function cukcukLogin() {
  if (!CUKCUK_SECRET_KEY) {
    throw new Error("CUKCUK_SECRET_KEY is missing");
  }

  const loginTime = new Date().toISOString();

  const signaturePayload = {
    AppID: CUKCUK_APP_ID,
    Domain: CUKCUK_DOMAIN,
    LoginTime: loginTime,
  };

  const payloadString = buildJsonString(signaturePayload);
  const signatureInfo = buildSignature(payloadString);

  const body = {
    ...signaturePayload,
    SignatureInfo: signatureInfo,
  };

  const res = await fetch(`${CUKCUK_BASE_URL}/api/Account/Login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const json = await res.json();

  if (!res.ok || json?.Success === false || !json?.Data?.AccessToken) {
    throw new Error(
      `CUKCUK login failed: ${JSON.stringify(json).slice(0, 500)}`
    );
  }

  return {
    accessToken: json.Data.AccessToken as string,
    companyCode: json.Data.CompanyCode as string | undefined,
    raw: json,
  };
}

function buildCukcukHeaders(accessToken: string, companyCode?: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    CompanyCode: companyCode || CUKCUK_DOMAIN,
  };
}

async function fetchSaInvoicesPaging(params: {
  accessToken: string;
  companyCode?: string;
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

  const res = await fetch(`${CUKCUK_BASE_URL}/api/v1/sainvoices/paging`, {
    method: "POST",
    headers: buildCukcukHeaders(params.accessToken, params.companyCode),
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const json = await res.json();

  if (!res.ok || json?.Success === false) {
    throw new Error(
      `sainvoices/paging failed: ${JSON.stringify(json).slice(0, 500)}`
    );
  }

  const data = json?.Data;

  if (Array.isArray(data)) return data as CukcukInvoice[];
  if (Array.isArray(data?.Data)) return data.Data as CukcukInvoice[];
  if (Array.isArray(data?.Items)) return data.Items as CukcukInvoice[];

  return [];
}

async function fetchSaInvoiceDetail(params: {
  accessToken: string;
  companyCode?: string;
  refId: string;
}) {
  const res = await fetch(
    `${CUKCUK_BASE_URL}/api/v1/sainvoices/${params.refId}`,
    {
      method: "GET",
      headers: buildCukcukHeaders(params.accessToken, params.companyCode),
      cache: "no-store",
    }
  );

  const json = await res.json();

  if (!res.ok || json?.Success === false) {
    throw new Error(
      `sainvoices/${params.refId} failed: ${JSON.stringify(json).slice(0, 500)}`
    );
  }

  return json?.Data || json;
}

function getInvoiceRefId(invoice: CukcukInvoice) {
  return invoice.RefId || invoice.RefID || invoice.refId || invoice.refID || "";
}

function getInvoiceRefNo(invoice: CukcukInvoice) {
  return invoice.RefNo || invoice.refNo || null;
}

function getInvoiceDate(invoice: CukcukInvoice) {
  return invoice.RefDate || invoice.PostedDate || invoice.refDate || null;
}

function toTimestamp(value: string | null | undefined) {
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

function isValidBusinessDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toRequestDateTime(value: Date | string) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
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

function getDetailsFromInvoiceDetailPayload(payload: any): CukcukInvoiceDetail[] {
  const candidates = [
    payload?.SAInvoiceDetails,
    payload?.saInvoiceDetails,
    payload?.Details,
    payload?.details,
    payload?.InvoiceDetails,
    payload?.invoiceDetails,
  ];

  const found = candidates.find((item) => Array.isArray(item));
  return found || [];
}

function getRefDetailId(detail: CukcukInvoiceDetail) {
  return (
    detail.RefDetailId ||
    detail.RefDetailID ||
    detail.refDetailId ||
    detail.refDetailID ||
    ""
  );
}

function getOrderDetailId(detail: CukcukInvoiceDetail) {
  return detail.OrderDetailID || detail.orderDetailID || detail.orderDetailId || null;
}

function getParentId(detail: CukcukInvoiceDetail) {
  return detail.ParentID || detail.ParentId || detail.parentID || detail.parentId || null;
}

function getRefDetailType(detail: CukcukInvoiceDetail) {
  return Number(detail.RefDetailType ?? detail.refDetailType ?? 0);
}

function getItemCode(detail: CukcukInvoiceDetail) {
  return detail.ItemCode ?? detail.itemCode ?? null;
}

function getItemName(detail: CukcukInvoiceDetail) {
  return detail.ItemName ?? detail.itemName ?? null;
}

function getQuantity(detail: CukcukInvoiceDetail) {
  return Number(detail.Quantity ?? detail.quantity ?? 0);
}

function getUnitName(detail: CukcukInvoiceDetail) {
  return detail.UnitName ?? detail.unitName ?? null;
}

function getAmount(detail: CukcukInvoiceDetail) {
  const amount = detail.Amount ?? detail.amount ?? null;
  return amount === null || amount === undefined ? null : Number(amount);
}

async function getMappingsByItemCodes(itemCodes: string[]) {
  if (itemCodes.length === 0) return new Map<string, PosItemMapping>();

  const { data, error } = await supabaseAdmin
    .from("pos_item_mappings")
    .select(
      "id, pos_item_code, pos_item_name, pos_unit_name, mapping_type, inventory_item_id, quantity_multiplier, is_active"
    )
    .in("pos_item_code", itemCodes)
    .eq("is_active", true);

  if (error) {
    throw new Error(`Failed to fetch mappings: ${error.message}`);
  }

  const map = new Map<string, PosItemMapping>();

  (data || []).forEach((row) => {
    map.set(row.pos_item_code, {
      ...row,
      quantity_multiplier: Number(row.quantity_multiplier ?? 1),
    });
  });

  return map;
}

async function getRecipesByMappingIds(mappingIds: number[]) {
  if (mappingIds.length === 0) {
    return new Map<number, PosItemMappingRecipe[]>();
  }

  const { data, error } = await supabaseAdmin
    .from("pos_item_mapping_recipes")
    .select(
      "id, mapping_id, inventory_item_id, quantity_per_pos_unit, is_active"
    )
    .in("mapping_id", mappingIds)
    .eq("is_active", true);

  if (error) {
    throw new Error(`Failed to fetch recipes: ${error.message}`);
  }

  const map = new Map<number, PosItemMappingRecipe[]>();

  (data || []).forEach((row) => {
    const mappingId = Number(row.mapping_id);
    const list = map.get(mappingId) || [];

    list.push({
      ...row,
      mapping_id: mappingId,
      quantity_per_pos_unit: Number(row.quantity_per_pos_unit ?? 0),
    });

    map.set(mappingId, list);
  });

  return map;
}

async function getAppliedLineKeys(lines: { invoice_ref_id: string; ref_detail_id: string }[]) {
  if (lines.length === 0) return new Set<string>();

  const invoiceRefIds = Array.from(new Set(lines.map((line) => line.invoice_ref_id)));

  const { data, error } = await supabaseAdmin
    .from("pos_processed_invoice_lines")
    .select("invoice_ref_id, ref_detail_id, status")
    .in("invoice_ref_id", invoiceRefIds)
    .eq("status", "applied");

  if (error) {
    throw new Error(`Failed to fetch applied lines: ${error.message}`);
  }

  const set = new Set<string>();

  (data || []).forEach((row) => {
    set.add(`${row.invoice_ref_id}::${row.ref_detail_id}`);
  });

  return set;
}

function buildDryRunResult(params: {
  detail: CukcukInvoiceDetail;
  mapping?: PosItemMapping;
  recipes?: PosItemMappingRecipe[];
}) {
  const quantity = getQuantity(params.detail);
  const itemCode = getItemCode(params.detail);
  const refDetailType = getRefDetailType(params.detail);

  if (refDetailType === 2 || !itemCode) {
    return {
      mappingType: "option" as MappingType,
      status: "skipped" as ProcessStatus,
      result: {
        action: "option",
        reason: "refDetailType=2 or itemCode is null",
        parentId: getParentId(params.detail),
      },
    };
  }

  if (!params.mapping) {
    return {
      mappingType: "unmapped" as MappingType,
      status: "dry_run" as ProcessStatus,
      result: {
        action: "needs_mapping",
        itemCode,
        quantity,
      },
    };
  }

  if (params.mapping.mapping_type === "ignore") {
    return {
      mappingType: "ignore" as MappingType,
      status: "skipped" as ProcessStatus,
      result: {
        action: "ignore",
        itemCode,
        quantity,
      },
    };
  }

  if (params.mapping.mapping_type === "manual") {
    return {
      mappingType: "manual" as MappingType,
      status: "dry_run" as ProcessStatus,
      result: {
        action: "manual_required",
        itemCode,
        quantity,
      },
    };
  }

  if (params.mapping.mapping_type === "direct") {
    const multiplier = Number(params.mapping.quantity_multiplier ?? 1);

    return {
      mappingType: "direct" as MappingType,
      status: "dry_run" as ProcessStatus,
      result: {
        action: "direct",
        itemCode,
        inventoryItemId: params.mapping.inventory_item_id,
        posQuantity: quantity,
        quantityMultiplier: multiplier,
        deductQuantity: quantity * multiplier,
      },
    };
  }

  if (params.mapping.mapping_type === "recipe") {
    const recipes = params.recipes || [];

    return {
      mappingType: "recipe" as MappingType,
      status: "dry_run" as ProcessStatus,
      result: {
        action: recipes.length > 0 ? "recipe" : "recipe_missing",
        itemCode,
        posQuantity: quantity,
        items: recipes.map((recipe) => ({
          inventoryItemId: recipe.inventory_item_id,
          quantityPerPosUnit: recipe.quantity_per_pos_unit,
          deductQuantity: quantity * recipe.quantity_per_pos_unit,
        })),
      },
    };
  }

  return {
    mappingType: "unmapped" as MappingType,
    status: "dry_run" as ProcessStatus,
    result: {
      action: "unknown",
      itemCode,
      quantity,
    },
  };
}

export async function POST(req: Request) {
  try {
    const guardResponse = requirePosAdminSecret(req);
    if (guardResponse) return guardResponse;

    const body = await req.json().catch(() => ({}));

    const businessDate = body.businessDate;
    const branchId = body.branchId || DEFAULT_BRANCH_ID;
    const limit = Number(body.limit || 10);
    const saveDryRun = body.saveDryRun !== false;
    const includeLines = body.includeLines === true;
    const includeDebug = body.includeDebug === true;

    if (!isValidBusinessDate(businessDate)) {
      return NextResponse.json(
        {
          ok: false,
          error: "businessDate is required. Format: YYYY-MM-DD",
          example: {
            businessDate: "2026-05-09",
            branchId: DEFAULT_BRANCH_ID,
            limit: 10,
            saveDryRun: true,
          },
        },
        { status: 400 }
      );
    }

    const businessWindow = getBusinessWindowByBusinessDate(businessDate);
    const requestRange = getCukcukBusinessDateRange(businessDate);

    const fromDate = requestRange.fromDate;
    const toDate = requestRange.toDate;

    const filterFromDate = toRequestDateTime(businessWindow.start);
    const filterToDate = toRequestDateTime(businessWindow.end);

    const login = await cukcukLogin();

    const invoices = await fetchSaInvoicesPaging({
      accessToken: login.accessToken,
      companyCode: login.companyCode,
      branchId,
      fromDate,
      limit,
    });

    const invoicesInRange = invoices.filter((invoice) => {
      const invoiceDate = getInvoiceDate(invoice);

      return isInvoiceInRequestedRange({
        invoiceDate,
        fromDate: filterFromDate,
        toDate: filterToDate,
      });
    });

    const missingDateInvoices = invoices.filter((invoice) => {
      const invoiceDate = getInvoiceDate(invoice);
      return !invoiceDate;
    });

    const outOfRangeInvoices = invoices.filter((invoice) => {
      const invoiceDate = getInvoiceDate(invoice);

      if (!invoiceDate) return false;

      return !isInvoiceInRequestedRange({
        invoiceDate,
        fromDate: filterFromDate,
        toDate: filterToDate,
      });
    });

    const invoiceDetailsPayloads = await Promise.all(
      invoicesInRange.map(async (invoice) => {
        const refId = getInvoiceRefId(invoice);

        if (!refId) {
          return {
            invoice,
            detailPayload: null,
            error: "Missing invoice refId",
          };
        }

        const detailPayload = await fetchSaInvoiceDetail({
          accessToken: login.accessToken,
          companyCode: login.companyCode,
          refId,
        });

        return {
          invoice,
          detailPayload,
          error: null,
        };
      })
    );

    const allLines = invoiceDetailsPayloads.flatMap((item) => {
      const invoiceRefId = getInvoiceRefId(item.invoice);
      const invoiceRefNo = getInvoiceRefNo(item.invoice);
      const invoiceDate = getInvoiceDate(item.invoice);

      const details = getDetailsFromInvoiceDetailPayload(item.detailPayload);

      return details.map((detail) => ({
        invoice: item.invoice,
        invoiceRefId,
        invoiceRefNo,
        invoiceDate,
        detail,
      }));
    });

    const itemCodes = Array.from(
      new Set(
        allLines
          .map((line) => getItemCode(line.detail))
          .filter((code): code is string => Boolean(code))
      )
    );

    const mappingMap = await getMappingsByItemCodes(itemCodes);

    const recipeMappingIds = Array.from(mappingMap.values())
      .filter((mapping) => mapping.mapping_type === "recipe")
      .map((mapping) => mapping.id);

    const recipeMap = await getRecipesByMappingIds(recipeMappingIds);

    const rawRows = allLines
      .map((line) => {
        const refDetailId = getRefDetailId(line.detail);

        if (!line.invoiceRefId || !refDetailId) return null;

        const itemCode = getItemCode(line.detail);
        const mapping = itemCode ? mappingMap.get(itemCode) : undefined;
        const recipes = mapping ? recipeMap.get(mapping.id) || [] : [];

        const dryRun = buildDryRunResult({
          detail: line.detail,
          mapping,
          recipes,
        });

        return {
          invoice_ref_id: line.invoiceRefId,
          invoice_ref_no: line.invoiceRefNo,
          invoice_date: line.invoiceDate,
          ref_detail_id: refDetailId,
          order_detail_id: getOrderDetailId(line.detail),
          parent_id: getParentId(line.detail),
          ref_detail_type: getRefDetailType(line.detail),
          item_code: itemCode,
          item_name: getItemName(line.detail),
          quantity: getQuantity(line.detail),
          unit_name: getUnitName(line.detail),
          amount: getAmount(line.detail),
          mapping_id: mapping?.id || null,
          mapping_type: dryRun.mappingType,
          status: dryRun.status,
          dry_run_result: dryRun.result,
          source_payload: line.detail,
          processed_at: new Date().toISOString(),
        };
      })
      .filter(Boolean) as any[];

    const appliedKeys = await getAppliedLineKeys(
      rawRows.map((row) => ({
        invoice_ref_id: row.invoice_ref_id,
        ref_detail_id: row.ref_detail_id,
      }))
    );

    const rows = rawRows.filter((row) => {
      const key = `${row.invoice_ref_id}::${row.ref_detail_id}`;
      return !appliedKeys.has(key);
    });

    if (saveDryRun && rows.length > 0) {
      const { error } = await supabaseAdmin
        .from("pos_processed_invoice_lines")
        .upsert(rows, {
          onConflict: "invoice_ref_id,ref_detail_id",
        });

      if (error) {
        throw new Error(`Failed to save dry-run rows: ${error.message}`);
      }

      const directRows = rows.filter((row) => {
        return (
          row.mapping_type === "direct" &&
          row.status === "dry_run" &&
          row.dry_run_result?.action === "direct" &&
          row.dry_run_result?.inventoryItemId &&
          row.dry_run_result?.deductQuantity
        );
      });

      if (directRows.length > 0) {
        const directKeys = directRows.map((row) => ({
          invoice_ref_id: row.invoice_ref_id,
          ref_detail_id: row.ref_detail_id,
        }));

        const directInvoiceRefIds = Array.from(
          new Set(directKeys.map((row) => row.invoice_ref_id))
        );

        const { data: savedLines, error: savedLinesError } = await supabaseAdmin
          .from("pos_processed_invoice_lines")
          .select(
            "id, invoice_ref_id, ref_detail_id, item_code, item_name, quantity, mapping_type, status, dry_run_result"
          )
          .in("invoice_ref_id", directInvoiceRefIds)
          .eq("mapping_type", "direct")
          .eq("status", "dry_run");

        if (savedLinesError) {
          throw new Error(
            `Failed to fetch saved direct lines: ${savedLinesError.message}`
          );
        }

        const directKeySet = new Set(
          directKeys.map((row) => `${row.invoice_ref_id}::${row.ref_detail_id}`)
        );

        const deductionRows = (savedLines || [])
          .filter((line) =>
            directKeySet.has(`${line.invoice_ref_id}::${line.ref_detail_id}`)
          )
          .map((line) => ({
            processed_line_id: line.id,
            invoice_ref_id: line.invoice_ref_id,
            ref_detail_id: line.ref_detail_id,
            pos_item_code: line.item_code,
            pos_item_name: line.item_name,
            pos_quantity: Number(line.quantity ?? 0),
            mapping_type: "direct",
            inventory_item_id: line.dry_run_result?.inventoryItemId,
            deduct_quantity: Number(line.dry_run_result?.deductQuantity ?? 0),
            status: "pending",
            error_message: null,
            applied_at: null,
          }))
          .filter(
            (row) =>
              row.processed_line_id &&
              row.inventory_item_id &&
              row.deduct_quantity > 0
          );

        if (deductionRows.length > 0) {
          const { error: deductionError } = await supabaseAdmin
            .from("pos_inventory_deductions")
            .upsert(deductionRows, {
              onConflict: "processed_line_id,inventory_item_id",
            });

          if (deductionError) {
            throw new Error(
              `Failed to save POS inventory deductions: ${deductionError.message}`
            );
          }
        }
      }
    }

    const summary = rows.reduce(
      (acc, row) => {
        const type = row.mapping_type || "unknown";
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    return NextResponse.json({
      ok: true,
      request: {
        businessDate,
        fromDate,
        toDate,
        filterFromDate,
        filterToDate,
        branchId,
        limit,
        saveDryRun,
        includeLines,
        includeDebug,
      },
      result: {
        invoiceCount: invoicesInRange.length,
        fetchedInvoiceCount: invoices.length,
        outOfRangeInvoiceCount: outOfRangeInvoices.length,
        missingDateInvoiceCount: missingDateInvoices.length,

        ...(includeDebug
          ? {
            sampleFetchedInvoices: invoices.slice(0, 3).map((invoice) => ({
              keys: Object.keys(invoice || {}),
              refId: getInvoiceRefId(invoice),
              refNo: getInvoiceRefNo(invoice),
              invoiceDate: getInvoiceDate(invoice),
              raw: invoice,
            })),
            outOfRangeInvoices: outOfRangeInvoices.slice(0, 10).map((invoice) => ({
              refId: getInvoiceRefId(invoice),
              refNo: getInvoiceRefNo(invoice),
              invoiceDate: getInvoiceDate(invoice),
            })),
          }
          : {}),

        lineCount: rows.length,
        skippedAlreadyAppliedCount: rawRows.length - rows.length,
        summary,

        ...(includeLines
          ? {
            lines: rows,
          }
          : {}),
      },
    });
  } catch (error: any) {
    console.error(error);

    return NextResponse.json(
      {
        ok: false,
        error: error?.message || "Unknown error",
      },
      { status: 500 }
    );
  }
}
