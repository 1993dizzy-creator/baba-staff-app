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

    let records = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (policy.scope === "admin_user_month") {
      const unauthorizedIds = records
        .filter((record) => record.status === "unauthorized_absence")
        .map((record) => Number(record.id));
      if (unauthorizedIds.length > 0) {
        const { data: logs, error: logError } = await supabaseServer
          .from("attendance_record_audit_logs")
          .select("attendance_record_id,actor_user_id,reason,created_at")
          .eq("action", "set_unauthorized_absence")
          .in("attendance_record_id", unauthorizedIds)
          .order("created_at", { ascending: false });
        if (logError) throw new Error(`UNAUTHORIZED_ABSENCE_AUDIT_READ_FAILED:${logError.code}`);
        const actorIds = [...new Set((logs ?? []).map((log) => Number(log.actor_user_id)).filter(Number.isSafeInteger))];
        const { data: actors, error: actorError } = actorIds.length
          ? await supabaseServer.from("users").select("id,name,username").in("id", actorIds)
          : { data: [], error: null };
        if (actorError) throw new Error(`UNAUTHORIZED_ABSENCE_ACTOR_READ_FAILED:${actorError.code}`);
        const actorsById = new Map((actors ?? []).map((actor) => [Number(actor.id), actor.name || actor.username]));
        const latestByRecord = new Map<number, { actorUserId: number; actorName: string | null; reason: string | null; createdAt: string }>();
        for (const log of logs ?? []) {
          const recordId = Number(log.attendance_record_id);
          if (!latestByRecord.has(recordId)) latestByRecord.set(recordId, {
            actorUserId: Number(log.actor_user_id),
            actorName: actorsById.get(Number(log.actor_user_id)) ?? null,
            reason: log.reason,
            createdAt: log.created_at,
          });
        }
        records = records.map((record) => ({
          ...record,
          unauthorized_absence_audit: latestByRecord.get(Number(record.id)) ?? null,
        }));
      }
    }

    return attendanceJson({ ok: true, records });
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
