import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type JsonObject = Record<string, unknown>;

function getLimit(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return 100;
}

function isValidBusinessDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function getAdminActor(actorUsername: string) {
  if (!actorUsername) return null;

  const { data } = await supabaseAdmin
    .from("users")
    .select("id, username, name, full_name, role, is_active")
    .eq("username", actorUsername)
    .eq("is_active", true)
    .maybeSingle();

  if (!data) return null;
  if (data.role !== "owner" && data.role !== "master") return null;

  return data;
}

async function readJson(res: Response) {
  return (await res.json().catch(() => null)) as JsonObject | null;
}

export async function POST(req: Request) {
  try {
    const secret = process.env.POS_ADMIN_SECRET?.trim();

    if (!secret) {
      return NextResponse.json(
        { ok: false, error: "POS_ADMIN_SECRET is not configured." },
        { status: 403 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const businessDate =
      typeof body.businessDate === "string" ? body.businessDate.trim() : "";
    const actorUsername =
      typeof body.actorUsername === "string" ? body.actorUsername.trim() : "";

    if (businessDate && !isValidBusinessDate(businessDate)) {
      return NextResponse.json(
        { ok: false, error: "businessDate must use YYYY-MM-DD format." },
        { status: 400 }
      );
    }

    const actor = await getAdminActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "POS 관리자 권한이 없습니다." },
        { status: 403 }
      );
    }

    const origin = new URL(req.url).origin;
    const syncBody: JsonObject = {
      limit: Math.min(Math.max(getLimit(body.limit), 1), 100),
    };

    if (businessDate) {
      syncBody.businessDate = businessDate;
    }

    const syncRes = await fetch(
      `${origin}/api/pos/cukcuk/sainvoices/sync-to-sales`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pos-admin-secret": secret,
        },
        body: JSON.stringify(syncBody),
        cache: "no-store",
      }
    );

    const syncJson = await readJson(syncRes);

    if (!syncRes.ok || syncJson?.ok === false) {
      return NextResponse.json(
        syncJson ?? {
          ok: false,
          error: `sales sync failed: HTTP ${syncRes.status}`,
        },
        { status: syncRes.status }
      );
    }

    return NextResponse.json(syncJson);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to run sales sync.",
      },
      { status: 500 }
    );
  }
}
