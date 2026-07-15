import { NextRequest, NextResponse } from "next/server";
import { canViewBar } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { isBarZoneCode } from "@/lib/bar/zone-map";
import { signedUrl } from "@/lib/bar/keeping-server";
import { supabaseServer } from "@/lib/supabase/server";

type Context = { params: Promise<{ code: string }> };
export async function GET(_request: NextRequest, context: Context) {
  try {
    const { actor, response } = await getBarServerActor();
    if (response || !actor) return response;
    if (!canViewBar(actor)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    const { code } = await context.params;
    if (!isBarZoneCode(code)) return NextResponse.json({ ok: false, error: "Invalid zone" }, { status: 400 });
    if (code === "A2") return NextResponse.json({ ok: true, items: [], total: 0 });
    const { data, error, count } = await supabaseServer.from("bar_keepings")
      .select("id,customer_name,liquor_name,remaining_percent,thumbnail_path", { count: "exact" })
      .eq("zone_code", code).eq("status", "active")
      .order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(3);
    if (error) throw error;
    const items = await Promise.all((data ?? []).map(async (row) => ({
      id: Number(row.id), customerName: row.customer_name, liquorName: row.liquor_name,
      remainingPercent: row.remaining_percent, thumbnailUrl: await signedUrl(row.thumbnail_path),
    })));
    return NextResponse.json({ ok: true, items, total: count ?? 0 });
  } catch (error) {
    console.error("[ZONE_KEEPINGS_ERROR]", error);
    return NextResponse.json({ ok: false, error: "Failed to load zone keepings" }, { status: 500 });
  }
}
