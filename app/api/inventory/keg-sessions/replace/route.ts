import { NextResponse } from "next/server";
import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { BUSINESS_TIMEZONE_OFFSET } from "@/lib/common/business-time";
import { resolveInventoryBusinessDate } from "@/lib/inventory/inventory-business-time";
import { roundDecimal } from "@/lib/inventory/number";
import { supabaseServer } from "@/lib/supabase/server";

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const roundQuantity = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

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
    const dryRun = body?.dryRun === true;
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

    if (dryRun) {
      const { data: item, error: itemError } = await supabaseServer
        .from("inventory")
        .select("id, quantity, package_content_quantity, package_content_unit")
        .eq("id", itemId)
        .maybeSingle();
      if (itemError) throw itemError;
      if (!item) {
        return NextResponse.json(
          { ok: false, error: "inventory_item_not_found", message: "Inventory item not found" },
          { status: 404 }
        );
      }

      const currentQuantity = roundQuantity(Number(item.quantity ?? 0));
      if (
        expectedQuantity !== null &&
        roundQuantity(expectedQuantity) !== currentQuantity
      ) {
        return NextResponse.json(
          {
            ok: false,
            code: "QUANTITY_CONFLICT",
            message:
              "Inventory quantity was changed by another user. Refresh and try again.",
            currentQuantity,
          },
          { status: 409 }
        );
      }
      if (currentQuantity < 1) {
        return NextResponse.json(
          {
            ok: false,
            error: "insufficient_keg_quantity",
            message: "Keg quantity cannot be lower than 1 before replacement",
          },
          { status: 409 }
        );
      }

      const capacityMl = Number(item.package_content_quantity ?? 0);
      if (
        !Number.isFinite(capacityMl) ||
        capacityMl <= 0 ||
        String(item.package_content_unit || "").toLowerCase() !== "ml"
      ) {
        return NextResponse.json(
          {
            ok: false,
            error: "invalid_keg_capacity",
            message: "Keg capacity must be configured in ml",
          },
          { status: 400 }
        );
      }

      const { count: mappingCount, error: mappingError } = await supabaseServer
        .from("inventory_keg_tracking_mappings")
        .select("id", { count: "exact", head: true })
        .eq("inventory_item_id", itemId)
        .eq("is_active", true)
        .eq("target_type", "product");
      if (mappingError) throw mappingError;
      if (!mappingCount) {
        return NextResponse.json(
          {
            ok: false,
            error: "active_keg_tracking_mapping_not_found",
            message: "Active keg tracking mapping not found",
          },
          { status: 400 }
        );
      }

      const { data: activeSession, error: sessionError } = await supabaseServer
        .from("inventory_keg_sessions")
        .select("id, started_at")
        .eq("inventory_item_id", itemId)
        .eq("status", "active")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (sessionError) throw sessionError;
      if (
        activeSession?.started_at &&
        replacementAt.getTime() < Date.parse(activeSession.started_at)
      ) {
        return NextResponse.json(
          {
            ok: false,
            error: "replacement_time_conflict",
            message:
              "Keg replacement time cannot be earlier than the active session start time",
          },
          { status: 409 }
        );
      }

      let salesBreakdown: Record<string, unknown> | null = null;
      if (activeSession?.started_at) {
        const { data: salesData, error: salesError } = await supabaseServer.rpc(
          "calculate_inventory_keg_sales",
          {
            p_item_id: itemId,
            p_started_at: activeSession.started_at,
            p_ended_at: replacementAt.toISOString(),
          }
        );
        if (salesError) throw salesError;
        const rawSales =
          salesData && typeof salesData === "object"
            ? (salesData as Record<string, unknown>)
            : {};
        const regularUnits = Number(rawSales.regularUnits ?? 0);
        const towerUnits = Number(rawSales.towerUnits ?? 0);
        const otherUnits = Number(rawSales.otherUnits ?? 0);
        salesBreakdown = {
          ...rawSales,
          totalUnits: roundDecimal(regularUnits + towerUnits + otherUnits),
        };
      }
      const soldMl = Number(salesBreakdown?.soldMl ?? 0);
      const lossMl = Math.max(capacityMl - soldMl, 0);
      const overageMl = Math.max(soldMl - capacityMl, 0);

      return NextResponse.json({
        ok: true,
        dryRun: true,
        actorUsername: auth.actor.username,
        itemId,
        currentQuantity,
        projectedQuantity: roundQuantity(currentQuantity - 1),
        activeSessionId: activeSession ? Number(activeSession.id) : null,
        replacementAt: replacementAt.toISOString(),
        businessDate,
        capacityMl,
        soldMl,
        lossMl,
        overageMl,
        usagePercent:
          capacityMl > 0 ? roundDecimal((soldMl / capacityMl) * 100) : 0,
        salesBreakdown,
        writesPerformed: false,
      });
    }

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
