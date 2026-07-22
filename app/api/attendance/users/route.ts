import {
  attendanceAuthFailure,
  attendanceJson,
  requireAttendanceActor,
} from "@/lib/attendance/server-api";
import { supabaseServer } from "@/lib/supabase/server";

const BASE_USER_FIELDS =
  "id,username,name,role,is_active,part,position,work_start_time,work_end_time";

export async function GET() {
  try {
    const auth = await requireAttendanceActor();
    if (!auth.ok) return attendanceAuthFailure(auth);

    const fields =
      auth.actor.role === "owner" || auth.actor.role === "master"
        ? `${BASE_USER_FIELDS},birth_date`
        : BASE_USER_FIELDS;
    const { data, error } = await supabaseServer
      .from("users")
      .select(fields)
      .eq("is_active", true)
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

    return attendanceJson({ ok: true, users: data ?? [] });
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
