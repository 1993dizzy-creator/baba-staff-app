import { NextResponse } from "next/server";
import { getAuthenticatedActor, requireRole } from "@/lib/auth/server-auth";
import {
  QUICK_REASON_VALUES,
  normalizeInventoryReason,
} from "@/lib/inventory/reasons";
import {
  fetchPreviousKegSessionSummariesByLogId,
  fetchPreviousKegSummariesByLogId,
} from "@/lib/inventory/keg-replacement-summary";
import { supabaseServer } from "@/lib/supabase/server";
import {
  inventoryLogDisplayUpdate,
  inventoryPurchaseLogCurrentItemSyncUpdate,
} from "@/lib/inventory/ledger-sync-contract";
import { projectInventoryPurchaseLogs } from "@/lib/ledger/inventory-projection";
import { resolveInventorySupplier } from "@/lib/inventory/supplier-partners-server";
import { insertInventoryPriceLog } from "@/lib/inventory/price-logs";

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const getErrorCauseMessage = (error: unknown) => {
  if (!error || typeof error !== "object" || !("cause" in error)) {
    return null;
  }

  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? cause.message : cause ? String(cause) : null;
};

const toNullableNumber = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

type CurrentInventoryItem = {
  item_name: string | null;
  item_name_vi: string | null;
  category: string | null;
  category_vi: string | null;
  unit: string | null;
  purchase_price: number | null;
  supplier: string | null;
  supplier_partner_id: number | null;
};

type InventoryLogsQueryOptions = {
  businessDate?: string | null;
  reason?: string | null;
  itemId?: number | null;
  includeKegSalesBreakdown?: boolean;
};

const loadInventoryLogs = async (options: InventoryLogsQueryOptions = {}) => {
  let query = supabaseServer
    .from("inventory_logs")
    .select("*")
    .order("created_at", { ascending: false });

  if (options.businessDate) {
    query = query.eq("business_date", options.businessDate);
  }

  if (options.reason) {
    query = query.eq("reason", normalizeInventoryReason(options.reason));
  }

  if (options.itemId) {
    query = query.eq("item_id", options.itemId);
  }

  const { data, error } = await query;
  if (error) {
    return {
      ok: false as const,
      error: "inventory_logs_query_failed",
      message: error.message,
    };
  }

  const logs = data || [];
  const kegReplaceLogIds = logs
    .filter((log) => log.source === "keg_replace")
    .map((log) => log.id);
  const previousKegSummaryByLogId = options.includeKegSalesBreakdown === false
    ? await fetchPreviousKegSessionSummariesByLogId(
        supabaseServer,
        kegReplaceLogIds
      )
    : await fetchPreviousKegSummariesByLogId(
        supabaseServer,
        kegReplaceLogIds
      );
  const enrichedLogs = logs.map((log) =>
    previousKegSummaryByLogId.has(log.id)
      ? { ...log, previousKegSummary: previousKegSummaryByLogId.get(log.id) }
      : log
  );

  return { ok: true as const, data: enrichedLogs };
};

const loadInventoryNotes = async () => {
  const { data, error } = await supabaseServer
    .from("inventory")
    .select("id, part, code, item_name, item_name_vi, note");

  if (error) {
    return {
      ok: false as const,
      error: "inventory_notes_query_failed",
      message: error.message,
    };
  }

  return { ok: true as const, data: data || [] };
};

const asPageResult = async <T,>(promise: Promise<T>) => {
  try {
    return await promise;
  } catch (error) {
    return {
      ok: false as const,
      error: "inventory_logs_fetch_failed",
      message: getErrorMessage(error),
    };
  }
};

const normalizeText = (value: unknown) =>
  String(value ?? "").replace(/\s+/g, " ").trim();

const buildInventoryLogSyncPayload = (
  currentItem: CurrentInventoryItem,
  syncPurchaseEconomics: boolean
): Record<string, string | number | null> => {
  return syncPurchaseEconomics
    ? inventoryPurchaseLogCurrentItemSyncUpdate(currentItem)
    : inventoryLogDisplayUpdate(currentItem);
};

const findLatestPurchaseLogId = async (itemId: number) => {
  const { data, error } = await supabaseServer
    .from("inventory_logs")
    .select("id")
    .eq("item_id", itemId)
    .eq("reason", "purchase")
    .gt("change_quantity", 0)
    .order("business_date", { ascending: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data?.id ? Number(data.id) : null;
};

export async function GET(req: Request) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const { searchParams } = new URL(req.url);
    const mode = searchParams.get("mode");
    const businessDate = searchParams.get("businessDate");
    const reason = searchParams.get("reason");
    const itemId = searchParams.get("itemId");

    if (mode === "page") {
      const [logsResult, notesResult] = await Promise.all([
        asPageResult(loadInventoryLogs({ includeKegSalesBreakdown: false })),
        asPageResult(loadInventoryNotes()),
      ]);

      return NextResponse.json({ ok: true, logsResult, notesResult });
    }

    if (mode === "logs") {
      let parsedItemId: number | null = null;
      if (itemId) {
        parsedItemId = Number(itemId);

        if (!Number.isFinite(parsedItemId) || parsedItemId <= 0) {
          return NextResponse.json(
            {
              ok: false,
              error: "invalid_item_id",
              message: "Invalid item id",
            },
            { status: 400 }
          );
        }

      }

      const result = await loadInventoryLogs({
        businessDate,
        reason,
        itemId: parsedItemId,
      });
      if (!result.ok) {
        return NextResponse.json(
          {
            ok: false,
            error: result.error,
            message: result.message,
          },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, data: result.data });
    }

    if (mode === "recent") {
      const { data, error } = await supabaseServer
        .from("inventory_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(3);

      if (error) {
        return NextResponse.json(
          {
            ok: false,
            error: "inventory_recent_logs_query_failed",
            message: error.message,
          },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, data: data || [] });
    }

    if (mode === "notes") {
      const result = await loadInventoryNotes();
      if (!result.ok) {
        return NextResponse.json(
          {
            ok: false,
            error: result.error,
            message: result.message,
          },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, data: result.data });
    }

    return NextResponse.json(
      { ok: false, error: "invalid_mode", message: "Invalid mode" },
      { status: 400 }
    );
  } catch (error) {
    console.error("[INVENTORY_LOGS_GET_ERROR]", {
      message: getErrorMessage(error),
      cause: getErrorCauseMessage(error),
      error,
    });

    return NextResponse.json(
      {
        ok: false,
        error: "inventory_logs_fetch_failed",
        message: getErrorMessage(error),
        cause: getErrorCauseMessage(error),
      },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const body = await req.json();
    const id = Number(body?.id);
    const logIds: number[] = Array.isArray(body?.logIds)
      ? Array.from(
          new Set(
            body.logIds
              .map((value: unknown) => Number(value))
              .filter((value: number) => Number.isFinite(value) && value > 0)
          )
        )
      : [];
    const syncCurrentItem = body?.syncCurrentItem === true;
    const targetLogIds = syncCurrentItem && logIds.length > 0 ? logIds : [id];
    const hasReason = Object.prototype.hasOwnProperty.call(body, "reason");
    const hasNewSupplier = Object.prototype.hasOwnProperty.call(body, "new_supplier");
    const hasNewPurchasePrice = Object.prototype.hasOwnProperty.call(
      body,
      "new_purchase_price"
    );

    if (targetLogIds.length === 0 || targetLogIds.some((logId) => !Number.isFinite(logId) || logId <= 0)) {
      return NextResponse.json(
        { ok: false, message: "Missing id" },
        { status: 400 }
      );
    }

    if (!syncCurrentItem && !hasReason && !hasNewSupplier && !hasNewPurchasePrice) {
      return NextResponse.json(
        { ok: false, message: "No update fields" },
        { status: 400 }
      );
    }

    const { data: existingRows, error: findError } = await supabaseServer
      .from("inventory_logs")
      .select("id, item_id, reason, source, change_quantity, business_date, new_purchase_price, item_name, code")
      .in("id", targetLogIds);

    if (findError) throw findError;

    if (!existingRows || existingRows.length !== targetLogIds.length) {
      return NextResponse.json(
        { ok: false, message: "Log not found" },
        { status: 404 }
      );
    }

    if (
      existingRows.some(
        (row) =>
          row.reason === "sale_deduction" || row.source === "pos_sales"
      )
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "protected_sales_inventory_log",
          message:
            "Sales inventory deduction logs can only be changed from the sales deduction flow.",
        },
        { status: 409 }
      );
    }

    const existing = existingRows[0];

    const updatePayload: Record<string, string | number | null> = {};
    let currentItem: CurrentInventoryItem | null = null;
    let latestPurchaseLogId: number | null = null;

    if (syncCurrentItem) {
      if (!existing.item_id) {
        return NextResponse.json(
          { ok: false, message: "Missing item id" },
          { status: 400 }
        );
      }

      const businessDate =
        typeof body?.businessDate === "string" ? body.businessDate : null;
      const invalidSyncTarget = existingRows.some((row) => {
        return (
          row.item_id !== existing.item_id ||
          (businessDate !== null && row.business_date !== businessDate)
        );
      });

      if (invalidSyncTarget) {
        return NextResponse.json(
          {
            ok: false,
            error: "invalid_sync_log_scope",
            message: "Invalid sync log scope",
          },
          { status: 400 }
        );
      }

      const { data, error: currentItemError } = await supabaseServer
        .from("inventory")
        .select(
          "item_name, item_name_vi, category, category_vi, unit, purchase_price, supplier, supplier_partner_id"
        )
        .eq("id", Number(existing.item_id))
        .maybeSingle();

      if (currentItemError) throw currentItemError;

      if (!data) {
        return NextResponse.json(
          { ok: false, message: "Item not found" },
          { status: 404 }
        );
      }

      currentItem = data;
      if (
        existingRows.some(
          (row) => normalizeInventoryReason(row.reason) === "purchase"
        )
      ) {
        latestPurchaseLogId = await findLatestPurchaseLogId(
          Number(existing.item_id)
        );
      }
    }

    if (hasReason) {
      const reason = normalizeInventoryReason(body?.reason);

      if (!QUICK_REASON_VALUES.includes(reason as (typeof QUICK_REASON_VALUES)[number])) {
        return NextResponse.json(
          { ok: false, message: "Invalid reason" },
          { status: 400 }
        );
      }

      updatePayload.reason = reason;
    }

    if (hasNewSupplier) {
      const supplier = normalizeText(body.new_supplier);
      const resolved = await resolveInventorySupplier({ supabase: supabaseServer,
        payload: { supplier: supplier || null }, actorUserId: auth.actor.id });
      updatePayload.new_supplier = resolved?.supplier ?? null;
      updatePayload.purchase_supplier_partner_id = resolved?.supplier_partner_id ?? null;
    }

    if (hasNewPurchasePrice) {
      const purchasePrice = toNullableNumber(body.new_purchase_price);

      if (
        body.new_purchase_price !== null &&
        body.new_purchase_price !== "" &&
        purchasePrice === null
      ) {
        return NextResponse.json(
          { ok: false, message: "Invalid purchase price" },
          { status: 400 }
        );
      }

      updatePayload.new_purchase_price = purchasePrice;
    }

    const updatedRowSelect =
      "id, item_id, item_name, item_name_vi, category, category_vi, new_category, new_category_vi, unit, new_unit, reason, business_date, change_quantity, new_supplier, new_purchase_price, purchase_supplier_partner_id";
    const updateLogRows = async (
      ids: number[],
      payload: Record<string, string | number | null>
    ) => {
      if (ids.length === 0) return [];

      const { data, error } = await supabaseServer
        .from("inventory_logs")
        .update(payload)
        .in("id", ids)
        .select(updatedRowSelect)
        .order("id", { ascending: true });

      if (error) throw error;
      return data || [];
    };

    let updatedRows;
    if (syncCurrentItem && currentItem) {
      const purchaseLogIds = existingRows
        .filter(
          (row) =>
            normalizeInventoryReason(row.reason) === "purchase" &&
            Number(row.id) === latestPurchaseLogId
        )
        .map((row) => Number(row.id));
      const displayOnlyLogIds = existingRows
        .filter(
          (row) => !purchaseLogIds.includes(Number(row.id))
        )
        .map((row) => Number(row.id));

      const [purchaseRows, displayOnlyRows] = await Promise.all([
        updateLogRows(purchaseLogIds, {
          ...buildInventoryLogSyncPayload(currentItem, true),
          ...updatePayload,
        }),
        updateLogRows(displayOnlyLogIds, {
          ...buildInventoryLogSyncPayload(currentItem, false),
          ...updatePayload,
        }),
      ]);
      updatedRows = [...purchaseRows, ...displayOnlyRows].sort(
        (left, right) => Number(left.id) - Number(right.id)
      );
    } else {
      updatedRows = await updateLogRows(targetLogIds, updatePayload);
    }

    const updatesPurchaseInfo = hasNewSupplier || hasNewPurchasePrice;
    const isPurchaseLog =
      normalizeInventoryReason(existing.reason) === "purchase" &&
      Number(existing.change_quantity ?? 0) > 0;

    if (!syncCurrentItem && updatesPurchaseInfo && isPurchaseLog && existing.item_id) {
      const latestPurchaseLogId = await findLatestPurchaseLogId(
        Number(existing.item_id)
      );

      if (latestPurchaseLogId === id) {
        const itemUpdatePayload: Record<string, string | number | null> = {};

        if (hasNewSupplier) {
          itemUpdatePayload.supplier = updatePayload.new_supplier;
          itemUpdatePayload.supplier_partner_id = updatePayload.purchase_supplier_partner_id;
        }

        if (hasNewPurchasePrice) {
          itemUpdatePayload.purchase_price = updatePayload.new_purchase_price;
        }

        if (Object.keys(itemUpdatePayload).length > 0) {
          const { error: itemUpdateError } = await supabaseServer
            .from("inventory")
            .update(itemUpdatePayload)
            .eq("id", Number(existing.item_id));

          if (itemUpdateError) throw itemUpdateError;
          if (hasNewPurchasePrice) {
            await insertInventoryPriceLog({ supabase: supabaseServer, itemId: existing.item_id,
              itemName: existing.item_name, itemCode: existing.code, oldPrice: existing.new_purchase_price,
              newPrice: updatePayload.new_purchase_price, businessDate: existing.business_date,
              source: "edit_form", reason: "manual_price_update", actorUsername: auth.actor.username });
          }
        }
      }
    }

    const purchaseSourceIds = existingRows.filter(row =>
      normalizeInventoryReason(row.reason) === "purchase" ||
      updatedRows.some(updated => updated.id === row.id && normalizeInventoryReason(updated.reason) === "purchase")
    ).map(row => Number(row.id));
    const ledgerSync = await projectInventoryPurchaseLogs(purchaseSourceIds, auth.actor.id);
    return NextResponse.json({
      ok: true,
      data: targetLogIds.length === 1 ? updatedRows[0] : updatedRows,
      ledgerSync,
    });
  } catch (error) {
    console.error("[INVENTORY_LOGS_PATCH_ERROR]", error);

    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = await requireRole(["master"]);
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const body = await req.json();
    const { logId } = body;

    if (!logId) {
      return NextResponse.json(
        { ok: false, message: "Missing logId" },
        { status: 400 }
      );
    }

    const { data: existingLog, error: findError } = await supabaseServer
      .from("inventory_logs")
      .select("id, reason, source")
      .eq("id", Number(logId))
      .maybeSingle();

    if (findError) throw findError;
    if (!existingLog) {
      return NextResponse.json(
        { ok: false, message: "Log not found" },
        { status: 404 }
      );
    }
    if (
      existingLog.reason === "sale_deduction" ||
      existingLog.source === "pos_sales"
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "protected_sales_inventory_log",
          message:
            "Sales inventory deduction logs cannot be deleted from inventory.",
        },
        { status: 409 }
      );
    }

    const { error } = await supabaseServer
      .from("inventory_logs")
      .delete()
      .eq("id", Number(logId));

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[INVENTORY_LOGS_DELETE_ERROR]", error);

    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}
