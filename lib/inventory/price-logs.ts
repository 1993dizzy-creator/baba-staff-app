export type InventoryPriceLogSource =
  | "quick_save"
  | "edit_form"
  | "create"
  | "system";

export type InventoryPriceLogReason =
  | "purchase"
  | "manual_price_update"
  | "create"
  | "system";

type InventoryPriceLogInsert = {
  item_id: number;
  item_name: string | null;
  item_code: string | null;
  old_price: number | null;
  new_price: number;
  diff: number | null;
  business_date: string;
  source: InventoryPriceLogSource;
  reason: InventoryPriceLogReason;
  actor_username: string | null;
  note: string | null;
};

type PriceLogSupabaseClient = {
  from: (table: "inventory_price_logs") => {
    insert: (
      rows: InventoryPriceLogInsert[]
    ) => PromiseLike<{ error: Error | { message?: string } | null }>;
  };
};

type InsertInventoryPriceLogInput = {
  supabase: PriceLogSupabaseClient;
  itemId: unknown;
  itemName?: unknown;
  itemCode?: unknown;
  oldPrice?: unknown;
  newPrice?: unknown;
  businessDate: string;
  source: InventoryPriceLogSource;
  reason: InventoryPriceLogReason;
  actorUsername?: unknown;
  note?: unknown;
};

const normalizeNullableNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

const normalizeRequiredNumber = (value: unknown) => {
  const numberValue = normalizeNullableNumber(value);
  return numberValue === null ? null : numberValue;
};

const normalizeNullableText = (value: unknown) => {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return trimmed || null;
};

const roundPriceDiff = (value: number) => Math.round(value * 1000) / 1000;

export async function insertInventoryPriceLog({
  supabase,
  itemId,
  itemName,
  itemCode,
  oldPrice,
  newPrice,
  businessDate,
  source,
  reason,
  actorUsername,
  note,
}: InsertInventoryPriceLogInput) {
  const normalizedItemId = Number(itemId);
  const normalizedOldPrice = normalizeNullableNumber(oldPrice);
  const normalizedNewPrice = normalizeRequiredNumber(newPrice);

  if (!Number.isFinite(normalizedItemId) || normalizedItemId <= 0) {
    return { inserted: false, skipped: "invalid_item_id" as const };
  }

  if (normalizedNewPrice === null) {
    return { inserted: false, skipped: "invalid_new_price" as const };
  }

  if (
    normalizedOldPrice !== null &&
    roundPriceDiff(normalizedOldPrice) === roundPriceDiff(normalizedNewPrice)
  ) {
    return { inserted: false, skipped: "same_price" as const };
  }

  const diff =
    normalizedOldPrice === null
      ? null
      : roundPriceDiff(normalizedNewPrice - normalizedOldPrice);

  const payload: InventoryPriceLogInsert = {
    item_id: normalizedItemId,
    item_name: normalizeNullableText(itemName),
    item_code: normalizeNullableText(itemCode),
    old_price: normalizedOldPrice,
    new_price: normalizedNewPrice,
    diff,
    business_date: businessDate,
    source,
    reason,
    actor_username: normalizeNullableText(actorUsername),
    note: normalizeNullableText(note),
  };

  const { error } = await supabase.from("inventory_price_logs").insert([payload]);

  if (error) throw error;

  return { inserted: true as const };
}
