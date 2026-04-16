import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getSnapshotDate() {
    const now = new Date();

    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);

    const year = Number(parts.find((p) => p.type === "year")?.value);
    const month = Number(parts.find((p) => p.type === "month")?.value);
    const day = Number(parts.find((p) => p.type === "day")?.value);

    const date = new Date(Date.UTC(year, month - 1, day));
    date.setUTCDate(date.getUTCDate() - 1);

    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd}`;
}

export async function GET(request: Request) {
    try {
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

        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );

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
                "id, item_name, item_name_vi, quantity, unit, purchase_price, part, category, category_vi, code, low_stock_threshold"
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

        const snapshotRows = (inventoryItems ?? []).map((item) => ({
            batch_id: batchId,
            item_id: item.id,
            item_name: item.item_name ?? "",
            item_name_vi: item.item_name_vi ?? "",
            part: item.part ?? "",
            category: item.category ?? "",
            category_vi: item.category_vi ?? "",
            code: item.code ?? "",
            unit: item.unit ?? "",
            quantity: item.quantity ?? 0,
            purchase_price: item.purchase_price,
            low_stock_threshold: item.low_stock_threshold ?? 0,
        }));

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
            insertedCount: insertedItems?.length ?? 0,
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