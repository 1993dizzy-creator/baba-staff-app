import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { fetchPreviousKegSummariesByLogId } from "@/lib/inventory/keg-replacement-summary";
import { supabaseServer } from "@/lib/supabase/server";

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const { id } = await params;
    const itemId = Number(id);

    if (!Number.isFinite(itemId) || itemId <= 0) {
      return NextResponse.json(
        {
          ok: false,
          error: id ? "invalid_item_id" : "missing_item_id",
          message: "Invalid item id",
        },
        { status: 400 }
      );
    }

    const { data, error } = await supabaseServer
      .from("inventory_logs")
      .select("*")
      .eq("item_id", itemId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      return NextResponse.json(
        {
          ok: false,
          error: "inventory_item_logs_query_failed",
          message: error.message,
        },
        { status: 500 }
      );
    }

    const logs = data || [];
    const kegReplaceLogIds = logs
      .filter((log) => log.source === "keg_replace")
      .map((log) => log.id);
    const previousKegSummaryByLogId = await fetchPreviousKegSummariesByLogId(
      supabaseServer,
      kegReplaceLogIds
    );

    const enrichedLogs = logs.map((log) =>
      previousKegSummaryByLogId.has(log.id)
        ? { ...log, previousKegSummary: previousKegSummaryByLogId.get(log.id) }
        : log
    );

    return NextResponse.json({
      ok: true,
      data: enrichedLogs,
    });
  } catch (error) {
    console.error("[INVENTORY_ITEM_LOGS_GET_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: "inventory_item_logs_fetch_failed",
        message: getErrorMessage(error),
      },
      { status: 500 }
    );
  }
}
