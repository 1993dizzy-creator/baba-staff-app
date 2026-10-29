import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { fetchPreviousKegSessionSummariesByLogId, fetchPreviousKegSummariesByLogId } from "@/lib/inventory/keg-replacement-summary";
import { supabaseServer } from "@/lib/supabase/server";

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const BUSINESS_DAY_LOG_LIMIT = 500;

const isBusinessDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};

type ItemLogRow = { id: number; reason?: string | null; change_quantity?: number | string | null; correction_of_inventory_log_id?: number | null; [key: string]: unknown };

// Read-only. One business day (stored business_date, 03:00 boundary) plus the
// explicitly linked purchase family of every receipt touched that day, so the
// UI can show each original receipt in its final state.
async function fetchBusinessDayLogs(itemId: number, businessDate: string) {
  const day = await supabaseServer.from("inventory_logs").select("*")
    .eq("item_id", itemId).eq("business_date", businessDate)
    .order("created_at", { ascending: false }).limit(BUSINESS_DAY_LOG_LIMIT);
  if (day.error) return { data: null, error: day.error };
  const rows = new Map<number, ItemLogRow>(((day.data ?? []) as ItemLogRow[]).map(row => [Number(row.id), row]));
  const rootIds = new Set<number>();
  for (const row of rows.values()) {
    if (row.correction_of_inventory_log_id != null) rootIds.add(Number(row.correction_of_inventory_log_id));
    else if (row.reason === "purchase" && Number(row.change_quantity) > 0) rootIds.add(Number(row.id));
  }
  const ids = [...rootIds].filter(id => Number.isSafeInteger(id) && id > 0);
  if (ids.length) {
    const [roots, corrections] = await Promise.all([
      supabaseServer.from("inventory_logs").select("*").eq("item_id", itemId).in("id", ids),
      supabaseServer.from("inventory_logs").select("*").eq("item_id", itemId)
        .in("correction_of_inventory_log_id", ids).order("id", { ascending: true }).limit(BUSINESS_DAY_LOG_LIMIT),
    ]);
    if (roots.error) return { data: null, error: roots.error };
    if (corrections.error) return { data: null, error: corrections.error };
    for (const row of [...(roots.data ?? []), ...(corrections.data ?? [])] as ItemLogRow[]) rows.set(Number(row.id), row);
  }
  const data = [...rows.values()].sort((a, b) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || Number(b.id) - Number(a.id));
  return { data, error: null };
}

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

    const businessDate = searchParams.get("businessDate");
    if (businessDate !== null && !isBusinessDate(businessDate)) {
      return NextResponse.json({ ok: false, error: "invalid_business_date" }, { status: 400 });
    }

    const { data, error } = businessDate !== null
      ? await fetchBusinessDayLogs(itemId, businessDate)
      : await supabaseServer
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
      ...(businessDate !== null ? { businessDate } : {}),
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
