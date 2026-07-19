import { NextResponse } from "next/server";
import { canViewBar } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(request: Request) {
  try {
    const { actor, response } = await getBarServerActor(request);
    if (response || !actor) return response;
    if (!canViewBar(actor)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    const [activeResult, closedResult] = await Promise.all([
      supabaseServer.from("bar_keepings").select("id", { count: "exact", head: true }).eq("status", "active"),
      supabaseServer.from("bar_keepings").select("id", { count: "exact", head: true }).eq("status", "closed"),
    ]);
    if (activeResult.error) throw activeResult.error;
    if (closedResult.error) throw closedResult.error;
    return NextResponse.json({ ok: true, counts: { active: activeResult.count ?? 0, closed: closedResult.count ?? 0 } });
  } catch (error) {
    console.error("[KEEPING_COUNTS_ERROR]", error);
    return NextResponse.json({ ok: false, error: "Failed to load keeping counts" }, { status: 500 });
  }
}
