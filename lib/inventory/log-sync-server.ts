import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  inventoryLogDisplayUpdate,
  inventoryPurchaseLogCurrentItemSyncUpdate,
} from "@/lib/inventory/ledger-sync-contract";

export type InventoryLogSyncItem = {
  item_name: string | null;
  item_name_vi: string | null;
  part: string | null;
  category: string | null;
  category_vi: string | null;
  code: string | null;
  unit: string | null;
  purchase_price: number | null;
  supplier: string | null;
  supplier_partner_id: number | null;
};

export const INVENTORY_LOG_SYNC_ROW_SELECT =
  "id, item_id, item_name, item_name_vi, part, new_part, category, category_vi, new_category, new_category_vi, code, new_code, unit, new_unit, reason, business_date, change_quantity, new_supplier, new_purchase_price, purchase_supplier_partner_id";

export const buildInventoryLogSyncPayload = (
  item: InventoryLogSyncItem,
  syncPurchaseEconomics: boolean
): Record<string, string | number | null> =>
  syncPurchaseEconomics
    ? inventoryPurchaseLogCurrentItemSyncUpdate(item)
    : inventoryLogDisplayUpdate(item);

export async function updateInventoryLogRows(
  supabase: SupabaseClient,
  ids: number[],
  payload: Record<string, string | number | null>
) {
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from("inventory_logs")
    .update(payload)
    .in("id", ids)
    .select(INVENTORY_LOG_SYNC_ROW_SELECT)
    .order("id", { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function syncInventoryLogRowsFromItem({
  supabase,
  item,
  purchaseLogIds,
  displayOnlyLogIds = [],
  overlay = {},
}: {
  supabase: SupabaseClient;
  item: InventoryLogSyncItem;
  purchaseLogIds: number[];
  displayOnlyLogIds?: number[];
  overlay?: Record<string, string | number | null>;
}) {
  const [purchaseRows, displayOnlyRows] = await Promise.all([
    updateInventoryLogRows(supabase, purchaseLogIds, {
      ...buildInventoryLogSyncPayload(item, true),
      ...overlay,
    }),
    updateInventoryLogRows(supabase, displayOnlyLogIds, {
      ...buildInventoryLogSyncPayload(item, false),
      ...overlay,
    }),
  ]);

  return [...purchaseRows, ...displayOnlyRows].sort(
    (left, right) => Number(left.id) - Number(right.id)
  );
}
