import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  QUICK_REASON_VALUES,
  normalizeInventoryReason,
} from "@/lib/inventory/reasons";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const getActor = async (actorUsername?: string) => {
  if (!actorUsername) return null;

  const { data } = await supabaseAdmin
    .from("users")
    .select("id, username, name, role, is_active")
    .eq("username", actorUsername)
    .eq("is_active", true)
    .maybeSingle();

  return data;
};

type Actor = {
  role?: string | null;
};

const isMaster = (user: Actor | null) => user?.role === "master";

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Server error";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode");
  const businessDate = searchParams.get("businessDate");
  const reason = searchParams.get("reason");
  const itemId = searchParams.get("itemId");

  try {
    if (mode === "logs") {
      let query = supabaseAdmin
        .from("inventory_logs")
        .select("*")
        .order("created_at", { ascending: false });

      if (businessDate) {
        query = query.eq("business_date", businessDate);
      }

      if (reason) {
        query = query.eq("reason", normalizeInventoryReason(reason));
      }

      if (itemId) {
        query = query.eq("item_id", Number(itemId));
      }

      const { data, error } = await query;

      if (error) throw error;

      return NextResponse.json({ ok: true, data: data || [] });
    }

    if (mode === "recent") {
      const { data, error } = await supabaseAdmin
        .from("inventory_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(3);

      if (error) throw error;

      return NextResponse.json({ ok: true, data: data || [] });
    }

    if (mode === "notes") {
      const { data, error } = await supabaseAdmin
        .from("inventory")
        .select("id, part, code, item_name, item_name_vi, note");

      if (error) throw error;

      return NextResponse.json({ ok: true, data: data || [] });
    }

    return NextResponse.json(
      { ok: false, message: "Invalid mode" },
      { status: 400 }
    );
  } catch (error) {
    console.error("[INVENTORY_LOGS_GET_ERROR]", error);

    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const id = Number(body?.id);
    const reason = normalizeInventoryReason(body?.reason);

    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json(
        { ok: false, message: "Missing id" },
        { status: 400 }
      );
    }

    if (!QUICK_REASON_VALUES.includes(reason as (typeof QUICK_REASON_VALUES)[number])) {
      return NextResponse.json(
        { ok: false, message: "Invalid reason" },
        { status: 400 }
      );
    }

    const { data: existing, error: findError } = await supabaseAdmin
      .from("inventory_logs")
      .select("id")
      .eq("id", id)
      .maybeSingle();

    if (findError) throw findError;

    if (!existing) {
      return NextResponse.json(
        { ok: false, message: "Log not found" },
        { status: 404 }
      );
    }

    const { data, error } = await supabaseAdmin
      .from("inventory_logs")
      .update({ reason })
      .eq("id", id)
      .select("id, reason, business_date, change_quantity")
      .single();

    if (error) throw error;

    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error("[INVENTORY_LOGS_PATCH_ERROR]", error);

    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json();
    const { logId, actorUsername } = body;

    if (!logId) {
      return NextResponse.json(
        { ok: false, message: "Missing logId" },
        { status: 400 }
      );
    }

    const actor = await getActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, message: "Invalid user" },
        { status: 401 }
      );
    }

    if (!isMaster(actor)) {
      return NextResponse.json(
        { ok: false, message: "No permission" },
        { status: 403 }
      );
    }

    const { error } = await supabaseAdmin
      .from("inventory_logs")
      .delete()
      .eq("id", Number(logId));

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[INVENTORY_LOGS_DELETE_ERROR]", error);

    return NextResponse.json(
      { ok: false, message: getErrorMessage(error) },
      { status: 500 }
    );
  }
}
