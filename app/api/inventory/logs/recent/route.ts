import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET() {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const { data, error } = await supabaseServer
      .from("inventory_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(3);

    if (error) throw error;

    return NextResponse.json({ ok: true, data: data || [] });
  } catch (error) {
    console.error("[INVENTORY_LOGS_RECENT_GET_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "Server error",
      },
      { status: 500 }
    );
  }
}
