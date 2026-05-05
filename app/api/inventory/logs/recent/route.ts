import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from("inventory_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(3);

    if (error) throw error;

    return NextResponse.json({ ok: true, data: data || [] });
  } catch (error: any) {
    console.error("[INVENTORY_LOGS_RECENT_GET_ERROR]", error);

    return NextResponse.json(
      { ok: false, message: error?.message || "Server error" },
      { status: 500 }
    );
  }
}