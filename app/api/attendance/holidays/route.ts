import {
  attendanceAuthFailure,
  attendanceJson,
  requireAttendanceActor,
} from "@/lib/attendance/server-api";
import { loadHolidaysForMonth } from "@/lib/store-settings/holidays-server";

// /attendance/leave 월간 캘린더용 — 로그인한 정상 사용자면 누구나 조회 가능한 가벼운
// 읽기 전용 endpoint다. owner 권한 API(/api/admin/store-settings/holidays)를 쓰지
// 않고, 근태 화면과 동일한 세션 인증(requireAttendanceActor)만 재사용한다. DB
// mutation은 전혀 하지 않는다.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireAttendanceActor();
    if (!auth.ok) return attendanceAuthFailure(auth);
    const month = new URL(request.url).searchParams.get("month");
    if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return attendanceJson({ ok: false, code: "INVALID_MONTH" }, 400);
    }
    const holidays = await loadHolidaysForMonth(month);
    return attendanceJson({ ok: true, month, holidays }, 200);
  } catch (error) {
    console.error("[ATTENDANCE_HOLIDAYS_GET_FAILED]", error);
    return attendanceJson({ ok: false, code: "ATTENDANCE_HOLIDAYS_LOAD_FAILED" }, 500);
  }
}
