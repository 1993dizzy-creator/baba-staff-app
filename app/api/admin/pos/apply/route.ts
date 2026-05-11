import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function getLimit(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 100;
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
  return await res.json().catch(() => null);
}

export async function POST(req: Request) {
  const secret = process.env.POS_ADMIN_SECRET;

  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "POS_ADMIN_SECRET is not configured." },
      { status: 503 }
    );
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const businessDate =
    typeof body.businessDate === "string" ? body.businessDate : "";

  const actorUsername =
    typeof body.actorUsername === "string" ? body.actorUsername : "";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return NextResponse.json(
      { ok: false, error: "businessDate 형식이 올바르지 않습니다." },
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
  const limit = getLimit(body.limit);
  const actorName = actor.name || actor.full_name || actor.username;

  const saveDryRunRes = await fetch(
    `${origin}/api/pos/cukcuk/sainvoices/dry-run`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pos-admin-secret": secret,
      },
      body: JSON.stringify({
        businessDate,
        limit,
        saveDryRun: true,
        includeLines: false,
        includeDebug: false,
        actorName,
        actorUsername: actor.username,
      }),
      cache: "no-store",
    }
  );

  const saveDryRunJson = await readJson(saveDryRunRes);

  if (!saveDryRunRes.ok || saveDryRunJson?.ok === false) {
    return NextResponse.json(
      {
        ok: false,
        step: "saveDryRun",
        error:
          saveDryRunJson?.error ||
          saveDryRunJson?.message ||
          `saveDryRun 실패: HTTP ${saveDryRunRes.status}`,
        saveDryRunResult: saveDryRunJson,
      },
      { status: saveDryRunRes.status }
    );
  }

  const applyRes = await fetch(`${origin}/api/pos/cukcuk/sainvoices/apply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-pos-admin-secret": secret,
    },
    body: JSON.stringify({
      businessDate,
      limit,
      actorName,
      actorUsername: actor.username,
    }),
    cache: "no-store",
  });

  const applyJson = await readJson(applyRes);

  if (!applyRes.ok || applyJson?.ok === false) {
    return NextResponse.json(
      {
        ok: false,
        step: "apply",
        error:
          applyJson?.error ||
          applyJson?.message ||
          `apply 실패: HTTP ${applyRes.status}`,
        saveDryRunResult: saveDryRunJson,
        applyResult: applyJson,
      },
      { status: applyRes.status }
    );
  }

  return NextResponse.json({
    ok: true,
    businessDate,
    saveDryRunResult: saveDryRunJson,
    applyResult: applyJson,
  });
}