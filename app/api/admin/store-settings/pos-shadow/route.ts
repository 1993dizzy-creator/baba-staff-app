import { NextResponse } from "next/server";
import { isStoreDateKey } from "@/lib/store-settings/business-time-core";
import { loadBusinessTimeAdapter } from "@/lib/store-settings/business-time-adapter";
import { runPosShadow } from "@/lib/store-settings/pos-shadow-server";
import { canMutateStoreSettings, getStoreSettingsActor } from "@/lib/store-settings/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

export async function POST(request: Request) {
  let businessDate: string | undefined;
  try {
    const auth = await getStoreSettingsActor();
    if (!auth.actor) return auth.response;
    if (!canMutateStoreSettings(auth.actor)) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN" }, { status: 403 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const unsupported = Object.keys(body).filter((key) => !["businessDate", "limit"].includes(key));
    if (unsupported.length > 0) {
      return NextResponse.json({ ok: false, code: "INVALID_REQUEST" }, { status: 400 });
    }
    if (body.businessDate !== undefined && (typeof body.businessDate !== "string" || !isStoreDateKey(body.businessDate))) {
      return NextResponse.json({ ok: false, code: "INVALID_BUSINESS_DATE" }, { status: 400 });
    }
    const limit = body.limit === undefined ? DEFAULT_LIMIT : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return NextResponse.json({ ok: false, code: "INVALID_LIMIT" }, { status: 400 });
    }

    businessDate = body.businessDate as string | undefined;
    if (!businessDate) {
      businessDate = (await loadBusinessTimeAdapter(new Date())).databaseBusinessDate;
    }
    const result = await runPosShadow({ businessDate, limit });
    if (result.status !== "ready") {
      console.warn("[POS_STORE_SETTINGS_SHADOW]", JSON.stringify({
        businessDate,
        revision: result.setting.revision,
        isFallback: result.setting.isFallback,
        status: result.status,
        mismatchKinds: result.mismatchKinds,
        limitReached: result.cukcuk.limitReached,
        detailFailureCount: result.cukcuk.detailFailureCount,
        missingTimestampCount: result.cukcuk.missingTimestampCount,
      }));
    }
    return NextResponse.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "POS_SHADOW_FAILED";
    const isCukcukError = code.startsWith("CUKCUK_");
    console.error("[POS_STORE_SETTINGS_SHADOW_ERROR]", JSON.stringify({ businessDate, code }));
    return NextResponse.json(
      { ok: false, code: isCukcukError ? "CUKCUK_READ_FAILED" : "POS_SHADOW_FAILED", status: "error" },
      { status: isCukcukError ? 502 : 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
