import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { findInventoryLanguageMissingItems, type InventoryLanguageRow } from "@/lib/inventory/language-missing";

export const dynamic = "force-dynamic";
const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
const PAGE_SIZE = 1000;

// Retain the URL for existing language-check callers. No historical sync queries
// or writes remain; language completeness is independent of the selected date.
export async function GET() {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code, code: auth.code }, { status: auth.status, headers: NO_STORE_HEADERS });
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Missing inventory language-check configuration");
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const inventoryItems: InventoryLanguageRow[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const result = await supabase.from("inventory").select("id, item_name, item_name_vi, is_active, created_at, updated_at")
        .eq("is_active", true).order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
      if (result.error) return NextResponse.json({ ok: false, error: "inventory_language_missing_query_failed" }, { status: 500, headers: NO_STORE_HEADERS });
      const rows = (result.data ?? []) as InventoryLanguageRow[];
      inventoryItems.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
    return NextResponse.json({ ok: true, canSync: false, languageMissingItems: findInventoryLanguageMissingItems(inventoryItems) }, { headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({ ok: false, error: "inventory_language_missing_query_failed" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

// Old clients must never restart a historical sync. Preserve the previous
// authentication/role contract, then explicitly reject every retired action.
export async function POST() {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code, code: auth.code }, { status: auth.status, headers: NO_STORE_HEADERS });
    if (!["owner", "master"].includes(String(auth.actor.role ?? "").trim().toLowerCase())) return NextResponse.json({ ok: false, error: "inventory_snapshot_name_sync_forbidden" }, { status: 403, headers: NO_STORE_HEADERS });
    return NextResponse.json({ ok: false, code: "INVENTORY_HISTORICAL_SYNC_DISABLED", error: "INVENTORY_HISTORICAL_SYNC_DISABLED" }, { status: 409, headers: NO_STORE_HEADERS });
  } catch {
    return NextResponse.json({ ok: false, error: "inventory_daily_sync_failed" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
