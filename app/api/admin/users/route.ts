import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/server-auth";
import { isDateKey, validateEmploymentDates } from "@/lib/employment/eligibility";
import { enforceTerminationAccountPolicy, getVietnamDateKey } from "@/lib/employment/termination-policy";
import { isPayrollOwnerRole } from "@/lib/payroll/eligibility";
import { getEmployeeLevelInfo, withEmployeeLevelInfo } from "@/lib/employee-level/server";
import { validateEmployeeLevelConfiguration } from "@/lib/employee-level/validation";
import type { EmployeeLevelInfo, EmployeeLevelValidationCode } from "@/lib/employee-level/types";

type JsonObject = Record<string, unknown>;

type UserRow = {
  id: number | string;
  username: string;
  name: string | null;
  full_name: string | null;
  role: string | null;
  part: string | null;
  position: string | null;
  gender: string | null;
  birth_date: string | null;
  hire_date: string | null;
  termination_date: string | null;
  work_start_time: string | null;
  work_end_time: string | null;
  is_active: boolean | null;
  is_system_account: boolean;
  payroll_eligible_override: boolean | null;
  level_program_enabled: boolean | null;
  level_base_date_override: string | null;
};

type UserResponseRow = UserRow & { levelInfo: EmployeeLevelInfo };

const USER_SELECT = `
  id,
  username,
  name,
  full_name,
  role,
  part,
  position,
  birth_date,
  hire_date,
  termination_date,
  gender,
  work_start_time,
  work_end_time,
  is_active,
  is_system_account,
  payroll_eligible_override,
  level_program_enabled,
  level_base_date_override
`;

const ROLE_ORDER = new Map([
  ["owner", 0],
  ["master", 1],
]);

const POSITION_ORDER = new Map([
  ["manager", 2],
  ["leader", 3],
  ["staff", 4],
]);

const ALLOWED_ROLES = new Set(["owner", "manager", "leader", "staff"]);
const BLOCKED_FORM_ROLES = new Set(["master", "admin"]);
const ALLOWED_POSITIONS = new Set(["owner", "manager", "leader", "staff"]);
const ALLOWED_UPDATE_KEYS = new Set([
  "name",
  "full_name",
  "role",
  "part",
  "position",
  "gender",
  "birth_date",
  "hire_date",
  "termination_date",
  "work_start_time",
  "work_end_time",
  "is_active",
  "payroll_eligible_override",
]);

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

function normalizeRole(value: unknown) {
  const role = normalizeText(value);
  return ALLOWED_ROLES.has(role) ? role : null;
}

function getLang(value: unknown) {
  return value === "vi" ? "vi" : "ko";
}

type LevelPolicyErrorCode =
  | "EMPLOYEE_NOT_FOUND" | "SYSTEM_ACCOUNT_NOT_ELIGIBLE" | "TERMINATED_EMPLOYEE_READ_ONLY"
  | "HIRE_DATE_REQUIRED" | "INVALID_LEVEL_PROGRAM_ENABLED" | "INVALID_BASE_DATE_MODE"
  | "BASE_DATE_REQUIRED" | "INVALID_BASE_DATE" | "BASE_DATE_BEFORE_HIRE_DATE"
  | "BASE_DATE_AFTER_TERMINATION_DATE" | "BASE_DATE_IN_FUTURE"
  | "CHANGE_REASON_REQUIRED" | "NO_CHANGES";

function levelPolicyError(code: LevelPolicyErrorCode, lang: "ko" | "vi") {
  const messages: Record<LevelPolicyErrorCode, { ko: string; vi: string }> = {
    EMPLOYEE_NOT_FOUND: { ko: "직원을 찾을 수 없습니다.", vi: "Không tìm thấy nhân viên." },
    SYSTEM_ACCOUNT_NOT_ELIGIBLE: { ko: "시스템 계정에는 직원 레벨을 설정할 수 없습니다.", vi: "Không thể thiết lập cấp nhân viên cho tài khoản hệ thống." },
    TERMINATED_EMPLOYEE_READ_ONLY: { ko: "퇴사자의 레벨 설정은 조회만 가능합니다.", vi: "Thiết lập cấp của nhân viên đã nghỉ việc chỉ có thể xem." },
    HIRE_DATE_REQUIRED: { ko: "레벨 제도를 적용하려면 입사일이 필요합니다.", vi: "Cần có ngày vào làm để áp dụng chế độ cấp." },
    INVALID_LEVEL_PROGRAM_ENABLED: { ko: "레벨 제도 상태가 올바르지 않습니다.", vi: "Trạng thái chế độ cấp không hợp lệ." },
    INVALID_BASE_DATE_MODE: { ko: "레벨 기준 방식이 올바르지 않습니다.", vi: "Cách chọn ngày bắt đầu tính cấp không hợp lệ." },
    BASE_DATE_REQUIRED: { ko: "레벨 기준일을 입력해주세요.", vi: "Vui lòng nhập ngày bắt đầu tính cấp." },
    INVALID_BASE_DATE: { ko: "레벨 기준일 형식이 올바르지 않습니다.", vi: "Định dạng ngày bắt đầu tính cấp không hợp lệ." },
    BASE_DATE_BEFORE_HIRE_DATE: { ko: "레벨 기준일은 입사일보다 빠를 수 없습니다.", vi: "Ngày bắt đầu tính cấp không thể sớm hơn ngày vào làm." },
    BASE_DATE_AFTER_TERMINATION_DATE: { ko: "레벨 기준일은 퇴사일보다 늦을 수 없습니다.", vi: "Ngày bắt đầu tính cấp không thể sau ngày nghỉ việc." },
    BASE_DATE_IN_FUTURE: { ko: "레벨 기준일은 오늘 이후 날짜로 설정할 수 없습니다.", vi: "Ngày bắt đầu tính cấp không thể sau ngày hôm nay." },
    CHANGE_REASON_REQUIRED: { ko: "변경 사유를 입력해주세요.", vi: "Vui lòng nhập lý do thay đổi." },
    NO_CHANGES: { ko: "변경된 레벨 설정이 없습니다.", vi: "Không có thay đổi trong thiết lập cấp." },
  };
  return messages[code][lang];
}

function validationCodeToPolicyCode(code: EmployeeLevelValidationCode): LevelPolicyErrorCode {
  if (code === "MISSING_HIRE_DATE") return "HIRE_DATE_REQUIRED";
  if (code === "INVALID_DATE") return "INVALID_BASE_DATE";
  return code as LevelPolicyErrorCode;
}

function policyResponse(code: LevelPolicyErrorCode, lang: "ko" | "vi", status = 400) {
  return NextResponse.json({ ok: false, code, error: levelPolicyError(code, lang) }, { status });
}

function getBlockedRoleError(lang: "ko" | "vi") {
  return lang === "vi"
    ? "Không thể chọn quyền này."
    : "선택할 수 없는 권한입니다.";
}

function getMasterEditError(lang: "ko" | "vi") {
  return lang === "vi"
    ? "Không thể chỉnh sửa tài khoản master."
    : "마스터 계정은 수정할 수 없습니다.";
}

function getBlockedPositionError(lang: "ko" | "vi") {
  return lang === "vi"
    ? "Không thể chọn chức vụ này."
    : "선택할 수 없는 직급입니다.";
}

function sortUsers(users: UserRow[]) {
  return [...users].sort((a, b) => {
    const aRank =
      ROLE_ORDER.get(a.role || "") ??
      POSITION_ORDER.get((a.position || "").toLowerCase()) ??
      99;
    const bRank =
      ROLE_ORDER.get(b.role || "") ??
      POSITION_ORDER.get((b.position || "").toLowerCase()) ??
      99;
    const rankDiff = aRank - bRank;
    if (rankDiff !== 0) return rankDiff;

    const activeDiff = Number(b.is_active === true) - Number(a.is_active === true);
    if (activeDiff !== 0) return activeDiff;

    const aName = (a.name || a.full_name || a.username || "").toLowerCase();
    const bName = (b.name || b.full_name || b.username || "").toLowerCase();
    return aName.localeCompare(bName);
  });
}

function normalizeUpdate(input: JsonObject) {
  const update: JsonObject = {};

  Object.entries(input).forEach(([key, value]) => {
    if (!ALLOWED_UPDATE_KEYS.has(key)) return;

    if (key === "role") {
      const role = normalizeRole(value);
      if (role) update.role = role;
      return;
    }

    if (key === "is_active") {
      update.is_active = value === true;
      return;
    }

    if (key === "payroll_eligible_override") {
      if (value === true || value === null) {
        update.payroll_eligible_override = value;
      }
      return;
    }

    if (key === "birth_date" || key === "hire_date" || key === "termination_date") {
      update[key] = nullableDate(value);
      return;
    }

    if (key === "work_start_time" || key === "work_end_time") {
      update[key] = nullableTime(value);
      return;
    }

    update[key] = nullableText(value);
  });

  return update;
}

export async function GET(req: Request) {
  try {
    void req;
    const auth = await requireRole(["owner", "master"]);
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code }, { status: auth.status });

    const { data, error } = await supabaseServer.from("users").select(USER_SELECT).eq("is_system_account", false);

    if (error) {
      throw new Error(`Failed to fetch users: ${error.message}`);
    }

    return NextResponse.json({
      ok: true,
      users: sortUsers((data || []) as UserRow[]).map((user) => withEmployeeLevelInfo(user, getVietnamDateKey())),
    });
  } catch (error) {
    console.error("[ADMIN_USERS_GET_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to fetch users.",
      },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as JsonObject;
    const auth = await requireRole(["owner", "master"]);
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.code }, { status: auth.status });

    const id = body.id;
    const lang = getLang(body.lang);

    if (typeof id !== "number" && typeof id !== "string") {
      return NextResponse.json(
        { ok: false, error: "User id is required" },
        { status: 400 }
      );
    }

    const inputUpdates = (body.updates || {}) as JsonObject;
    if (body.action === "update_employee_level_policy") {
      if (typeof body.levelProgramEnabled !== "boolean") return policyResponse("INVALID_LEVEL_PROGRAM_ENABLED", lang);
      if (body.baseDateMode !== "hire_date" && body.baseDateMode !== "override") return policyResponse("INVALID_BASE_DATE_MODE", lang);
      const changeReason = normalizeText(body.changeReason);
      if (changeReason.length < 2) return policyResponse("CHANGE_REASON_REQUIRED", lang);

      const { data: target, error: targetError } = await supabaseServer.from("users").select(USER_SELECT).eq("id", id).maybeSingle();
      if (targetError) throw new Error(`Failed to fetch target user: ${targetError.message}`);
      if (!target) return policyResponse("EMPLOYEE_NOT_FOUND", lang, 404);
      const employee = target as UserRow;
      if (employee.is_system_account) return policyResponse("SYSTEM_ACCOUNT_NOT_ELIGIBLE", lang, 403);
      if (employee.termination_date) return policyResponse("TERMINATED_EMPLOYEE_READ_ONLY", lang, 409);
      if (!employee.hire_date) return policyResponse("HIRE_DATE_REQUIRED", lang);

      let override: string | null = null;
      if (body.levelProgramEnabled && body.baseDateMode === "override") {
        if (!normalizeText(body.levelBaseDateOverride)) return policyResponse("BASE_DATE_REQUIRED", lang);
        if (!isDateKey(body.levelBaseDateOverride)) return policyResponse("INVALID_BASE_DATE", lang);
        override = String(body.levelBaseDateOverride);
      }
      const today = getVietnamDateKey();
      const validation = validateEmployeeLevelConfiguration({
        levelProgramEnabled: body.levelProgramEnabled,
        hireDate: employee.hire_date,
        levelBaseDateOverride: override,
        terminationDate: employee.termination_date,
        isSystemAccount: employee.is_system_account,
        today,
      });
      if (!validation.valid) return policyResponse(validationCodeToPolicyCode(validation.codes[0]), lang);
      if (employee.level_program_enabled === body.levelProgramEnabled && employee.level_base_date_override === override) return policyResponse("NO_CHANGES", lang, 409);

      const previousInfo = getEmployeeLevelInfo(employee, today);
      const nextInfo = getEmployeeLevelInfo({ ...employee, level_program_enabled: body.levelProgramEnabled, level_base_date_override: override }, today);
      const { data, error } = await supabaseServer.rpc("employee_update_level_policy_v1", {
        p_user_id: id,
        p_enabled: body.levelProgramEnabled,
        p_base_date_override: override,
        p_actor_id: auth.actor.id,
        p_actor_username: auth.actor.username,
        p_change_reason: changeReason,
        p_previous_level: previousInfo.level,
        p_next_level: nextInfo.level,
      });
      if (error) throw new Error(`Failed to update employee level policy: ${error.message}`);
      return NextResponse.json({ ok: true, user: withEmployeeLevelInfo(data as UserRow, today) satisfies UserResponseRow });
    }
    if (body.action === "rehire") {
      const rehireDate = body.rehireDate;
      if (body.confirmPreviousPayrollCompleted !== true || !isDateKey(rehireDate)) {
        return NextResponse.json({ ok: false, error: lang === "vi" ? "Vui lòng xác nhận và nhập ngày làm lại hợp lệ." : "확인 후 올바른 복귀일을 입력해주세요." }, { status: 400 });
      }
      const { data: target } = await supabaseServer.from("users").select(USER_SELECT).eq("id", id).maybeSingle();
      if (!target || target.is_system_account || target.is_active !== false || !target.termination_date) {
        return NextResponse.json({ ok: false, error: lang === "vi" ? "Không thể xử lý làm lại cho tài khoản này." : "이 계정은 복귀 처리할 수 없습니다." }, { status: 409 });
      }
      const today = getVietnamDateKey();
      const previousInfo = getEmployeeLevelInfo(target as UserRow, today);
      const { data, error } = await supabaseServer.rpc("employee_rehire_with_level_reset_v1", {
        p_user_id: id, p_rehire_date: rehireDate, p_actor_id: auth.actor.id,
        p_actor_username: auth.actor.username,
        p_change_reason: lang === "vi" ? "Đặt lại chính sách cấp khi làm lại" : "복귀에 따른 레벨 정책 초기화",
        p_previous_level: previousInfo.level,
      });
      if (error) throw new Error(`Failed to rehire user: ${error.message}`);
      return NextResponse.json({ ok: true, user: withEmployeeLevelInfo(data as UserRow, today) });
    }
    const requestedRole = normalizeText(inputUpdates.role);

    if (BLOCKED_FORM_ROLES.has(requestedRole)) {
      return NextResponse.json(
        { ok: false, error: getBlockedRoleError(lang) },
        { status: 403 }
      );
    }

    if (Object.prototype.hasOwnProperty.call(inputUpdates, "position")) {
      const requestedPosition = normalizeText(inputUpdates.position);

      if (!ALLOWED_POSITIONS.has(requestedPosition)) {
        return NextResponse.json(
          { ok: false, error: getBlockedPositionError(lang) },
          { status: 400 }
        );
      }
    }

    let update = normalizeUpdate(inputUpdates);

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { ok: false, error: "No editable fields" },
        { status: 400 }
      );
    }

    const { data: target, error: targetError } = await supabaseServer
      .from("users")
      .select("id, role, hire_date, termination_date, is_active, is_system_account, payroll_eligible_override, level_program_enabled, level_base_date_override")
      .eq("id", id)
      .maybeSingle();

    if (targetError) {
      throw new Error(`Failed to fetch target user: ${targetError.message}`);
    }

    if (!target || target.is_system_account) {
      return NextResponse.json(
        { ok: false, error: "User not found" },
        { status: 404 }
      );
    }

    const hasPayrollOverrideUpdate = Object.prototype.hasOwnProperty.call(
      inputUpdates,
      "payroll_eligible_override"
    );
    if (hasPayrollOverrideUpdate) {
      const requestedOverride = inputUpdates.payroll_eligible_override;
      if (
        !isPayrollOwnerRole(target.role) ||
        (requestedOverride !== true && requestedOverride !== null)
      ) {
        return NextResponse.json(
          { ok: false, error: "Payroll eligibility override is not editable for this user." },
          { status: 403 }
        );
      }
    }

    const isPayrollOverrideOnly =
      hasPayrollOverrideUpdate && Object.keys(update).length === 1;
    if (target.role === "master" && !isPayrollOverrideOnly) {
      return NextResponse.json(
        {
          ok: false,
          error: getMasterEditError(lang),
        },
        { status: 403 }
      );
    }

    const employment = {
      hire_date: Object.prototype.hasOwnProperty.call(update, "hire_date") ? update.hire_date as string | null : target.hire_date,
      termination_date: Object.prototype.hasOwnProperty.call(update, "termination_date") ? update.termination_date as string | null : target.termination_date,
    };
    if (!validateEmploymentDates(employment)) {
      return NextResponse.json({ ok: false, error: lang === "vi" ? "Ngày nghỉ việc không thể sớm hơn ngày vào làm." : "퇴사일은 입사일보다 빠를 수 없습니다." }, { status: 400 });
    }

    const terminationPolicy = enforceTerminationAccountPolicy({
      update,
      current: {
        termination_date: target.termination_date,
        is_active: target.is_active,
      },
    });
    if (!terminationPolicy.ok) {
      return NextResponse.json(
        {
          ok: false,
          error:
            lang === "vi"
              ? "Ngày nghỉ việc không thể sau ngày hôm nay."
              : "퇴사일은 오늘 이후 날짜로 설정할 수 없습니다.",
        },
        { status: 400 }
      );
    }
    update = terminationPolicy.update;

    const { data, error } = await supabaseServer
      .from("users")
      .update(update)
      .eq("id", id)
      .eq("is_system_account", false)
      .select(USER_SELECT)
      .single();

    if (error) {
      throw new Error(`Failed to update user: ${error.message}`);
    }

    return NextResponse.json({
      ok: true,
      user: withEmployeeLevelInfo(data as UserRow, getVietnamDateKey()),
    });
  } catch (error) {
    console.error("[ADMIN_USERS_PATCH_ERROR]", error);

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to update user.",
      },
      { status: 500 }
    );
  }
}
