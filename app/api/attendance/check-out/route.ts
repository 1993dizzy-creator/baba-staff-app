import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  getAttendanceWorkDate,
  getEarlyLeaveMinutes,
  getMinutesDiff,
  getStatusByMinutes,
} from "@/lib/attendance/time";
import { ATTENDANCE_STATUS } from "@/lib/attendance/status";

const messages = {
  ko: {
    missingUser: "사용자 정보가 없습니다.",
    invalidLocation: "매장 위치에서만 퇴근할 수 있습니다.",
    userError: "사용자 조회 중 오류가 발생했습니다.",
    inactiveUser: "활성화된 사용자가 아닙니다.",
    existingError: "출근 기록 확인 중 오류가 발생했습니다.",
    noCheckIn: "출근 기록이 없습니다.",
    alreadyCheckedOut: "이미 퇴근 처리되었습니다.",
    saveError: "퇴근 저장 중 오류가 발생했습니다.",
    success: "퇴근 처리되었습니다.",
    exception: "퇴근 처리 중 오류가 발생했습니다.",
  },
  vi: {
    missingUser: "Không có thông tin người dùng.",
    invalidLocation: "Chỉ có thể chấm công ra khi ở tại cửa hàng.",
    userError: "Đã xảy ra lỗi khi kiểm tra người dùng.",
    inactiveUser: "Tài khoản này không hoạt động.",
    existingError: "Đã xảy ra lỗi khi kiểm tra lịch sử chấm công.",
    noCheckIn: "Không có lịch sử chấm công vào.",
    alreadyCheckedOut: "Bạn đã chấm công ra rồi.",
    saveError: "Đã xảy ra lỗi khi lưu chấm công ra.",
    success: "Đã chấm công ra thành công.",
    exception: "Đã xảy ra lỗi khi xử lý chấm công ra.",
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
      console.error("check-out user error:", userError);
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

    const { data: existing, error: existingError } = await supabaseServer
      .from("attendance_records")
      .select("*")
      .eq("user_id", user_id)
      .not("check_in_at", "is", null)
      .is("check_out_at", null)
      .order("check_in_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingError) {
      console.error("check-out existing error:", existingError);
      return NextResponse.json(
        { ok: false, message: getMessage(lang, "existingError") },
        { status: 500 }
      );
    }

    if (!existing?.check_in_at) {
      return NextResponse.json(
        { ok: false, message: getMessage(lang, "noCheckIn") },
        { status: 409 }
      );
    }

    if (existing.check_out_at) {
      return NextResponse.json(
        { ok: false, message: getMessage(lang, "alreadyCheckedOut") },
        { status: 409 }
      );
    }

    const workMinutes = getMinutesDiff(existing.check_in_at, nowIso);

    const rawEarlyLeaveMinutes = getEarlyLeaveMinutes(
      existing.check_in_at,
      nowIso,
      user.work_end_time
    );

    const status = getStatusByMinutes(
      Number(existing.late_minutes || 0),
      rawEarlyLeaveMinutes
    );

    const earlyLeaveMinutes =
      status === ATTENDANCE_STATUS.EARLY_LEAVE ? rawEarlyLeaveMinutes : 0;

    const { data, error } = await supabaseServer
      .from("attendance_records")
      .update({
        check_out_at: nowIso,
        status,
        work_minutes: workMinutes,
        early_leave_minutes: earlyLeaveMinutes,
        updated_at: nowIso,
      })
      .eq("id", existing.id)
      .select()
      .single();

    if (error) {
      console.error("check-out save error:", error);
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
      action: "check_out",
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
    console.error("check-out exception:", err);

    return NextResponse.json(
      { ok: false, message: getMessage(lang, "exception") },
      { status: 500 }
    );
  }
}