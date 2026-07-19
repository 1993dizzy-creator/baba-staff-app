import { NextResponse } from "next/server";
import { canManageBarKeeping } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { supabaseServer } from "@/lib/supabase/server";

const SEARCH_MAX_LENGTH = 80;

function escapePostgrestSearch(value: string) {
  return value.replace(/[%,()]/g, " ").replace(/\s+/g, " ").trim();
}

export async function GET(request: Request) {
  try {
    const auth = await getBarServerActor(request);
    if (auth.response) return auth.response;
    if (!canManageBarKeeping(auth.actor)) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }

    const rawQuery = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    if (rawQuery.length > SEARCH_MAX_LENGTH) {
      return NextResponse.json({ ok: false, error: "Invalid search query" }, { status: 400 });
    }
    const queryText = escapePostgrestSearch(rawQuery);
    if (!queryText) return NextResponse.json({ ok: true, items: [] });

    const pattern = `*${queryText}*`;
    const { data, error } = await supabaseServer
      .from("inventory")
      .select("id,item_name,item_name_vi,code,category,category_vi")
      .eq("part", "bar")
      .eq("is_active", true)
      .or(`item_name.ilike.${pattern},item_name_vi.ilike.${pattern},code.ilike.${pattern}`)
      .order("item_name", { ascending: true })
      .limit(12);

    if (error) throw error;
    return NextResponse.json({ ok: true, items: data ?? [] });
  } catch (error) {
    console.error("[BAR_KEEPING_PRODUCTS_GET_ERROR]", error);
    return NextResponse.json({ ok: false, error: "Failed to search products" }, { status: 500 });
  }
}
