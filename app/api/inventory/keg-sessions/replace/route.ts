import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { BUSINESS_TIMEZONE_OFFSET } from "@/lib/common/business-time";
import { resolveInventoryBusinessDate } from "@/lib/inventory/inventory-business-time";
import { supabaseServer } from "@/lib/supabase/server";

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const parseReplacementAt = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return new Date();
  const rawValue = value.trim();
  const normalizedValue =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(rawValue)
      ? `${rawValue}:00${BUSINESS_TIMEZONE_OFFSET}`
      : rawValue;
  const date = new Date(normalizedValue);
  return Number.isFinite(date.getTime()) ? date : null;
};

export async function POST(req: Request) {
  try {
    const auth = await getAuthenticatedActor();
    if (!auth.ok) {
      return NextResponse.json(
        { ok: false, error: auth.code, code: auth.code },
        { status: auth.status }
      );
    }

    const body = await req.json();
    const itemId = Number(body?.itemId);
    const expectedQuantity =
      body?.expectedQuantity === undefined ||
      body?.expectedQuantity === null ||
      body?.expectedQuantity === ""
        ? null
        : Number(body.expectedQuantity);
    const replacementAt = parseReplacementAt(
      body?.replacementAt ?? body?.replacementLocalDateTime
    );

    if (!Number.isFinite(itemId) || itemId <= 0) {
      return NextResponse.json(
        { ok: false, error: "invalid_item_id", message: "Invalid item id" },
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

    if (!replacementAt) {
      return NextResponse.json(
        {
          ok: false,
          error: "invalid_replacement_time",
          message: "Invalid replacement time",
        },
        { status: 400 }
      );
    }

    if (replacementAt.getTime() > Date.now()) {
      return NextResponse.json(
        {
          ok: false,
          error: "future_replacement_time",
          message: "Replacement time cannot be in the future",
        },
        { status: 400 }
      );
    }

    const businessDate = (await resolveInventoryBusinessDate(replacementAt)).businessDate;
    const { data, error } = await supabaseServer.rpc("replace_inventory_keg", {
      p_item_id: itemId,
      p_actor_username: auth.actor.username,
      p_business_date: businessDate,
      p_expected_quantity: expectedQuantity,
      p_replacement_at: replacementAt.toISOString(),
    });

    if (error) {
      console.error("[INVENTORY_KEG_REPLACE_RPC_ERROR]", error);
      const isInsufficientKegQuantity = error.message.includes(
        "Keg quantity cannot be lower than 1 before replacement"
      );
      const isTimeConflict = error.message.includes(
        "Keg replacement time cannot be earlier than the active session start time"
      );

      return NextResponse.json(
        {
          ok: false,
          error: isInsufficientKegQuantity
            ? "insufficient_keg_quantity"
            : isTimeConflict
              ? "replacement_time_conflict"
            : "keg_replace_failed",
          message: error.message,
        },
        { status: isInsufficientKegQuantity || isTimeConflict ? 409 : 400 }
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
