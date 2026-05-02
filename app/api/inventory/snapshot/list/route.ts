import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: batches, error: batchError } = await supabase
      .from("inventory_snapshot_batches")
      .select("id, snapshot_date, created_at, note")
      .order("snapshot_date", { ascending: false });

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
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}