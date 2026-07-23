import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { fetchKegProgressByItemId } from "@/lib/inventory/keg-progress";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const parseItemIds = (value: string | null) => {
  if (!value) return [];

  return Array.from(
    new Set(
      value
        .split(",")
        .map((item) => Number(item.trim()))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
};

export async function GET(req: Request) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const { searchParams } = new URL(req.url);
    const itemIds = parseItemIds(searchParams.get("itemIds"));

    if (itemIds.length === 0) {
      return NextResponse.json({ ok: true, progressMap: {} });
    }

    const { data: inventoryItems, error: inventoryError } = await supabaseAdmin
      .from("inventory")
      .select("id, unit, package_content_quantity, package_content_unit")
      .in("id", itemIds);

    if (inventoryError) throw inventoryError;

    const kegCandidateIds = (inventoryItems || [])
      .filter((item) => {
        const unit = String(item.unit || "").trim().toLowerCase();
        const packageUnit = String(item.package_content_unit || "")
          .trim()
          .toLowerCase();
        const packageQuantity = Number(item.package_content_quantity ?? 0);

        return unit === "keg" && packageUnit === "ml" && packageQuantity > 0;
      })
      .map((item) => Number(item.id))
      .filter((id) => Number.isFinite(id) && id > 0);

    const progressByItemId = await fetchKegProgressByItemId({
      supabase: supabaseAdmin,
      inventoryItems: inventoryItems || [],
      kegCandidateIds,
    });

    const progressMap = Object.fromEntries(
      Array.from(progressByItemId.entries()).map(([itemId, progress]) => [
        String(itemId),
        progress,
      ])
    );

    return NextResponse.json({ ok: true, progressMap });
  } catch (error) {
    console.error("[INVENTORY_KEG_PROGRESS_GET_ERROR]", error);

    return NextResponse.json(
      { ok: false, error: "inventory_keg_progress_load_failed" },
      { status: 500 }
    );
  }
}
