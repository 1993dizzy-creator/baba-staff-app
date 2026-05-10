import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { toNumber, roundDecimal } from "@/lib/inventory/number";
import { getSnapshotDate } from "@/lib/inventory/business-day";

const formatSnapshotDisplayDate = (value: string) => {
  const d = new Date(value);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}.${mm}.${dd}`;
};

const createSupabaseAdmin = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

async function getLatestSnapshotResponse() {
  const supabase = createSupabaseAdmin();

  const { data: latestBatch, error: batchError } = await supabase
    .from("inventory_snapshot_batches")
    .select("id, snapshot_date")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (batchError) throw batchError;

  if (!latestBatch) {
    return NextResponse.json({
      ok: true,
      data: {
        snapshotMap: {},
        snapshotDate: "",
      },
    });
  }

  const { data: items, error: itemsError } = await supabase
    .from("inventory_snapshot_items")
    .select("item_id, quantity")
    .eq("batch_id", latestBatch.id);

  if (itemsError) throw itemsError;

  const snapshotMap: Record<number, number> = {};

  (items || []).forEach((item) => {
    if (item.item_id !== null && item.item_id !== undefined) {
      snapshotMap[Number(item.item_id)] = Number(item.quantity ?? 0);
    }
  });

  return NextResponse.json({
    ok: true,
    data: {
      snapshotMap,
      snapshotDate: latestBatch.snapshot_date
        ? formatSnapshotDisplayDate(latestBatch.snapshot_date)
        : "",
    },
  });
}

async function getSnapshotListResponse() {
  const supabase = createSupabaseAdmin();

  const { data: batches, error: batchError } = await supabase
    .from("inventory_snapshot_batches")
    .select("id, snapshot_date, created_at, note")
    .order("id", { ascending: false });

  if (batchError) {
    return NextResponse.json(
      { ok: false, message: batchError.message },
      { status: 500 }
    );
  }

  const { data: purchaseRows, error: purchaseError } = await supabase
    .from("inventory_snapshot_items")
    .select("batch_id")
    .gt("change_quantity", 0);

  if (purchaseError) {
    return NextResponse.json(
      { ok: false, message: purchaseError.message },
      { status: 500 }
    );
  }

  const purchaseBatchMap: Record<number, boolean> = {};

  (purchaseRows || []).forEach((row) => {
    if (row.batch_id !== null && row.batch_id !== undefined) {
      purchaseBatchMap[Number(row.batch_id)] = true;
    }
  });

  return NextResponse.json({
    ok: true,
    batches: batches ?? [],
    purchaseBatchMap,
  });
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("mode");

    if (mode === "latest") {
      return await getLatestSnapshotResponse();
    }

    if (mode === "list") {
      return await getSnapshotListResponse();
    }

    const authHeader = request.headers.get("authorization");
    const userAgent = request.headers.get("user-agent") || "";
    const isCron = userAgent.includes("vercel-cron");
    const expected = `Bearer ${process.env.CRON_SECRET}`;

    if (!isCron && authHeader !== expected) {
      return NextResponse.json(
        { ok: false, step: "unauthorized", message: "Unauthorized" },
        { status: 401 }
      );
    }

    const supabase = createSupabaseAdmin();

    const snapshotDate = getSnapshotDate();

    const { data: existingBatch, error: existingBatchError } = await supabase
      .from("inventory_snapshot_batches")
      .select("id, snapshot_date")
      .eq("snapshot_date", snapshotDate)
      .maybeSingle();

    if (existingBatchError) {
      return NextResponse.json(
        {
          ok: false,
          step: "existing-batch-query-failed",
          snapshotDate,
          error: existingBatchError.message,
        },
        { status: 500 }
      );
    }

    if (existingBatch) {
      return NextResponse.json({
        ok: true,
        step: "batch-already-exists",
        snapshotDate,
        batchId: existingBatch.id,
        message: "Snapshot already created for this date",
      });
    }

    const { data: prevBatch, error: prevBatchError } = await supabase
      .from("inventory_snapshot_batches")
      .select("id, snapshot_date")
      .lt("snapshot_date", snapshotDate)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (prevBatchError) {
      return NextResponse.json(
        {
          ok: false,
          step: "prev-batch-query-failed",
          snapshotDate,
          error: prevBatchError.message,
        },
        { status: 500 }
      );
    }

    const prevQuantityMap = new Map<number, number>();

    if (prevBatch?.id) {
      const { data: prevItems, error: prevItemsError } = await supabase
        .from("inventory_snapshot_items")
        .select("item_id, quantity")
        .eq("batch_id", prevBatch.id);

      if (prevItemsError) {
        return NextResponse.json(
          {
            ok: false,
            step: "prev-items-query-failed",
            snapshotDate,
            prevBatchId: prevBatch.id,
            error: prevItemsError.message,
          },
          { status: 500 }
        );
      }

      for (const item of prevItems ?? []) {
        if (item.item_id != null) {
          prevQuantityMap.set(Number(item.item_id), toNumber(item.quantity));
        }
      }
    }

    const { data: createdBatch, error: createBatchError } = await supabase
      .from("inventory_snapshot_batches")
      .insert({
        snapshot_date: snapshotDate,
        note: "daily auto snapshot",
      })
      .select("id, snapshot_date, created_at")
      .single();

    if (createBatchError || !createdBatch) {
      return NextResponse.json(
        {
          ok: false,
          step: "batch-insert-failed",
          snapshotDate,
          error: createBatchError?.message ?? "Batch insert failed",
        },
        { status: 500 }
      );
    }

    const batchId = createdBatch.id;

    const { data: inventoryItems, error: inventoryError } = await supabase
      .from("inventory")
      .select(
        "id, item_name, item_name_vi, quantity, unit, purchase_price, supplier, part, category, category_vi, code, low_stock_threshold"
      )
      .order("updated_at", { ascending: false });

    if (inventoryError) {
      return NextResponse.json(
        {
          ok: false,
          step: "inventory-query-failed",
          snapshotDate,
          batchId,
          error: inventoryError.message,
        },
        { status: 500 }
      );
    }

    const snapshotRows = (inventoryItems ?? []).map((item) => {
      const currentQuantity = toNumber(item.quantity);
      const prevQuantity = prevQuantityMap.has(Number(item.id))
        ? prevQuantityMap.get(Number(item.id))!
        : null;

      const changeQuantity =
        prevQuantity === null
          ? null
          : roundDecimal(currentQuantity - prevQuantity);

      const purchasePrice =
        item.purchase_price === null || item.purchase_price === undefined
          ? null
          : toNumber(item.purchase_price);

      const totalPurchasePrice =
        changeQuantity !== null && changeQuantity > 0 && purchasePrice !== null
          ? roundDecimal(changeQuantity * purchasePrice)
          : null;

      return {
        batch_id: batchId,
        item_id: item.id,

        item_name: item.item_name ?? "",
        item_name_vi: item.item_name_vi ?? "",

        part: item.part ?? "",
        category: item.category ?? "",
        category_vi: item.category_vi ?? "",
        code: item.code ?? "",
        unit: item.unit ?? "",

        quantity: currentQuantity,
        prev_quantity: prevQuantity,
        change_quantity: changeQuantity,

        purchase_price: purchasePrice,
        supplier: item.supplier ?? "",
        total_purchase_price: totalPurchasePrice,

        low_stock_threshold: item.low_stock_threshold ?? 1,
      };
    });

    if (snapshotRows.length === 0) {
      return NextResponse.json({
        ok: true,
        step: "no-inventory-items",
        snapshotDate,
        batchId,
        insertedCount: 0,
      });
    }

    const { data: insertedItems, error: snapshotItemsError } = await supabase
      .from("inventory_snapshot_items")
      .insert(snapshotRows)
      .select("id");

    if (snapshotItemsError) {
      return NextResponse.json(
        {
          ok: false,
          step: "snapshot-items-insert-failed",
          snapshotDate,
          batchId,
          rowCount: snapshotRows.length,
          error: snapshotItemsError.message,
          sampleRow: snapshotRows[0] ?? null,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      step: "snapshot-complete",
      snapshotDate,
      batchId,
      prevBatchId: prevBatch?.id ?? null,
      prevSnapshotDate: prevBatch?.snapshot_date ?? null,
      insertedCount: insertedItems?.length ?? 0,
      increasedCount: snapshotRows.filter(
        (row) => row.change_quantity !== null && row.change_quantity > 0
      ).length,
      now: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        step: "top-level-catch",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
