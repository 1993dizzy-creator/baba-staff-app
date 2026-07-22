import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  ATTENDANCE_STATUS,
  APPROVAL_STATUS,
  LEAVE_ACTION,
} from "@/lib/attendance/status";
import { isAttendanceAdminRole } from "@/lib/attendance/api-policy";
import {
  attendanceAuthFailure,
  attendanceJson,
  requireAttendanceActor,
} from "@/lib/attendance/server-api";

const messages = {
  ko: {
    missingAction: "요청 구분이 없습니다.",
    missingRecord: "휴무 신청 정보가 없습니다.",
    noPermission: "권한이 없습니다.",
    updateError: "휴무 승인 처리 중 오류가 발생했습니다.",
    noTarget: "처리된 휴무 신청이 없습니다.",
    successApprove: "휴무 승인되었습니다.",
    successCancelApproval: "휴무 승인이 취소되었습니다.",
    exception: "휴무 승인 처리 중 오류가 발생했습니다.",
  },
  vi: {
    missingAction: "Không có loại yêu cầu.",
    missingRecord: "Không có thông tin yêu cầu nghỉ.",
    noPermission: "Không có quyền.",
    updateError: "Đã xảy ra lỗi khi xử lý duyệt nghỉ.",
    noTarget: "Không có yêu cầu nghỉ nào được xử lý.",
    successApprove: "Đã duyệt ngày nghỉ.",
    successCancelApproval: "Đã hủy duyệt ngày nghỉ.",
    exception: "Đã xảy ra lỗi khi xử lý duyệt nghỉ.",
  },
} as const;

type Lang = keyof typeof messages;
const MUTATION_RECORD_FIELDS =
  "id,user_id,work_date,status,note,approval_status,approved_by,approved_at,created_at,updated_at";

function getLang(value: unknown): Lang {
  return value === "vi" ? "vi" : "ko";
}

export async function POST(req: Request) {
  let lang: Lang = "ko";

  try {
    const auth = await requireAttendanceActor();
    if (!auth.ok) return attendanceAuthFailure(auth);
    if (!isAttendanceAdminRole(auth.actor.role)) {
      return attendanceJson({ ok: false, code: "FORBIDDEN", message: messages[lang].noPermission }, 403);
    }

    const body = await req.json();
    lang = getLang(body.language);

    const { action, record_id } = body;

    if (!action) {
      return NextResponse.json(
        { ok: false, message: messages[lang].missingAction },
        { status: 400 }
      );
    }

    if (!record_id) {
      return NextResponse.json(
        { ok: false, message: messages[lang].missingRecord },
        { status: 400 }
      );
    }

    if (action === LEAVE_ACTION.APPROVE) {
      const { data, error } = await supabaseServer
        .from("attendance_records")
        .update({
          approval_status: APPROVAL_STATUS.APPROVED,
          approved_by: auth.actor.name || auth.actor.username,
          approved_at: new Date().toISOString(),
        })
        .eq("id", record_id)
        .eq("status", ATTENDANCE_STATUS.LEAVE)
        .or(`approval_status.eq.${APPROVAL_STATUS.PENDING},approval_status.is.null`)
        .select(MUTATION_RECORD_FIELDS)
        .maybeSingle();

      if (error) {
        console.error("leave approve error:", error);
        return NextResponse.json(
          { ok: false, message: messages[lang].updateError },
          { status: 500 }
        );
      }

      if (!data) {
        return NextResponse.json(
          { ok: false, message: messages[lang].noTarget },
          { status: 404 }
        );
      }

      return NextResponse.json({
        ok: true,
        message: messages[lang].successApprove,
        record: data,
      });
    }

    if (action === LEAVE_ACTION.CANCEL_APPROVAL) {
      const { data, error } = await supabaseServer
        .from("attendance_records")
        .update({
          approval_status: APPROVAL_STATUS.PENDING,
          approved_by: null,
          approved_at: null,
        })
        .eq("id", record_id)
        .eq("status", ATTENDANCE_STATUS.LEAVE)
        .eq("approval_status", APPROVAL_STATUS.APPROVED)
        .select(MUTATION_RECORD_FIELDS)
        .maybeSingle();

      if (error) {
        console.error("leave cancel approval error:", error);
        return NextResponse.json(
          { ok: false, message: messages[lang].updateError },
          { status: 500 }
        );
      }

      if (!data) {
        return NextResponse.json(
          { ok: false, message: messages[lang].noTarget },
          { status: 404 }
        );
      }

      return NextResponse.json({
        ok: true,
        message: messages[lang].successCancelApproval,
        record: data,
      });
    }

    return NextResponse.json(
      { ok: false, message: messages[lang].missingAction },
      { status: 400 }
    );
  } catch (err) {
    console.error("leave admin exception:", err);

    return NextResponse.json(
      { ok: false, message: messages[lang].exception },
      { status: 500 }
    );
  }
}
