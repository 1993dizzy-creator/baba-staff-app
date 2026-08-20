import "server-only";

import { getBusinessDate } from "@/lib/common/business-time";
import {
  loadBusinessTimeSnapshotsForDates,
  resolveConfiguredBusinessDate,
} from "@/lib/store-settings/business-time-adapter";

export type ResolvedBusinessDate = {
  businessDate: string;
  source: "explicit" | "configured" | "error_fallback";
};

function logLookupFailed(error: unknown) {
  console.error(
    "[SALES_ADMIN_STORE_SETTING_LOOKUP_FAILED]",
    JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
  );
}

// Single settings lookup per request (only when no explicit date/month was
// given): /admin/sales pages and APIs must not each compute "today" with
// their own 03:00/Asia-Ho_Chi_Minh logic. Explicit values always pass through
// unchanged and never trigger a settings lookup.
//
// Uses resolveConfiguredBusinessDate (store_business_date_for_timestamp_v1
// only), not the full loadBusinessTimeAdapter: Sales only ever reads
// databaseBusinessDate and never touched the adapter's snapshot/context, so
// the extra store_get_settings_overview_v1 round trip was pure overhead. A
// failure of that overview RPC can no longer affect Sales business-date
// resolution as a result — only the date RPC's success/failure matters here.
export async function resolveAdminSalesBusinessDate(
  explicit: string | null | undefined
): Promise<ResolvedBusinessDate> {
  if (explicit) {
    return { businessDate: explicit, source: "explicit" };
  }

  try {
    const businessDate = await resolveConfiguredBusinessDate(new Date());
    return { businessDate, source: "configured" };
  } catch (error) {
    logLookupFailed(error);
    return { businessDate: getBusinessDate(), source: "error_fallback" };
  }
}

export type ResolvedMonth = {
  month: string;
  source: "explicit" | "configured" | "error_fallback";
};

export async function resolveAdminSalesMonth(
  explicit: string | null | undefined
): Promise<ResolvedMonth> {
  if (explicit) {
    return { month: explicit, source: "explicit" };
  }

  const resolved = await resolveAdminSalesBusinessDate(null);
  return { month: resolved.businessDate.slice(0, 7), source: resolved.source };
}

export type ResolvedCutoffHour = {
  cutoffHour: number;
  source: "configured" | "error_fallback";
};

const LEGACY_CUTOFF_HOUR = 3;

// Used only where a hardcoded cutoff hour was previously compared against a
// wall-clock hour for a specific, already-known businessDate (e.g. deciding
// whether a manually-typed "02:30" sale time belongs to that businessDate's
// calendar day or the next one). Not used for resolving which businessDate to
// use — see resolveAdminSalesBusinessDate for that.
export async function resolveAdminSalesCutoffHour(
  businessDate: string
): Promise<ResolvedCutoffHour> {
  try {
    const snapshots = await loadBusinessTimeSnapshotsForDates([businessDate]);
    const snapshot = snapshots.get(businessDate);
    const cutoffHour = Number(snapshot?.cutoff.slice(0, 2));

    if (!snapshot || !Number.isInteger(cutoffHour)) {
      throw new Error("STORE_SETTING_CUTOFF_UNAVAILABLE");
    }

    return { cutoffHour, source: "configured" };
  } catch (error) {
    logLookupFailed(error);
    return { cutoffHour: LEGACY_CUTOFF_HOUR, source: "error_fallback" };
  }
}
