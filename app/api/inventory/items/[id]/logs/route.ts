import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const itemId = Number(params.id);

    if (!Number.isFinite(itemId)) {
      return NextResponse.json(
        { ok: false, message: "Invalid item id" },
        { status: 400 }
      );
    }

    const { data, error } = await supabaseAdmin
      .from("inventory_logs")
      .select("*")
      .eq("item_id", itemId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    return NextResponse.json({
      ok: true,
      data: data || [],
    });
  } catch (error: any) {
    console.error("[INVENTORY_ITEM_LOGS_GET_ERROR]", error);

    return NextResponse.json(
      { ok: false, message: error?.message || "Server error" },
      { status: 500 }
    );
  }
}