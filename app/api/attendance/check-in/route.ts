import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  getAttendanceWorkDate,
  getLateMinutes,
} from "@/lib/attendance/time";
import {
  ATTENDANCE_STATUS,
  APPROVAL_STATUS,
} from "@/lib/attendance/status";

const messages = {
  ko: {
    missingUser: "사용자 정보가 없습니다.",
    invalidLocation: "매장 위치에서만 출근할 수 있습니다.",
    userError: "사용자 조회 중 오류가 발생했습니다.",
    inactiveUser: "활성화된 사용자가 아닙니다.",
    existingError: "출근 기록 확인 중 오류가 발생했습니다.",
    alreadyCheckedIn: "이미 출근 처리되었습니다.",
    blockedByLeave:
      "해당 날짜에 휴무 기록이 있습니다. 휴무 신청을 취소하거나 관리자에게 확인해주세요.",
    unresolvedPreviousShift:
      "이전 근무일의 퇴근 기록이 완료되지 않았습니다. 관리자에게 퇴근시간 보정을 요청해주세요.",
    saveError: "출근 저장 중 오류가 발생했습니다.",
    success: "출근 처리되었습니다.",
    exception: "출근 처리 중 오류가 발생했습니다.",
  },
  vi: {
    missingUser: "Không có thông tin người dùng.",
    invalidLocation: "Chỉ có thể chấm công khi ở tại cửa hàng.",
    userError: "Đã xảy ra lỗi khi kiểm tra người dùng.",
    inactiveUser: "Tài khoản này không hoạt động.",
    existingError: "Đã xảy ra lỗi khi kiểm tra lịch sử chấm công.",
    alreadyCheckedIn: "Bạn đã chấm công vào rồi.",
    blockedByLeave:
      "Ngày này đã có yêu cầu nghỉ. Vui lòng hủy yêu cầu nghỉ hoặc liên hệ quản lý để xác nhận.",
    unresolvedPreviousShift:
      "Ca làm việc trước vẫn chưa có giờ tan ca. Vui lòng yêu cầu quản lý chỉnh lại giờ tan ca.",
    saveError: "Đã xảy ra lỗi khi lưu chấm công vào.",
    success: "Đã chấm công vào thành công.",
    exception: "Đã xảy ra lỗi khi xử lý chấm công vào.",
  },
} as const;

type Lang = keyof typeof messages;
type MessageKey = keyof typeof messages.ko;

function getMessage(lang: Lang, key: MessageKey) {
  return messages[lang][key];
}

function getLang(value: unknown): Lang {
  return value === "vi" ? "vi" : "ko";
}

export async function POST(req: Request) {
  let lang: Lang = "ko";

  try {
    const body = await req.json();
    lang = getLang(body.language);

    const {
      user_id,
      user_name,
      username,
      latitude,
      longitude,
      distance_m,
      is_location_valid,
    } = body;

    if (!user_id || !user_name || !username) {
      return NextResponse.json(
        { ok: false, message: getMessage(lang, "missingUser") },
        { status: 400 }
      );
    }

    if (is_location_valid === false) {
      return NextResponse.json(
        { ok: false, message: getMessage(lang, "invalidLocation") },
        { status: 403 }
      );
    }

    const workDate = getAttendanceWorkDate();
    const nowIso = new Date().toISOString();

    const { data: user, error: userError } = await supabaseServer
      .from("users")
      .select("id, name, username, work_start_time, work_end_time, part, position")
      .eq("id", user_id)
      .eq("is_active", true)
      .maybeSingle();

    if (userError) {
      console.error("check-in user error:", userError);
      return NextResponse.json(
        { ok: false, message: getMessage(lang, "userError") },
        { status: 500 }
      );
    }

    if (!user) {
      return NextResponse.json(
        { ok: false, message: getMessage(lang, "inactiveUser") },
        { status: 403 }
      );
    }

    const { data: openRecord, error: openRecordError } = await supabaseServer
      .from("attendance_records")
      .select("id, work_date, check_in_at")
      .eq("user_id", user_id)
      .not("check_in_at", "is", null)
      .is("check_out_at", null)
      .order("check_in_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (openRecordError) {
      console.error("check-in open record error:", openRecordError);
      return NextResponse.json(
        { ok: false, message: getMessage(lang, "existingError") },
        { status: 500 }
      );
    }

    // 같은 영업일의 미퇴근 기록은 기존 중복 출근 방지 로직(아래 existing 체크)이 처리한다.
    // 그 외(이전 영업일 또는 비정상적인 미래 날짜)의 미퇴근 기록은 신규 출근을 차단한다.
    if (openRecord && openRecord.work_date !== workDate) {
      return NextResponse.json(
        {
          ok: false,
          message: getMessage(lang, "unresolvedPreviousShift"),
          code: "UNRESOLVED_PREVIOUS_SHIFT",
        },
        { status: 409 }
      );
    }

    const { data: existing, error: existingError } = await supabaseServer
      .from("attendance_records")
      .select("*")
      .eq("user_id", user_id)
      .eq("work_date", workDate)
      .maybeSingle();

    if (existingError) {
      console.error("check-in existing error:", existingError);
      return NextResponse.json(
        { ok: false, message: getMessage(lang, "existingError") },
        { status: 500 }
      );
    }

    if (existing?.check_in_at) {
      return NextResponse.json(
        { ok: false, message: getMessage(lang, "alreadyCheckedIn") },
        { status: 409 }
      );
    }

    if (existing?.status === ATTENDANCE_STATUS.LEAVE) {
      return NextResponse.json(
        { ok: false, message: getMessage(lang, "blockedByLeave") },
        { status: 409 }
      );
    }

    const lateMinutes = getLateMinutes(nowIso, user.work_start_time, workDate);

    const status = ATTENDANCE_STATUS.WORKING;

    const payload = {
      user_id,
      work_date: workDate,
      status,
      check_in_at: nowIso,
      late_minutes: lateMinutes,
      check_in_latitude: latitude ?? null,
      check_in_longitude: longitude ?? null,
      check_in_distance_m: distance_m ?? null,
      updated_at: nowIso,
    };

    const { data, error } = existing
      ? await supabaseServer
        .from("attendance_records")
        .update(payload)
        .eq("id", existing.id)
        .select()
        .single()
      : await supabaseServer
        .from("attendance_records")
        .insert({
          ...payload,
          approval_status: APPROVAL_STATUS.APPROVED,
        })
        .select()
        .single();

    if (error) {
      console.error("check-in save error:", error);
      return NextResponse.json(
        { ok: false, message: getMessage(lang, "saveError") },
        { status: 500 }
      );
    }

    await supabaseServer.from("attendance_check_logs").insert({
      user_id: String(user_id),
      user_name,
      username,
      work_date: workDate,
      action: "check_in",
      checked_at: nowIso,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      distance_m: distance_m ?? null,
      is_location_valid: is_location_valid ?? null,
      success: true,
    });

    return NextResponse.json({
      ok: true,
      message: getMessage(lang, "success"),
      record: data,
    });
  } catch (err) {
    console.error("check-in exception:", err);

    return NextResponse.json(
      { ok: false, message: getMessage(lang, "exception") },
      { status: 500 }
    );
  }
}