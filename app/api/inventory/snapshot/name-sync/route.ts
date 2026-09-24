import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { syncInventoryLogRowsFromItem } from "@/lib/inventory/log-sync-server";
import {
  canRunInventorySnapshotNameSync,
  findInventoryLogNameSyncItems,
  isInventorySnapshotNameSyncEligible,
  planInventoryLogNameUpdates,
  type CurrentInventoryDailySyncRow,
  type InventoryDailySyncLogRow,
  type InventoryDailySyncPlan,
} from "@/lib/inventory/snapshot-name-sync";
import { projectInventoryPurchaseLogs } from "@/lib/ledger/inventory-projection";
import {
  findInventoryLanguageMissingItems,
  type InventoryLanguageRow,
} from "@/lib/inventory/language-missing";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
const LOG_PAGE_SIZE = 1000;
const LOG_SELECT = [
  "id", "item_id", "business_date", "created_at", "reason", "change_quantity",
  "prev_quantity", "new_quantity", "item_name", "item_name_vi", "part", "new_part",
  "category", "category_vi", "new_category", "new_category_vi", "code", "new_code",
  "unit", "new_unit", "new_purchase_price", "new_supplier", "purchase_supplier_partner_id",
].join(", ");
const INVENTORY_SELECT = [
  "id", "item_name", "item_name_vi", "part", "category", "category_vi", "code", "unit",
  "purchase_price", "supplier", "supplier_partner_id", "quantity", "is_active",
].join(", ");
const LANGUAGE_INVENTORY_SELECT = "id, item_name, item_name_vi, is_active";

const createSupabaseAdmin = () => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Missing inventory daily sync server configuration");
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
};

const isPositiveId = (value: number) => Number.isSafeInteger(value) && value > 0;
const isValidBusinessDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

async function loadDailySyncRows(
  supabase: ReturnType<typeof createSupabaseAdmin>,
  businessDate: string,
  itemId?: number
) {
  const logs: InventoryDailySyncLogRow[] = [];
  for (let from = 0; ; from += LOG_PAGE_SIZE) {
    let query = supabase.from("inventory_logs").select(LOG_SELECT)
      .eq("business_date", businessDate).not("item_id", "is", null);
    if (itemId !== undefined) query = query.eq("item_id", itemId);
    const result = await query.order("created_at", { ascending: true })
      .order("id", { ascending: true }).range(from, from + LOG_PAGE_SIZE - 1);
    if (result.error) return { ok: false as const, error: "inventory_daily_sync_logs_query_failed" };
    const page = (result.data ?? []) as unknown as InventoryDailySyncLogRow[];
    logs.push(...page);
    if (page.length < LOG_PAGE_SIZE) break;
  }

  const itemIds = Array.from(new Set(logs.map((row) => Number(row.item_id)).filter(isPositiveId)));
  if (itemIds.length === 0) return { ok: true as const, logs, inventoryItems: [] as CurrentInventoryDailySyncRow[] };

  const inventoryResult = await supabase.from("inventory").select(INVENTORY_SELECT)
    .in("id", itemIds).eq("is_active", true);
  if (inventoryResult.error) return { ok: false as const, error: "inventory_daily_sync_inventory_query_failed" };
  return {
    ok: true as const,
    logs,
    inventoryItems: (inventoryResult.data ?? []) as unknown as CurrentInventoryDailySyncRow[],
  };
}

async function loadActiveInventoryLanguageRows(
  supabase: ReturnType<typeof createSupabaseAdmin>
) {
  const result = await supabase.from("inventory").select(LANGUAGE_INVENTORY_SELECT)
    .eq("is_active", true).order("id", { ascending: true });
  if (result.error) return { ok: false as const, error: "inventory_language_missing_query_failed" };
  return {
    ok: true as const,
    inventoryItems: (result.data ?? []) as unknown as InventoryLanguageRow[],
  };
}

async function loadOptionalSnapshotBatchId(
  supabase: ReturnType<typeof createSupabaseAdmin>,
  businessDate: string
) {
  const result = await supabase.from("inventory_snapshot_batches").select("id")
    .eq("snapshot_date", businessDate).order("id", { ascending: false }).limit(1).maybeSingle();
  if (result.error) return { ok: false as const, error: "inventory_daily_sync_batch_query_failed" };
  return { ok: true as const, batchId: result.data ? Number(result.data.id) : null };
}

async function syncSnapshotItem(
  supabase: ReturnType<typeof createSupabaseAdmin>,
  batchId: number | null,
  item: CurrentInventoryDailySyncRow
) {
  if (batchId === null) return 0;
  const rows = await supabase.from("inventory_snapshot_items").select("id, change_quantity")
    .eq("batch_id", batchId).eq("item_id", item.id);
  if (rows.error) throw rows.error;

  for (const row of rows.data ?? []) {
    const quantity = Number(row.change_quantity ?? 0);
    const price = item.purchase_price === null ? null : Number(item.purchase_price);
    const totalPurchasePrice = price === null || !Number.isFinite(quantity) ? null : quantity * price;
    const result = await supabase.from("inventory_snapshot_items").update({
      item_name: item.item_name,
      item_name_vi: item.item_name_vi,
      part: item.part,
      category: item.category,
      category_vi: item.category_vi,
      code: item.code,
      unit: item.unit,
      purchase_price: item.purchase_price,
      supplier: item.supplier,
      total_purchase_price: totalPurchasePrice,
    }).eq("id", Number(row.id)).eq("batch_id", batchId).eq("item_id", item.id);
    if (result.error) throw result.error;
  }
  return rows.data?.length ?? 0;
}

async function runItemSync({
  supabase,
  plan,
  inventoryItem,
  actorUserId,
  snapshotBatchId,
}: {
  supabase: ReturnType<typeof createSupabaseAdmin>;
  plan: InventoryDailySyncPlan;
  inventoryItem: CurrentInventoryDailySyncRow;
  actorUserId: number;
  snapshotBatchId: number | null;
}) {
  if (plan.quantityReviewRequired) {
    return { itemId: plan.itemId, status: "review_required" as const, code: "QUANTITY_CORRECTION_REQUIRED" };
  }

  try {
    const ledgerResults = [];
    for (const target of plan.targets) {
      await syncInventoryLogRowsFromItem({
        supabase,
        item: target.syncItem,
        purchaseLogIds: [target.purchaseLogId],
      });
      ledgerResults.push(await projectInventoryPurchaseLogs([target.purchaseLogId], actorUserId));
    }
    const snapshotRowsUpdated = await syncSnapshotItem(supabase, snapshotBatchId, inventoryItem);
    const review = ledgerResults.find((result) => result.status === "review_required" || result.status === "pending");
    const failed = ledgerResults.find((result) => result.status === "failed");
    if (failed) return { itemId: plan.itemId, status: "failed" as const, code: failed.code, snapshotRowsUpdated };
    if (review) return { itemId: plan.itemId, status: "review_required" as const, code: review.code, snapshotRowsUpdated };
    return {
      itemId: plan.itemId,
      status: "synced" as const,
      purchaseLogIds: plan.logIds,
      snapshotRowsUpdated,
    };
  } catch (error) {
    console.error("[INVENTORY_DAILY_SYNC_ITEM_FAILED]", { itemId: plan.itemId, error });
    return { itemId: plan.itemId, status: "failed" as const, code: "INVENTORY_DAILY_SYNC_FAILED" };
  }
}

export async function GET(request: Request) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code, code: auth.code }, { status: auth.status, headers: NO_STORE_HEADERS });
    const businessDate = new URL(request.url).searchParams.get("businessDate");
    if (!isValidBusinessDate(businessDate)) return NextResponse.json({ ok: false, error: "inventory_daily_sync_invalid_business_date" }, { status: 400, headers: NO_STORE_HEADERS });

    const supabase = createSupabaseAdmin();
    const languageRows = await loadActiveInventoryLanguageRows(supabase);
    if (!languageRows.ok) return NextResponse.json({ ok: false, error: languageRows.error }, { status: 500, headers: NO_STORE_HEADERS });

    const canSync = canRunInventorySnapshotNameSync(auth.actor.role);
    if (!isInventorySnapshotNameSyncEligible(businessDate)) return NextResponse.json({
      ok: true,
      businessDate,
      canSync,
      languageMissingItems: findInventoryLanguageMissingItems(languageRows.inventoryItems),
      dailySyncItems: [],
    }, { headers: NO_STORE_HEADERS });
    const rows = await loadDailySyncRows(supabase, businessDate);
    if (!rows.ok) return NextResponse.json({ ok: false, error: rows.error }, { status: 500, headers: NO_STORE_HEADERS });
    return NextResponse.json({
      ok: true,
      businessDate,
      canSync,
      languageMissingItems: findInventoryLanguageMissingItems(languageRows.inventoryItems),
      dailySyncItems: findInventoryLogNameSyncItems(businessDate, rows.logs, rows.inventoryItems),
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[INVENTORY_DAILY_SYNC_GET_FAILED]", error);
    return NextResponse.json({ ok: false, error: "inventory_daily_sync_failed" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code, code: auth.code }, { status: auth.status, headers: NO_STORE_HEADERS });
    if (!canRunInventorySnapshotNameSync(auth.actor.role)) return NextResponse.json({ ok: false, error: "inventory_snapshot_name_sync_forbidden" }, { status: 403, headers: NO_STORE_HEADERS });

    let body: { action?: unknown; business_date?: unknown; item_id?: unknown };
    try { body = await request.json(); }
    catch { return NextResponse.json({ ok: false, error: "inventory_daily_sync_invalid_body" }, { status: 400, headers: NO_STORE_HEADERS }); }
    const action = body.action;
    const businessDate = body.business_date;
    const itemId = action === "sync_item" ? Number(body.item_id) : undefined;
    if ((action !== "sync_item" && action !== "sync_all") || !isValidBusinessDate(businessDate) || (action === "sync_item" && !isPositiveId(Number(itemId)))) {
      return NextResponse.json({ ok: false, error: "inventory_daily_sync_invalid_request" }, { status: 400, headers: NO_STORE_HEADERS });
    }
    if (!isInventorySnapshotNameSyncEligible(businessDate)) return NextResponse.json({ ok: false, error: "inventory_snapshot_name_sync_before_start_date" }, { status: 400, headers: NO_STORE_HEADERS });

    const supabase = createSupabaseAdmin();
    const rows = await loadDailySyncRows(supabase, businessDate, itemId);
    if (!rows.ok) return NextResponse.json({ ok: false, error: rows.error }, { status: 500, headers: NO_STORE_HEADERS });
    const plans = planInventoryLogNameUpdates(businessDate, rows.logs, rows.inventoryItems, itemId);
    const snapshotBatch = await loadOptionalSnapshotBatchId(supabase, businessDate);
    if (!snapshotBatch.ok) return NextResponse.json({ ok: false, error: snapshotBatch.error }, { status: 500, headers: NO_STORE_HEADERS });

    const inventoryById = new Map(rows.inventoryItems.map((item) => [Number(item.id), item] as const));
    const results = [];
    for (const plan of plans) {
      const inventoryItem = inventoryById.get(plan.itemId);
      if (!inventoryItem) {
        results.push({ itemId: plan.itemId, status: "failed" as const, code: "INVENTORY_ITEM_NOT_FOUND" });
        continue;
      }
      results.push(await runItemSync({
        supabase,
        plan,
        inventoryItem,
        actorUserId: auth.actor.id,
        snapshotBatchId: snapshotBatch.batchId,
      }));
    }

    return NextResponse.json({
      ok: true,
      businessDate,
      snapshotBatchId: snapshotBatch.batchId,
      results,
      syncedCount: results.filter((result) => result.status === "synced").length,
      reviewRequiredCount: results.filter((result) => result.status === "review_required").length,
      failedCount: results.filter((result) => result.status === "failed").length,
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[INVENTORY_DAILY_SYNC_POST_FAILED]", error);
    return NextResponse.json({ ok: false, error: "inventory_daily_sync_failed" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
