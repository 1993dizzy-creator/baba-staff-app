import { analyzeDailyEffectivePurchases, type DailyPurchaseDiagnostic } from "@/lib/inventory/daily-effective-purchases";
import { NextResponse } from "next/server";
import { getAuthenticatedActor, requireRole } from "@/lib/auth/server-auth";
import {
  QUICK_REASON_VALUES,
  inventoryReasonChangeIssue,
  inventoryPurchaseErrorMessage,
  normalizeInventoryReason,
} from "@/lib/inventory/reasons";
import {
  fetchPreviousKegSessionSummariesByLogId,
  fetchPreviousKegSummariesByLogId,
} from "@/lib/inventory/keg-replacement-summary";
import { supabaseServer } from "@/lib/supabase/server";
import {
  syncInventoryLogRowsFromItem,
  updateInventoryLogRows,
  type InventoryLogSyncItem,
} from "@/lib/inventory/log-sync-server";
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

type InventoryLogsQueryOptions = {
  businessDate?: string | null;
  reason?: string | null;
  itemId?: number | null;
  includeKegSalesBreakdown?: boolean;
  effectivePurchases?: boolean;
};

// Fields used by the log cards, localized search and change history.
const LOG_CARD_COLUMNS = [
  "id", "item_id", "item_name", "item_name_vi", "category", "category_vi",
  "part", "code", "unit", "action", "reason", "source", "created_at", "actor_name",
  "change_quantity", "business_date", "correction_of_inventory_log_id", "billed_amount", "billed_amount_mode",
  ...["quantity", "purchase_price", "note", "supplier", "code", "unit", "category",
    "category_vi", "part", "low_stock_threshold"].flatMap((field) => [`prev_${field}`, `new_${field}`]),
].join(", ");
const LOG_PAGE_SIZE = 500;
type InventoryLogQueryRow = {
  id: number;
  created_at: string | null;
  source?: string;
  [key: string]: unknown;
};

const loadInventoryLogs = async (options: InventoryLogsQueryOptions = {}) => {
  const logs: InventoryLogQueryRow[] = [];
  let purchaseDiagnostics: Array<DailyPurchaseDiagnostic & { projectionStatuses?: Array<{inventory_log_id:number;status:string;code:string}>; projectionStatusUnavailable?:boolean }> = [];
  let cursor: { id: number; created_at: string | null } | undefined;
  for (;;) {
    let query = supabaseServer
      .from("inventory_logs")
      // Snapshot consumers retain their existing projection.
      .select(options.includeKegSalesBreakdown === false ? LOG_CARD_COLUMNS : "*")
      .order("created_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: false })
      .limit(LOG_PAGE_SIZE);

    if (cursor) {
      query = cursor.created_at === null
        ? query.is("created_at", null).lt("id", cursor.id)
        : query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id}),created_at.is.null`);
    }

    if (options.businessDate) {
      query = query.eq("business_date", options.businessDate);
    }

    if (options.reason) {
      query = query.eq("reason", normalizeInventoryReason(options.reason));
    }

    if (options.itemId) {
      query = query.eq("item_id", options.itemId);
    }

    const { data, error } = await query.returns<InventoryLogQueryRow[]>();
    if (error) {
      return {
        ok: false as const,
        error: "inventory_logs_query_failed",
        message: error.message,
      };
    }

    const page = data || [];
    logs.push(...page);
    if (page.length < LOG_PAGE_SIZE) break;
    const last = page[page.length - 1];
    cursor = { id: Number(last.id), created_at: last.created_at ?? null };
  }
  if (options.businessDate && options.effectivePurchases) {
    const roots = logs.filter(row => row.reason === "purchase" && Number(row.change_quantity) > 0 && row.correction_of_inventory_log_id == null);
    const corrections: InventoryLogQueryRow[] = [];
    for (let start = 0; start < roots.length; start += 100) {
      const ids = roots.slice(start, start + 100).map(row => row.id);
      for (let offset = 0; ; offset += LOG_PAGE_SIZE) {
        const result = await supabaseServer.from("inventory_logs").select("*")
          .in("correction_of_inventory_log_id", ids).order("id", { ascending: true }).range(offset, offset + LOG_PAGE_SIZE - 1);
        if (result.error) return { ok: false as const, error: "inventory_logs_query_failed", message: result.error.message };
        corrections.push(...(result.data ?? []));
        if ((result.data ?? []).length < LOG_PAGE_SIZE) break;
      }
    }
    const analysis = analyzeDailyEffectivePurchases(logs, corrections);
    purchaseDiagnostics = analysis.diagnostics;
    // Status reads never re-project or repair historical data. Failure remains explicit.
    const ids = [...new Set(purchaseDiagnostics.flatMap(row => row.logIds))];
    const statuses: Array<{inventory_log_id:number;status:string;code:string}> = [];
    let statusUnavailable = false;
    for (let offset=0;offset<ids.length;offset+=100) {
      try {
        const result = await supabaseServer.from("ledger_inventory_projection_status").select("inventory_log_id,status,code").in("inventory_log_id",ids.slice(offset,offset+100));
        if(result.error) { statusUnavailable=true; continue; }
        statuses.push(...(result.data??[]));
      } catch { statusUnavailable=true; }
    }
    purchaseDiagnostics = purchaseDiagnostics.map(row => ({...row,projectionStatusUnavailable:statusUnavailable,
      projectionStatuses:statuses.filter(status=>row.logIds.includes(Number(status.inventory_log_id)))}));
    logs.splice(0, logs.length, ...analysis.purchases);
  }
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

  return { ok: true as const, data: enrichedLogs, ...(options.effectivePurchases ? {purchaseDiagnostics} : {}) };
};

const loadInventoryNotes = async () => {
  const notes = [];
  let afterId: number | undefined;
  for (;;) {
    let query = supabaseServer
      .from("inventory")
      .select("id, part, code, item_name, item_name_vi, note")
      .order("id", { ascending: true })
      .limit(LOG_PAGE_SIZE);
    if (afterId !== undefined) query = query.gt("id", afterId);
    const { data, error } = await query;

    if (error) {
      return {
        ok: false as const,
        error: "inventory_notes_query_failed",
        message: error.message,
      };
    }

    const page = data || [];
    notes.push(...page);
    if (page.length < LOG_PAGE_SIZE) break;
    afterId = Number(page[page.length - 1].id);
  }
  return { ok: true as const, data: notes };
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
        effectivePurchases: searchParams.get("effectivePurchases") === "true",
        includeKegSalesBreakdown: searchParams.get("view") === "cards" ? false : undefined,
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

      return NextResponse.json({ ok: true, data: result.data, ...("purchaseDiagnostics" in result ? {purchaseDiagnostics:result.purchaseDiagnostics} : {}) });
    }

    if (mode === "recent") {
      const { data, error } = await supabaseServer
        .from("inventory_logs")
        .select(LOG_CARD_COLUMNS)
        .order("created_at", { ascending: false, nullsFirst: false })
        .order("id", { ascending: false })
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
      .select("id, item_id, reason, source, change_quantity, correction_of_inventory_log_id, business_date, new_purchase_price, item_name, code")
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

    // Reject before supplier resolution, source writes, or Ledger projection. This
    // endpoint cannot atomically reverse/rebook a purchase while changing its label.
    if (hasReason) {
      const nextReason = normalizeInventoryReason(body.reason);
      if (!QUICK_REASON_VALUES.includes(nextReason as (typeof QUICK_REASON_VALUES)[number])) return NextResponse.json({ok:false,message:"Invalid reason"},{status:400});
      const issue = existingRows.map(row=>inventoryReasonChangeIssue(row,nextReason)).find(Boolean);
      if(issue) return NextResponse.json({ok:false,error:issue,message:inventoryPurchaseErrorMessage(issue,"ko")},{status:409});
    }
    const existing = existingRows[0];

    // A receipt edited through 입고 수정 is booked by its linked edit logs. Its price and
    // supplier are changed only there; a log edit or item sync must not overwrite them.
    const receiptEditQueries = await Promise.all(["id", "correction_of_inventory_log_id"].map(column =>
      supabaseServer.from("inventory_logs").select("id, action, correction_of_inventory_log_id")
        .eq("action", "receipt_edit").in(column, targetLogIds)));
    const receiptEditError = receiptEditQueries.find(result => result.error)?.error;
    if (receiptEditError) throw receiptEditError;
    // A receipt registered with a manual 실청구금액 is protected the same way: its amount is
    // kept by 입고 수정 logs, never by rewriting the receipt row (the DB also refuses it).
    const { data: manualBilledRows, error: manualBilledError } = await supabaseServer.from("inventory_logs")
      .select("id, billed_amount_mode").eq("billed_amount_mode", "manual").in("id", targetLogIds);
    if (manualBilledError) throw manualBilledError;
    const receiptEditedIds = new Set(receiptEditQueries.flatMap(result => result.data ?? [])
      .filter(row => row.action === "receipt_edit")
      .flatMap(row => [Number(row.id), Number(row.correction_of_inventory_log_id)])
      .concat((manualBilledRows ?? []).filter(row => row.billed_amount_mode === "manual").map(row => Number(row.id)))
      .filter(logId => targetLogIds.includes(logId)));
    if (receiptEditedIds.size > 0 && (hasNewSupplier || hasNewPurchasePrice)) {
      return NextResponse.json({ ok: false, error: "inventory_receipt_edit_protected",
        message: inventoryPurchaseErrorMessage("inventory_receipt_edit_protected", "ko") }, { status: 409 });
    }

    const updatePayload: Record<string, string | number | null> = {};
    let currentItem: InventoryLogSyncItem | null = null;
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
          "item_name, item_name_vi, part, category, category_vi, code, unit, purchase_price, supplier, supplier_partner_id"
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

    let updatedRows;
    if (syncCurrentItem && currentItem) {
      const purchaseLogIds = existingRows
        .filter(
          (row) =>
            normalizeInventoryReason(row.reason) === "purchase" &&
            Number(row.id) === latestPurchaseLogId &&
            !receiptEditedIds.has(Number(row.id))
        )
        .map((row) => Number(row.id));
      const displayOnlyLogIds = existingRows
        .filter(
          (row) => !purchaseLogIds.includes(Number(row.id))
        )
        .map((row) => Number(row.id));

      updatedRows = await syncInventoryLogRowsFromItem({
        supabase: supabaseServer,
        item: currentItem,
        purchaseLogIds,
        displayOnlyLogIds,
        overlay: updatePayload,
      });
    } else {
      updatedRows = await updateInventoryLogRows(
        supabaseServer,
        targetLogIds,
        updatePayload
      );
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
