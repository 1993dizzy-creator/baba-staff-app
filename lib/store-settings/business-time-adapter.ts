import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import {
  calculateBusinessTimeContext,
  createBusinessTimeSnapshot,
} from "@/lib/store-settings/business-time-adapter-core";
import type { StoreSetting, StoreSettingsOverview } from "@/lib/store-settings/types";

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
