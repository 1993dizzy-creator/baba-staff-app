import "server-only";
import { NextResponse } from "next/server";
import { BUSINESS_TIMEZONE_OFFSET } from "@/lib/common/business-time";
import { resolveInventoryBusinessDate } from "@/lib/inventory/inventory-business-time";
import { supabaseServer } from "@/lib/supabase/server";

export function parseKegSafetyTime(value: unknown, defaultNow = false) {
    if (value == null || value === "") return defaultNow ? new Date() : null;
    if (typeof value !== "string") return null;
    const raw = value.trim();
    const parts = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?$/);
    if (!parts || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4] ?? 0) > 59) return null;
    const day = new Date(`${parts[1]}T00:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0,10) !== parts[1]) return null;
    const date = new Date(parts[5] ? raw : `${raw}${parts[4] ? "" : ":00"}${BUSINESS_TIMEZONE_OFFSET}`);
    return Number.isFinite(date.getTime()) ? date : null;
}

export async function runKegSafetyChange(options: {
    action: "replace" | "edit-start"; itemId: number | null; sessionId: number | null;
    actorUsername: string; body: Record<string, unknown>;
}) {
    const { action, itemId, sessionId, actorUsername, body } = options;
    const dryRun = body?.dryRun === true;
    const at = parseKegSafetyTime(action === "replace" ? body.replacementAt ?? body.replacementLocalDateTime : body.startedAt ?? body.startedLocalDateTime, dryRun && action === "replace");
    const expectedQuantity = body.expectedQuantity == null || body.expectedQuantity === "" ? null : Number(body.expectedQuantity);
    if (!at || (expectedQuantity !== null && !Number.isFinite(expectedQuantity))) {
        return NextResponse.json({ ok: false, code: "KEG_INVALID_REQUEST" }, { status: 400 });
    }
    if (at.getTime() > Date.now()) return NextResponse.json({ ok: false, code: "KEG_FUTURE_TIME" }, { status: 400 });
    if (!dryRun && (typeof body.requestId !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(body.requestId) ||
        typeof body.previewToken !== "string" || !/^[\da-f]{64}$/i.test(body.previewToken) ||
        (body.reason != null && typeof body.reason !== "string") || String(body.reason ?? "").length > 500)) {
        return NextResponse.json({ ok: false, code: "KEG_INVALID_REQUEST" }, { status: 400 });
    }
    const businessDate = (await resolveInventoryBusinessDate(at)).businessDate;
    const args = { p_action: action, p_item_id: itemId, p_session_id: sessionId, p_at: at.toISOString(), p_business_date: businessDate,
        p_actor_username: actorUsername, p_expected_quantity: expectedQuantity };
    const { data, error } = dryRun
        ? await supabaseServer.rpc("inventory_preview_keg_change", args)
        : await supabaseServer.rpc("inventory_apply_keg_change", { ...args, p_preview_token: body.previewToken,
            p_request_id: body.requestId, p_reason: String(body.reason ?? "").trim(), p_confirm: body.confirmed === true });
    if (error) {
        const code = error.message.match(/KEG_[A-Z_]+/)?.[0] ?? "KEG_SAFETY_UNAVAILABLE";
        const status = code === "KEG_SAFETY_UNAVAILABLE" ? 503 : code.endsWith("NOT_FOUND") ? 404
            : code === "KEG_INVALID_ACTOR" ? 403 : ["KEG_FUTURE_TIME", "KEG_INVALID_REQUEST", "KEG_INVALID_CAPACITY", "KEG_BUSINESS_DATE_MISMATCH"].includes(code) ? 400 : 409;
        return NextResponse.json({ ok: false, code }, { status });
    }
    if (!data || typeof data !== "object") return NextResponse.json({ ok: false, code: "KEG_SAFETY_UNAVAILABLE" }, { status: 503 });
    return NextResponse.json(data);
}
