import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  getAttendanceWorkDate,
  getEarlyLeaveMinutes,
  getLateMinutes,
  getMinutesDiff,
  getShiftAutoCloseIso,
  getStatusByMinutes,
  isOpenRecordUnresolved,
  makeCheckInIso,
  makeCheckOutIso,
  makeIsoFromLocalDateTime,
} from "@/lib/attendance/time";
import {
  ATTENDANCE_STATUS,
  APPROVAL_STATUS,
} from "@/lib/attendance/status";
import { isAttendanceAdminRole } from "@/lib/attendance/api-policy";
import { getNormalizedLatePatch } from "@/lib/attendance/mutation-policy";
import {
  attendanceAuthFailure,
  requireAttendanceActor,
} from "@/lib/attendance/server-api";

type Action =
  | "force_check_in"
  | "force_check_out"
  | "set_leave"
  | "update_record"
  | "normalize_late"
  | "auto_close_at_01"
  | "delete_orphan_record";

const MUTATION_RECORD_FIELDS =
  "id,user_id,work_date,status,check_in_at,check_out_at,late_minutes,early_leave_minutes,work_minutes,note,approval_status,approved_by,approved_at,created_at,updated_at";

// 선택한 월과 무관하게, 이전 영업일부터 남아있는 미퇴근 기록을 관리자 화면에서 바로 확인할 수 있도록
// 별도 조회 엔드포인트로 제공한다. 직원 수만큼 반복 조회하지 않도록 단일 쿼리로 처리한다.
export async function GET(req: Request) {
  try {
    const auth = await requireAttendanceActor();
    if (!auth.ok) return attendanceAuthFailure(auth);
    const { searchParams } = new URL(req.url);
    const lang: "ko" | "vi" = searchParams.get("lang") === "vi" ? "vi" : "ko";
    if (!isAttendanceAdminRole(auth.actor.role)) {
      return NextResponse.json(
        {
          ok: false,
          message: lang === "vi" ? "Không có quyền." : "권한이 없습니다.",
        },
        { status: 403 }
      );
    }

    const businessDate = getAttendanceWorkDate();

    // 이전 영업일 기록뿐 아니라 "현재 영업일이지만 마감시각(다음 날 01:00)이 지난" 기록도
    // 후보에 포함해야 하므로 DB에서는 work_date <= 현재 영업일까지 넓게 가져온 뒤,
    // 상세 화면과 동일한 공통 함수 isOpenRecordUnresolved()로 서버에서 최종 필터링한다.
    // 특정 시점에 열려 있는 미퇴근 기록 수는 매장 재직 인원 규모로 자연히 제한되므로
    // 이 범위 확장이 조회량을 과도하게 늘리지 않는다.
    const { data: candidates, error } = await supabaseServer
      .from("attendance_records")
      .select("id, user_id, work_date, check_in_at")
      .not("check_in_at", "is", null)
      .is("check_out_at", null)
      .lte("work_date", businessDate)
      .order("work_date", { ascending: true });

    if (error) {
      return NextResponse.json(
        {
          ok: false,
          message:
            lang === "vi"
              ? "Lỗi khi truy vấn ca làm việc chưa ghi nhận giờ tan ca."
              : "미퇴근 기록 조회 중 오류가 발생했습니다.",
        },
        { status: 500 }
      );
    }

    const now = new Date();
    const unresolvedRecords = (candidates ?? []).filter((record) =>
      isOpenRecordUnresolved(
        { check_in_at: record.check_in_at, check_out_at: null, work_date: record.work_date },
        now
      )
    );

    // 활성 직원만 반환하는 /api/attendance/users에 의존하지 않고, 미퇴근 기록에 등장하는
    // user_id만 모아 한 번에 조회한다(N+1 방지). 비활성 사용자와, users row 자체가 없는
    // orphan 기록(연결된 직원 정보 없음)을 명확히 구분해 카드 표시 정보로 함께 내려준다.
    const userIds = Array.from(new Set(unresolvedRecords.map((record) => record.user_id)));

    const usersById = new Map<
      number,
      { id: number; username: string | null; name: string | null; is_active: boolean | null }
    >();

    if (userIds.length > 0) {
      const { data: userRows, error: userRowsError } = await supabaseServer
        .from("users")
        .select("id, username, name, is_active")
        .in("id", userIds);

      if (userRowsError) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Lỗi khi truy vấn thông tin nhân viên."
                : "직원 정보 조회 중 오류가 발생했습니다.",
          },
          { status: 500 }
        );
      }

      (userRows ?? []).forEach((row) => usersById.set(row.id, row));
    }

    const enrichedRecords = unresolvedRecords.map((record) => ({
      ...record,
      user: usersById.get(record.user_id) ?? null,
    }));

    return NextResponse.json({
      ok: true,
      unresolvedOpenRecords: enrichedRecords,
    });
  } catch {
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

export async function POST(req: Request) {
  try {
    const auth = await requireAttendanceActor();
    if (!auth.ok) return attendanceAuthFailure(auth);
    const body = await req.json();

    const {
      action,
      user_id,
      work_date,
      time,
      note,
      mark_normal,
      lang = "ko", // 🔥 핵심
      check_in_datetime,
      check_out_datetime,
      clear_check_out,
      attendance_id,
      is_new,
    }: {
      action?: Action;
      user_id?: string | number;
      work_date?: string;
      time?: string;
      note?: string;
      mark_normal?: boolean;
      lang?: "ko" | "vi";
      check_in_datetime?: string;
      check_out_datetime?: string;
      clear_check_out?: boolean;
      attendance_id?: string | number;
      is_new?: boolean;
    } = body;

    const isNormalizeLateAction =
      action === "normalize_late" ||
      (action === "update_record" && mark_normal === true);

    if (!action || (!isNormalizeLateAction && (!user_id || !work_date))) {
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

    if (!isAttendanceAdminRole(auth.actor.role)) {
      return NextResponse.json(
        {
          ok: false,
          message:
            lang === "vi"
              ? "Không có quyền."
              : "권한이 없습니다.",
        },
        { status: 403 }
      );
    }

    // 지각 정상처리는 일반 보정 폼과 분리한다. 이전 화면 버전이 update_record와
    // mark_normal을 함께 보내더라도 출퇴근/조퇴/메모 필드를 절대 덮어쓰지 않는다.
    if (isNormalizeLateAction) {
      if (!attendance_id) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Thiếu mã bản ghi chấm công."
                : "근태 기록 ID가 없습니다.",
          },
          { status: 400 }
        );
      }

      const { data: targetRecord, error: targetError } = await supabaseServer
        .from("attendance_records")
        .select("*")
        .eq("id", attendance_id)
        .maybeSingle();

      if (targetError) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Lỗi khi truy vấn bản ghi chấm công."
                : "근태 기록 조회 중 오류가 발생했습니다.",
          },
          { status: 500 }
        );
      }

      if (!targetRecord) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Không tìm thấy bản ghi chấm công."
                : "근태 기록을 찾을 수 없습니다.",
          },
          { status: 404 }
        );
      }

      if (targetRecord.status === ATTENDANCE_STATUS.LEAVE) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Không thể xử lý đi muộn cho ngày nghỉ."
                : "휴무 기록은 지각 정상처리할 수 없습니다.",
          },
          { status: 409 }
        );
      }

      if (Number(targetRecord.late_minutes || 0) <= 0) {
        return NextResponse.json({ ok: true, record: targetRecord, no_op: true });
      }

      if (!targetRecord.check_in_at) {
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

      const { data, error } = await supabaseServer
        .from("attendance_records")
        .update(getNormalizedLatePatch(targetRecord, new Date().toISOString()))
        .eq("id", targetRecord.id)
        .gt("late_minutes", 0)
        .select(MUTATION_RECORD_FIELDS)
        .maybeSingle();

      if (error) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Lỗi khi xử lý đi muộn."
                : "지각 정상처리 중 오류가 발생했습니다.",
          },
          { status: 500 }
        );
      }

      // 같은 기록을 동시에 정상처리한 경우 최신 행을 다시 읽어 안전한 no-op으로 응답한다.
      if (!data) {
        const { data: latest, error: latestError } = await supabaseServer
          .from("attendance_records")
          .select("*")
          .eq("id", targetRecord.id)
          .maybeSingle();

        if (latestError || !latest) {
          return NextResponse.json(
            {
              ok: false,
              message:
                lang === "vi"
                  ? "Lỗi khi xử lý đi muộn."
                  : "지각 정상처리 중 오류가 발생했습니다.",
            },
            { status: 500 }
          );
        }

        return NextResponse.json({ ok: true, record: latest, no_op: true });
      }

      return NextResponse.json({ ok: true, record: data });
    }

    // normalize_late 이외의 기존 action은 아래 공통 처리에서 사용자와 근무일을 사용한다.
    // 상단 검증과 동일한 조건을 명시해 타입을 좁히고 기존 필수값 정책을 유지한다.
    if (!user_id || !work_date) {
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

    // 🔥 고아 근태 기록 삭제: 연결된 users row가 실제로 존재하지 않는 기록만 대상으로 한다.
    // orphan 기록은 정의상 유효한 user_id가 없으므로, 아래의 "필수 유저 조회"보다 먼저 처리해야 한다.
    if (action === "delete_orphan_record") {
      if (!attendance_id) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Thiếu mã bản ghi chấm công."
                : "근태 기록 ID가 없습니다.",
          },
          { status: 400 }
        );
      }

      const { data: targetRecord, error: targetError } = await supabaseServer
        .from("attendance_records")
        .select("id, user_id")
        .eq("id", attendance_id)
        .maybeSingle();

      if (targetError) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Lỗi khi truy vấn bản ghi chấm công."
                : "근태 기록 조회 중 오류가 발생했습니다.",
          },
          { status: 500 }
        );
      }

      if (!targetRecord) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Không tìm thấy bản ghi chấm công."
                : "근태 기록을 찾을 수 없습니다.",
          },
          { status: 404 }
        );
      }

      const { data: linkedUser, error: linkedUserError } = await supabaseServer
        .from("users")
        .select("id")
        .eq("id", targetRecord.user_id)
        .maybeSingle();

      if (linkedUserError) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Lỗi khi kiểm tra nhân viên liên kết."
                : "연결된 직원 확인 중 오류가 발생했습니다.",
          },
          { status: 500 }
        );
      }

      // users row가 실제로 존재하면(비활성 포함) orphan이 아니므로 삭제를 차단한다.
      if (linkedUser) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Bản ghi này vẫn còn liên kết với nhân viên nên không thể xóa."
                : "연결된 직원 정보가 있는 기록은 삭제할 수 없습니다.",
          },
          { status: 409 }
        );
      }

      const { error: deleteError } = await supabaseServer
        .from("attendance_records")
        .delete()
        .eq("id", attendance_id);

      if (deleteError) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Lỗi khi xóa bản ghi chấm công."
                : "근태 기록 삭제 중 오류가 발생했습니다.",
          },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, deleted_id: attendance_id });
    }

    // 🔥 유저 조회
    // 비활성 직원의 과거 근태도 관리자가 보정할 수 있어야 하므로 is_active로 걸러내지 않는다.
    // (완전히 삭제되어 users row 자체가 없는 orphan 기록은 delete_orphan_record에서 별도 처리한다.)
    const { data: user, error: userError } = await supabaseServer
      .from("users")
      .select("*")
      .eq("id", user_id)
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

    // 🔥 기존 기록 조회 (user_id + work_date 기준, force_check_in/force_check_out/set_leave용 upsert 대상)
    const { data: existingByDate, error: existingError } = await supabaseServer
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

    let existing = existingByDate;

    // update_record / auto_close_at_01은 클라이언트가 전달한 user_id + work_date를 신뢰하지 않고
    // 화면에서 선택한 정확한 attendance_id로 다시 조회한다. 같은 직원·같은 날짜에 레거시 중복
    // 기록이 있어도 엉뚱한 행을 건드리지 않기 위함이다. work_date 등 이후 계산에 쓰이는 값도
    // 이 조회 결과(=DB의 실제 값)를 기준으로 삼는다.
    if (
      attendance_id &&
      (action === "update_record" || action === "auto_close_at_01")
    ) {
      const { data: recordById, error: recordByIdError } = await supabaseServer
        .from("attendance_records")
        .select("*")
        .eq("id", attendance_id)
        .maybeSingle();

      if (recordByIdError) {
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

      if (!recordById || Number(recordById.user_id) !== Number(user_id)) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Không tìm thấy bản ghi chấm công."
                : "근태 기록을 찾을 수 없습니다.",
          },
          { status: 404 }
        );
      }

      existing = recordById;
    }

    const nowIso = new Date().toISOString();

    // 🔥 휴무 처리
    if (action === "set_leave") {
      // 공란 날짜용 "휴무 처리" 신규 생성 요청인데 그 사이 다른 요청으로 이미 근태 기록(근무든
      // 휴무든)이 생겼다면 화면을 새로고침하도록 명확히 차단한다(중복 생성 방지).
      if (is_new === true && existing) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Ngày này đã có dữ liệu chấm công. Vui lòng tải lại và kiểm tra."
                : "이미 해당 날짜에 근태 기록이 있습니다. 새로고침 후 다시 확인해주세요.",
          },
          { status: 409 }
        );
      }

      // 이미 출근/근무 기록이 있는 날짜를 휴무로 덮어써서 근무 데이터가 사라지지 않도록 차단한다.
      // (leave/route.ts의 직원 휴무 신청 차단 로직과 동일한 기준)
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
          {
            ok: false,
            message:
              lang === "vi"
                ? "Ngày này đã có dữ liệu chấm công nên không thể xử lý nghỉ. Vui lòng kiểm tra lại giờ vào/ra."
                : "이미 근무 기록이 있는 날짜에는 휴무로 처리할 수 없습니다. 출퇴근 기록을 먼저 확인해주세요.",
          },
          { status: 409 }
        );
      }

      const payload = {
        user_id,
        work_date,
        status: ATTENDANCE_STATUS.LEAVE,
        check_in_at: null,
        check_out_at: null,
        late_minutes: 0,
        early_leave_minutes: 0,
        work_minutes: 0,
        note: note || "관리자 휴무 처리",
        approval_status: APPROVAL_STATUS.APPROVED,
        approved_by: auth.actor.name || auth.actor.username,
        approved_at: nowIso,
        updated_at: nowIso,
      };

      const { data, error } = existing
        ? await supabaseServer
          .from("attendance_records")
          .update(payload)
          .eq("id", existing.id)
          .select(MUTATION_RECORD_FIELDS)
          .single()
        : await supabaseServer
          .from("attendance_records")
          .insert(payload)
          .select(MUTATION_RECORD_FIELDS)
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

    if (action === "update_record") {
      // 이미 휴무로 처리된 날짜에는 이 액션으로 출퇴근 데이터를 추가/수정할 수 없다
      // (근무/휴무 충돌 방지). 메모만 바꾸는 것은 허용한다.
      if (existing && existing.status === ATTENDANCE_STATUS.LEAVE) {
        if (check_in_datetime || check_out_datetime) {
          return NextResponse.json(
            {
              ok: false,
              message:
                lang === "vi"
                  ? "Ngày này đã được xử lý nghỉ nên không thể thêm giờ làm việc. Vui lòng hủy nghỉ trước."
                  : "휴무로 처리된 날짜에는 근무 기록을 추가할 수 없습니다. 먼저 휴무 처리를 취소해주세요.",
            },
            { status: 409 }
          );
        }

        const { data, error } = await supabaseServer
          .from("attendance_records")
          .update({ note: note ?? existing.note ?? null, updated_at: nowIso })
          .eq("id", existing.id)
          .select(MUTATION_RECORD_FIELDS)
          .single();

        if (error) {
          return NextResponse.json(
            {
              ok: false,
              message:
                lang === "vi"
                  ? "Lỗi khi chỉnh sửa chấm công."
                  : "근태 기록 보정 중 오류가 발생했습니다.",
            },
            { status: 500 }
          );
        }

        return NextResponse.json({ ok: true, record: data });
      }

      // existing이 없으면 해당 날짜(work_date)에 근태 기록이 아예 없는 "공란" 상태이므로
      // 새 근무 기록을 생성한다. 이 경우 출근 일시는 반드시 있어야 한다.
      const isCreating = !existing;

      // 공란 날짜용 "근무 기록 추가" 신규 생성 요청인데 그 사이 다른 요청으로 이미 근태 기록이
      // 생겼다면(경합) 조용히 그 기록을 수정하는 대신 명확히 차단한다(중복 생성 방지).
      if (is_new === true && !isCreating) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Ngày này đã có dữ liệu chấm công. Vui lòng tải lại và kiểm tra."
                : "이미 해당 날짜에 근태 기록이 있습니다. 새로고침 후 다시 확인해주세요.",
          },
          { status: 409 }
        );
      }

      if (isCreating && !check_in_datetime) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi" ? "Vui lòng nhập giờ vào." : "출근 일시를 입력해주세요.",
          },
          { status: 400 }
        );
      }

      // 관리자 보정은 실제 출근/퇴근 날짜와 시각을 명확한 datetime 값으로 직접 받아서
      // 자정 이후 퇴근이나 과거 날짜 보정에서 "다음 날로 자동 해석"되는 모호함을 없앤다.
      let finalCheckInIso: string | null = existing?.check_in_at ?? null;
      let finalCheckOutIso: string | null = existing?.check_out_at ?? null;

      if (check_in_datetime) {
        try {
          finalCheckInIso = makeIsoFromLocalDateTime(check_in_datetime);
        } catch {
          return NextResponse.json(
            {
              ok: false,
              message:
                lang === "vi"
                  ? "Vui lòng kiểm tra lại ngày giờ vào."
                  : "출근 일시를 다시 확인해주세요.",
            },
            { status: 400 }
          );
        }
      }

      if (clear_check_out === true) {
        finalCheckOutIso = null;
      } else if (check_out_datetime) {
        try {
          finalCheckOutIso = makeIsoFromLocalDateTime(check_out_datetime);
        } catch {
          return NextResponse.json(
            {
              ok: false,
              message:
                lang === "vi"
                  ? "Vui lòng kiểm tra lại ngày giờ ra."
                  : "퇴근 일시를 다시 확인해주세요.",
            },
            { status: 400 }
          );
        }
      }

      if (!finalCheckInIso) {
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

      if (
        finalCheckOutIso &&
        new Date(finalCheckOutIso).getTime() <= new Date(finalCheckInIso).getTime()
      ) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Giờ vào không được muộn hơn giờ ra. Vui lòng kiểm tra lại giờ chấm công."
                : "출근 시간은 퇴근 시간보다 늦을 수 없습니다. 출퇴근 시간을 다시 확인해주세요.",
          },
          { status: 400 }
        );
      }

      // work_date는 관리자가 별도로 지정하는 값이 아니라, 실제 출근일시를 베트남 영업일
      // 기준으로 변환해 자동으로 정한다. 출근일시를 바꾸지 않았다면 DB에 저장된 기존 work_date를
      // 유지한다(클라이언트가 보낸 work_date가 아니라 attendance_id로 조회한 실제 값 기준).
      // 신규 생성 시에는 work_date(=상단에서 이미 이 날짜에 기록이 없음을 확인한 값)가 기준이 된다.
      const referenceWorkDate = existing ? existing.work_date : work_date;
      const targetWorkDate = check_in_datetime
        ? getAttendanceWorkDate(new Date(finalCheckInIso))
        : referenceWorkDate;

      if (targetWorkDate !== referenceWorkDate) {
        let conflictQuery = supabaseServer
          .from("attendance_records")
          .select("id")
          .eq("user_id", user_id)
          .eq("work_date", targetWorkDate);

        if (existing) {
          conflictQuery = conflictQuery.neq("id", existing.id);
        }

        const { data: conflict, error: conflictError } = await conflictQuery.maybeSingle();

        if (conflictError) {
          return NextResponse.json(
            {
              ok: false,
              message:
                lang === "vi"
                  ? "Lỗi khi kiểm tra dữ liệu chấm công."
                  : "근태 기록 확인 중 오류가 발생했습니다.",
            },
            { status: 500 }
          );
        }

        if (conflict) {
          return NextResponse.json(
            {
              ok: false,
              message:
                lang === "vi"
                  ? "Ngày này đã có dữ liệu chấm công."
                  : "해당 날짜에 이미 근태 기록이 있습니다.",
            },
            { status: 409 }
          );
        }
      }

      const nextLateMinutes = getLateMinutes(
        finalCheckInIso,
        user.work_start_time,
        targetWorkDate
      );
      let nextWorkMinutes = 0;
      let nextEarlyLeaveMinutes = 0;
      let nextStatus: typeof ATTENDANCE_STATUS[keyof typeof ATTENDANCE_STATUS] =
        ATTENDANCE_STATUS.WORKING;

      if (finalCheckOutIso) {
        nextWorkMinutes = getMinutesDiff(finalCheckInIso, finalCheckOutIso);

        const rawEarlyLeaveMinutes = getEarlyLeaveMinutes(
          finalCheckInIso,
          finalCheckOutIso,
          user.work_end_time,
          targetWorkDate
        );

        nextStatus = getStatusByMinutes(nextLateMinutes, rawEarlyLeaveMinutes);
        nextEarlyLeaveMinutes =
          nextStatus === ATTENDANCE_STATUS.EARLY_LEAVE ? rawEarlyLeaveMinutes : 0;
      }

      const recordPayload = {
        user_id,
        work_date: targetWorkDate,
        status: nextStatus,
        check_in_at: finalCheckInIso,
        check_out_at: finalCheckOutIso,
        late_minutes: nextLateMinutes,
        early_leave_minutes: nextEarlyLeaveMinutes,
        work_minutes: nextWorkMinutes,
        approval_status: APPROVAL_STATUS.APPROVED,
        note: note ?? existing?.note ?? null,
        updated_at: nowIso,
      };

      const { data, error } = isCreating
        ? await supabaseServer
          .from("attendance_records")
          .insert(recordPayload)
          .select(MUTATION_RECORD_FIELDS)
          .single()
        : await supabaseServer
          .from("attendance_records")
          .update(recordPayload)
          .eq("id", existing.id)
          .select(MUTATION_RECORD_FIELDS)
          .single();

      if (error) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Lỗi khi chỉnh sửa chấm công."
                : "근태 기록 보정 중 오류가 발생했습니다.",
          },
          { status: 500 }
        );
      }

      return NextResponse.json({ ok: true, record: data });
    }

    // 🔥 미퇴근 기록 자동보정: 퇴근시각을 영업일 다음 날 01:00(정상 마감시각)으로 확정한다.
    if (action === "auto_close_at_01") {
      if (!existing || !existing.check_in_at || existing.check_out_at) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Bản ghi chấm công đã được xử lý hoặc không tồn tại."
                : "이미 처리되었거나 존재하지 않는 근태 기록입니다.",
          },
          { status: 409 }
        );
      }

      // getShiftAutoCloseIso("다음 날 01:00")는 상세 화면 기본값(getDefaultShiftDateTimeValue)과
      // 동일한 계산이므로, 자동보정과 상세 화면에서 기본값을 그대로 저장하는 경우 결과가 일치한다.
      const autoCheckOutIso = getShiftAutoCloseIso(existing.work_date);

      if (
        new Date(autoCheckOutIso).getTime() <= new Date(existing.check_in_at).getTime()
      ) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Giờ vào không hợp lệ. Vui lòng chỉnh sửa thủ công."
                : "출근시각이 비정상적입니다. 수동으로 보정해주세요.",
          },
          { status: 409 }
        );
      }

      const lateMinutes = getLateMinutes(
        existing.check_in_at,
        user.work_start_time,
        existing.work_date
      );
      const workMinutes = getMinutesDiff(existing.check_in_at, autoCheckOutIso);

      const rawEarlyLeaveMinutes = getEarlyLeaveMinutes(
        existing.check_in_at,
        autoCheckOutIso,
        user.work_end_time,
        existing.work_date
      );

      const status = getStatusByMinutes(lateMinutes, rawEarlyLeaveMinutes);
      const earlyLeaveMinutes =
        status === ATTENDANCE_STATUS.EARLY_LEAVE ? rawEarlyLeaveMinutes : 0;

      // 다른 요청이 그 사이 이미 퇴근 처리를 완료했다면 check_out_at이 더 이상 null이 아니므로
      // 이 조건부 업데이트는 0건에 매치되어 중복 보정을 막는다.
      const { data, error } = await supabaseServer
        .from("attendance_records")
        .update({
          check_out_at: autoCheckOutIso,
          status,
          late_minutes: lateMinutes,
          early_leave_minutes: earlyLeaveMinutes,
          work_minutes: workMinutes,
          approval_status: APPROVAL_STATUS.APPROVED,
          updated_at: nowIso,
        })
        .eq("id", existing.id)
        .is("check_out_at", null)
        .select(MUTATION_RECORD_FIELDS)
        .maybeSingle();

      if (error) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Lỗi khi tự động điều chỉnh."
                : "자동보정 중 오류가 발생했습니다.",
          },
          { status: 500 }
        );
      }

      if (!data) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Bản ghi chấm công đã được xử lý hoặc không tồn tại."
                : "이미 처리되었거나 존재하지 않는 근태 기록입니다.",
          },
          { status: 409 }
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

      if (
        checkOutIso &&
        new Date(checkInIso).getTime() >= new Date(checkOutIso).getTime()
      ) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Giờ vào không được muộn hơn giờ ra. Vui lòng kiểm tra lại giờ chấm công."
                : "출근 시간은 퇴근 시간보다 늦을 수 없습니다. 출퇴근 시간을 다시 확인해주세요.",
          },
          { status: 400 }
        );
      }

      const lateMinutes = getLateMinutes(
        checkInIso,
        user.work_start_time,
        work_date
      );

      const workMinutes = checkOutIso
        ? getMinutesDiff(checkInIso, checkOutIso)
        : existing?.work_minutes ?? 0;

      let earlyLeaveMinutes = existing?.early_leave_minutes ?? 0;
      let status: typeof ATTENDANCE_STATUS[keyof typeof ATTENDANCE_STATUS] =
        ATTENDANCE_STATUS.WORKING;

      if (checkOutIso) {
        const rawEarlyLeaveMinutes = getEarlyLeaveMinutes(
          checkInIso,
          checkOutIso,
          user.work_end_time,
          work_date
        );

        status = getStatusByMinutes(lateMinutes, rawEarlyLeaveMinutes);

        earlyLeaveMinutes =
          status === ATTENDANCE_STATUS.EARLY_LEAVE ? rawEarlyLeaveMinutes : 0;
      }

      const payload = {
        user_id,
        work_date,
        status,
        check_in_at: checkInIso,
        late_minutes: lateMinutes,
        early_leave_minutes: earlyLeaveMinutes,
        work_minutes: workMinutes,
        approval_status: APPROVAL_STATUS.APPROVED,
        note: note || existing?.note || null,
        updated_at: nowIso,
      };

      const { data, error } = existing
        ? await supabaseServer
          .from("attendance_records")
          .update(payload)
          .eq("id", existing.id)
          .select(MUTATION_RECORD_FIELDS)
          .single()
        : await supabaseServer
          .from("attendance_records")
          .insert(payload)
          .select(MUTATION_RECORD_FIELDS)
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

      if (new Date(checkOutIso).getTime() <= new Date(checkInIso).getTime()) {
        return NextResponse.json(
          {
            ok: false,
            message:
              lang === "vi"
                ? "Giờ vào không được muộn hơn giờ ra. Vui lòng kiểm tra lại giờ chấm công."
                : "출근 시간은 퇴근 시간보다 늦을 수 없습니다. 출퇴근 시간을 다시 확인해주세요.",
          },
          { status: 400 }
        );
      }

      const rawEarlyLeaveMinutes = getEarlyLeaveMinutes(
        checkInIso,
        checkOutIso,
        user.work_end_time,
        work_date
      );

      const workMinutes = getMinutesDiff(checkInIso, checkOutIso);

      const status = getStatusByMinutes(
        Number(existing.late_minutes || 0),
        rawEarlyLeaveMinutes
      );

      const earlyLeaveMinutes =
        status === ATTENDANCE_STATUS.EARLY_LEAVE ? rawEarlyLeaveMinutes : 0;

      const { data, error } = await supabaseServer
        .from("attendance_records")
        .update({
          status,
          check_out_at: checkOutIso,
          work_minutes: workMinutes,
          early_leave_minutes: earlyLeaveMinutes,
          approval_status: APPROVAL_STATUS.APPROVED,
          note: note || existing.note || null,
          updated_at: nowIso,
        })
        .eq("id", existing.id)
        .select(MUTATION_RECORD_FIELDS)
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
  } catch {
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
