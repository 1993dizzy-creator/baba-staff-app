import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type JsonObject = Record<string, unknown>;

function canSyncPosProducts(role: unknown) {
  return role === "owner" || role === "master" || role === "manager";
}

async function getAdminActor(actorUsername: string) {
  if (!actorUsername) return null;

  const { data } = await supabaseAdmin
    .from("users")
    .select("id, username, role, is_active")
    .eq("username", actorUsername)
    .eq("is_active", true)
    .maybeSingle();

  if (!data || !canSyncPosProducts(data.role)) return null;
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
    const actorUsername =
      typeof body.actorUsername === "string" ? body.actorUsername.trim() : "";
    const actor = await getAdminActor(actorUsername);

    if (!actor) {
      return NextResponse.json(
        { ok: false, error: "No permission" },
        { status: 403 }
      );
    }

    const origin = new URL(req.url).origin;
    const syncRes = await fetch(
      `${origin}/api/pos/products/sync-from-cukcuk`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pos-admin-secret": secret,
        },
        body: JSON.stringify({
          actorUsername: actor.username,
          syncAll: true,
          maxPages: 20,
          includeInactive: true,
          includeDetails: true,
          forceDetailRefresh: true,
        }),
        cache: "no-store",
      }
    );
    const syncJson = await readJson(syncRes);

    if (!syncRes.ok || syncJson?.ok === false) {
      return NextResponse.json(
        syncJson ?? {
          ok: false,
          error: `product sync failed: HTTP ${syncRes.status}`,
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
            : "Failed to run product sync.",
      },
      { status: 500 }
    );
  }
}
