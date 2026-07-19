import "server-only";

import { loginCukcuk } from "@/lib/pos/cukcuk/auth";
import {
  buildCukcukHeaders,
  CUKCUK_BASE_URL,
  getDetailsFromInvoicePayload,
  getInvoiceRefId,
  getParentRefDetailId,
  getPaymentStatus,
  getRefDetailType,
  getString,
  isCanceledPaymentStatus,
  type CukcukInvoice,
  type JsonObject,
} from "@/lib/pos/cukcuk/sales-receipt-sync";
import { getBusinessWindowByBusinessDate } from "@/lib/common/business-time";
import {
  buildPosCollectionWindow,
  calculateBusinessTimeContext,
} from "@/lib/store-settings/business-time-adapter-core";
import { loadBusinessTimeSnapshotsForDates } from "@/lib/store-settings/business-time-adapter";
import {
  buildPosShadowResult,
  isTimestampInHalfOpenRange,
  type PosShadowObservation,
} from "@/lib/store-settings/pos-shadow-core";
import { supabaseServer } from "@/lib/supabase/server";

const DEFAULT_BRANCH_ID = "c39228ba-a452-4cf9-bf34-424ffb151fb8";
const DETAIL_CONCURRENCY = 4;
const CUKCUK_TIMEOUT_MS = 20_000;

function getCukcukDataArray(json: JsonObject) {
  const data = json.Data;
  if (Array.isArray(data)) return data as CukcukInvoice[];
  if (data && typeof data === "object") {
    const nested = data as JsonObject;
    if (Array.isArray(nested.Data)) return nested.Data as CukcukInvoice[];
    if (Array.isArray(nested.Items)) return nested.Items as CukcukInvoice[];
  }
  return [];
}

async function fetchInvoiceList(params: {
  accessToken: string;
  companyCode: string;
  fromDate: string;
  limit: number;
}) {
  const response = await fetch(`${CUKCUK_BASE_URL}/api/v1/sainvoices/paging`, {
    method: "POST",
    headers: buildCukcukHeaders(params.accessToken, params.companyCode),
    body: JSON.stringify({
      Page: 1,
      Limit: params.limit,
      BranchId: DEFAULT_BRANCH_ID,
      LastSyncDate: params.fromDate,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(CUKCUK_TIMEOUT_MS),
  });
  const json = (await response.json()) as JsonObject;
  if (!response.ok || json.Success === false) throw new Error("CUKCUK_LIST_FAILED");
  return getCukcukDataArray(json);
}

async function fetchInvoiceDetail(params: {
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
      signal: AbortSignal.timeout(CUKCUK_TIMEOUT_MS),
    }
  );
  const json = (await response.json()) as JsonObject;
  if (!response.ok || json.Success === false) throw new Error("CUKCUK_DETAIL_FAILED");
  return json;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
) {
  const result = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        result[index] = await mapper(items[index]);
      }
    })
  );
  return result;
}

function getTimestamp(detail: JsonObject | null, invoice: CukcukInvoice) {
  return getString(detail, ["RefDate", "refDate", "PostedDate", "postedDate"])
    ?? getString(invoice, ["RefDate", "refDate", "PostedDate", "postedDate"]);
}

function invoiceStatus(detail: JsonObject | null, invoice: CukcukInvoice) {
  const paymentStatus = getPaymentStatus(detail ?? invoice) ?? getPaymentStatus(invoice);
  const canceled = detail?.IsCanceled === true || detail?.isCanceled === true
    || isCanceledPaymentStatus(paymentStatus);
  return canceled ? "canceled" as const : paymentStatus === 3 ? "completed" as const : "other" as const;
}

export async function runPosShadow(params: { businessDate: string; limit: number }) {
  const snapshots = await loadBusinessTimeSnapshotsForDates([params.businessDate]);
  const requestedSnapshot = snapshots.get(params.businessDate);
  if (!requestedSnapshot) throw new Error("STORE_SETTING_LOOKUP_FAILED");

  const legacy = getBusinessWindowByBusinessDate(params.businessDate);
  const configured = buildPosCollectionWindow(params.businessDate, requestedSnapshot);
  const legacyWindow = { from: legacy.start.toISOString(), to: legacy.end.toISOString() };
  const configuredWindow = { from: configured.collectionFrom, to: configured.collectionTo };
  const starts = [legacyWindow.from, configuredWindow.from].filter((value): value is string => Boolean(value));
  const queryFrom = starts.sort(
    (left, right) => new Date(left).getTime() - new Date(right).getTime()
  )[0];
  if (!queryFrom) throw new Error("COLLECTION_WINDOW_UNAVAILABLE");

  const login = await loginCukcuk();
  const invoices = await fetchInvoiceList({
    accessToken: login.accessToken,
    companyCode: login.companyCode,
    fromDate: queryFrom,
    limit: params.limit,
  });
  const candidateInvoices = invoices.filter((invoice) => {
    const timestamp = getTimestamp(null, invoice);
    return !timestamp
      || isTimestampInHalfOpenRange(timestamp, legacyWindow.from, legacyWindow.to)
      || isTimestampInHalfOpenRange(timestamp, configuredWindow.from, configuredWindow.to);
  });
  const details = await mapWithConcurrency(candidateInvoices, DETAIL_CONCURRENCY, async (invoice) => {
    const refId = getInvoiceRefId(invoice);
    if (!refId) return { invoice, detail: null, failed: true };
    try {
      return {
        invoice,
        detail: await fetchInvoiceDetail({
          accessToken: login.accessToken,
          companyCode: login.companyCode,
          refId,
        }),
        failed: false,
      };
    } catch {
      return { invoice, detail: null, failed: true };
    }
  });

  const timestampRows = details.map((item) => ({ ...item, timestamp: getTimestamp(item.detail, item.invoice) }));
  const initialContexts = timestampRows
    .filter((item): item is typeof item & { timestamp: string } => Boolean(item.timestamp))
    .map((item) => calculateBusinessTimeContext(item.timestamp, requestedSnapshot));
  const candidateDates = [...new Set(initialContexts.map((context) => context.businessDate))];
  const candidateSnapshots = await loadBusinessTimeSnapshotsForDates(candidateDates);
  const pureRows = timestampRows.map((item) => {
    if (!item.timestamp) return { ...item, context: null };
    const initial = calculateBusinessTimeContext(item.timestamp, requestedSnapshot);
    const snapshot = candidateSnapshots.get(initial.businessDate) ?? requestedSnapshot;
    return { ...item, context: calculateBusinessTimeContext(item.timestamp, snapshot) };
  });

  const representativeByPureDate = new Map<string, string>();
  for (const row of pureRows) {
    if (row.timestamp && row.context && !representativeByPureDate.has(row.context.businessDate)) {
      representativeByPureDate.set(row.context.businessDate, row.timestamp);
    }
  }
  const databaseDates = new Map<string, string>();
  await Promise.all([...representativeByPureDate].map(async ([pureDate, timestamp]) => {
    const { data, error } = await supabaseServer.rpc(
      "store_business_date_for_timestamp_v1",
      { p_timestamp: new Date(timestamp).toISOString() }
    );
    if (error || typeof data !== "string") throw new Error("STORE_BUSINESS_DATE_RPC_FAILED");
    databaseDates.set(pureDate, data);
  }));

  const observations: PosShadowObservation[] = pureRows.map((row) => {
    const lines = row.detail ? getDetailsFromInvoicePayload(row.detail) : [];
    return {
      timestamp: row.timestamp,
      configuredPureBusinessDate: row.context?.businessDate ?? null,
      configuredDbBusinessDate: row.context ? databaseDates.get(row.context.businessDate) ?? null : null,
      inLegacyRange: isTimestampInHalfOpenRange(row.timestamp, legacyWindow.from, legacyWindow.to),
      inConfiguredRange: isTimestampInHalfOpenRange(
        row.timestamp,
        configuredWindow.from,
        configuredWindow.to
      ),
      status: invoiceStatus(row.detail, row.invoice),
      optionLineCount: lines.filter((line) => getRefDetailType(line) === 2).length,
      parentLineCount: lines.filter((line) => Boolean(getParentRefDetailId(line))).length,
    };
  });

  return buildPosShadowResult({
    businessDate: params.businessDate,
    snapshot: requestedSnapshot,
    legacyWindow,
    configuredWindow,
    listCount: invoices.length,
    detailCount: details.filter((item) => item.detail).length,
    detailFailureCount: details.filter((item) => item.failed).length,
    limit: params.limit,
    observations,
  });
}
