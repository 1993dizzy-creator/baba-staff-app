import { resolveAttendanceRecordsPolicy } from "@/lib/attendance/api-policy";
import {
  attendanceAuthFailure,
  attendanceJson,
  requireAttendanceActor,
} from "@/lib/attendance/server-api";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(req: Request) {
  try {
    const auth = await requireAttendanceActor();
    if (!auth.ok) return attendanceAuthFailure(auth);

    const policy = resolveAttendanceRecordsPolicy({
      searchParams: new URL(req.url).searchParams,
      actorId: auth.actor.id,
      actorRole: auth.actor.role,
    });
    if (!policy.ok) {
      return attendanceJson({ ok: false, code: policy.code }, policy.status);
    }

    if (policy.scope === "admin_user_month") {
      const { data: target, error: targetError } = await supabaseServer
        .from("users")
        .select("id")
        .eq("id", policy.userId!)
        .maybeSingle();
      if (targetError) {
        console.error("attendance target user error:", targetError);
        return attendanceJson(
          { ok: false, message: "직원 확인 중 오류가 발생했습니다." },
          500
        );
      }
      if (!target) {
        return attendanceJson(
          { ok: false, code: "INVALID_TARGET_USER" },
          400
        );
      }
    }

    let query = supabaseServer
      .from("attendance_records")
      .select(policy.projection);

    if (policy.userId !== undefined) query = query.eq("user_id", policy.userId);
    if (policy.workDate) query = query.eq("work_date", policy.workDate);
    if (policy.startDate) query = query.gte("work_date", policy.startDate);
    if (policy.endDate) query = query.lte("work_date", policy.endDate);
    if (policy.status) query = query.eq("status", policy.status);

    const { data, error } = await query.order("work_date", { ascending: true });
    if (error) {
      console.error("attendance records error:", error);
      return attendanceJson(
        {
          ok: false,
          message: "근태 기록 조회 중 오류가 발생했습니다.",
        },
        500
      );
    }

    return attendanceJson({ ok: true, records: data ?? [] });
  } catch (err) {
    console.error("attendance records exception:", err);
    return attendanceJson(
      {
        ok: false,
        message: "근태 기록 처리 중 오류가 발생했습니다.",
      },
      500
    );
  }
}
