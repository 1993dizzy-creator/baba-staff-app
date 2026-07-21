import "server-only";

import { getBusinessDate } from "@/lib/common/business-time";
import {
  loadBusinessTimeAdapter,
  loadBusinessTimeSnapshotsForDates,
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
export async function resolveAdminSalesBusinessDate(
  explicit: string | null | undefined
): Promise<ResolvedBusinessDate> {
  if (explicit) {
    return { businessDate: explicit, source: "explicit" };
  }

  try {
    const adapter = await loadBusinessTimeAdapter(new Date());
    return { businessDate: adapter.databaseBusinessDate, source: "configured" };
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
