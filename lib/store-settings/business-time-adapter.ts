import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import {
  calculateBusinessTimeContext,
  createBusinessTimeSnapshot,
} from "@/lib/store-settings/business-time-adapter-core";
import type { StoreSetting, StoreSettingsOverview } from "@/lib/store-settings/types";

// Date-only variant of loadBusinessTimeAdapter, for callers that need the
// configured businessDate and nothing else (no hours/cutoff snapshot, no
// open/close context). Calls store_business_date_for_timestamp_v1 alone —
// that RPC already resolves the active store-setting revision, its
// timezone/cutoff, and the effective_from_business_date transition boundary
// on its own, so it is a complete source of truth for businessDate by
// itself. Skipping store_get_settings_overview_v1 here does not change what
// businessDate is returned: loadBusinessTimeAdapter's databaseBusinessDate
// field is this same RPC's raw response, never adjusted by the overview
// call. Do not use this for anything that needs hours/cutoff/revision data —
// use loadBusinessTimeAdapter for that.
export async function resolveConfiguredBusinessDate(timestamp: Date | string) {
  const value = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (!Number.isFinite(value.getTime())) throw new Error("Invalid business-time timestamp");

  const { data: databaseBusinessDate, error: dateError } = await supabaseServer.rpc(
    "store_business_date_for_timestamp_v1",
    { p_timestamp: value.toISOString() }
  );
  if (dateError || typeof databaseBusinessDate !== "string") {
    throw new Error(`Failed to calculate configured business date: ${dateError?.message ?? "invalid response"}`);
  }

  return databaseBusinessDate;
}

export async function loadBusinessTimeAdapter(timestamp: Date | string) {
  const value = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (!Number.isFinite(value.getTime())) throw new Error("Invalid business-time timestamp");

  const { data: databaseBusinessDate, error: dateError } = await supabaseServer.rpc(
    "store_business_date_for_timestamp_v1",
    { p_timestamp: value.toISOString() }
  );
  if (dateError || typeof databaseBusinessDate !== "string") {
    throw new Error(`Failed to calculate configured business date: ${dateError?.message ?? "invalid response"}`);
  }

  const { data, error } = await supabaseServer.rpc("store_get_settings_overview_v1", {
    p_business_date: databaseBusinessDate,
  });
  if (error) throw new Error(`Failed to load configured store setting: ${error.message}`);

  const overview = data as Omit<StoreSettingsOverview, "fallbackUsed">;
  const snapshot = createBusinessTimeSnapshot(
    overview.current as StoreSetting | null,
    databaseBusinessDate
  );

  return {
    context: calculateBusinessTimeContext(value, snapshot),
    snapshot,
    databaseBusinessDate,
  };
}

export async function loadBusinessTimeSnapshotsForDates(businessDates: string[]) {
  const uniqueDates = [...new Set(businessDates)];
  const entries = await Promise.all(
    uniqueDates.map(async (businessDate) => {
      const { data, error } = await supabaseServer.rpc("store_get_settings_overview_v1", {
        p_business_date: businessDate,
      });
      if (error) throw new Error(`Failed to load store setting for ${businessDate}: ${error.message}`);
      const overview = data as Omit<StoreSettingsOverview, "fallbackUsed">;
      return [
        businessDate,
        createBusinessTimeSnapshot(overview.current as StoreSetting | null, businessDate),
      ] as const;
    })
  );
  return new Map(entries);
}
