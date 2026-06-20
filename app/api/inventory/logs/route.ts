import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  QUICK_REASON_VALUES,
  normalizeInventoryReason,
} from "@/lib/inventory/reasons";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const getActor = async (actorUsername?: string) => {
  if (!actorUsername) return null;

  const { data } = await supabaseAdmin
    .from("users")
    .select("id, username, name, role, is_active")
    .eq("username", actorUsername)
    .eq("is_active", true)
    .maybeSingle();

  return data;
};

type Actor = {
  role?: string | null;
};

const isMaster = (user: Actor | null) => user?.role === "master";

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
  supplier: string | null;
  purchase_price: string | number | null;
};

const normalizeText = (value: unknown) =>
  String(value ?? "").replace(/\s+/g, " ").trim();

const buildInventoryLogSyncPayload = (
  currentItem: CurrentInventoryItem
): Record<string, string | number | null> => {
  const supplier = normalizeText(currentItem.supplier);

  return {
    item_name: currentItem.item_name ?? null,
    item_name_vi: currentItem.item_name_vi ?? null,

    category: currentItem.category ?? null,
    category_vi: currentItem.category_vi ?? null,
    new_category: currentItem.category ?? null,
    new_category_vi: currentItem.category_vi ?? null,

    unit: currentItem.unit ?? null,
    new_unit: currentItem.unit ?? null,

    new_supplier: supplier || null,
    new_purchase_price: toNullableNumber(currentItem.purchase_price),
  };
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode");
  const businessDate = searchParams.get("businessDate");
  const reason = searchParams.get("reason");
  const itemId = searchParams.get("itemId");

  try {
    if (mode === "logs") {
      let query = supabaseAdmin
        .from("inventory_logs")
        .select("*")
        .order("created_at", { ascending: false });

      if (businessDate) {
        query = query.eq("business_date", businessDate);
      }

      if (reason) {
        query = query.eq("reason", normalizeInventoryReason(reason));
      }

      if (itemId) {
        const parsedItemId = Number(itemId);

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

        query = query.eq("item_id", parsedItemId);
      }

      const { data, error } = await query;

      if (error) {
        return NextResponse.json(
          {
            ok: false,
            error: "inventory_logs_query_failed",
            message: error.message,
          },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, data: data || [] });
    }

    if (mode === "recent") {
      const { data, error } = await supabaseAdmin
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
      const { data, error } = await supabaseAdmin
        .from("inventory")
        .select("id, part, code, item_name, item_name_vi, note");

      if (error) {
        return NextResponse.json(
          {
            ok: false,
            error: "inventory_notes_query_failed",
            message: error.message,
          },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, data: data || [] });
    }

    return NextResponse.json(
      { ok: false, error: "invalid_mode", message: "Invalid mode" },
      { status: 400 }
    );
  } catch (error) {
    console.error("[INVENTORY_LOGS_GET_ERROR]", {
      mode,
      businessDate,
      reason,
      itemId,
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

    const { data: existingRows, error: findError } = await supabaseAdmin
      .from("inventory_logs")
      .select("id, item_id, reason, source, change_quantity, business_date")
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

      const { data: currentItem, error: currentItemError } = await supabaseAdmin
        .from("inventory")
        .select("item_name, item_name_vi, category, category_vi, unit, supplier, purchase_price")
        .eq("id", Number(existing.item_id))
        .maybeSingle();

      if (currentItemError) throw currentItemError;

      if (!currentItem) {
        return NextResponse.json(
          { ok: false, message: "Item not found" },
          { status: 404 }
        );
      }

      Object.assign(updatePayload, buildInventoryLogSyncPayload(currentItem));
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
      updatePayload.new_supplier = supplier || null;
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

    const { data, error } = await supabaseAdmin
      .from("inventory_logs")
      .update(updatePayload)
      .in("id", targetLogIds)
      .select("id, item_id, item_name, item_name_vi, category, category_vi, new_category, new_category_vi, unit, new_unit, reason, business_date, change_quantity, new_supplier, new_purchase_price")
      .order("id", { ascending: true });

    if (error) throw error;
    const updatedRows = data || [];

    const updatesPurchaseInfo = hasNewSupplier || hasNewPurchasePrice;
    const isPurchaseLog =
      normalizeInventoryReason(existing.reason) === "purchase" &&
      Number(existing.change_quantity ?? 0) > 0;

    if (!syncCurrentItem && updatesPurchaseInfo && isPurchaseLog && existing.item_id) {
      const { data: latestPurchaseLog, error: latestError } = await supabaseAdmin
        .from("inventory_logs")
        .select("id")
        .eq("item_id", Number(existing.item_id))
        .eq("reason", "purchase")
        .gt("change_quantity", 0)
        .order("business_date", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestError) throw latestError;

      if (latestPurchaseLog?.id === id) {
        const itemUpdatePayload: Record<string, string | number | null> = {};

        if (hasNewSupplier) {
          itemUpdatePayload.supplier = updatePayload.new_supplier;
        }

        if (hasNewPurchasePrice) {
          itemUpdatePayload.purchase_price = updatePayload.new_purchase_price;
        }

        if (Object.keys(itemUpdatePayload).length > 0) {
          const { error: itemUpdateError } = await supabaseAdmin
            .from("inventory")
            .update(itemUpdatePayload)
            .eq("id", Number(existing.item_id));

          if (itemUpdateError) throw itemUpdateError;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      data: targetLogIds.length === 1 ? updatedRows[0] : updatedRows,
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
    const body = await req.json();
    const { logId, actorUsername } = body;

    if (!logId) {
      return NextResponse.json(
        { ok: false, message: "Missing logId" },
        { status: 400 }
      );
    }

    const actor = await getActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, message: "Invalid user" },
        { status: 401 }
      );
    }

    if (!isMaster(actor)) {
      return NextResponse.json(
        { ok: false, message: "No permission" },
        { status: 403 }
      );
    }

    const { data: existingLog, error: findError } = await supabaseAdmin
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

    const { error } = await supabaseAdmin
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
