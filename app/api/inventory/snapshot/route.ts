import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

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
    const now = new Date();

    // 베트남 시간 기준 "오늘 날짜"
    const { year, month, day } = getVietnamDateParts(now);

    // 베트남 기준 오늘 00:00으로 만든 뒤 하루 빼서 전 영업일 계산
    const vietnamToday = new Date(`${year}-${month}-${day}T00:00:00+07:00`);
    vietnamToday.setDate(vietnamToday.getDate() - 1);

    const snapshotYear = vietnamToday.getFullYear();
    const snapshotMonth = String(vietnamToday.getMonth() + 1).padStart(2, "0");
    const snapshotDay = String(vietnamToday.getDate()).padStart(2, "0");

    return `${snapshotYear}-${snapshotMonth}-${snapshotDay}`;
}

export async function GET(request: Request) {
    try {
        const authHeader = request.headers.get("authorization");
        const expected = `Bearer ${process.env.CRON_SECRET}`;

        if (authHeader !== expected) {
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