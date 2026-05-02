import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  makeCheckInIso,
  makeCheckOutIso,
  getLateMinutes,
  getEarlyLeaveMinutes,
  getMinutesDiff,
} from "@/lib/attendance/utils";

type Action = "force_check_in" | "force_check_out" | "set_leave";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const {
      action,
      user_id,
      work_date,
      time,
      note,
      admin_name,
      lang = "ko", // 🔥 핵심
    } = body;

    if (!action || !user_id || !work_date) {
      return NextResponse.json(
        {
          ok: false,
          message:
            lang === "vi"
              ? "Thiếu thông tin bắt buộc."
              : "필수 정보가 없습니다.",
        },
        { status: 400 }
      );
    }

    // 🔥 유저 조회
    const { data: user, error: userError } = await supabaseServer
      .from("users")
      .select("*")
      .eq("id", user_id)
      .eq("is_active", true)
      .maybeSingle();

    if (userError) {
      return NextResponse.json(
        {
          ok: false,
          message:
            lang === "vi"
              ? "Lỗi khi truy vấn nhân viên."
              : "직원 조회 중 오류가 발생했습니다.",
        },
        { status: 500 }
      );
    }

    if (!user) {
      return NextResponse.json(
        {
          ok: false,
          message:
            lang === "vi"
              ? "Không tìm thấy nhân viên."
              : "직원 정보를 찾을 수 없습니다.",
        },
        { status: 404 }
      );
    }

    // 🔥 기존 기록 조회
    const { data: existing, error: existingError } = await supabaseServer
      .from("attendance_records")
      .select("*")
      .eq("user_id", user_id)
      .eq("work_date", work_date)
      .maybeSingle();

    if (existingError) {
      return NextResponse.json(
        {
          ok: false,
          message:
            lang === "vi"
              ? "Lỗi khi truy vấn chấm công."
              : "근태 기록 조회 중 오류가 발생했습니다.",
        },
        { status: 500 }
      );
    }

    const nowIso = new Date().toISOString();

    // 🔥 휴무 처리
    if (action === "set_leave") {
      const payload = {
        user_id,
        work_date,
        status: "leave",
        check_in_at: null,
        check_out_at: null,
        late_minutes: 0,
        early_leave_minutes: 0,
        work_minutes: 0,
        note: note || "관리자 휴무 처리",
        approval_status: "approved",
        approved_by: admin_name || null,
        approved_at: nowIso,
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
          .insert(payload)
          .select()
          .single();

      if (error) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Lỗi khi xử lý nghỉ phép."
                : "휴무 처리 중 오류가 발생했습니다.",
          },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, record: data });
    }

    if (!time) {
      return NextResponse.json(
        {
          ok: false,
          message:
            lang === "vi"
              ? "Thiếu thông tin thời gian."
              : "시간 정보가 없습니다.",
        },
        { status: 400 }
      );
    }

    // 🔥 출근 수정
    if (action === "force_check_in") {
      const checkInIso = makeCheckInIso(work_date, time);
      const checkOutIso = existing?.check_out_at ?? null;

      const lateMinutes = getLateMinutes(
        checkInIso,
        user.work_start_time
      );

      const workMinutes = checkOutIso
        ? getMinutesDiff(checkInIso, checkOutIso)
        : existing?.work_minutes ?? 0;

      let earlyLeaveMinutes = existing?.early_leave_minutes ?? 0;
      let status = "working";

      if (checkOutIso) {
        const rawEarlyLeaveMinutes = getEarlyLeaveMinutes(
          checkInIso,
          checkOutIso,
          user.work_end_time
        );

        status = rawEarlyLeaveMinutes >= 90 ? "early_leave" : "done";

        earlyLeaveMinutes =
          status === "early_leave" ? rawEarlyLeaveMinutes : 0;
      }

      const payload = {
        user_id,
        work_date,
        status,
        check_in_at: checkInIso,
        late_minutes: lateMinutes,
        early_leave_minutes: earlyLeaveMinutes,
        work_minutes: workMinutes,
        approval_status: "approved",
        note: note || existing?.note || null,
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
          .insert(payload)
          .select()
          .single();

      if (error) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Lỗi khi chỉnh sửa giờ vào."
                : "출근 수정 중 오류가 발생했습니다.",
          },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, record: data });
    }

    // 🔥 퇴근 수정 (핵심)
    if (action === "force_check_out") {
      const checkInIso = existing?.check_in_at;

      if (!existing || !checkInIso) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Không có dữ liệu giờ vào."
                : "출근 기록이 없습니다.",
          },
          { status: 409 }
        );
      }

      const checkOutIso = makeCheckOutIso(work_date, time, checkInIso);

      const rawEarlyLeaveMinutes = getEarlyLeaveMinutes(
        checkInIso,
        checkOutIso,
        user.work_end_time
      );

      const workMinutes = getMinutesDiff(checkInIso, checkOutIso);

      const status = rawEarlyLeaveMinutes >= 90 ? "early_leave" : "done";

      const earlyLeaveMinutes =
        status === "early_leave" ? rawEarlyLeaveMinutes : 0;

      const { data, error } = await supabaseServer
        .from("attendance_records")
        .update({
          status,
          check_out_at: checkOutIso,
          work_minutes: workMinutes,
          early_leave_minutes: earlyLeaveMinutes,
          approval_status: "approved",
          note: note || existing.note || null,
          updated_at: nowIso,
        })
        .eq("id", existing.id)
        .select()
        .single();

      if (error) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Lỗi khi chỉnh sửa giờ ra."
                : "퇴근 수정 중 오류가 발생했습니다.",
          },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, record: data });
    }

    return NextResponse.json(
      {
        ok: false,
        message:
          lang === "vi"
            ? "Hành động không được hỗ trợ."
            : "지원하지 않는 작업입니다.",
      },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        message:
          "Lỗi hệ thống xử lý chấm công / 관리자 근태 처리 중 오류가 발생했습니다.",
      },
      { status: 500 }
    );
  }
}