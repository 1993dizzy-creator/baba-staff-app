import "server-only";
import { supabaseServer } from "@/lib/supabase/server";

// Keep schema availability separate from write enablement. Turning writes off
// must NEVER turn synchronization protection off for existing resolutions.
export function resolutionSchemaReady() {
  return process.env.POS_ADMIN_RESOLUTION_SCHEMA_READY === "true";
}
export function resolutionWritesEnabled() {
  return resolutionSchemaReady() && process.env.POS_ADMIN_RESOLUTION_ENABLED === "true";
}
export function resolutionWorkSchemaReady() {
  return resolutionSchemaReady() && process.env.POS_ADMIN_RESOLUTION_V2_SCHEMA_READY === "true";
}
export function resolutionWorkEnabled() {
  return resolutionWorkSchemaReady() && resolutionWritesEnabled();
}

export async function protectedResolutionRefs(refIds: string[]) {
  if (!resolutionSchemaReady() || !refIds.length) return new Set<string>();
  const { data, error } = await supabaseServer.from("pos_sales_receipt_admin_resolutions")
    .select("receipt:pos_sales_receipts!inner(ref_id)").in("receipt.ref_id", [...new Set(refIds)]);
  if (error) throw new Error("POS_RESOLUTION_PROTECTION_UNAVAILABLE");
  const refs = new Set<string>();
  for (const row of data || []) {
    const receipts = Array.isArray(row.receipt) ? row.receipt : [row.receipt];
    for (const receipt of receipts) if (receipt?.ref_id) refs.add(receipt.ref_id);
  }
  return refs;
}
