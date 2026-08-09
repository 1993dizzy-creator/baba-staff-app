import { NextResponse } from "next/server";
import { canMutateStoreSettings, getStoreSettingsActor } from "@/lib/store-settings/server";
import { prepareHolidayCalendar } from "@/lib/store-settings/holidays-server";
import {
  resolveVietnamHolidayPreparation,
  type NationalDayOption,
  type TetOption,
} from "@/lib/store-settings/vietnam-holiday-calendar";

// 다음 연도 법정공휴일 준비 — /api/admin/store-settings/holidays(날짜 1개 토글)와는
// 완전히 다른 동작(연도 전체 생성)이라 별도 route로 분리한다. 인증/mutate 권한은
// 기존 getStoreSettingsActor()/canMutateStoreSettings()를 그대로 재사용한다.
//
// 이미 존재하는 연도는 이 route가 절대 덮어쓰지 않는다 — RPC 자체가 먼저 확인해
// year_already_exists를 반환하고, 이 route는 그 결과를 그대로 409로 옮길 뿐이다.

export const dynamic = "force-dynamic";

function isValidYear(value: number) {
  return Number.isSafeInteger(value) && value >= 2020 && value <= 2100;
}

export async function POST(request: Request) {
  try {
    const auth = await getStoreSettingsActor();
    if (auth.response || !auth.actor) return auth.response;
    if (!canMutateStoreSettings(auth.actor)) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN" }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const allowedKeys = new Set([
      "year",
      "tetOption",
      "nationalDayOption",
    ]);
    const year = Number(body?.year);
    const tetOption = body?.tetOption;
    const nationalDayOption = body?.nationalDayOption;
    if (
      !body ||
      Object.keys(body).some((key) => !allowedKeys.has(key)) ||
      !isValidYear(year) ||
      !(["before1", "before2", "before3"] as unknown[]).includes(tetOption) ||
      !(["before", "after"] as unknown[]).includes(nationalDayOption)
    ) {
      return NextResponse.json({ ok: false, code: "INVALID_PREPARE_REQUEST" }, { status: 400 });
    }

    const calculated = resolveVietnamHolidayPreparation(
      year,
      tetOption as TetOption,
      nationalDayOption as NationalDayOption
    );
    const result = await prepareHolidayCalendar(
      {
        year,
        ...calculated,
        // 사전 준비 단계에는 공식 발표 메타데이터를 받지 않는다. 기존 RPC 시그니처와
        // 향후 별도 공식 발표 확인/정정 기능을 위해 컬럼과 파라미터는 그대로 둔다.
        sourceUrl: null,
        sourcePublishedAt: null,
      },
      auth.actor.id
    );

    if (result.status !== "ok") {
      const statusMap: Record<string, number> = {
        forbidden: 403,
        invalid_year: 400,
        year_already_exists: 409,
        invalid_dates: 400,
        invalid_national_day_adjacent: 400,
      };
      return NextResponse.json(
        { ok: false, code: result.status.toUpperCase() },
        { status: statusMap[result.status] ?? 400 }
      );
    }

    return NextResponse.json(
      { ok: true, year: result.year },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[STORE_HOLIDAYS_PREPARE_YEAR_FAILED]", error);
    return NextResponse.json({ ok: false, code: "STORE_HOLIDAYS_PREPARE_FAILED" }, { status: 500 });
  }
}
