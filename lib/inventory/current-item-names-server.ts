import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InventoryItemNames } from "./current-item-names";

// Bounded bulk reads, including historical dates. A failed/missing/inactive
// master falls back to the stored names; source rows are never mutated.
export async function withCurrentInventoryNames<T extends { item_id?: number | null }>(supabase: SupabaseClient, rows: readonly T[]): Promise<Array<T & { currentItemNames?: InventoryItemNames | null }>> {
  const ids = [...new Set(rows.map(row => Number(row.item_id)).filter(id => Number.isSafeInteger(id) && id > 0))];
  const names = new Map<number, InventoryItemNames>();
  const resolved = new Set<number>();
  for (let start = 0; start < ids.length; start += 200) {
    try {
      const chunk = ids.slice(start, start + 200);
      const result = await supabase.from("inventory").select("id,item_name,item_name_vi,updated_at").in("id", chunk).eq("is_active", true);
      if (result.error) continue;
      chunk.forEach(id => resolved.add(id));
      for (const item of result.data ?? []) names.set(Number(item.id), { item_name: item.item_name, item_name_vi: item.item_name_vi, updated_at: item.updated_at });
    } catch { /* Optional display enrichment must not hide historical rows. */ }
  }
  return rows.map(row => names.has(Number(row.item_id)) ? { ...row, currentItemNames: names.get(Number(row.item_id)) }
    : resolved.has(Number(row.item_id)) ? { ...row, currentItemNames: null } : { ...row });
}
