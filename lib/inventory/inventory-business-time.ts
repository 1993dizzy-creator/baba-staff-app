import "server-only";

import { getBusinessDate } from "@/lib/common/business-time";
import { getSnapshotDate } from "@/lib/inventory/business-day";
import { resolveConfiguredBusinessDate } from "@/lib/store-settings/business-time-adapter";
import { addStoreDays } from "@/lib/store-settings/business-time-core";

export type ResolvedInventoryBusinessDate = {
  businessDate: string;
  source: "configured" | "error_fallback";
};

function logLookupFailed(error: unknown) {
  console.error(
    "[INVENTORY_STORE_SETTING_LOOKUP_FAILED]",
    JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
  );
}

// Resolves the business date for a specific timestamp (or "now" when omitted)
// via the date RPC, which already resolves the configured timezone/cutoff.
// No hours/revision snapshot is consumed here, so an overview lookup is unnecessary.
// Keep each invocation fresh; callers must not resolve dates in per-item loops.
export async function resolveInventoryBusinessDate(
  timestamp?: Date
): Promise<ResolvedInventoryBusinessDate> {
  try {
    const businessDate = await resolveConfiguredBusinessDate(timestamp ?? new Date());
    return { businessDate, source: "configured" };
  } catch (error) {
    logLookupFailed(error);
    return { businessDate: getBusinessDate(timestamp), source: "error_fallback" };
  }
}

// The business date that just closed, as of now — used by the daily snapshot
// cron, which must record the day that ended, not the one that just started.
export async function resolveInventoryPreviousBusinessDate(): Promise<ResolvedInventoryBusinessDate> {
  const current = await resolveInventoryBusinessDate();
  if (current.source === "error_fallback") {
    return { businessDate: getSnapshotDate(), source: "error_fallback" };
  }
  return { businessDate: addStoreDays(current.businessDate, -1), source: current.source };
}

export type ResolvedInventoryMonth = {
  month: string;
  source: "explicit" | "configured" | "error_fallback";
};

export async function resolveInventoryMonth(
  explicit: string | null | undefined
): Promise<ResolvedInventoryMonth> {
  if (explicit) {
    return { month: explicit, source: "explicit" };
  }

  const resolved = await resolveInventoryBusinessDate();
  return { month: resolved.businessDate.slice(0, 7), source: resolved.source };
}
