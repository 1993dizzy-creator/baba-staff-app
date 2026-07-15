import { NextRequest, NextResponse } from "next/server";
import { canViewBarLogs } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { isBarZoneCode } from "@/lib/bar/zone-map";
import { supabaseServer } from "@/lib/supabase/server";

const ZONE_LOG_ACTIONS = [
  "zone_content_updated", "zone_assignee_assigned", "zone_assignee_changed", "zone_assignee_removed",
  "zone_photo_added", "zone_photo_replaced", "zone_photo_removed",
] as const;

export async function GET(request: NextRequest) {
  try {
    const { actor, response } = await getBarServerActor();
    if (response || !actor) return response;
    if (!canViewBarLogs(actor)) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });

    const rawPageSize = request.nextUrl.searchParams.get("limit") ?? request.nextUrl.searchParams.get("pageSize");
    const parsedPageSize = rawPageSize == null ? 20 : Number(rawPageSize);
    if (!Number.isInteger(parsedPageSize) || parsedPageSize < 1 || parsedPageSize > 50) {
      return NextResponse.json({ ok: false, error: "Invalid log limit", code: "INVALID_INPUT" }, { status: 400 });
    }
    const pageSize = parsedPageSize;
    const cursorParam = request.nextUrl.searchParams.get("cursor");
    const cursor = cursorParam ? parseCursor(cursorParam) : null;
    if (cursorParam && !cursor) {
      return NextResponse.json({ ok: false, error: "Invalid log cursor", code: "INVALID_INPUT" }, { status: 400 });
    }
    let query = supabaseServer
      .from("bar_activity_logs")
      .select("id, entity_type, entity_id, entity_code_snapshot, action_type, before_data, after_data, actor_name_snapshot, created_at")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    const entityType = request.nextUrl.searchParams.get("entityType");
    const code = request.nextUrl.searchParams.get("code");
    const actionType = request.nextUrl.searchParams.get("actionType");
    const entityId = request.nextUrl.searchParams.get("id");
    if (entityType && !["zone", "keeping"].includes(entityType)) {
      return NextResponse.json({ ok: false, error: "Invalid log entity type", code: "INVALID_INPUT" }, { status: 400 });
    }
    if (code && (entityType !== "zone" || !isBarZoneCode(code))) {
      return NextResponse.json({ ok: false, error: "Invalid BAR zone code", code: "INVALID_ZONE" }, { status: 400 });
    }
    if (entityId && (entityType !== "keeping" || !Number.isSafeInteger(Number(entityId)) || Number(entityId) < 1)) {
      return NextResponse.json({ ok: false, error: "Invalid keeping id", code: "INVALID_INPUT" }, { status: 400 });
    }
    if (entityType) query = query.eq("entity_type", entityType);
    if (code) query = query.eq("entity_code_snapshot", code).in("action_type", [...ZONE_LOG_ACTIONS]);
    if (entityId) query = query.eq("entity_id", Number(entityId));
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
        beforeData: safeLogData(row.before_data), afterData: safeLogData(row.after_data),
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

function safeLogData(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(["customer_name", "liquor_name", "remaining_percent", "zone_code", "close_reason"].flatMap((key) =>
    typeof source[key] === "string" || typeof source[key] === "number" ? [[key, source[key]]] : []
  ));
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
