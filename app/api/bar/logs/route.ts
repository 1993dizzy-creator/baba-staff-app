import { NextRequest, NextResponse } from "next/server";
import { canViewBarLogs } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    const { actor, response } = await getBarServerActor();
    if (response || !actor) return response;
    if (!canViewBarLogs(actor)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

    const pageSize = Math.min(50, Math.max(1, Number(request.nextUrl.searchParams.get("pageSize")) || 20));
    const cursorParam = request.nextUrl.searchParams.get("cursor");
    const cursor = cursorParam ? parseCursor(cursorParam) : null;
    if (cursorParam && !cursor) {
      return NextResponse.json({ ok: false, error: "Invalid log cursor", code: "INVALID_INPUT" }, { status: 400 });
    }
    let query = supabaseServer
      .from("bar_activity_logs")
      .select("id, entity_type, entity_id, entity_code_snapshot, action_type, actor_name_snapshot, created_at")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    const entityType = request.nextUrl.searchParams.get("entityType");
    const actionType = request.nextUrl.searchParams.get("actionType");
    if (entityType) query = query.eq("entity_type", entityType);
    if (actionType) query = query.eq("action_type", actionType);
    if (cursor) {
      query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
    }
    const { data, error } = await query.limit(pageSize + 1);
    if (error) throw error;
    const hasMore = (data?.length ?? 0) > pageSize;
    const pageRows = (data ?? []).slice(0, pageSize);
    const last = pageRows.at(-1);
    return NextResponse.json({
      ok: true,
      logs: pageRows.map((row) => ({
        id: Number(row.id), entityType: row.entity_type, entityId: Number(row.entity_id),
        entityCode: row.entity_code_snapshot, actionType: row.action_type,
        actorName: row.actor_name_snapshot, createdAt: row.created_at,
      })),
      pageSize,
      hasMore,
      nextCursor: hasMore && last
        ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: Number(last.id) }), "utf8").toString("base64url")
        : null,
    });
  } catch (error) {
    console.error("[BAR_LOGS_GET_ERROR]", error);
    return NextResponse.json({ ok: false, error: "Failed to load BAR logs" }, { status: 500 });
  }
}

function parseCursor(value: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    const date = typeof parsed.createdAt === "string" ? new Date(parsed.createdAt) : null;
    const id = Number(parsed.id);
    if (!date || Number.isNaN(date.getTime()) || !Number.isSafeInteger(id) || id < 1) return null;
    return { createdAt: date.toISOString(), id };
  } catch {
    return null;
  }
}
