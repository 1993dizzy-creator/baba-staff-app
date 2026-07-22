import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  ATTENDANCE_STATUS,
  APPROVAL_STATUS,
  LEAVE_ACTION,
} from "@/lib/attendance/status";
import { validateLeaveRequestTarget } from "@/lib/attendance/api-policy";
import { canCancelOwnLeave } from "@/lib/attendance/mutation-policy";
import {
  attendanceAuthFailure,
  attendanceJson,
  requireAttendanceActor,
} from "@/lib/attendance/server-api";

const messages = {
  ko: {
    missingAction: "요청 구분이 없습니다.",
    missingUser: "사용자 정보가 없습니다.",
    missingDate: "휴무 날짜가 없습니다.",
    existingError: "휴무 신청 확인 중 오류가 발생했습니다.",
    alreadyRequested: "이미 휴무 신청이 있습니다.",
    blockedByWork:
      "이미 출근 또는 근무 기록이 있는 날짜에는 휴무를 신청할 수 없습니다. 관리자에게 근태 보정을 요청해주세요.",
    createError: "휴무 신청 저장 중 오류가 발생했습니다.",
    cancelError: "휴무 신청 취소 중 오류가 발생했습니다.",
    noCancelTarget: "취소할 휴무 신청이 없습니다.",
    successRequest: "휴무 신청되었습니다.",
    successCancel: "휴무 신청이 취소되었습니다.",
    exception: "휴무 처리 중 오류가 발생했습니다.",
  },
  vi: {
    missingAction: "Không có loại yêu cầu.",
    missingUser: "Không có thông tin người dùng.",
    missingDate: "Không có ngày nghỉ.",
    existingError: "Đã xảy ra lỗi khi kiểm tra yêu cầu nghỉ.",
    alreadyRequested: "Đã có yêu cầu nghỉ cho ngày này.",
    blockedByWork:
      "Không thể đăng ký nghỉ vào ngày đã có dữ liệu chấm công hoặc đang làm việc. Vui lòng liên hệ quản lý để điều chỉnh chấm công.",
    createError: "Đã xảy ra lỗi khi lưu yêu cầu nghỉ.",
    cancelError: "Đã xảy ra lỗi khi hủy yêu cầu nghỉ.",
    noCancelTarget: "Không có yêu cầu nghỉ để hủy.",
    successRequest: "Đã đăng ký nghỉ.",
    successCancel: "Đã hủy yêu cầu nghỉ.",
    exception: "Đã xảy ra lỗi khi xử lý nghỉ.",
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

    const body = await req.json();
    lang = getLang(body.language);

    const { action, user_id, work_date, record_id, note } = body;

    if (!action) {
      return NextResponse.json(
        { ok: false, message: messages[lang].missingAction },
        { status: 400 }
      );
    }

    if (action === LEAVE_ACTION.REQUEST) {
      const target = validateLeaveRequestTarget(auth.actor.id, user_id);
      if (!target.ok) return attendanceJson({ ok: false, code: target.code }, target.status);
      const userId = target.userId;

      if (!work_date) {
        return NextResponse.json(
          { ok: false, message: messages[lang].missingDate },
          { status: 400 }
        );
      }

      const { data: existing, error: existingError } = await supabaseServer
        .from("attendance_records")
        .select("id, status, check_in_at")
        .eq("user_id", userId)
        .eq("work_date", work_date)
        .maybeSingle();

      if (existingError) {
        console.error("leave existing error:", existingError);
        return NextResponse.json(
          { ok: false, message: messages[lang].existingError },
          { status: 500 }
        );
      }

      if (existing?.status === ATTENDANCE_STATUS.LEAVE) {
        return NextResponse.json(
          { ok: false, message: messages[lang].alreadyRequested },
          { status: 409 }
        );
      }

      const workInProgressStatuses: string[] = [
        ATTENDANCE_STATUS.WORKING,
        ATTENDANCE_STATUS.DONE,
        ATTENDANCE_STATUS.LATE,
        ATTENDANCE_STATUS.EARLY_LEAVE,
      ];

      if (
        existing &&
        (Boolean(existing.check_in_at) ||
          workInProgressStatuses.includes(existing.status))
      ) {
        return NextResponse.json(
          { ok: false, message: messages[lang].blockedByWork },
          { status: 409 }
        );
      }

      const { data, error } = await supabaseServer
        .from("attendance_records")
        .insert({
          user_id: userId,
          work_date,
          status: ATTENDANCE_STATUS.LEAVE,
          note: note || "",
          approval_status: APPROVAL_STATUS.PENDING,
        })
        .select(MUTATION_RECORD_FIELDS)
        .single();

      if (error) {
        console.error("leave create error:", error);
        return NextResponse.json(
          { ok: false, message: messages[lang].createError },
          { status: 500 }
        );
      }

      return NextResponse.json({
        ok: true,
        message: messages[lang].successRequest,
        record: data,
      });
    }

   if (action === LEAVE_ACTION.CANCEL) {
      if (!record_id) {
        return NextResponse.json(
          { ok: false, message: messages[lang].noCancelTarget },
          { status: 400 }
        );
      }

      const { data: targetRecord, error: targetError } = await supabaseServer
        .from("attendance_records")
        .select("id,user_id,status,approval_status")
        .eq("id", record_id)
        .eq("status", ATTENDANCE_STATUS.LEAVE)
        .maybeSingle();

      if (targetError) {
        console.error("leave cancel target error:", targetError);
        return NextResponse.json(
          { ok: false, message: messages[lang].cancelError },
          { status: 500 }
        );
      }
      if (!targetRecord) {
        return NextResponse.json(
          { ok: false, message: messages[lang].noCancelTarget },
          { status: 404 }
        );
      }
      if (!canCancelOwnLeave({
        actorId: auth.actor.id,
        recordUserId: targetRecord.user_id,
      })) {
        return attendanceJson({ ok: false, code: "FORBIDDEN" }, 403);
      }

      const { data, error } = await supabaseServer
        .from("attendance_records")
        .delete()
        .eq("id", record_id)
        .eq("user_id", auth.actor.id)
        .eq("status", ATTENDANCE_STATUS.LEAVE)
        .select(MUTATION_RECORD_FIELDS)
        .maybeSingle();

      if (error) {
        console.error("leave cancel error:", error);
        return NextResponse.json(
          { ok: false, message: messages[lang].cancelError },
          { status: 500 }
        );
      }

      if (!data) {
        return NextResponse.json(
          { ok: false, message: messages[lang].noCancelTarget },
          { status: 404 }
        );
      }

      return NextResponse.json({
        ok: true,
        message: messages[lang].successCancel,
        record: data,
      });
    }

    return NextResponse.json(
      { ok: false, message: messages[lang].missingAction },
      { status: 400 }
    );
  } catch (err) {
    console.error("leave exception:", err);

    return NextResponse.json(
      { ok: false, message: messages[lang].exception },
      { status: 500 }
    );
  }
}
