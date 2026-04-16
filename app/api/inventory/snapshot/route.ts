import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

function getVietnamDateParts(date = new Date()) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });

    const parts = formatter.formatToParts(date);

    const year = parts.find((part) => part.type === "year")?.value ?? "";
    const month = parts.find((part) => part.type === "month")?.value ?? "";
    const day = parts.find((part) => part.type === "day")?.value ?? "";

    return { year, month, day };
}

function getSnapshotDate() {
    console.log("snapshotDate:", snapshotDate);
    console.log("server now:", new Date().toISOString());
    const now = new Date();

    // 베트남 기준 현재 시간
    const vietnamNow = new Date(
        now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" })
    );

    // 하루 빼기
    vietnamNow.setDate(vietnamNow.getDate() - 1);

    const yyyy = vietnamNow.getFullYear();
    const mm = String(vietnamNow.getMonth() + 1).padStart(2, "0");
    const dd = String(vietnamNow.getDate()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd}`;
}

export async function GET(request: Request) {

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

    try {
        const authHeader = request.headers.get("authorization");
        const userAgent = request.headers.get("user-agent") || "";

        const isCron = userAgent.includes("vercel-cron");

        const expected = `Bearer ${process.env.CRON_SECRET}`;

        if (!isCron && authHeader !== expected) {
            return NextResponse.json(
                { ok: false, message: "Unauthorized" },
                { status: 401 }
            );
        }

        const snapshotDate = getSnapshotDate();
        // 이하 기존 코드 그대로

        // 1) 같은 날짜 스냅샷이 이미 있는지 확인
        const { data: existingBatch, error: existingBatchError } = await supabase
            .from("inventory_snapshot_batches")
            .select("id, snapshot_date")
            .eq("snapshot_date", snapshotDate)
            .maybeSingle();

        if (existingBatchError) {
            console.error("existingBatchError", existingBatchError);
            return NextResponse.json(
                {
                    ok: false,
                    step: "check_existing_batch",
                    message: existingBatchError.message,
                },
                { status: 500 }
            );
        }

        if (existingBatch) {
            console.log("SKIPPED - already exists:", snapshotDate);
            return NextResponse.json({
                ok: true,
                skipped: true,
                message: "Snapshot already exists for this snapshot_date.",
                snapshot_date: snapshotDate,
                batch_id: existingBatch.id,
            });
        }

        // 2) 현재 inventory 전체 조회
        const { data: inventoryRows, error: inventoryError } = await supabase
            .from("inventory")
            .select(`
                id,
                item_name,
                item_name_vi,
                part,
                category,
                category_vi,
                code,
                unit,
                quantity,
                purchase_price,
                low_stock_threshold
            `)
            .order("id", { ascending: true });

        if (inventoryError) {
            console.error("inventoryError", inventoryError);
            return NextResponse.json(
                {
                    ok: false,
                    step: "fetch_inventory",
                    message: inventoryError.message,
                },
                { status: 500 }
            );
        }

        // 3) batch 생성
        const { data: batchRow, error: batchInsertError } = await supabase
            .from("inventory_snapshot_batches")
            .insert([
                {
                    snapshot_date: snapshotDate,
                    snapshot_at: new Date().toISOString(),
                },
            ])
            .select("id, snapshot_date")
            .single();

        if (batchInsertError || !batchRow) {
            console.error("batchInsertError", batchInsertError);
            return NextResponse.json(
                {
                    ok: false,
                    step: "insert_batch",
                    message: batchInsertError?.message || "Batch insert failed",
                },
                { status: 500 }
            );
        }

        // 4) item bulk insert
        const snapshotItems =
            (inventoryRows || []).map((item) => ({
                batch_id: batchRow.id,
                item_id: item.id,
                item_name: item.item_name ?? null,
                item_name_vi: item.item_name_vi ?? null,
                part: item.part,
                category: item.category ?? null,
                category_vi: item.category_vi ?? null,
                code: item.code ?? null,
                unit: item.unit,
                quantity: item.quantity ?? 0,
                purchase_price: item.purchase_price ?? null,
                low_stock_threshold: item.low_stock_threshold ?? null,
            })) ?? [];

        if (snapshotItems.length > 0) {
            const { error: itemsInsertError } = await supabase
                .from("inventory_snapshot_items")
                .insert(snapshotItems);

            if (itemsInsertError) {
                console.error("itemsInsertError", itemsInsertError);

                // batch까지 생성됐는데 item insert 실패하면 batch도 정리
                await supabase
                    .from("inventory_snapshot_batches")
                    .delete()
                    .eq("id", batchRow.id);

                return NextResponse.json(
                    {
                        ok: false,
                        step: "insert_snapshot_items",
                        message: itemsInsertError.message,
                    },
                    { status: 500 }
                );
            }
        }

        return NextResponse.json({
            ok: true,
            skipped: false,
            message: "Snapshot created successfully.",
            snapshot_date: snapshotDate,
            batch_id: batchRow.id,
            item_count: snapshotItems.length,
        });
    } catch (error) {
        console.error("snapshot route unexpected error", error);

        return NextResponse.json(
            {
                ok: false,
                step: "unexpected",
                message: error instanceof Error ? error.message : "Unknown error",
            },
            { status: 500 }
        );
    }
}