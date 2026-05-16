import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

// Fallback only: this builds a receipt-history catalog, not the official POS catalog.
// The canonical POS product catalog is source='cukcuk' from /api/pos/products/sync-from-cukcuk.

type RequestBody = {
  actorUsername?: unknown;
};

type ReceiptLineRow = {
  item_code: string | null;
  item_name: string | null;
  unit_name: string | null;
  unit_price: number | string | null;
  ref_date: string | null;
  created_at?: string | null;
};

type ProductBucket = {
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  unitPrice: number;
  lastSeenAt: string | null;
};

function toNumber(value: number | string | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function getAdminActor(actorUsername: unknown) {
  if (typeof actorUsername !== "string" || !actorUsername.trim()) return null;

  const { data, error } = await supabaseServer
    .from("users")
    .select("id, username, role, is_active")
    .eq("username", actorUsername.trim())
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to verify admin actor: ${error.message}`);
  }

  if (data?.role !== "owner" && data?.role !== "master") return null;
  return data;
}

function getBucketKey(row: ReceiptLineRow) {
  return [
    row.item_code || "",
    row.item_name || "",
    row.unit_name || "",
    String(toNumber(row.unit_price)),
  ].join("::");
}

function isLater(left: string | null, right: string | null) {
  if (!left) return false;
  if (!right) return true;
  return new Date(left).getTime() > new Date(right).getTime();
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as RequestBody | null;
    const actor = await getAdminActor(body?.actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    const { data, error } = await supabaseServer
      .from("pos_sales_receipt_lines")
      .select("item_code, item_name, unit_name, unit_price, ref_date, created_at")
      .not("item_name", "is", null)
      .eq("is_option", false)
      .order("ref_date", { ascending: false })
      .limit(10000);

    if (error) {
      throw new Error(`Failed to fetch receipt lines: ${error.message}`);
    }

    const buckets = new Map<string, ProductBucket>();

    ((data || []) as ReceiptLineRow[]).forEach((row) => {
      const itemName = (row.item_name || "").trim();
      if (!itemName) return;

      const key = getBucketKey(row);
      const seenAt = row.ref_date || row.created_at || null;
      const current = buckets.get(key);

      if (!current) {
        buckets.set(key, {
          itemCode: row.item_code,
          itemName,
          unitName: row.unit_name,
          unitPrice: toNumber(row.unit_price),
          lastSeenAt: seenAt,
        });
        return;
      }

      if (isLater(seenAt, current.lastSeenAt)) {
        current.lastSeenAt = seenAt;
      }
    });

    const now = new Date().toISOString();
    const { data: existingProducts, error: existingError } = await supabaseServer
      .from("pos_products")
      .select("id, item_code, item_name, unit_name, unit_price")
      .eq("source", "receipt_history");

    if (existingError) {
      throw new Error(`Failed to fetch existing POS products: ${existingError.message}`);
    }

    const existingByKey = new Map(
      ((existingProducts || []) as {
        id: number;
        item_code: string | null;
        item_name: string;
        unit_name: string | null;
        unit_price: number | string | null;
      }[]).map((product) => [
        [
          product.item_code || "",
          product.item_name || "",
          product.unit_name || "",
          String(toNumber(product.unit_price)),
        ].join("::"),
        product.id,
      ])
    );
    const rebuiltRows = Array.from(buckets.values()).map((product) => ({
      key: [
        product.itemCode || "",
        product.itemName,
        product.unitName || "",
        String(product.unitPrice),
      ].join("::"),
      product,
    }));
    const rowsToInsert = rebuiltRows
      .filter((row) => !existingByKey.has(row.key))
      .map(({ product }) => ({
        source: "receipt_history",
        item_id: null,
        item_code: product.itemCode,
        item_name: product.itemName,
        unit_name: product.unitName,
        unit_price: product.unitPrice,
        is_active: true,
        raw_json: {
          source: "receipt_history",
          rebuiltBy: actor.username,
        },
        last_seen_at: product.lastSeenAt,
        synced_at: now,
        updated_at: now,
      }));
    const rowsToUpdate = rebuiltRows
      .filter((row) => existingByKey.has(row.key))
      .map(({ key, product }) => ({
        id: existingByKey.get(key) as number,
        lastSeenAt: product.lastSeenAt,
      }));

    if (rowsToInsert.length > 0) {
      const { error: insertError } = await supabaseServer
        .from("pos_products")
        .insert(rowsToInsert);

      if (insertError) {
        throw new Error(`Failed to insert POS products: ${insertError.message}`);
      }
    }

    for (const row of rowsToUpdate) {
      const { error: updateError } = await supabaseServer
        .from("pos_products")
        .update({
          is_active: true,
          last_seen_at: row.lastSeenAt,
          synced_at: now,
          updated_at: now,
        })
        .eq("id", row.id);

      if (updateError) {
        throw new Error(`Failed to update POS product ${row.id}: ${updateError.message}`);
      }
    }

    return NextResponse.json({
      ok: true,
      insertedCount: rowsToInsert.length,
      updatedCount: rowsToUpdate.length,
      note: "기존 판매 이력 기반 카탈로그입니다. 전체 판매중 품목 목록은 CUKCUK 상품 동기화 route가 필요합니다.",
    });
  } catch (error) {
    console.error("[POS_PRODUCTS_REBUILD_FROM_RECEIPTS_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to rebuild POS products.",
      },
      { status: 500 }
    );
  }
}
