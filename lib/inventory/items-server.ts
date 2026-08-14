import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { KegProgress, KegTrackingMappingRow } from "@/lib/inventory/keg-progress";

type SupabaseClientLike = Pick<SupabaseClient, "from">;

export const INVENTORY_ITEM_SELECT = `
  id,
  item_name,
  item_name_vi,
  part,
  category,
  category_vi,
  quantity,
  unit,
  note,
  purchase_price,
  supplier,
  code,
  low_stock_threshold,
  low_stock_enabled,
  package_content_quantity,
  package_content_unit,
  is_active,
  image_path,
  updated_at,
  updated_by_name
`;

export type InventoryReadItem = Record<string, unknown> & {
  id: number | string;
};

export const canToggleInventoryItemActiveStatus = (role: unknown) =>
  role === "owner" ||
  role === "master" ||
  role === "manager" ||
  role === "leader";

export const getInventoryKegCandidateIds = (
  items: Array<Record<string, unknown>>
) =>
  items
    .filter((item) => {
      const unit = String(item.unit || "").trim().toLowerCase();
      const packageUnit = String(item.package_content_unit || "")
        .trim()
        .toLowerCase();
      const packageQuantity = Number(item.package_content_quantity ?? 0);

      return unit === "keg" && packageUnit === "ml" && packageQuantity > 0;
    })
    .map((item) => Number(item.id))
    .filter((id) => Number.isFinite(id) && id > 0);

export async function fetchInventoryItems(params: {
  supabase: SupabaseClientLike;
  includeInactive: boolean;
}) {
  let query = params.supabase
    .from("inventory")
    .select(INVENTORY_ITEM_SELECT)
    .order("updated_at", { ascending: false });

  if (!params.includeInactive) {
    query = query.eq("is_active", true);
  }

  const { data, error } = await query;
  if (error) throw error;

  return (data || []) as InventoryReadItem[];
}

export async function fetchActiveKegTrackingMappings(params: {
  supabase: SupabaseClientLike;
  kegCandidateIds: number[];
}) {
  if (params.kegCandidateIds.length === 0) {
    return [] as KegTrackingMappingRow[];
  }

  const { data, error } = await params.supabase
    .from("inventory_keg_tracking_mappings")
    .select("inventory_item_id, pos_product_id, quantity_per_pos_unit, unit")
    .in("inventory_item_id", params.kegCandidateIds)
    .eq("is_active", true)
    .eq("target_type", "product");

  if (error) throw error;
  return (data || []) as KegTrackingMappingRow[];
}

export function buildInventoryItemsResponse(params: {
  items: InventoryReadItem[];
  activeMappings: KegTrackingMappingRow[];
  kegProgressByItemId?: Map<number, KegProgress>;
}) {
  const activeKegTrackingIds = new Set(
    params.activeMappings
      .map((mapping) => Number(mapping.inventory_item_id))
      .filter((id) => Number.isFinite(id) && id > 0)
  );

  return params.items.map((item) => ({
    ...item,
    has_active_keg_tracking: activeKegTrackingIds.has(Number(item.id)),
    kegProgress: params.kegProgressByItemId?.get(Number(item.id)) ?? null,
    lastStockCheckDate: null,
    daysSinceStockCheck: null,
    needsStockCheck: false,
  }));
}
