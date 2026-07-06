import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  BUSINESS_TIMEZONE_OFFSET,
  getBusinessDate,
} from "@/lib/common/business-time";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const parseSessionStartedAt = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return null;
  const rawValue = value.trim();
  const normalizedValue =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(rawValue)
      ? `${rawValue}:00${BUSINESS_TIMEZONE_OFFSET}`
      : rawValue;
  const date = new Date(normalizedValue);
  return Number.isFinite(date.getTime()) ? date : null;
};

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const sessionId = Number(id);
    const body = await req.json();
    const actorUsername =
      typeof body?.actorUsername === "string" ? body.actorUsername.trim() : "";
    const startedAt = parseSessionStartedAt(
      body?.startedAt ?? body?.startedLocalDateTime
    );

    if (!Number.isFinite(sessionId) || sessionId <= 0) {
      return NextResponse.json(
        { ok: false, error: "invalid_session_id", message: "Invalid session id" },
        { status: 400 }
      );
    }

    if (!actorUsername) {
      return NextResponse.json(
        { ok: false, error: "missing_actor", message: "Missing actor" },
        { status: 400 }
      );
    }

    if (!startedAt) {
      return NextResponse.json(
        {
          ok: false,
          error: "invalid_started_at",
          message: "Invalid session start time",
        },
        { status: 400 }
      );
    }

    if (startedAt.getTime() > Date.now()) {
      return NextResponse.json(
        {
          ok: false,
          error: "future_started_at",
          message: "Session start time cannot be in the future",
        },
        { status: 400 }
      );
    }

    const { data: actor } = await supabaseAdmin
      .from("users")
      .select("id, username, is_active")
      .eq("username", actorUsername)
      .eq("is_active", true)
      .maybeSingle();

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "invalid_actor", message: "Invalid user" },
        { status: 401 }
      );
    }

    const { data: session, error: sessionError } = await supabaseAdmin
      .from("inventory_keg_sessions")
      .select(
        "id, inventory_item_id, status, started_at, started_log_id, created_by"
      )
      .eq("id", sessionId)
      .maybeSingle();

    if (sessionError) throw sessionError;

    if (!session || session.status !== "active") {
      return NextResponse.json(
        {
          ok: false,
          error: "active_session_not_found",
          message: "Active keg session not found",
        },
        { status: 404 }
      );
    }

    const businessDate = getBusinessDate(startedAt);
    const startedAtIso = startedAt.toISOString();

    const { error: updateError } = await supabaseAdmin
      .from("inventory_keg_sessions")
      .update({
        started_at: startedAtIso,
        started_business_date: businessDate,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sessionId)
      .eq("status", "active");

    if (updateError) throw updateError;

    if (session.started_log_id) {
      const { error: previousUpdateError } = await supabaseAdmin
        .from("inventory_keg_sessions")
        .update({
          ended_at: startedAtIso,
          ended_business_date: businessDate,
          updated_at: new Date().toISOString(),
        })
        .eq("inventory_item_id", session.inventory_item_id)
        .eq("status", "closed")
        .eq("ended_log_id", session.started_log_id);

      if (previousUpdateError) throw previousUpdateError;
    }

    return NextResponse.json({
      ok: true,
      session: {
        id: sessionId,
        startedAt: startedAtIso,
        startedBusinessDate: businessDate,
      },
    });
  } catch (error) {
    console.error("[INVENTORY_KEG_SESSION_PATCH_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: "keg_session_update_failed",
        message: getErrorMessage(error),
      },
      { status: 500 }
    );
  }
}
