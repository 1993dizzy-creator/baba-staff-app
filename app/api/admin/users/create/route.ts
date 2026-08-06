import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/server-auth";
import { toLegacyEmployeePosition } from "@/lib/common/roles";

type JsonObject = Record<string, unknown>;

const ALLOWED_ROLES = new Set(["owner", "manager", "leader", "staff"]);
const BLOCKED_FORM_ROLES = new Set(["master", "admin"]);

function normalizeText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function nullableText(value: unknown) {
  const text = normalizeText(value);
  return text || null;
}

function nullableDate(value: unknown) {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function nullableTime(value: unknown) {
  const text = normalizeText(value);
  return /^\d{2}:\d{2}$/.test(text) ? text : null;
}

function getLang(value: unknown) {
  return value === "vi" ? "vi" : "ko";
}

function getBlockedRoleError(lang: "ko" | "vi") {
  return lang === "vi"
    ? "Không thể chọn quyền này."
    : "선택할 수 없는 권한입니다.";
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const auth = await requireRole(["owner", "master"]);
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code }, { status: auth.status });

    const username = normalizeText(body.username);
    const password = normalizeText(body.password);
    const name = normalizeText(body.name);
    const role = normalizeText(body.role) || "staff";
    const lang = getLang(body.lang);
    const levelProgramEnabled = typeof body.level_program_enabled === "boolean"
      ? body.level_program_enabled
      : !["owner", "master"].includes(role);
    const automaticChangeReason = levelProgramEnabled
      ? "employee_created_level_enabled"
      : "employee_created_level_disabled";

    if (!username || !password || !name) {
      return NextResponse.json(
        { ok: false, error: "username, password and name are required" },
        { status: 400 }
      );
    }

    if (BLOCKED_FORM_ROLES.has(role)) {
      return NextResponse.json(
        { ok: false, error: getBlockedRoleError(lang) },
        { status: 403 }
      );
    }

    if (!ALLOWED_ROLES.has(role)) {
      return NextResponse.json(
        { ok: false, error: "Invalid role" },
        { status: 400 }
      );
    }

    // 레거시 DB 호환용 position은 클라이언트가 보낸 값을 신뢰하지 않고 항상 검증된
    // role에서 파생한다. 구버전 탭이 position 필드를 함께 보내도 여기서는 아예
    // 읽지 않으므로 요청이 실패하지 않는다(롤링 배포 호환).
    const position = toLegacyEmployeePosition(role);

    const hireDate = nullableDate(body.hire_date);
    if (levelProgramEnabled && !hireDate) {
      return NextResponse.json(
        { ok: false, error: lang === "vi" ? "Cần có ngày vào làm để áp dụng cấp." : "레벨을 적용하려면 입사일이 필요합니다." },
        { status: 400 },
      );
    }

    const { data: existing, error: existingError } = await supabaseServer
      .from("users")
      .select("id")
      .eq("username", username)
      .maybeSingle();

    if (existingError) {
      throw new Error(`Failed to check username: ${existingError.message}`);
    }

    if (existing) {
      return NextResponse.json(
        { ok: false, error: "Duplicate username" },
        { status: 409 }
      );
    }

    const attendanceTrackingEnabled = body.attendance_tracking_enabled !== false;
    const appLoginEnabled = body.app_login_enabled !== false;

    const { data, error } = await supabaseServer.rpc(
      "employee_create_with_schedule_v5",
      { p_employee: {
        username,
        password,
        name,
        full_name: nullableText(body.full_name),
        role,
        part: nullableText(body.part),
        position,
        gender: nullableText(body.gender),
        birth_date: nullableDate(body.birth_date),
        hire_date: hireDate,
        termination_date: null,
        work_start_time: nullableTime(body.work_start_time),
        work_end_time: nullableTime(body.work_end_time),
        is_active: body.is_active === false ? false : true,
        is_system_account: false,
        attendance_tracking_enabled: attendanceTrackingEnabled,
        app_login_enabled: appLoginEnabled,
      }, p_level_program_enabled: levelProgramEnabled, p_change_reason: automaticChangeReason,
        p_actor_id: auth.actor.id, p_actor_username: auth.actor.username },
    );

    if (error) {
      throw new Error(`Failed to create user: ${error.message}`);
    }

    return NextResponse.json({
      ok: true,
      user: data,
    });
  } catch (error) {
    console.error("[ADMIN_USERS_CREATE_POST_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to create user.",
      },
      { status: 500 }
    );
  }
}
