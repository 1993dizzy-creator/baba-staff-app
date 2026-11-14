import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/server-auth";
import { isDateKey, validateEmploymentDates } from "@/lib/employment/eligibility";
import { enforceTerminationAccountPolicy, getVietnamDateKey } from "@/lib/employment/termination-policy";
import { isPayrollOwnerRole } from "@/lib/payroll/eligibility";
import { getEmployeeRoleRank, toLegacyEmployeePosition } from "@/lib/common/roles";
import { isMasterGeneralEditBlocked, isPayrollOverrideOnlyUpdate } from "@/lib/employee/profile-update-policy";
import { applyEmployeeLevelProgramVersion, getEmployeeLevelInfo, loadEmployeeLevelProgramVersions, loadEmployeeLevelProgramVersionsForDatesUnscoped, withEmployeeLevelInfo } from "@/lib/employee-level/server";
import { loadMealAllowanceEligibilityAt, loadMealAllowanceEligibilityVersionsAt } from "@/lib/payroll/meal-allowance-eligibility-server";
import { selectMealAllowanceEligibilityAt } from "@/lib/payroll/meal-allowance";
import { validateEmployeeLevelBaseMonth, validateEmployeeLevelConfiguration } from "@/lib/employee-level/validation";
import { hireMonthBase, isEmployeeLevelBaseMonth } from "@/lib/employee-level/month";
import {
  isEmployeeLevelBaseMode,
  isEmployeeLevelEligibleRole,
  isEmployeeLevelMonthBaseMode,
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
  const fallbackMode = (row: UserRow) => isEmployeeLevelMonthBaseMode(row.level_base_mode)
    ? row.level_base_mode
    : row.level_base_date_override ? "override" : "hire_date";
  const currentSalaryRaiseEnabled = currentVersion?.salaryRaiseEnabled !== false;
  const nextSalaryRaiseEnabled = nextVersion?.salaryRaiseEnabled !== false;
  return {
    ...withEmployeeLevelInfo(currentUser, today),
    levelProgramPolicy: {
      currentEnabled,
      currentVersionId: currentVersion?.id ?? null,
      currentRevision: currentVersion?.revision ?? null,
      nextEnabled,
      currentBaseDateMode: currentVersion?.baseDateMode ?? fallbackMode(currentUser),
      nextBaseDateMode: nextVersion?.baseDateMode ?? fallbackMode(nextUser),
      currentBaseDate: currentVersion?.baseDate ?? currentUser.hire_date,
      nextBaseDate: nextVersion?.baseDate ?? nextUser.hire_date,
      currentSalaryRaiseEnabled,
      nextSalaryRaiseEnabled,
      hasScheduledChange: currentEnabled !== nextEnabled
        || currentVersion?.baseDateMode !== nextVersion?.baseDateMode
        || currentVersion?.baseDate !== nextVersion?.baseDate
        || currentSalaryRaiseEnabled !== nextSalaryRaiseEnabled,
      nextEffectiveFrom: nextMonthStart(today),
      currentEffectiveFrom: currentVersion?.effectiveFrom ?? null,
      nextPolicyEffectiveFrom: nextVersion?.effectiveFrom ?? null,
    },
  };
}

function withMealAllowanceEligibility<T extends { id: number | string }>(
  user: T,
  eligibility: Map<number, boolean>,
) {
  return { ...user, mealAllowanceEligible: eligibility.get(Number(user.id)) ?? false };
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
  level_base_date_override,
  level_base_mode,
  attendance_tracking_enabled,
  app_login_enabled
`;

const ALLOWED_ROLES = new Set(["owner", "manager", "leader", "staff"]);
const BLOCKED_FORM_ROLES = new Set(["master", "admin"]);
// position은 더 이상 독립 입력 필드가 아니다 — 최종 role에서 항상 파생해 저장한다
// (아래 resultingRole 계산부 참고). 클라이언트가 payload에 position을 보내도
// normalizeUpdate가 허용 키에서 걸러내 조용히 무시한다(구버전 탭 호환).
const ALLOWED_UPDATE_KEYS = new Set([
  "name",
  "full_name",
  "role",
  "part",
  "gender",
  "birth_date",
  "hire_date",
  "termination_date",
  "work_start_time",
  "work_end_time",
  "is_active",
  "payroll_eligible_override",
  "attendance_tracking_enabled",
  "app_login_enabled",
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
  | "BASE_DATE_AFTER_TERMINATION_DATE" | "BASE_DATE_IN_FUTURE"
  | "INVALID_BASE_MONTH" | "BASE_MONTH_BEFORE_HIRE_MONTH" | "BASE_MONTH_AFTER_TERMINATION"
  | "INVALID_SALARY_RAISE_SETTING" | "SALARY_RAISE_DECISION_REQUIRED";

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
    INVALID_BASE_MONTH: { ko: "레벨 기준월을 YYYY-MM 형식으로 선택해주세요.", vi: "Vui lòng chọn tháng mốc tính cấp theo định dạng YYYY-MM." },
    BASE_MONTH_BEFORE_HIRE_MONTH: { ko: "레벨 기준월은 실제 입사월보다 빠를 수 없습니다.", vi: "Tháng mốc tính cấp không thể sớm hơn tháng vào làm." },
    BASE_MONTH_AFTER_TERMINATION: { ko: "레벨 기준월은 퇴사월보다 늦을 수 없습니다.", vi: "Tháng mốc tính cấp không thể sau tháng nghỉ việc." },
    INVALID_SALARY_RAISE_SETTING: { ko: "레벨 급여 인상 적용 설정이 올바르지 않습니다.", vi: "Thiết lập áp dụng tăng lương theo cấp không hợp lệ." },
    SALARY_RAISE_DECISION_REQUIRED: { ko: "레벨을 적용하려면 레벨 인상의 급여 반영 여부를 선택해주세요.", vi: "Khi áp dụng cấp, vui lòng chọn có tính tăng lương theo cấp vào lương hay không." },
  };
  return messages[code][lang];
}

function validationCodeToPolicyCode(code: EmployeeLevelValidationCode): LevelPolicyErrorCode {
  if (code === "MISSING_HIRE_DATE") return "HIRE_DATE_REQUIRED";
  if (code === "INVALID_DATE") return "INVALID_BASE_DATE";
  if (code === "SYSTEM_ACCOUNT_NOT_ELIGIBLE") return "SYSTEM_ACCOUNT_NOT_ELIGIBLE";
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

function getAttendanceOpenRecordError(lang: "ko" | "vi") {
  return lang === "vi"
    ? "Không thể tắt chấm công vì nhân viên vẫn còn bản ghi chưa chấm công ra. Vui lòng xử lý giờ ra hoặc điều chỉnh bản ghi trước."
    : "현재 퇴근되지 않은 근태 기록이 있어 근태 사용을 해제할 수 없습니다. 먼저 퇴근 처리하거나 관리자 보정을 완료해주세요.";
}

function sortUsers(users: UserRow[]) {
  return [...users].sort((a, b) => {
    // 표시 순서는 role 기준: master → owner → manager → leader → staff.
    const rankDiff = getEmployeeRoleRank(a.role) - getEmployeeRoleRank(b.role);
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

    if (key === "attendance_tracking_enabled" || key === "app_login_enabled") {
      update[key] = value === true;
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

    // today/nextDate don't depend on the users query, so all three reads can
    // start together right after auth — level and meal are read broadly
    // (date-scoped only, no candidate-userId prefilter) instead of waiting
    // for the users query to resolve first. Extra rows belonging to system
    // accounts or any other user are never a problem: the final mapping
    // below only ever looks values up by ids taken from `users` (already
    // filtered to is_system_account=false), so anything else in the broader
    // reads is simply never read.
    const today = getVietnamDateKey();
    const nextDate = nextMonthStart(today);
    const [usersResult, versionsByDate, mealVersionsByUser] = await Promise.all([
      supabaseServer.from("users").select(USER_SELECT).eq("is_system_account", false),
      loadEmployeeLevelProgramVersionsForDatesUnscoped([today, nextDate]),
      loadMealAllowanceEligibilityVersionsAt(today),
    ]);

    if (usersResult.error) {
      throw new Error(`Failed to fetch users: ${usersResult.error.message}`);
    }

    const users = sortUsers((usersResult.data || []).map(sanitizePublicEmployeeUser));
    const versions = versionsByDate.get(today) ?? new Map();
    const nextVersions = versionsByDate.get(nextDate) ?? new Map();
    const mealAllowanceEligibility = new Map<number, boolean>(
      users.map((user) => {
        const userId = Number(user.id);
        return [userId, selectMealAllowanceEligibilityAt(mealVersionsByUser.get(userId) ?? [], today)];
      }),
    );
    return NextResponse.json({
      ok: true,
      users: users.map((user) => withMealAllowanceEligibility(
        withLevelPolicyState(user, versions.get(Number(user.id)), nextVersions.get(Number(user.id)), today),
        mealAllowanceEligibility,
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
    const isCancelTermination = body.action === "cancel_termination";
    if (body.action === "rehire") {
      const rehireDate = body.rehireDate;
      const rehireLevelEnabled = body.levelProgramEnabled;
      if (body.confirmPreviousPayrollCompleted !== true || !isDateKey(rehireDate) || typeof rehireLevelEnabled !== "boolean") {
        return NextResponse.json({ ok: false, error: lang === "vi" ? "Vui lòng xác nhận và nhập ngày làm lại hợp lệ." : "확인 후 올바른 복귀일을 입력해주세요." }, { status: 400 });
      }
      // New rehire policies automatically pay regular level raises when enabled.
      const rehireSalaryRaise = rehireLevelEnabled ? true : null;
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
      // v4: the rehire date sets a hire_month base (1–15 -> that month, 16+ -> next month).
      const { data, error } = await supabaseServer.rpc("employee_rehire_with_level_policy_v4", {
        p_user_id: id, p_rehire_date: rehireDate, p_actor_id: auth.actor.id,
        p_actor_username: auth.actor.username,
        p_level_program_enabled: rehireLevelEnabled,
        p_change_reason: rehireLevelEnabled
          ? "employee_rehired_level_enabled"
          : "employee_rehired_level_disabled",
        p_previous_level: previousInfo.level,
        p_salary_raise_enabled: typeof rehireSalaryRaise === "boolean" ? rehireSalaryRaise : null,
      });
      if (error) throw new Error(`Failed to rehire user: ${error.message}`);
      const [versions, nextVersions, mealAllowanceEligibility] = await Promise.all([
        loadEmployeeLevelProgramVersions([Number(id)], today),
        loadEmployeeLevelProgramVersions([Number(id)], nextMonthStart(today)),
        loadMealAllowanceEligibilityAt([Number(id)], today),
      ]);
      return NextResponse.json({
        ok: true,
        user: withMealAllowanceEligibility(
          withLevelPolicyState(
            sanitizePublicEmployeeUser(data),
            versions.get(Number(id)),
            nextVersions.get(Number(id)),
            today,
          ),
          mealAllowanceEligibility,
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

    let update = normalizeUpdate(inputUpdates);

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { ok: false, error: "No editable fields" },
        { status: 400 }
      );
    }

    const { data: target, error: targetError } = await supabaseServer
      .from("users")
      .select("id, role, hire_date, termination_date, is_active, is_system_account, payroll_eligible_override, level_program_enabled, level_base_date_override, level_base_mode")
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

    if (isCancelTermination) {
      const explicitlyClearsTermination =
        Object.prototype.hasOwnProperty.call(update, "termination_date") &&
        update.termination_date === null;
      const explicitlyReactivates =
        Object.prototype.hasOwnProperty.call(update, "is_active") &&
        update.is_active === true;
      const preservesHireDate =
        !Object.prototype.hasOwnProperty.call(update, "hire_date") ||
        update.hire_date === target.hire_date;
      if (
        !target.termination_date ||
        target.is_active !== false ||
        !explicitlyClearsTermination ||
        !explicitlyReactivates ||
        !preservesHireDate
      ) {
        return NextResponse.json(
          {
            ok: false,
            error:
              lang === "vi"
                ? "Không thể hủy thông tin nghỉ việc với các giá trị đã nhập."
                : "입력한 값으로 퇴사 처리를 취소할 수 없습니다.",
          },
          { status: 409 },
        );
      }
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

    const isPayrollOverrideOnly = isPayrollOverrideOnlyUpdate(update, hasPayrollOverrideUpdate);
    if (isMasterGeneralEditBlocked(target.role, isPayrollOverrideOnly)) {
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
      allowExplicitReactivationOnClear: isCancelTermination,
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
    // 레거시 DB 호환용 position은 클라이언트가 무엇을 보냈든 최종 role에서 다시
    // 계산한다(role=master는 position=owner로 유지). update에 role이 없는 요청
    // (예: 생년월일만 수정)도 target.role 기준으로 항상 동기화된다.
    //
    // update 객체 자체에는 절대 position을 섞지 않는다 — isPayrollOverrideOnlyUpdate가
    // update의 키 개수로 override-only 여부를 판정하는데(위에서 isMasterGeneralEditBlocked
    // 판정까지 이미 끝남), 이 시점 이후 어떤 코드가 update에 필드를 추가해도 그 판정이
    // 흔들리지 않도록, derivedPosition은 별도 변수로 들고 있다가 RPC 호출 시점에만
    // 병합한다.
    const derivedPosition = toLegacyEmployeePosition(resultingRole);
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
    const nextMonth = nextMonthStart(today);
    if (requestedEffectiveFrom) {
      if (requestedEffectiveFrom !== nextMonth) {
        return NextResponse.json({
          ok: false,
          code: "INVALID_LEVEL_EFFECTIVE_MONTH",
          error: lang === "vi"
            ? "Thay đổi mới bắt đầu từ ngày 1 tháng sau."
            : "새 정책은 다음 달 1일부터 적용됩니다.",
        }, { status: 400 });
      }
    }
    const comparisonVersion = currentVersion;
    const comparisonEnabled = comparisonVersion?.enabled
      ?? isEmployeeLevelEligibleRole(resultingRole, target.level_program_enabled);
    // Legacy modes are internal compatibility for unchanged profile saves only.
    const requestedBaseDateMode = body.levelBaseDateMode;
    if (!isEmployeeLevelBaseMode(requestedBaseDateMode)) {
      return policyResponse("INVALID_BASE_DATE", lang);
    }
    let requestedBaseDateOverride: string | null = null;
    if (requestedBaseDateMode === "override") {
      requestedBaseDateOverride = normalizeText(body.levelBaseDateOverride);
      if (!requestedBaseDateOverride || !isDateKey(requestedBaseDateOverride)) {
        return policyResponse("INVALID_BASE_DATE", lang);
      }
    } else if (requestedBaseDateMode === "override_month") {
      const baseMonth = normalizeText(body.levelBaseMonth);
      if (!isEmployeeLevelBaseMonth(baseMonth)) return policyResponse("INVALID_BASE_MONTH", lang);
      requestedBaseDateOverride = `${baseMonth}-01`;
    }
    const comparisonBaseDateMode = comparisonVersion?.baseDateMode
      ?? (isEmployeeLevelMonthBaseMode(target.level_base_mode)
        ? target.level_base_mode
        : target.level_base_date_override ? "override" : "hire_date");
    const comparisonBaseDateOverride = comparisonBaseDateMode === "override" || comparisonBaseDateMode === "override_month"
      ? comparisonVersion?.baseDate ?? target.level_base_date_override
      : null;
    const comparisonSalaryRaiseEnabled = comparisonVersion?.salaryRaiseEnabled !== false;
    const baseUsesOverride = requestedBaseDateMode === "override" || requestedBaseDateMode === "override_month";
    // hire_month: the month stored on the version vs the month the (edited) hire date gives.
    const hireMonthChanged = resultingHireDate !== target.hire_date && requestedBaseDateMode === "hire_month" && comparisonBaseDateMode === "hire_month"
      && Boolean(comparisonVersion?.baseDate)
      && comparisonVersion?.baseDate !== `${hireMonthBase(resultingHireDate)}-01`;
    const settingsChanged = comparisonEnabled !== levelProgramEnabled
      || comparisonBaseDateMode !== requestedBaseDateMode
      || (baseUsesOverride && comparisonBaseDateOverride !== requestedBaseDateOverride)
      || hireMonthChanged;
    if (hireMonthChanged && body.levelPolicyEdit !== true) {
      return NextResponse.json({ ok: false, code: "LEVEL_BASE_MONTH_REVIEW_REQUIRED", error: lang === "vi" ? "Ngày vào làm mới làm thay đổi tháng mốc. Kiểm tra tháng mốc trong thiết lập cấp, bấm 'Áp dụng', rồi bấm Lưu ở thông tin nhân viên để lưu chính thức." : "입사일 변경으로 기준월이 달라집니다. 레벨 설정에서 기준월을 확인한 후 '적용'을 누르고, 직원 상세에서 최종 저장해주세요." }, { status: 400 });
    }
    const salaryRaiseEnabled = levelProgramEnabled && (settingsChanged || body.levelPolicyEdit === true)
      ? true : comparisonSalaryRaiseEnabled;
    const levelPolicyChanged = settingsChanged || comparisonSalaryRaiseEnabled !== salaryRaiseEnabled;
    if (levelPolicyChanged && !isEmployeeLevelMonthBaseMode(requestedBaseDateMode)) {
      return NextResponse.json({ ok: false, code: "LEVEL_MONTH_BASE_REQUIRED",
        error: lang === "vi" ? "Thay đổi cấp cần dùng tháng mốc tự động hoặc tháng mốc chỉ định."
          : "레벨 설정을 변경하려면 입사월 자동 또는 직접 기준월을 선택해주세요.",
      }, { status: 400 });
    }
    const levelEffectiveFrom = levelPolicyChanged ? nextMonth : "";
    if (levelPolicyChanged) {
      const scheduled = (await loadEmployeeLevelProgramVersions([Number(id)], nextMonth)).get(Number(id));
      if (scheduled && scheduled.effectiveFrom > today) return NextResponse.json({ ok: false, code: "LEVEL_POLICY_SCHEDULED_CHANGE_EXISTS",
        error: lang === "vi" ? "Đã có thay đổi cấp được lên lịch. Không ghi đè lịch hiện có." : "이미 예약된 레벨 변경이 있습니다. 기존 예약을 덮어쓸 수 없습니다." }, { status: 409 });
    }
    const expectedVersionId = body.levelExpectedVersionId === undefined ? currentVersion?.id ?? null : body.levelExpectedVersionId;
    const expectedRevision = body.levelExpectedRevision === undefined ? currentVersion?.revision ?? null : body.levelExpectedRevision;
    if ([expectedVersionId, expectedRevision].some(value => value !== null && (!Number.isSafeInteger(value) || Number(value) < 1))) {
      return NextResponse.json({ ok: false, error: "INVALID_LEVEL_EXPECTED_VERSION" }, { status: 400 });
    }
    const automaticChangeReason = comparisonEnabled !== levelProgramEnabled
      ? levelProgramEnabled ? "admin_level_enabled" : "admin_level_disabled"
      : comparisonBaseDateMode !== requestedBaseDateMode
        ? `admin_level_base_${requestedBaseDateMode}`
        : (baseUsesOverride && comparisonBaseDateOverride !== requestedBaseDateOverride) || hireMonthChanged
          ? "admin_level_base_date_changed"
          : salaryRaiseEnabled ? "admin_level_salary_raise_enabled" : "admin_level_salary_raise_disabled";
    if (target.is_system_account && levelProgramEnabled === true) {
      return policyResponse("SYSTEM_ACCOUNT_NOT_ELIGIBLE", lang, 403);
    }
    if (
      !target.is_system_account
    ) {
      // Legacy date rules for date modes (unchanged); month rules for month modes.
      const levelValidation = isEmployeeLevelMonthBaseMode(requestedBaseDateMode)
        ? validateEmployeeLevelBaseMonth({
            mode: requestedBaseDateMode,
            baseMonth: requestedBaseDateOverride ? requestedBaseDateOverride.slice(0, 7) : null,
            hireDate: resultingHireDate,
            terminationDate: resultingTerminationDate,
          })
        : validateEmployeeLevelConfiguration({
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
      "employee_update_profile_and_level_v11",
      {
        p_user_id: id,
        p_updates: { ...update, position: derivedPosition },
        p_level_program_enabled: levelProgramEnabled,
        p_effective_from: levelPolicyChanged ? levelEffectiveFrom : null,
        p_base_date_mode: requestedBaseDateMode,
        p_base_date_override: requestedBaseDateOverride,
        p_salary_raise_enabled: salaryRaiseEnabled,
        p_expected_version_id: expectedVersionId,
        p_expected_revision: expectedRevision,
        p_change_reason: levelPolicyChanged ? automaticChangeReason : null,
        p_actor_id: auth.actor.id,
        p_actor_username: auth.actor.username,
      }
    );

    if (error) {
      if (/LEVEL_POLICY_STALE|LEVEL_POLICY_SCHEDULED_CHANGE_EXISTS/.test(error.message ?? "")) {
        return NextResponse.json({ ok: false, code: error.message.includes("LEVEL_POLICY_STALE") ? "LEVEL_POLICY_STALE" : "LEVEL_POLICY_SCHEDULED_CHANGE_EXISTS",
          error: lang === "vi" ? "Chính sách đã thay đổi hoặc có lịch mới. Tải lại thông tin nhân viên trước khi lưu." : "레벨 정책이 변경되었거나 예약이 추가되었습니다. 직원 정보를 새로 불러온 뒤 저장해주세요." }, { status: 409 });
      }
      if (error.message?.includes("ATTENDANCE_OPEN_RECORD_EXISTS")) {
        return NextResponse.json(
          {
            ok: false,
            code: "ATTENDANCE_OPEN_RECORD_EXISTS",
            error: getAttendanceOpenRecordError(lang),
          },
          { status: 409 }
        );
      }
      throw new Error(`Failed to atomically update user: ${error.message}`);
    }

    const [updatedVersions, updatedNextVersions, updatedMealAllowanceEligibility] = await Promise.all([
      loadEmployeeLevelProgramVersions([Number(id)], today),
      loadEmployeeLevelProgramVersions([Number(id)], nextMonthStart(today)),
      loadMealAllowanceEligibilityAt([Number(id)], today),
    ]);
    return NextResponse.json({
      ok: true,
      user: withMealAllowanceEligibility(
        withLevelPolicyState(
          sanitizePublicEmployeeUser(data),
          updatedVersions.get(Number(id)),
          updatedNextVersions.get(Number(id)),
          today,
        ),
        updatedMealAllowanceEligibility,
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
