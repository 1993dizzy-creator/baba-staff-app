import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import {
  fetchInventoryStatusByItemId,
  inventoryStatusMapToRecord,
  parseInventoryItemIds,
} from "@/lib/inventory/stock-check-status-server";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const body = await req.json();
    const itemIds = parseInventoryItemIds(body?.itemIds);

    if (itemIds.length === 0) {
      return NextResponse.json({ ok: true, statusMap: {} });
    }

    const stockCheckStatusByItemId = await fetchInventoryStatusByItemId({
      supabase: supabaseAdmin,
      itemIds,
    });

    return NextResponse.json({
      ok: true,
      statusMap: inventoryStatusMapToRecord(stockCheckStatusByItemId),
    });
  } catch (error) {
    console.error("[INVENTORY_ITEMS_STATUS_POST_ERROR]", error);

    return NextResponse.json(
      { ok: false, error: "inventory_status_load_failed" },
      { status: 500 }
    );
  }
}
