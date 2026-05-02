import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const batchId = Number(id);

    if (!Number.isFinite(batchId)) {
      return NextResponse.json(
        { ok: false, message: "Invalid batch id" },
        { status: 400 }
      );
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data, error } = await supabase
      .from("inventory_snapshot_items")
      .select(`
        id,
        batch_id,
        item_id,
        item_name,
        item_name_vi,
        part,
        category,
        category_vi,
        quantity,
        prev_quantity,
        change_quantity,
        unit,
        code,
        purchase_price,
        supplier,
        total_purchase_price
      `)
      .eq("batch_id", batchId)
      .order("code", { ascending: true });

    if (error) {
      return NextResponse.json(
        { ok: false, message: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      items: data ?? [],
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