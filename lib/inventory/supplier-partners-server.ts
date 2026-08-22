import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

type SupplierResolution = {
  status?: string;
  supplierName?: string | null;
  supplierPartnerId?: number | null;
};

export async function resolveInventorySupplier(params: {
  supabase: SupabaseClient;
  payload: Record<string, unknown>;
  actorUserId: number;
}) {
  const hasSupplier = Object.prototype.hasOwnProperty.call(params.payload, "supplier");
  const hasPartner = Object.prototype.hasOwnProperty.call(params.payload, "supplierPartnerId");
  const legacyPartner = Object.prototype.hasOwnProperty.call(params.payload, "supplier_partner_id");
  if (!hasSupplier && !hasPartner && !legacyPartner) return null;

  const rawPartnerId = hasPartner
    ? params.payload.supplierPartnerId
    : params.payload.supplier_partner_id;
  const partnerId = rawPartnerId === null || rawPartnerId === undefined || rawPartnerId === ""
    ? null
    : Number(rawPartnerId);
  if (partnerId !== null && (!Number.isSafeInteger(partnerId) || partnerId < 1)) {
    throw new Error("invalid_supplier_partner");
  }
  const supplierName = typeof params.payload.supplier === "string"
    ? params.payload.supplier.replace(/\s+/g, " ").trim()
    : null;

  const { data, error } = await params.supabase.rpc(
    "business_partner_resolve_inventory_supplier_v1",
    {
      p_supplier_name: supplierName,
      p_supplier_partner_id: partnerId,
      p_actor_user_id: params.actorUserId,
    }
  );
  if (error) throw error;
  const result = data as SupplierResolution;
  if (result.status !== "resolved") throw new Error(result.status ?? "supplier_resolution_failed");
  return {
    supplier: result.supplierName ?? null,
    supplier_partner_id: result.supplierPartnerId ?? null,
  };
}

export function applyResolvedInventorySupplier(
  payload: Record<string, unknown>,
  resolution: { supplier: string | null; supplier_partner_id: number | null } | null
) {
  delete payload.supplierPartnerId;
  delete payload.supplier_partner_id;
  if (!resolution) return payload;
  payload.supplier = resolution.supplier;
  payload.supplier_partner_id = resolution.supplier_partner_id;
  return payload;
}
