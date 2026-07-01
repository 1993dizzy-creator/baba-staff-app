import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getBusinessDate } from "@/lib/common/business-time";

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

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const itemId = Number(body?.itemId);
    const actorUsername =
      typeof body?.actorUsername === "string" ? body.actorUsername.trim() : "";
    const expectedQuantity =
      body?.expectedQuantity === undefined ||
      body?.expectedQuantity === null ||
      body?.expectedQuantity === ""
        ? null
        : Number(body.expectedQuantity);

    if (!Number.isFinite(itemId) || itemId <= 0) {
      return NextResponse.json(
        { ok: false, error: "invalid_item_id", message: "Invalid item id" },
        { status: 400 }
      );
    }

    if (!actorUsername) {
      return NextResponse.json(
        { ok: false, error: "missing_actor", message: "Missing actor" },
        { status: 400 }
      );
    }

    if (expectedQuantity !== null && !Number.isFinite(expectedQuantity)) {
      return NextResponse.json(
        {
          ok: false,
          error: "invalid_expected_quantity",
          message: "Invalid expected quantity",
        },
        { status: 400 }
      );
    }

    const businessDate = getBusinessDate();
    const { data, error } = await supabaseAdmin.rpc("replace_inventory_keg", {
      p_item_id: itemId,
      p_actor_username: actorUsername,
      p_business_date: businessDate,
      p_expected_quantity: expectedQuantity,
    });

    if (error) {
      console.error("[INVENTORY_KEG_REPLACE_RPC_ERROR]", error);
      const isInsufficientKegQuantity = error.message.includes(
        "Keg quantity cannot be lower than 1 before replacement"
      );

      return NextResponse.json(
        {
          ok: false,
          error: isInsufficientKegQuantity
            ? "insufficient_keg_quantity"
            : "keg_replace_failed",
          message: error.message,
        },
        { status: isInsufficientKegQuantity ? 409 : 400 }
      );
    }

    const result =
      data && typeof data === "object" ? (data as Record<string, unknown>) : {};

    if (result.ok === false && result.code === "QUANTITY_CONFLICT") {
      return NextResponse.json(
        {
          ok: false,
          code: "QUANTITY_CONFLICT",
          message:
            "Inventory quantity was changed by another user. Refresh and try again.",
          currentQuantity: result.currentQuantity,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      ok: true,
      businessDate,
      ...result,
    });
  } catch (error) {
    console.error("[INVENTORY_KEG_REPLACE_POST_ERROR]", error);
    return NextResponse.json(
      {
        ok: false,
        error: "keg_replace_exception",
        message: getErrorMessage(error),
      },
      { status: 500 }
    );
  }
}
