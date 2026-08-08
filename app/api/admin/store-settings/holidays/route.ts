import { NextResponse } from "next/server";
import { canMutateStoreSettings, getStoreSettingsActor } from "@/lib/store-settings/server";
import { loadHolidayCalendar, toggleHolidayOperationPolicy } from "@/lib/store-settings/holidays-server";

// 매장 공휴일 관리 — store_setting_versions와 독립된 모듈이므로 기존
// /api/admin/store-settings에 합치지 않고 별도 route로 둔다. 인증/mutate 권한은
// 기존 getStoreSettingsActor()/canMutateStoreSettings()를 그대로 재사용한다.
//
// POST는 날짜 1개(holidayId)의 BABA 내부 "매장 영업 + 200% 적용" 선택을 즉시
// 저장/해제한다 — 법정공휴일 원본(store_holidays)은 절대 지우지 않는다.

export const dynamic = "force-dynamic";

function isValidYear(value: number) {
  return Number.isSafeInteger(value) && value >= 2020 && value <= 2100;
}

export async function GET(request: Request) {
  try {
    const auth = await getStoreSettingsActor();
    if (auth.response || !auth.actor) return auth.response;
    const yearParam = new URL(request.url).searchParams.get("year");
    const year = Number(yearParam);
    if (!yearParam || !isValidYear(year)) {
      return NextResponse.json({ ok: false, code: "INVALID_YEAR" }, { status: 400 });
    }
    const { calendar, holidays } = await loadHolidayCalendar(year);
    return NextResponse.json(
      {
        ok: true,
        year,
        calendar,
        holidays,
        capabilities: { mutate: canMutateStoreSettings(auth.actor) },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[STORE_HOLIDAYS_GET_FAILED]", error);
    return NextResponse.json({ ok: false, code: "STORE_HOLIDAYS_LOAD_FAILED" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await getStoreSettingsActor();
    if (auth.response || !auth.actor) return auth.response;
    if (!canMutateStoreSettings(auth.actor)) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN" }, { status: 403 });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const allowedKeys = new Set(["holidayId", "selected"]);
    const holidayId = Number(body?.holidayId);
    const selected = body?.selected;
    if (
      !body ||
      Object.keys(body).some((key) => !allowedKeys.has(key)) ||
      !Number.isSafeInteger(holidayId) ||
      holidayId < 1 ||
      typeof selected !== "boolean"
    ) {
      return NextResponse.json({ ok: false, code: "INVALID_HOLIDAY_REQUEST" }, { status: 400 });
    }
    const result = await toggleHolidayOperationPolicy(holidayId, selected, auth.actor.id);
    if (result.status !== "ok") {
      const statusMap: Record<string, number> = {
        forbidden: 403,
        not_found: 404,
        invalid_request: 400,
      };
      return NextResponse.json(
        { ok: false, code: result.status.toUpperCase() },
        { status: statusMap[result.status] ?? 400 }
      );
    }
    return NextResponse.json(
      {
        ok: true,
        holidayId: result.holidayId,
        selected: result.selected,
        internalPayMultiplier: result.internalPayMultiplier,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[STORE_HOLIDAYS_TOGGLE_FAILED]", error);
    return NextResponse.json({ ok: false, code: "STORE_HOLIDAYS_SAVE_FAILED" }, { status: 500 });
  }
}
