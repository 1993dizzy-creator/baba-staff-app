import { isAttendanceAdminRole } from "@/lib/attendance/api-policy";
import {
  attendanceAuthFailure,
  attendanceJson,
  requireAttendanceActor,
} from "@/lib/attendance/server-api";
import {
  APPROVAL_STATUS,
  ATTENDANCE_STATUS,
} from "@/lib/attendance/status";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await requireAttendanceActor();
    if (!auth.ok) return attendanceAuthFailure(auth);

    if (!isAttendanceAdminRole(auth.actor.role)) {
      return attendanceJson({ ok: false, code: "FORBIDDEN" }, 403);
    }

    const { data, count, error } = await supabaseServer
      .from("attendance_records")
      .select("work_date", { count: "exact" })
      .eq("status", ATTENDANCE_STATUS.LEAVE)
      .eq("approval_status", APPROVAL_STATUS.PENDING)
      .order("work_date", { ascending: true })
      .limit(1);

    if (error) {
      console.error("pending leave summary error:", {
        code: error.code,
        message: error.message,
      });
      return attendanceJson(
        { ok: false, code: "PENDING_LEAVE_SUMMARY_FAILED" },
        500
      );
    }

    const pendingCount = count ?? 0;
    return attendanceJson({
      ok: true,
      pendingCount,
      hasPending: pendingCount > 0,
      oldestWorkDate: data?.[0]?.work_date ?? null,
    });
  } catch (error) {
    console.error("pending leave summary exception:", error);
    return attendanceJson(
      { ok: false, code: "PENDING_LEAVE_SUMMARY_FAILED" },
      500
    );
  }
}
