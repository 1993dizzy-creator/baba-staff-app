import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requirePosAdminSecret } from "@/lib/pos/api-guard";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function isValidBusinessDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toNullablePositiveInteger(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const numberValue = Number(value);

  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return null;
  }

  return numberValue;
}

export async function POST(req: Request) {
  try {
    const guardResponse = requirePosAdminSecret(req);
    if (guardResponse) return guardResponse;

    if (process.env.POS_APPLY_ENABLED !== "true") {
      return NextResponse.json(
        {
          ok: false,
          error: "POS apply is disabled. Set POS_APPLY_ENABLED=true only when you are ready to apply.",
        },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));

    const businessDate = body.businessDate;
    const limit = toNullablePositiveInteger(body.limit);
    const actorName = body.actorName || "CUKCUK POS";
    const actorUsername = body.actorUsername || "cukcuk_pos";

    if (!isValidBusinessDate(businessDate)) {
      return NextResponse.json(
        {
          ok: false,
          error: "businessDate is required. Format: YYYY-MM-DD",
          example: {
            businessDate: "2026-05-09",
            limit: null,
          },
        },
        { status: 400 }
      );
    }

    const { data, error } = await supabaseAdmin.rpc(
      "apply_pos_direct_inventory_deductions",
      {
        p_business_date: businessDate,
        p_limit: limit,
        p_actor_name: actorName,
        p_actor_username: actorUsername,
      }
    );

    if (error) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          details: error,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      request: {
        businessDate,
        limit,
        actorName,
        actorUsername,
      },
      result: data,
    });
  } catch (error: any) {
    console.error(error);

    return NextResponse.json(
      {
        ok: false,
        error: error?.message || "Unknown POS apply error",
      },
      { status: 500 }
    );
  }
}
