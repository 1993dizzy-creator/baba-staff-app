import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const createSupabaseAdmin = () => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    const missing = [
      !supabaseUrl ? "NEXT_PUBLIC_SUPABASE_URL" : null,
      !serviceRoleKey ? "SUPABASE_SERVICE_ROLE_KEY" : null,
    ].filter(Boolean);
    const error = new Error(`Missing server env: ${missing.join(", ")}`);
    error.name = "MissingServerEnvError";
    throw error;
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
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

    const supabaseAdmin = createSupabaseAdmin();

    const { data, error } = await supabaseAdmin
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

    return NextResponse.json({
      ok: true,
      data: data || [],
    });
  } catch (error) {
    const errorCode =
      error instanceof Error && error.name === "MissingServerEnvError"
        ? "missing_server_env"
        : "inventory_item_logs_fetch_failed";

    console.error("[INVENTORY_ITEM_LOGS_GET_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: errorCode,
        message: getErrorMessage(error),
      },
      { status: 500 }
    );
  }
}
