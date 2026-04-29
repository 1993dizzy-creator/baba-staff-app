import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

const messages = {
  ko: {
    missingUser: "사용자 정보가 없습니다.",
    invalidLocation: "매장 위치에서만 출근할 수 있습니다.",
    userError: "사용자 조회 중 오류가 발생했습니다.",
    inactiveUser: "활성화된 사용자가 아닙니다.",
    existingError: "출근 기록 확인 중 오류가 발생했습니다.",
    alreadyCheckedIn: "이미 출근 처리되었습니다.",
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

function getTodayVietnamDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
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

    const workDate = getTodayVietnamDate();
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

    let lateMinutes = 0;

    if (user.work_start_time) {
      const standardStart = new Date(`${workDate}T${user.work_start_time}:00+07:00`);
      const now = new Date(nowIso);

      lateMinutes = Math.max(
        0,
        Math.floor((now.getTime() - standardStart.getTime()) / 60000)
      );
    }

    const status = "working";

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
            approval_status: "approved",
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