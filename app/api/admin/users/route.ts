import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/server-auth";
import { isDateKey, validateEmploymentDates } from "@/lib/employment/eligibility";
import { enforceTerminationAccountPolicy, getVietnamDateKey } from "@/lib/employment/termination-policy";
import { isPayrollOwnerRole } from "@/lib/payroll/eligibility";
import { applyEmployeeLevelProgramVersion, getEmployeeLevelInfo, loadEmployeeLevelProgramVersions, withEmployeeLevelInfo } from "@/lib/employee-level/server";
import { validateEmployeeLevelConfiguration } from "@/lib/employee-level/validation";
import {
  isEmployeeLevelEligibleRole,
  type EmployeeLevelProgramVersion,
  type EmployeeLevelValidationCode,
} from "@/lib/employee-level/types";
import {
  sanitizePublicEmployeeUser,
  type PublicEmployeeUserRow,
} from "@/lib/employee-level/public-user";

type JsonObject = Record<string, unknown>;

type UserRow = PublicEmployeeUserRow;

function nextMonthStart(dateKey: string) {
  const [year, month] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

function withLevelPolicyState(
  user: UserRow,
  currentVersion: EmployeeLevelProgramVersion | undefined,
  nextVersion: EmployeeLevelProgramVersion | undefined,
  today: string,
) {
  const currentUser = applyEmployeeLevelProgramVersion(user, currentVersion);
  const nextUser = applyEmployeeLevelProgramVersion(user, nextVersion);
  const currentEnabled = isEmployeeLevelEligibleRole(currentUser.role, currentUser.level_program_enabled);
  const nextEnabled = isEmployeeLevelEligibleRole(nextUser.role, nextUser.level_program_enabled);
  return {
    ...withEmployeeLevelInfo(currentUser, today),
    levelProgramPolicy: {
      currentEnabled,
      nextEnabled,
      currentBaseDateMode: currentVersion?.baseDateMode ?? (currentUser.level_base_date_override ? "override" : "hire_date"),
      nextBaseDateMode: nextVersion?.baseDateMode ?? (nextUser.level_base_date_override ? "override" : "hire_date"),
      currentBaseDate: currentVersion?.baseDate ?? currentUser.hire_date,
      nextBaseDate: nextVersion?.baseDate ?? nextUser.hire_date,
      hasScheduledChange: currentEnabled !== nextEnabled
        || currentVersion?.baseDateMode !== nextVersion?.baseDateMode
        || currentVersion?.baseDate !== nextVersion?.baseDate,
      nextEffectiveFrom: nextMonthStart(today),
    },
  };
}

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
  | "INVALID_LEVEL_PROGRAM_SETTING"
  | "HIRE_DATE_REQUIRED"
  | "BASE_DATE_REQUIRED" | "INVALID_BASE_DATE" | "BASE_DATE_BEFORE_HIRE_DATE"
  | "BASE_DATE_AFTER_TERMINATION_DATE" | "BASE_DATE_IN_FUTURE";

function levelPolicyError(code: LevelPolicyErrorCode, lang: "ko" | "vi") {
  const messages: Record<LevelPolicyErrorCode, { ko: string; vi: string }> = {
    EMPLOYEE_NOT_FOUND: { ko: "직원을 찾을 수 없습니다.", vi: "Không tìm thấy nhân viên." },
    SYSTEM_ACCOUNT_NOT_ELIGIBLE: { ko: "시스템 계정에는 직원 레벨을 설정할 수 없습니다.", vi: "Không thể thiết lập cấp nhân viên cho tài khoản hệ thống." },
    TERMINATED_EMPLOYEE_READ_ONLY: { ko: "퇴사자의 레벨 설정은 조회만 가능합니다.", vi: "Thiết lập cấp của nhân viên đã nghỉ việc chỉ có thể xem." },
    INVALID_LEVEL_PROGRAM_SETTING: { ko: "레벨 대상 포함 설정이 올바르지 않습니다.", vi: "Thiết lập bao gồm cấp nhân viên không hợp lệ." },
    HIRE_DATE_REQUIRED: { ko: "레벨 제도를 적용하려면 입사일이 필요합니다.", vi: "Cần có ngày vào làm để áp dụng chế độ cấp." },
    BASE_DATE_REQUIRED: { ko: "레벨 기준일을 입력해주세요.", vi: "Vui lòng nhập ngày bắt đầu tính cấp." },
    INVALID_BASE_DATE: { ko: "레벨 기준일 형식이 올바르지 않습니다.", vi: "Định dạng ngày bắt đầu tính cấp không hợp lệ." },
    BASE_DATE_BEFORE_HIRE_DATE: { ko: "레벨 기준일은 입사일보다 빠를 수 없습니다.", vi: "Ngày bắt đầu tính cấp không thể sớm hơn ngày vào làm." },
    BASE_DATE_AFTER_TERMINATION_DATE: { ko: "레벨 기준일은 퇴사일보다 늦을 수 없습니다.", vi: "Ngày bắt đầu tính cấp không thể sau ngày nghỉ việc." },
    BASE_DATE_IN_FUTURE: { ko: "레벨 기준일은 오늘 이후 날짜로 설정할 수 없습니다.", vi: "Ngày bắt đầu tính cấp không thể sau ngày hôm nay." },
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

    const users = sortUsers((data || []).map(sanitizePublicEmployeeUser));
    const today = getVietnamDateKey();
    const userIds = users.map((user) => Number(user.id));
    const [versions, nextVersions] = await Promise.all([
      loadEmployeeLevelProgramVersions(userIds, today),
      loadEmployeeLevelProgramVersions(userIds, nextMonthStart(today)),
    ]);
    return NextResponse.json({
      ok: true,
      users: users.map((user) => withLevelPolicyState(
        user, versions.get(Number(user.id)), nextVersions.get(Number(user.id)), today,
      )),
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
    if (body.action === "rehire") {
      const rehireDate = body.rehireDate;
      const rehireLevelEnabled = body.levelProgramEnabled;
      if (body.confirmPreviousPayrollCompleted !== true || !isDateKey(rehireDate) || typeof rehireLevelEnabled !== "boolean") {
        return NextResponse.json({ ok: false, error: lang === "vi" ? "Vui lòng xác nhận và nhập ngày làm lại hợp lệ." : "확인 후 올바른 복귀일을 입력해주세요." }, { status: 400 });
      }
      const { data: target } = await supabaseServer.from("users").select(USER_SELECT).eq("id", id).maybeSingle();
      if (!target || target.is_system_account || target.is_active !== false || !target.termination_date) {
        return NextResponse.json({ ok: false, error: lang === "vi" ? "Không thể xử lý làm lại cho tài khoản này." : "이 계정은 복귀 처리할 수 없습니다." }, { status: 409 });
      }
      const today = getVietnamDateKey();
      const previousVersions = await loadEmployeeLevelProgramVersions([Number(id)], today);
      const previousInfo = getEmployeeLevelInfo(
        applyEmployeeLevelProgramVersion(target as UserRow, previousVersions.get(Number(id))),
        today,
      );
      const { data, error } = await supabaseServer.rpc("employee_rehire_with_level_policy_v3", {
        p_user_id: id, p_rehire_date: rehireDate, p_actor_id: auth.actor.id,
        p_actor_username: auth.actor.username,
        p_level_program_enabled: rehireLevelEnabled,
        p_change_reason: rehireLevelEnabled
          ? "employee_rehired_level_enabled"
          : "employee_rehired_level_disabled",
        p_previous_level: previousInfo.level,
      });
      if (error) throw new Error(`Failed to rehire user: ${error.message}`);
      const [versions, nextVersions] = await Promise.all([
        loadEmployeeLevelProgramVersions([Number(id)], today),
        loadEmployeeLevelProgramVersions([Number(id)], nextMonthStart(today)),
      ]);
      return NextResponse.json({
        ok: true,
        user: withLevelPolicyState(
          sanitizePublicEmployeeUser(data),
          versions.get(Number(id)),
          nextVersions.get(Number(id)),
          today,
        ),
      });
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

    if (!target) {
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

    const resultingHireDate = Object.prototype.hasOwnProperty.call(update, "hire_date")
      ? update.hire_date as string | null
      : target.hire_date;
    const resultingTerminationDate = Object.prototype.hasOwnProperty.call(update, "termination_date")
      ? update.termination_date as string | null
      : target.termination_date;
    const resultingRole = Object.prototype.hasOwnProperty.call(update, "role")
      ? update.role as string | null
      : target.role;
    const today = getVietnamDateKey();
    const versions = await loadEmployeeLevelProgramVersions([Number(id)], today);
    const currentVersion = versions.get(Number(id));
    let levelProgramEnabled = currentVersion?.enabled
      ?? isEmployeeLevelEligibleRole(resultingRole, target.level_program_enabled);
    if (Object.prototype.hasOwnProperty.call(body, "levelProgramEnabled")) {
      if (typeof body.levelProgramEnabled !== "boolean") {
        return policyResponse("INVALID_LEVEL_PROGRAM_SETTING", lang);
      }
      levelProgramEnabled = body.levelProgramEnabled;
    }
    const requestedEffectiveFrom = normalizeText(body.levelEffectiveFrom);
    const currentMonth = `${today.slice(0, 7)}-01`;
    const nextMonth = nextMonthStart(today);
    if (requestedEffectiveFrom) {
      if (!/^\d{4}-\d{2}-01$/.test(requestedEffectiveFrom)
        || (requestedEffectiveFrom !== currentMonth && requestedEffectiveFrom !== nextMonth)) {
        return NextResponse.json({
          ok: false,
          code: "INVALID_LEVEL_EFFECTIVE_MONTH",
          error: lang === "vi"
            ? "Chỉ có thể chọn tháng này hoặc tháng sau."
            : "적용 월은 이번 달 또는 다음 달만 선택할 수 있습니다.",
        }, { status: 400 });
      }
    }
    const comparisonVersion = requestedEffectiveFrom
      ? (await loadEmployeeLevelProgramVersions([Number(id)], requestedEffectiveFrom)).get(Number(id))
      : currentVersion;
    const comparisonEnabled = comparisonVersion?.enabled
      ?? isEmployeeLevelEligibleRole(resultingRole, target.level_program_enabled);
    const requestedBaseDateMode = body.levelBaseDateMode;
    if (requestedBaseDateMode !== "hire_date" && requestedBaseDateMode !== "override") {
      return policyResponse("INVALID_BASE_DATE", lang);
    }
    const requestedBaseDateOverride = requestedBaseDateMode === "override"
      ? normalizeText(body.levelBaseDateOverride)
      : null;
    if (requestedBaseDateMode === "override" && (!requestedBaseDateOverride || !isDateKey(requestedBaseDateOverride))) {
      return policyResponse("INVALID_BASE_DATE", lang);
    }
    const comparisonBaseDateMode = comparisonVersion?.baseDateMode
      ?? (target.level_base_date_override ? "override" : "hire_date");
    const comparisonBaseDateOverride = comparisonBaseDateMode === "override"
      ? comparisonVersion?.baseDate ?? target.level_base_date_override
      : null;
    const levelPolicyChanged = comparisonEnabled !== levelProgramEnabled
      || comparisonBaseDateMode !== requestedBaseDateMode
      || (requestedBaseDateMode === "override" && comparisonBaseDateOverride !== requestedBaseDateOverride);
    const levelEffectiveFrom = levelPolicyChanged ? requestedEffectiveFrom : "";
    if (levelPolicyChanged && !levelEffectiveFrom) {
      return NextResponse.json({ ok: false, error: lang === "vi" ? "Vui lòng chọn tháng áp dụng." : "적용 월을 선택해주세요." }, { status: 400 });
    }
    const automaticChangeReason = comparisonEnabled !== levelProgramEnabled
      ? levelProgramEnabled ? "admin_level_enabled" : "admin_level_disabled"
      : comparisonBaseDateMode !== requestedBaseDateMode
        ? requestedBaseDateMode === "hire_date" ? "admin_level_base_hire_date" : "admin_level_base_override"
        : "admin_level_base_date_changed";
    if (target.is_system_account && levelProgramEnabled === true) {
      return policyResponse("SYSTEM_ACCOUNT_NOT_ELIGIBLE", lang, 403);
    }
    if (
      !target.is_system_account
    ) {
      const levelValidation = validateEmployeeLevelConfiguration({
        hireDate: resultingHireDate,
        levelBaseDateOverride: requestedBaseDateOverride,
        terminationDate: resultingTerminationDate,
        today,
      });
      if (!levelValidation.valid) {
        return policyResponse(validationCodeToPolicyCode(levelValidation.codes[0]), lang);
      }
    }
    if (target.termination_date && levelPolicyChanged) {
      return policyResponse("TERMINATED_EMPLOYEE_READ_ONLY", lang, 409);
    }

    const { data, error } = await supabaseServer.rpc(
      "employee_update_profile_and_level_v6",
      {
        p_user_id: id,
        p_updates: update,
        p_level_program_enabled: levelProgramEnabled,
        p_effective_from: levelPolicyChanged ? levelEffectiveFrom : null,
        p_base_date_mode: requestedBaseDateMode,
        p_base_date_override: requestedBaseDateOverride,
        p_change_reason: levelPolicyChanged ? automaticChangeReason : null,
        p_actor_id: auth.actor.id,
        p_actor_username: auth.actor.username,
      }
    );

    if (error) {
      throw new Error(`Failed to atomically update user: ${error.message}`);
    }

    const [updatedVersions, updatedNextVersions] = await Promise.all([
      loadEmployeeLevelProgramVersions([Number(id)], today),
      loadEmployeeLevelProgramVersions([Number(id)], nextMonthStart(today)),
    ]);
    return NextResponse.json({
      ok: true,
      user: withLevelPolicyState(
        sanitizePublicEmployeeUser(data),
        updatedVersions.get(Number(id)),
        updatedNextVersions.get(Number(id)),
        today,
      ),
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
