import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  ATTENDANCE_STATUS,
  APPROVAL_STATUS,
  LEAVE_ACTION,
} from "@/lib/attendance/status";

const messages = {
  ko: {
    missingAction: "요청 구분이 없습니다.",
    missingUser: "사용자 정보가 없습니다.",
    missingDate: "휴무 날짜가 없습니다.",
    existingError: "휴무 신청 확인 중 오류가 발생했습니다.",
    alreadyRequested: "이미 휴무 신청이 있습니다.",
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
    createError: "Đã xảy ra lỗi khi lưu yêu cầu nghỉ.",
    cancelError: "Đã xảy ra lỗi khi hủy yêu cầu nghỉ.",
    noCancelTarget: "Không có yêu cầu nghỉ để hủy.",
    successRequest: "Đã đăng ký nghỉ.",
    successCancel: "Đã hủy yêu cầu nghỉ.",
    exception: "Đã xảy ra lỗi khi xử lý nghỉ.",
  },
} as const;

type Lang = keyof typeof messages;

function getLang(value: unknown): Lang {
  return value === "vi" ? "vi" : "ko";
}

export async function POST(req: Request) {
  let lang: Lang = "ko";

  try {
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
      if (!user_id) {
        return NextResponse.json(
          { ok: false, message: messages[lang].missingUser },
          { status: 400 }
        );
      }

      if (!work_date) {
        return NextResponse.json(
          { ok: false, message: messages[lang].missingDate },
          { status: 400 }
        );
      }

      const { data: existing, error: existingError } = await supabaseServer
        .from("attendance_records")
        .select("id")
        .eq("user_id", user_id)
        .eq("work_date", work_date)
        .eq("status", ATTENDANCE_STATUS.LEAVE)
        .maybeSingle();

      if (existingError) {
        console.error("leave existing error:", existingError);
        return NextResponse.json(
          { ok: false, message: messages[lang].existingError },
          { status: 500 }
        );
      }

      if (existing) {
        return NextResponse.json(
          { ok: false, message: messages[lang].alreadyRequested },
          { status: 409 }
        );
      }

      const { data, error } = await supabaseServer
        .from("attendance_records")
        .insert({
          user_id,
          work_date,
          status: ATTENDANCE_STATUS.LEAVE,
          note: note || "",
          approval_status: APPROVAL_STATUS.PENDING,
        })
        .select()
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

      const { data, error } = await supabaseServer
        .from("attendance_records")
        .delete()
        .eq("id", record_id)
        .eq("status", ATTENDANCE_STATUS.LEAVE)
        .select("id");

      if (error) {
        console.error("leave cancel error:", error);
        return NextResponse.json(
          { ok: false, message: messages[lang].cancelError },
          { status: 500 }
        );
      }

      if (!data || data.length === 0) {
        return NextResponse.json(
          { ok: false, message: messages[lang].noCancelTarget },
          { status: 404 }
        );
      }

      return NextResponse.json({
        ok: true,
        message: messages[lang].successCancel,
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