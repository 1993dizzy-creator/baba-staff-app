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

export async function GET() {
  try {
    const supabase = createSupabaseAdmin();

    const { data: batches, error: batchError } = await supabase
      .from("inventory_snapshot_batches")
      .select("id, snapshot_date, created_at, note")
      .order("id", { ascending: false });

    if (batchError) {
      return NextResponse.json(
        {
          ok: false,
          error: "snapshot_batches_query_failed",
          message: batchError.message,
        },
        { status: 500 }
      );
    }

    const { data: purchaseRows, error: purchaseError } = await supabase
      .from("inventory_snapshot_items")
      .select("batch_id")
      .gt("change_quantity", 0);

    if (purchaseError) {
      return NextResponse.json(
        {
          ok: false,
          error: "snapshot_purchase_rows_query_failed",
          message: purchaseError.message,
        },
        { status: 500 }
      );
    }

    const purchaseBatchMap: Record<number, boolean> = {};

    (purchaseRows || []).forEach((row) => {
      if (row.batch_id !== null && row.batch_id !== undefined) {
        purchaseBatchMap[Number(row.batch_id)] = true;
      }
    });

    return NextResponse.json({
      ok: true,
      batches: batches ?? [],
      purchaseBatchMap,
    });
  } catch (error) {
    const errorCode =
      error instanceof Error && error.name === "MissingServerEnvError"
        ? "missing_server_env"
        : "snapshot_batches_fetch_failed";

    console.error("[SNAPSHOT_BATCHES_FETCH_FAILED]", error);

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
