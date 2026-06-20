import { NextResponse } from "next/server";
import { getMappingAdminActor } from "@/lib/pos/mapping-admin";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isBusinessDate(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

export async function GET(req: Request) {
  try {
    const searchParams = new URL(req.url).searchParams;
    const actorUsername = (searchParams.get("actorUsername") || "").trim();
    const actor = await getMappingAdminActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    const limit = Math.min(
      Math.max(Number(searchParams.get("limit") || 20), 1),
      100
    );
    const offset = Math.max(Number(searchParams.get("offset") || 0), 0);
    const status = (searchParams.get("status") || "").trim();
    const dateFrom = searchParams.get("businessDateFrom");
    const dateTo = searchParams.get("businessDateTo");
    let query = supabaseServer
      .from("pos_inventory_deduction_batches")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq("status", status);
    if (isBusinessDate(dateFrom)) {
      query = query.gte("business_date_to", dateFrom);
    }
    if (isBusinessDate(dateTo)) {
      query = query.lte("business_date_from", dateTo);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    const batches = data || [];
    return NextResponse.json({
      ok: true,
      total: count || 0,
      limit,
      offset,
      summary: batches.reduce(
        (result, batch) => {
          result.receiptCount += Number(batch.receipt_count || 0);
          result.readyReceiptCount += Number(batch.ready_receipt_count || 0);
          result.blockedReceiptCount += Number(
            batch.blocked_receipt_count || 0
          );
          return result;
        },
        {
          batchCount: batches.length,
          receiptCount: 0,
          readyReceiptCount: 0,
          blockedReceiptCount: 0,
        }
      ),
      batches,
    });
  } catch (error) {
    console.error("[ADMIN_SALES_INVENTORY_BATCHES_GET_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Failed to load batches.",
      },
      { status: 500 }
    );
  }
}
