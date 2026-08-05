import "server-only";

import { supabaseServer } from "@/lib/supabase/server";

// attendance_record_audit_logs.action은 이 값들과 cancel_check_in/cancel_check_out/
// cancel_leave(취소 RPC 전용), normalize_late/normalize_early_leave/policy_recalculation
// (다른 흐름에서 예약된 값)로 제한된다. 이 모듈은 일반 관리자 보정과 자동보정만 다룬다.
export type AttendanceAuditAction = "manual_update" | "auto_close";

export type AttendanceAuditLogEntry = {
  attendanceRecordId: number | null;
  sourceAttendanceRecordId: number | null;
  targetUserId: number;
  workDate: string;
  action: AttendanceAuditAction;
  actorUserId: number;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  reason: string | null;
};

// attendance_record_audit_logs 테이블과 service_role insert 권한은
// 202607240001/202607240003 마이그레이션에서 이미 만들어졌다(다른 목적으로 예약된 채
// 실제로는 아무 코드도 기록하지 않고 있었다). 새 Migration이나 RPC 없이, 기존 스키마와
// 권한 그대로 이 함수만 추가해 관리자 보정 mutation에 감사 이력을 남긴다.
//
// 감사 로그 기록은 부가 정보이므로, 실패해도 이미 커밋된 attendance_records 보정 자체를
// 되돌리거나 API 응답을 실패시키지 않는다(best-effort insert).
export async function recordAttendanceAuditLog(
  entry: AttendanceAuditLogEntry
): Promise<void> {
  const { error } = await supabaseServer.from("attendance_record_audit_logs").insert({
    attendance_record_id: entry.attendanceRecordId,
    source_attendance_record_id: entry.sourceAttendanceRecordId,
    target_user_id: entry.targetUserId,
    work_date: entry.workDate,
    action: entry.action,
    actor_user_id: entry.actorUserId,
    before_snapshot: entry.beforeSnapshot,
    after_snapshot: entry.afterSnapshot,
    reason: entry.reason,
  });

  if (error) {
    console.error("[attendance-audit-log] insert failed", {
      action: entry.action,
      targetUserId: entry.targetUserId,
      workDate: entry.workDate,
      code: error.code,
      message: error.message,
    });
  }
}
