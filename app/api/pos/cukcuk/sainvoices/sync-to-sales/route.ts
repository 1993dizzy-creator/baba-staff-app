import { NextResponse } from "next/server";
import { loginCukcuk } from "@/lib/pos/cukcuk/auth";
import { requirePosAdminSecret } from "@/lib/pos/api-guard";
import {
  getBusinessDate,
  getBusinessWindowByBusinessDate,
} from "@/lib/common/business-time";
import { supabaseServer } from "@/lib/supabase/server";
import {
  SOURCE,
  CUKCUK_BASE_URL,
  buildCukcukHeaders,
  fetchSaInvoiceDetail,
  getInvoiceRefId,
  getInvoiceDate,
  getDetailsFromInvoicePayload,
  getPaymentsFromInvoicePayload,
  buildReceiptRow,
  buildLineRow,
  buildPaymentRow,
  saveReceipts,
  saveLines,
  savePayments,
  markReceiptsInventoryDeductionEligible,
  getReceiptPaymentSources,
  dedupePaymentRows,
  stripRawJson,
  type JsonObject,
  type CukcukInvoice,
} from "@/lib/pos/cukcuk/sales-receipt-sync";

export const runtime = "nodejs";

const DEFAULT_BRANCH_ID = "c39228ba-a452-4cf9-bf34-424ffb151fb8";
const SYNC_LOCK_TIMEOUT_MS = 15 * 60 * 1000;
const RECENT_SUCCESS_SKIP_WINDOW_MS = 3 * 60 * 1000;
const CUKCUK_LIMIT_REACHED_WARNING =
  "CUKCUK 응답이 limit에 도달했습니다. 해당 businessDate 데이터가 일부 누락됐을 수 있으니 POS 원본 매출과 검산하세요.";

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

// Step 1 perf improvement: if the same source/businessDate/branchId synced
// successfully within RECENT_SUCCESS_SKIP_WINDOW_MS, a plain (non-force)
// sync request can skip CUKCUK entirely and just report that prior result.
// Read-only — does not touch acquireSyncRun's running-lock behavior.
async function getRecentSuccessfulSyncRun(params: {
  businessDate: string;
  branchId: string;
}) {
  const sinceIso = new Date(
    Date.now() - RECENT_SUCCESS_SKIP_WINDOW_MS
  ).toISOString();

  const { data, error } = await supabaseServer
    .from("pos_sales_sync_runs")
    .select(
      "id, finished_at, receipt_count, line_count, created_count, updated_count, canceled_count"
    )
    .eq("source", SOURCE)
    .eq("business_date", params.businessDate)
    .eq("branch_id", params.branchId)
    .eq("status", "success")
    .gte("finished_at", sinceIso)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Failed to fetch recent successful sales sync run: ${error.message}`
    );
  }

  return data as {
    id: number;
    finished_at: string;
    receipt_count: number | null;
    line_count: number | null;
    created_count: number | null;
    updated_count: number | null;
    canceled_count: number | null;
  } | null;
}

function isDuplicateKeyError(error: unknown) {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return false;
  }

  return String(error.message).includes("duplicate key");
}

async function acquireSyncRun(params: {
  businessDate: string;
  branchId: string;
  requestParams: JsonObject;
}) {
  const acquireStartedAt = Date.now();
  let cleanupMs = 0;

  try {
    const insertStartedAt = Date.now();
    const syncRunId = await createSyncRun(params);
    const insertMs = Date.now() - insertStartedAt;

    return {
      syncRunId,
      timing: {
        totalMs: Date.now() - acquireStartedAt,
        cleanupMs,
        insertMs,
      },
    };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const cleanupStartedAt = Date.now();
      await expireStaleSyncRuns(params);
      cleanupMs = Date.now() - cleanupStartedAt;

      try {
        const retryInsertStartedAt = Date.now();
        const syncRunId = await createSyncRun(params);
        const insertMs = Date.now() - retryInsertStartedAt;

        return {
          syncRunId,
          timing: {
            totalMs: Date.now() - acquireStartedAt,
            cleanupMs,
            insertMs,
          },
        };
      } catch (retryError) {
        if (!isDuplicateKeyError(retryError)) {
          throw retryError;
        }
      }

      const conflictLookupStartedAt = Date.now();
      const running = await getRunningSyncRun(params);
      const conflictLookupMs = Date.now() - conflictLookupStartedAt;

      console.warn("[SALES_SYNC_CONFLICT]", {
        businessDate: params.businessDate,
        branchId: params.branchId,
        cleanupMs,
        conflictLookupMs,
      });

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
    const force = body.force === true || body.force === "true";

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

    if (!force) {
      const recentSuccess = await getRecentSuccessfulSyncRun({
        businessDate,
        branchId,
      });

      if (recentSuccess) {
        return NextResponse.json({
          ok: true,
          skipped: true,
          reason: "recent_success",
          businessDate,
          branchId,
          lastSyncRunId: Number(recentSuccess.id),
          lastSyncedAt: recentSuccess.finished_at,
          receiptCount: recentSuccess.receipt_count ?? 0,
          lineCount: recentSuccess.line_count ?? 0,
          createdCount: recentSuccess.created_count ?? 0,
          updatedCount: recentSuccess.updated_count ?? 0,
          canceledCount: recentSuccess.canceled_count ?? 0,
        });
      }
    }

    syncContext = {
      businessDate,
      branchId,
      requestParams,
    };
    const syncStartedAt = Date.now();
    const acquireResult = await acquireSyncRun(syncContext);
    syncRunId = acquireResult.syncRunId;
    const acquireTiming = acquireResult.timing;

    // Step 2/2.5 perf instrumentation: one summary log line per full sync
    // (never logged on the skipped-early-return path above), split into the
    // phases that matter for diagnosing where sync time actually goes.
    let phaseStartedAt = Date.now();
    const timingsMs: Record<string, number> = {};
    const markPhase = (label: string) => {
      const now = Date.now();
      timingsMs[label] = now - phaseStartedAt;
      phaseStartedAt = now;
    };

    const login = await loginCukcuk();
    markPhase("loginMs");

    const invoices = await fetchSaInvoicesPaging({
      accessToken: login.accessToken,
      companyCode: login.companyCode,
      branchId,
      fromDate: requestRange.fromDate,
      limit,
    });
    markPhase("invoiceListMs");
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
    markPhase("invoiceDetailMs");

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
    markPhase("saveReceiptsMs");

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
    markPhase("saveLinesMs");
    const buildPaymentRowsStartedAt = Date.now();
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
    let buildPaymentRowsMs = Date.now() - buildPaymentRowsStartedAt;

    const getReceiptPaymentSourcesStartedAt = Date.now();
    const receiptPaymentSources = await getReceiptPaymentSources(
      receiptRows.map((row) => row.ref_id)
    );
    const getReceiptPaymentSourcesMs = Date.now() - getReceiptPaymentSourcesStartedAt;

    const buildPaymentRowsStartedAt2 = Date.now();
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
    buildPaymentRowsMs += Date.now() - buildPaymentRowsStartedAt2;

    const paymentSaveResult = await savePayments(paymentRows);
    await markReceiptsInventoryDeductionEligible(
      Array.from(
        new Set([
          ...receiptSaveResult.autoEligibleReceiptIds,
          ...lineSaveResult.inventoryChangedReceiptIds,
        ])
      ),
      syncedAt,
      lineSaveResult.inventoryChangedReceiptIds
    );
    markPhase("savePaymentsMs");
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

    const finishStartedAt = Date.now();
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
    const finishMs = Date.now() - finishStartedAt;

    console.log(
      "[SALES_SYNC_TIMING]",
      JSON.stringify({
        syncRunId,
        businessDate,
        branchId,
        invoiceCount: receiptRows.length,
        lineCount: lineRows.length,
        totalMs: Date.now() - syncStartedAt,
        acquireMs: acquireTiming.totalMs,
        acquireDetail: {
          cleanupMs: acquireTiming.cleanupMs,
          insertMs: acquireTiming.insertMs,
        },
        loginMs: timingsMs.loginMs,
        invoiceListMs: timingsMs.invoiceListMs,
        invoiceDetailMs: timingsMs.invoiceDetailMs,
        saveReceiptsMs: timingsMs.saveReceiptsMs,
        saveReceiptsDetail: receiptSaveResult.timing,
        saveLinesMs: timingsMs.saveLinesMs,
        saveLinesDetail: lineSaveResult.timing,
        savePaymentsMs: timingsMs.savePaymentsMs,
        savePaymentsDetail: {
          getReceiptPaymentSourcesMs,
          buildPaymentRowsMs,
          ...paymentSaveResult.timing,
        },
        finishMs,
      })
    );

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
        const finishFailedStartedAt = Date.now();
        await finishSyncRun({
          runId: syncRunId,
          status: "failed",
          errorMessage: message,
        });
        console.warn("[SALES_SYNC_TIMING_FAILED]", {
          syncRunId,
          finishMs: Date.now() - finishFailedStartedAt,
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
