import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  try {
    const { data: latestBatch, error: batchError } = await supabaseAdmin
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

    const { data: items, error: itemsError } = await supabaseAdmin
      .from("inventory_snapshot_items")
      .select("item_id, quantity")
      .eq("batch_id", latestBatch.id);

    if (itemsError) throw itemsError;

    const snapshotMap: Record<number, number> = {};

    const formatDate = (value: string) => {
      const d = new Date(value);
      const yy = String(d.getFullYear()).slice(2);
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yy}.${mm}.${dd}`;
    };

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
          ? formatDate(latestBatch.snapshot_date)
          : "",
      },
    });
  } catch (error: any) {
    console.error("[INVENTORY_SNAPSHOT_LATEST_GET_ERROR]", error);

    return NextResponse.json(
      { ok: false, message: error?.message || "Server error" },
      { status: 500 }
    );
  }
}