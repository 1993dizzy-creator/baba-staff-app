import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { fetchPreviousKegSessionSummariesByLogId, fetchPreviousKegSummariesByLogId } from "@/lib/inventory/keg-replacement-summary";
import { supabaseServer } from "@/lib/supabase/server";

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function GET(
  request: Request,
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

    const searchParams = new URL(request.url).searchParams;
    const kegLogIdParam = searchParams.get("kegLogId");
    if (kegLogIdParam !== null) {
      const kegLogId = Number(kegLogIdParam);
      if (!Number.isSafeInteger(kegLogId) || kegLogId <= 0) {
        return NextResponse.json({ ok: false, error: "invalid_keg_log_id" }, { status: 400 });
      }
      // Scope the requested record to this item before reading its session/POS data.
      const { data: matchingLogs, error: logError } = await supabaseServer
        .from("inventory_logs").select("id").eq("item_id", itemId)
        .eq("id", kegLogId).eq("source", "keg_replace").limit(1);
      if (logError) throw logError;
      if (!matchingLogs?.length) {
        return NextResponse.json({ ok: false, error: "keg_log_not_found" }, { status: 404 });
      }
      const summaries = await fetchPreviousKegSummariesByLogId(supabaseServer, [kegLogId]);
      const summary = summaries.get(kegLogId);
      if (!summary) {
        return NextResponse.json({ ok: false, error: "keg_session_not_found" }, { status: 404 });
      }
      if (summary.soldMl > 0 && !summary.salesBreakdown) {
        return NextResponse.json({ ok: false, error: "keg_sales_breakdown_unavailable" }, { status: 503 });
      }
      return NextResponse.json({ ok: true, itemId, logId: kegLogId, summary });
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
    // Existing callers retain full enrichment; /inventory explicitly defers POS detail.
    const fetchSummaries = searchParams.get("includeKegSalesBreakdown") === "false"
      ? fetchPreviousKegSessionSummariesByLogId
      : fetchPreviousKegSummariesByLogId;
    const previousKegSummaryByLogId = await fetchSummaries(
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
