import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

type Action = "force_check_in" | "force_check_out" | "set_leave";

function getStatusByMinutes(lateMinutes: number, earlyLeaveMinutes: number) {
  if (earlyLeaveMinutes >= 90) return "early_leave";
  if (lateMinutes > 0) return "working";
  return "done";
}

function getMinutesDiff(startIso: string, endIso: string) {
  return Math.max(
    0,
    Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000)
  );
}

function makeVietnamIso(workDate: string, time: string) {
  return new Date(`${workDate}T${time}:00+07:00`).toISOString();
}

function getLateMinutes(workDate: string, checkInIso: string, workStartTime?: string | null) {
  if (!workStartTime) return 0;

  const standardStart = new Date(`${workDate}T${workStartTime}:00+07:00`);
  const checkIn = new Date(checkInIso);

  return Math.max(
    0,
    Math.floor((checkIn.getTime() - standardStart.getTime()) / 60000)
  );
}

function getEarlyLeaveMinutes(workDate: string, checkOutIso: string, workEndTime?: string | null) {
  if (!workEndTime) return 0;

  const standardEnd = new Date(`${workDate}T${workEndTime}:00+07:00`);
  const checkOut = new Date(checkOutIso);

  const minutes = Math.max(
    0,
    Math.floor((standardEnd.getTime() - checkOut.getTime()) / 60000)
  );

  return minutes >= 90 ? minutes : 0;
}

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
    }: {
      action: Action;
      user_id: number;
      work_date: string;
      time?: string;
      note?: string;
      admin_name?: string;
    } = body;

    if (!action || !user_id || !work_date) {
      return NextResponse.json(
        { ok: false, message: "필수 정보가 없습니다." },
        { status: 400 }
      );
    }

    const { data: user, error: userError } = await supabaseServer
      .from("users")
      .select("id, name, username, work_start_time, work_end_time")
      .eq("id", user_id)
      .eq("is_active", true)
      .maybeSingle();

    if (userError) {
      console.error("admin attendance user error:", userError);
      return NextResponse.json(
        { ok: false, message: "직원 조회 중 오류가 발생했습니다." },
        { status: 500 }
      );
    }

    if (!user) {
      return NextResponse.json(
        { ok: false, message: "직원 정보를 찾을 수 없습니다." },
        { status: 404 }
      );
    }

    const { data: existing, error: existingError } = await supabaseServer
      .from("attendance_records")
      .select("*")
      .eq("user_id", user_id)
      .eq("work_date", work_date)
      .maybeSingle();

    if (existingError) {
      console.error("admin attendance existing error:", existingError);
      return NextResponse.json(
        { ok: false, message: "근태 기록 조회 중 오류가 발생했습니다." },
        { status: 500 }
      );
    }

    const nowIso = new Date().toISOString();

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
        console.error("admin set leave error:", error);
        return NextResponse.json(
          { ok: false, message: "휴무 처리 중 오류가 발생했습니다." },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, record: data });
    }

    if (!time) {
      return NextResponse.json(
        { ok: false, message: "시간 정보가 없습니다." },
        { status: 400 }
      );
    }

    const targetIso = makeVietnamIso(work_date, time);

    if (action === "force_check_in") {
      const checkOutIso = existing?.check_out_at ?? null;
      const lateMinutes = getLateMinutes(work_date, targetIso, user.work_start_time);

      const workMinutes = checkOutIso ? getMinutesDiff(targetIso, checkOutIso) : existing?.work_minutes ?? 0;

      const earlyLeaveMinutes = checkOutIso
        ? getEarlyLeaveMinutes(work_date, checkOutIso, user.work_end_time)
        : existing?.early_leave_minutes ?? 0;

      const status = checkOutIso
        ? getStatusByMinutes(lateMinutes, earlyLeaveMinutes)
        : "working";

      const payload = {
        user_id,
        work_date,
        status,
        check_in_at: targetIso,
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
        console.error("admin force check-in error:", error);
        return NextResponse.json(
          { ok: false, message: "출근 수정 중 오류가 발생했습니다." },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, record: data });
    }

    if (action === "force_check_out") {
      if (!existing?.check_in_at) {
        return NextResponse.json(
          { ok: false, message: "출근 기록이 없습니다." },
          { status: 409 }
        );
      }

      const checkOutIso = targetIso;
      const lateMinutes = existing.late_minutes || 0;
      const earlyLeaveMinutes = getEarlyLeaveMinutes(
        work_date,
        checkOutIso,
        user.work_end_time
      );

      const workMinutes = getMinutesDiff(existing.check_in_at, checkOutIso);
      const status = getStatusByMinutes(lateMinutes, earlyLeaveMinutes);

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
        console.error("admin force check-out error:", error);
        return NextResponse.json(
          { ok: false, message: "퇴근 수정 중 오류가 발생했습니다." },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, record: data });
    }

    return NextResponse.json(
      { ok: false, message: "지원하지 않는 작업입니다." },
      { status: 400 }
    );
  } catch (err) {
    console.error("admin attendance exception:", err);

    return NextResponse.json(
      { ok: false, message: "관리자 근태 처리 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}