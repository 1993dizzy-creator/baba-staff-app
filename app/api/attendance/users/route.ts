import {
  attendanceAuthFailure,
  attendanceJson,
  requireAttendanceActor,
} from "@/lib/attendance/server-api";
import { supabaseServer } from "@/lib/supabase/server";
import { getAttendanceWorkDate } from "@/lib/attendance/time";
import { isEmployedOn, shouldIncludeMonthlyEmployee } from "@/lib/employment/eligibility";

const BASE_USER_FIELDS =
  "id,username,name,role,is_active,part,position,work_start_time,work_end_time,hire_date,termination_date,is_system_account";

export async function GET(request: Request) {
  try {
    const auth = await requireAttendanceActor();
    if (!auth.ok) return attendanceAuthFailure(auth);

    const fields =
      auth.actor.role === "owner" || auth.actor.role === "master"
        ? `${BASE_USER_FIELDS},birth_date`
        : BASE_USER_FIELDS;
    const search = new URL(request.url).searchParams;
    const mode = search.get("mode") === "month" ? "month" : "current";
    const month = search.get("month");
    if (mode === "month" && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "")) {
      return attendanceJson({ ok: false, code: "INVALID_MONTH" }, 400);
    }
    const { data, error } = await supabaseServer
      .from("users")
      .select(fields)
      .eq("is_system_account", false)
      .order("part", { ascending: true })
      .order("position", { ascending: true })
      .order("name", { ascending: true });

    if (error) {
      console.error("attendance users error:", error);
      return attendanceJson(
        {
          ok: false,
          message: "직원 목록 조회 중 오류가 발생했습니다.",
        },
        500
      );
    }

    const rows = (data ?? []) as unknown as Array<{id:number;is_active:boolean;hire_date:string|null;termination_date:string|null}>;
    if (mode === "current") {
      const date = getAttendanceWorkDate();
      return attendanceJson({ ok: true, users: rows.filter(user => user.is_active === true && isEmployedOn(user, date)) });
    }
    const first = `${month}-01`;
    const next = new Date(`${first}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1); next.setUTCDate(0);
    const last = next.toISOString().slice(0, 10);
    const { data: attendance, error: attendanceError } = await supabaseServer.from("attendance_records").select("user_id").gte("work_date", first).lte("work_date", last);
    if (attendanceError) throw new Error(`Failed to load monthly attendance users: ${attendanceError.message}`);
    const recordedIds = new Set((attendance ?? []).map(row => Number(row.user_id)));
    return attendanceJson({ ok: true, users: rows.filter(user => shouldIncludeMonthlyEmployee(user, month!, recordedIds.has(Number(user.id)))) });
  } catch (err) {
    console.error("attendance users exception:", err);
    return attendanceJson(
      {
        ok: false,
        message: "직원 목록 처리 중 오류가 발생했습니다.",
      },
      500
    );
  }
}
