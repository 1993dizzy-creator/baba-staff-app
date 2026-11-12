"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { calculateCombinedSalary, type CompensationContract } from "@/lib/payroll/compensation";
import type { buildEmployeeLevelHistory } from "@/lib/employee-level/history";
import { usePathname, useRouter } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { PART_VALUES, getPartKey, getPartMeta } from "@/lib/common/parts";
import {
  EDITABLE_EMPLOYEE_ROLE_VALUES,
  getEmployeeRoleLabel,
  getEmployeeRoleRank,
  isEditableEmployeeRole,
} from "@/lib/common/roles";
import { GENDER_VALUES, getGenderLabel } from "@/lib/common/genders";
import { useLanguage } from "@/lib/language-context";
import { getUser, isAdmin } from "@/lib/supabase/auth";
import { ui } from "@/lib/styles/ui";
import { adminUsersText } from "@/lib/text";
import { attendanceFetch } from "@/lib/auth/client-session";
import EmployeeNameWithLevel from "@/components/employee/EmployeeNameWithLevel";
import {
  isEmployeeLevelAutomaticRole,
  isEmployeeLevelMonthBaseMode,
  type EmployeeLevelBaseMode,
  type EmployeeLevelInfo,
} from "@/lib/employee-level/types";
import { addCalendarMonthsClamped, calculateEmployeeLevel } from "@/lib/employee-level/calculate";
import { hireMonthBase } from "@/lib/employee-level/month";
import { employeeLevelMonthCandidate } from "@/lib/employee-level/month-transition";
import { isPayrollEligible, requiresFixedMonthlyContract } from "@/lib/payroll/eligibility";
import EmployeePayrollSettingsPanel, { type EmployeePayrollPanelUser } from "@/components/payroll/EmployeePayrollSettingsPanel";
import type { MealAllowanceVersion } from "@/components/payroll/EmployeeMealAllowanceSettings";
import { usePayrollContracts, type PayrollContractView, type PayrollContractsController } from "@/components/payroll/usePayrollContracts";
import { resolveSettingsSummaryReference, type SettingHistoryState } from "@/lib/payroll/settings-summary";
import { NO_PAYROLL_UNSAVED, hasPayrollUnsaved, payrollLeaveMessage, useLeaveGuard, type PayrollUnsavedState } from "@/components/payroll/payrollUnsaved";
import { isTopModal, useModalFocusTrap } from "@/components/payroll/useModalFocusTrap";
import { payrollApplicabilityIcons, type PayrollApplicabilityEmployee, type PayrollApplicabilityIcon } from "@/lib/payroll/applicability-icons";
import { vietnamCurrentMonthStart } from "@/lib/payroll/ui-dates";
import { scheduledMinutesPerDay } from "@/lib/payroll/work-schedule";

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
  level_base_mode?: string | null;
  attendance_tracking_enabled: boolean;
  app_login_enabled: boolean;
  mealAllowanceEligible: boolean;
  levelInfo: EmployeeLevelInfo;
  levelProgramPolicy?: {
    currentEnabled: boolean;
    currentVersionId?: number | null;
    currentRevision?: number | null;
    nextEnabled: boolean;
    currentBaseDateMode: EmployeeLevelBaseMode;
    nextBaseDateMode: EmployeeLevelBaseMode;
    currentBaseDate: string | null;
    nextBaseDate: string | null;
    currentSalaryRaiseEnabled?: boolean;
    nextSalaryRaiseEnabled?: boolean;
    hasScheduledChange: boolean;
    nextEffectiveFrom: string;
    currentEffectiveFrom?: string | null;
    nextPolicyEffectiveFrom?: string | null;
  };
};

type LevelPolicyDraft = {
  included: boolean;
  baseDateMode: EmployeeLevelBaseMode;
  /** Legacy "override" date (kept only to preserve an existing basis). */
  baseDateOverride: string;
  /** "YYYY-MM" for override_month. */
  baseMonth: string;
  /** null = not chosen yet (required when the level is turned ON). */
  salaryRaiseEnabled: boolean | null;
  effectiveMonth: "current" | "next";
  applied?: boolean;
};

function currentPolicyEnabled(user: UserRow) {
  return user.levelProgramPolicy?.currentEnabled
    ?? (user.level_program_enabled === false
      ? false
      : isEmployeeLevelAutomaticRole(user.role) || user.level_program_enabled === true);
}

function policyEnabledForMonth(user: UserRow, month: LevelPolicyDraft["effectiveMonth"]) {
  return month === "next"
    ? user.levelProgramPolicy?.nextEnabled ?? currentPolicyEnabled(user)
    : currentPolicyEnabled(user);
}

function policyBaseForMonth(user: UserRow, month: LevelPolicyDraft["effectiveMonth"]) {
  const next = month === "next";
  const mode = next ? user.levelProgramPolicy?.nextBaseDateMode : user.levelProgramPolicy?.currentBaseDateMode;
  const baseDate = next ? user.levelProgramPolicy?.nextBaseDate : user.levelProgramPolicy?.currentBaseDate;
  const salaryRaiseEnabled = next ? user.levelProgramPolicy?.nextSalaryRaiseEnabled : user.levelProgramPolicy?.currentSalaryRaiseEnabled;
  const fallbackMode: EmployeeLevelBaseMode = isEmployeeLevelMonthBaseMode(user.level_base_mode)
    ? user.level_base_mode
    : user.level_base_date_override ? "override" : "hire_date";
  return {
    mode: mode ?? fallbackMode,
    baseDate: baseDate ?? user.level_base_date_override ?? user.hire_date,
    salaryRaiseEnabled: salaryRaiseEnabled !== false,
  };
}

function draftFromBase(included: boolean, base: ReturnType<typeof policyBaseForMonth>, effectiveMonth: LevelPolicyDraft["effectiveMonth"]): LevelPolicyDraft {
  return {
    included,
    baseDateMode: base.mode,
    baseDateOverride: base.mode === "override" ? base.baseDate ?? "" : "",
    baseMonth: base.mode === "override_month" ? (base.baseDate ?? "").slice(0, 7) : "",
    // A level that is OFF has no raise decision yet: turning it ON must choose one.
    salaryRaiseEnabled: included ? base.salaryRaiseEnabled : null,
    effectiveMonth,
  };
}

function initialLevelPolicyDraft(user: UserRow): LevelPolicyDraft {
  return draftFromBase(currentPolicyEnabled(user), policyBaseForMonth(user, "current"), "current");
}

/** True when the draft differs from the policy in force for the chosen effective month. */
function levelDraftChanged(user: UserRow, draft: LevelPolicyDraft, hireDate: string | null) {
  const base = policyBaseForMonth(user, draft.effectiveMonth);
  const hireMonth = hireMonthBase(hireDate);
  return draft.included !== policyEnabledForMonth(user, draft.effectiveMonth)
    || draft.baseDateMode !== base.mode
    || (draft.baseDateMode === "override" && draft.baseDateOverride !== base.baseDate)
    || (draft.baseDateMode === "override_month" && `${draft.baseMonth}-01` !== base.baseDate)
    // hire_month: a hire-date edit that moves the base month needs a new policy version.
    || (draft.baseDateMode === "hire_month" && base.mode === "hire_month" && hireDate !== user.hire_date && hireMonth !== null && `${hireMonth}-01` !== base.baseDate)
    || (draft.salaryRaiseEnabled !== null && draft.salaryRaiseEnabled !== base.salaryRaiseEnabled);
}

type UsersResponse = {
  ok: boolean;
  error?: string;
  code?: string;
  users?: UserRow[];
  user?: UserRow;
};

type AdminUsersPageText = (typeof adminUsersText)[keyof typeof adminUsersText];

type PayrollFocusSection = "detail" | "payroll";
/** 직원 목록 전체에서 급여·복리후생 패널은 한 번에 한 직원만 연다. */
type PayrollSectionControl = {
  openUserId: string | null;
  /** 호출 시점의 최신 미저장 상태(패널이 알린 값을 ref로 즉시 반영). */
  unsaved: () => PayrollUnsavedState;
  /** 열린 급여 패널의 이탈 확인 문구(없으면 null). 호출 시점의 최신 미저장 상태로 만든다. */
  leaveMessage: () => string | null;
  initialFocusUserId: string | null;
  initialSection: PayrollFocusSection | null;
  /** 열린 패널을 닫게 되는 경우(접기·다른 직원 열기) 미저장 입력이 있으면 먼저 확인한다. 취소하면 false. */
  setOpen: (id: UserRow["id"], open: boolean) => boolean;
  setUnsaved: (state: PayrollUnsavedState) => void;
  onMealChanged: () => void;
  /** 목록 둘째 줄의 급여 적용 아이콘(급여관리 overview 1회 조회 결과). */
  applicability: (id: UserRow["id"]) => PayrollIconsForUser;
};

/**
 * 급여관리 overview(이번 베트남 월) 1회 조회에서 아이콘 판정에 필요한 값만 보관한다.
 * 조회 전·실패는 "미적용"과 구분한다.
 */
type PayrollApplicabilityState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      month: string;
      future: boolean;
      monthClosed: boolean;
      mealUserIds: ReadonlySet<number>;
      bonusUserIds: ReadonlySet<number>;
      employees: ReadonlyMap<number, PayrollApplicabilityEmployee>;
    };
type PayrollIconsForUser =
  | { status: "loading" | "error" }
  | { status: "ready"; icons: PayrollApplicabilityIcon[] };

function minimalPayrollApplicability(month: string, data: Record<string, unknown>): PayrollApplicabilityState {
  const employees = new Map<number, PayrollApplicabilityEmployee>();
  for (const raw of data.employees as Array<Record<string, unknown>>) {
    const userId = Number(raw.userId);
    const tax = raw.tax as { status?: unknown; taxMode?: unknown } | null | undefined;
    const standing = raw.attendanceStanding as { perfectAttendanceCurrent?: unknown } | null | undefined;
    const incentives = Array.isArray(raw.automaticIncentives) ? raw.automaticIncentives as Array<{ category?: unknown; sourceSnapshot?: Record<string, unknown> }> : [];
    employees.set(userId, {
      userId,
      insuranceEnrolled: raw.insuranceEnrolled === true,
      tax: tax ? { status: String(tax.status ?? ""), taxMode: tax.taxMode == null ? null : String(tax.taxMode) } : null,
      attendanceStanding: standing ? { perfectAttendanceCurrent: standing.perfectAttendanceCurrent === true } : null,
      automaticIncentives: incentives.map((item) => ({ category: String(item.category ?? ""), sourceSnapshot: { payrollMonth: item.sourceSnapshot?.payrollMonth } })),
    });
  }
  const ids = (value: unknown) => new Set(Array.isArray(value) ? value.map(Number) : []);
  return {
    status: "ready", month, future: data.future === true, monthClosed: data.monthClosed === true,
    mealUserIds: ids(data.mealAllowanceEligibleUserIds), bonusUserIds: ids(data.attendanceBonusEligibleUserIds), employees,
  };
}

const roleOptions = EDITABLE_EMPLOYEE_ROLE_VALUES;
const partOptions = PART_VALUES;
const genders = ["", ...GENDER_VALUES] as const;
const groupOrder = ["owner", "kitchen", "hall", "bar", "cleaning", "etc", "inactive"] as const;

type UserGroupKey = (typeof groupOrder)[number];
type GroupMeta = {
  label: string;
  emoji: string;
  color: string;
  bg: string;
  border: string;
};

function emptyToNull(value: string) {
  return value.trim() || null;
}

/**
 * 목록 근무시간 옆 총 근무시간. 급여 스케줄과 같은 규칙(scheduledMinutesPerDay, 자정 넘김 포함)으로
 * 시작~종료 경과 시간을 구한다(휴게 차감 없음). 시작·종료 중 하나라도 없거나 같으면 표시하지 않는다.
 */
function workDurationLabel(user: Pick<UserRow, "work_start_time" | "work_end_time">, text: AdminUsersPageText) {
  if (!user.work_start_time || !user.work_end_time) return "";
  const minutes = scheduledMinutesPerDay(user.work_start_time.slice(0, 5), user.work_end_time.slice(0, 5), 0);
  if (minutes === null) return "";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [hours ? `${hours}${text.durationHours}` : "", rest ? `${rest}${text.durationMinutes}` : ""].filter(Boolean);
  return parts.join(" ");
}

function formatWorkTime(user: UserRow) {
  const start = user.work_start_time || "-";
  const end = user.work_end_time || "-";
  return `${start}-${end}`;
}

function levelEffectiveFrom(mode: LevelPolicyDraft["effectiveMonth"]) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const date = new Date(Date.UTC(year, month - 1 + (mode === "next" ? 1 : 0), 1));
  return date.toISOString().slice(0, 10);
}

function getAge(birthDate?: string | null) {
  if (!birthDate) return null;

  const birth = new Date(birthDate);
  if (!Number.isFinite(birth.getTime())) return null;

  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const monthDiff = now.getMonth() - birth.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) {
    age -= 1;
  }

  return age;
}

function isRoleOption(value: string | null): value is (typeof roleOptions)[number] {
  return isEditableEmployeeRole(value);
}

function isPartOption(value: string | null): value is (typeof partOptions)[number] {
  return partOptions.includes(value as (typeof partOptions)[number]);
}

function getPartLabel(part: string, text: AdminUsersPageText) {
  if (part === "owner") return text.ownerGroup;
  if (part === "kitchen") return text.kitchenGroup;
  if (part === "hall") return text.hallGroup;
  if (part === "bar") return text.barGroup;
  if (part === "cleaning") return text.cleaningGroup;
  if (part === "etc") return text.etcGroup;
  return part;
}

function isOwnerGroupUser(user: Pick<UserRow, "role">) {
  return user.role === "owner" || user.role === "master";
}

// 파트 판정은 공통 상수(lib/common/parts)의 getPartKey를 그대로 사용한다. 알 수 없는
// part 값은 (예전처럼 "주방"으로 떨어지지 않고) getPartKey의 기본값인 "etc"로 모인다.
function getUserGroup(user: UserRow): UserGroupKey {
  if (isOwnerGroupUser(user)) return "owner";
  return getPartKey(user.part);
}

const PART_GROUP_LABELS: Record<Exclude<UserGroupKey, "owner" | "inactive">, keyof AdminUsersPageText> = {
  kitchen: "kitchenGroup",
  hall: "hallGroup",
  bar: "barGroup",
  cleaning: "cleaningGroup",
  etc: "etcGroup",
};

function getGroupMeta(key: UserGroupKey, text: AdminUsersPageText): GroupMeta {
  if (key === "owner") {
    return {
      label: text.ownerGroup,
      emoji: "👑",
      color: "#7c3aed",
      bg: "#f5f3ff",
      border: "#8b5cf6",
    };
  }

  if (key === "inactive") {
    return {
      label: text.inactiveGroup,
      emoji: "◌",
      color: "#6b7280",
      bg: "#f9fafb",
      border: "#d1d5db",
    };
  }

  const meta = getPartMeta(key);

  return {
    label: text[PART_GROUP_LABELS[key]],
    emoji: meta.emoji,
    color: meta.color,
    bg: meta.bg,
    border: meta.border,
  };
}

// 표시 순서는 role 기준이다: master → owner → manager → leader → staff.
// (예전에는 role=owner가 role=master보다 먼저 나오는 순서 오류가 있었다.)
function getRank(user: UserRow) {
  return getEmployeeRoleRank(user.role);
}

function getActiveUserGroup(user: UserRow): UserGroupKey {
  if (user.is_active === false) return "inactive";
  return getUserGroup(user);
}

function sortUsersForDisplay(users: UserRow[]) {
  return [...users].sort((a, b) => {
    const rankDiff = getRank(a) - getRank(b);
    if (rankDiff !== 0) return rankDiff;

    const activeDiff = Number(b.is_active === true) - Number(a.is_active === true);
    if (activeDiff !== 0) return activeDiff;

    const aName = (a.name || a.full_name || a.username || "").toLowerCase();
    const bName = (b.name || b.full_name || b.username || "").toLowerCase();
    return aName.localeCompare(bName);
  });
}

function UserNav({ active }: { active: "list" | "create" }) {
  const { lang } = useLanguage();
  const text = adminUsersText[lang];
  const pathname = usePathname();

  return (
    <SubNav
      tabs={[
        {
          href: "/admin/users",
          label: text.listTab,
          active: active === "list" || pathname === "/admin/users",
        },
        {
          href: "/admin/users/create",
          label: text.createTab,
          active: active === "create" || pathname === "/admin/users/create",
        },
      ]}
    />
  );
}

function UserCard({
  user,
  onSave,
  onRehire,
  isSaving,
  payroll,
}: {
  user: UserRow;
  onSave: (user: UserRow, draft: UserRow, levelDraft: LevelPolicyDraft) => Promise<boolean>;
  onRehire: (user: UserRow, rehireDate: string, levelEnabled: boolean, salaryRaiseEnabled: boolean | null) => void;
  isSaving: boolean;
  payroll: PayrollSectionControl;
}) {
  const { lang } = useLanguage();
  const text = adminUsersText[lang];
  const router = useRouter();
  // 급여설정 화면에서 "직원관리로 이동"으로 왔으면 이 직원의 상세를 연 상태로 시작한다.
  const initialFocus = payroll.initialFocusUserId === String(user.id) ? payroll.initialSection : null;
  const [isEditing, setIsEditing] = useState(initialFocus !== null);
  const articleRef = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState<UserRow>(user);
  const [rehireOpen, setRehireOpen] = useState(false);
  const [rehireDate, setRehireDate] = useState("");
  const [rehireLevelEnabled, setRehireLevelEnabled] = useState(true);
  const [levelDraft, setLevelDraft] = useState<LevelPolicyDraft>(() => initialLevelPolicyDraft(user));

  const displayName = user.name || user.full_name || user.username;
  const isMasterUser = user.role === "master";
  const age = getAge(user.birth_date);
  const isAdminGroupUser = isOwnerGroupUser(user);
  const positionText = getEmployeeRoleLabel(user.role, lang);
  const nameText = `${displayName}${age ? ` (${age})` : ""}`;
  // 근무시간이 저장되지 않은 직원(근태 미사용 등)은 "---" 자리 표시 없이 비워 둔다.
  const workTime = !isAdminGroupUser && !user.termination_date && (user.work_start_time || user.work_end_time) ? formatWorkTime(user) : "";
  const workDuration = workTime ? workDurationLabel(user, text) : "";
  const applicability = payroll.applicability(user.id);
  const applicabilityIcons = applicability.status === "ready" ? applicability.icons : [];
  // 조회 전·실패 표시는 급여 대상 후보에게만 보여 준다(그 외 계정은 급여관리에도 아이콘이 없다).
  const applicabilityPending = applicability.status !== "ready" && !user.is_system_account && isPayrollEligible(user);
  const hasSecondRow = applicabilityIcons.length > 0 || applicabilityPending || Boolean(workTime) || Boolean(user.termination_date);
  const roleValue = isRoleOption(draft.role) ? draft.role : "staff";
  const partValue = isPartOption(draft.part) ? draft.part : "kitchen";
  const hasLevelEditor = !user.is_system_account;
  const currentBase = policyBaseForMonth(user, "current");
  const [levelModalOpen, setLevelModalOpen] = useState(false);
  const savePending = useRef(false);
  const levelButtonRef = useRef<HTMLButtonElement>(null);
  // 레벨 설정 창을 연 버튼(상세의 레벨 카드 또는 급여·복리후생 시트 안). 닫으면 그 버튼으로 포커스를 돌린다.
  const levelOpenerRef = useRef<HTMLElement | null>(null);
  const openLevelModal = (event: { currentTarget: HTMLElement }) => { levelOpenerRef.current = event.currentTarget; setLevelModalOpen(true); };
  // 열린 modal <dialog> 동안 바깥 요소는 inert라 focus가 무시되므로, dialog가 닫혀 DOM에서 빠진 뒤 포커스를 옮긴다.
  const focusLevelOpener = () => { window.setTimeout(() => { const opener = levelOpenerRef.current; (opener?.isConnected ? opener : levelButtonRef.current)?.focus(); }, 0); };
  const payrollOpen = isEditing && payroll.openUserId === String(user.id);
  // 직원 상세를 연 경우에만 이 직원 1명의 계약을 조회한다(목록 전체 조회 없음). 한 줄 요약과
  // 급여·복리후생 패널이 이 결과를 함께 쓴다. 다른 화면에서 돌아오면 다시 조회한다.
  const contracts = usePayrollContracts(isEditing ? Number(user.id) : null, { refreshOnReturn: true });
  useEffect(() => {
    if (initialFocus) articleRef.current?.scrollIntoView({ block: "start" });
  }, [initialFocus]);
  function leaveMessage() {
    const draftChanged = userDraftChanged(user, draft) || levelDraftChanged(user, levelDraft, draft.hire_date);
    const payrollMessage = payrollOpen ? payroll.leaveMessage() : null;
    if (draftChanged && payrollMessage) return `${text.unsavedLeaveConfirm}\n\n${payrollMessage}`;
    return payrollMessage ?? (draftChanged ? text.unsavedLeaveConfirm : null);
  }
  function openPayrollSettings() {
    const message = leaveMessage();
    if (message && !window.confirm(message)) return;
    // 뒤로가기로 돌아왔을 때 이 직원 상세(와 열려 있던 급여 영역)를 다시 열 수 있게 현재 위치를 기록한다.
    router.replace(`/admin/users?userId=${encodeURIComponent(String(user.id))}&section=${payrollOpen ? "payroll" : "detail"}`, { scroll: false });
    router.push(`/admin/payroll/settings?tab=employee&userId=${encodeURIComponent(String(user.id))}`);
  }
  // 재직 상태(is_active)는 일반 토글로 바꾸지 않는다. 다음 두 경우에만 명시적으로 복구한다.
  // - 퇴사 취소: 퇴사자의 퇴사일을 지우고 "퇴사 취소 확정"을 선택한 경우(서버 cancel_termination 검증)
  // - 비활성 해제: 퇴사일 없이 비활성인 기존 직원을 "비활성 해제"한 경우
  const cancellingTermination = !isMasterUser && Boolean(user.termination_date) && !draft.termination_date;
  const inactiveWithoutTermination = !isMasterUser && user.is_active === false && !user.termination_date;
  const reactivating = inactiveWithoutTermination && !draft.termination_date && draft.is_active === true;

  function cancelEdit() {
    if (isSaving || savePending.current) return;
    if (payrollOpen && !payroll.setOpen(user.id, false)) return;
    setDraft(user);
    setLevelDraft(initialLevelPolicyDraft(user));
    setLevelModalOpen(false);
    setIsEditing(false);
  }

  function update<K extends keyof UserRow>(key: K, value: UserRow[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <article ref={articleRef} style={styles.userRow}>
      <div style={styles.rowMain}>
        <div style={styles.rowText}>
          <span style={styles.rowTitle}>
            <EmployeeNameWithLevel name={nameText} levelInfo={user.levelInfo} lang={lang} nameStyle={styles.rowName} showDisabledBadge />
            <span style={styles.rowPosition}> · {positionText}</span>
          </span>
        </div>
        <div style={styles.badgeRow}>
          {!user.is_system_account ? (
            <button
              type="button"
              style={styles.inlineEditButton}
              disabled={isSaving}
              onClick={() => {
                if (isSaving || savePending.current) return;
                if (isEditing) { cancelEdit(); return; }
                if (!isEditing) {
                  setDraft(user);
                  setLevelDraft(initialLevelPolicyDraft(user));
                }
                setIsEditing((current) => !current);
              }}
            >
              {isEditing ? text.cancel : text.edit}
            </button>
          ) : null}
        </div>
      </div>

      {hasSecondRow ? (
        <div style={styles.rowSub}>
          <span style={styles.payrollIcons} role="group" aria-label={text.payrollIconsGroup}>
            {applicabilityPending && applicability.status === "loading" ? <span style={styles.payrollIconsMuted} role="status" title={text.payrollIconsLoading} aria-label={text.payrollIconsLoading}>…</span> : null}
            {applicabilityPending && applicability.status === "error" ? <span style={styles.payrollIconsMuted} role="status" title={text.payrollIconsUnavailable} aria-label={text.payrollIconsUnavailable}>{text.payrollIconsUnavailableShort}</span> : null}
            <PayrollIconList icons={applicabilityIcons} />
          </span>
          {workTime || user.termination_date ? <span style={styles.rowSubRight}>
            {workTime ? <span style={styles.workTimeText}>{workTime}{workDuration ? ` (${workDuration})` : ""}</span> : null}
            {user.termination_date ? <span style={styles.lockedBadge}>{text.terminatedOn} {user.termination_date}</span> : null}
          </span> : null}
        </div>
      ) : null}

      {isEditing ? (
        <fieldset disabled={isSaving} style={styles.formGrid}>
          {!isMasterUser ? (
            <>
          <section style={sectionStyle("basic")}>
          <SectionTitle emoji="🪪">{text.basicInfo}</SectionTitle>
          <div style={styles.fieldRow2}>
            <Field label={text.name}>
              <input
                value={draft.name || ""}
                onChange={(event) => update("name", event.target.value)}
                style={styles.input}
              />
            </Field>
            <Field label={text.fullName}>
              <input
                value={draft.full_name || ""}
                onChange={(event) => update("full_name", event.target.value)}
                style={styles.input}
              />
            </Field>
          </div>
          <div style={styles.fieldRow2}>
            <Field label={text.role}>
              <select
                value={roleValue}
                onChange={(event) => {
                  const nextRole = event.target.value;
                  update("role", nextRole);
                }}
                style={styles.input}
              >
                {roleOptions.map((role) => (
                  <option key={role} value={role}>
                    {getEmployeeRoleLabel(role, lang)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={text.part}>
              <select
                value={partValue}
                onChange={(event) => update("part", emptyToNull(event.target.value))}
                style={styles.input}
              >
                {partOptions.map((part) => (
                  <option key={part} value={part}>
                    {getPartLabel(part, text)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div style={styles.fieldRow2}>
            <Field label={text.gender}>
              <select
                value={draft.gender || ""}
                onChange={(event) => update("gender", emptyToNull(event.target.value))}
                style={styles.input}
              >
                {genders.map((gender) => (
                  <option key={gender || "none"} value={gender}>
                    {getGenderLabel(gender, lang)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={text.birthDate}>
              <input
                type="date"
                value={draft.birth_date || ""}
                onChange={(event) => update("birth_date", emptyToNull(event.target.value))}
                style={styles.input}
              />
            </Field>
          </div>
          <div style={styles.fieldRow2}>
            <Field label={text.hireDate}>
              <input
                type="date"
                value={draft.hire_date || ""}
                onChange={(event) => update("hire_date", emptyToNull(event.target.value))}
                style={styles.input}
              />
            </Field>
            <Field label={text.terminationDate}>
              <input
                type="date"
                value={draft.termination_date || ""}
                onChange={(event) => update("termination_date", emptyToNull(event.target.value))}
                style={styles.input}
              />
            </Field>
          </div>
          {draft.termination_date ? (
            <span style={styles.fieldNotice}>
              {text.terminationDeactivationNotice}
            </span>
          ) : null}
          <div style={styles.statusRow}>
            <span style={styles.fieldLabel}>{text.employmentStatus}</span>
            <span style={styles.statusActions}>
              <span style={employmentStatusStyle(user)}>{employmentStatusLabel(user, text)}</span>
              {inactiveWithoutTermination ? <button type="button" style={styles.payrollLinkButton} aria-pressed={reactivating} onClick={() => update("is_active", reactivating ? false : true)}>{reactivating ? text.reactivateUndo : text.reactivate}</button> : null}
            </span>
          </div>
          {inactiveWithoutTermination ? <span style={reactivating ? styles.fieldNotice : styles.modalHint}>{reactivating ? text.reactivatePending : text.reactivateHelp}</span> : null}
          {cancellingTermination ? <>
            <label style={styles.confirmCheck}>
              <input type="checkbox" checked={draft.is_active === true} onChange={(event) => update("is_active", event.target.checked)} />
              <span>{text.cancelTerminationConfirm}</span>
            </label>
            <span style={styles.modalHint}>{text.cancelTerminationHelp}</span>
          </> : null}
          {user.is_active === false && user.termination_date ? (
            <div style={styles.rehireBox}>
              <button type="button" style={styles.secondaryButton} onClick={() => setRehireOpen(current => !current)}>{text.rehire}</button>
              {rehireOpen ? <div style={{display:"grid",gap:8,marginTop:8}}>
                <p style={{margin:0,fontSize:12,lineHeight:1.5}}>{text.rehireWarning}</p>
                <Field label={text.rehireDate}><input type="date" value={rehireDate} onChange={event=>setRehireDate(event.target.value)} style={styles.input}/></Field>
                <div style={styles.segmented}>{[true,false].map(enabled=><label key={String(enabled)} style={rehireLevelEnabled===enabled?styles.segmentActive:styles.segment}><input type="radio" name={`rehire-level-${user.id}`} checked={rehireLevelEnabled===enabled} onChange={()=>setRehireLevelEnabled(enabled)}/>{enabled?text.levelEnabled:text.levelDisabled}</label>)}</div>
                <button type="button" disabled={!rehireDate||isSaving} style={styles.primaryButton} onClick={()=>onRehire(user,rehireDate,rehireLevelEnabled,rehireLevelEnabled?true:null)}>{text.rehire}</button>
              </div> : null}
            </div>
          ) : null}
          </section>
            </>
          ) : null}
          <section style={sectionStyle("workPay")}>
            <SectionTitle emoji="⏰">{text.workPayInfo}</SectionTitle>
            {!isMasterUser ? <>
              <Toggle label={text.attendanceTracking} checked={draft.attendance_tracking_enabled !== false} onChange={value => update("attendance_tracking_enabled", value)} />
              {draft.attendance_tracking_enabled !== false ? (
                <div style={styles.fieldRow2}>
                  <Field label={text.workStartTime}>
                    <input
                      type="time"
                      value={draft.work_start_time || ""}
                      onChange={(event) => update("work_start_time", emptyToNull(event.target.value))}
                      style={styles.input}
                    />
                  </Field>
                  <Field label={text.workEndTime}>
                    <input
                      type="time"
                      value={draft.work_end_time || ""}
                      onChange={(event) => update("work_end_time", emptyToNull(event.target.value))}
                      style={styles.input}
                    />
                  </Field>
                </div>
              ) : null}
              <span style={styles.modalHint}>{text.attendancePayrollHelp}</span>
            </> : null}
            <PayrollContractStatus user={user} draft={draft} text={text} contracts={contracts} />
          {hasLevelEditor ? <div style={styles.subsection}>
            <SubsectionTitle emoji="📈">{text.longTermLevel}</SubsectionTitle>
            <LevelDetails levelInfo={user.levelInfo} text={text} />
            {isEmployeeLevelMonthBaseMode(currentBase.mode) ? <span style={styles.fieldNotice}>{text.levelBaseMonth}: {currentBase.baseDate?.slice(0, 7) ?? "-"}</span> : null}
            {/* 목록의 레벨 일정 줄을 없애면서, 그 줄에만 있던 월 기준 전환 안내를 이 영역(레벨 설정 버튼 옆)으로 옮긴다. 조건은 기존과 같다. */}
            {user.levelInfo.eligible && user.levelInfo.displayLabel && !isEmployeeLevelMonthBaseMode(user.levelInfo.baseDateSource) ? <span style={styles.fieldNotice}>{text.levelMonthTransitionRequired}</span> : null}
            <button ref={levelButtonRef} type="button" style={styles.secondaryButton} disabled={isSaving || Boolean(user.termination_date)} onClick={openLevelModal}>{text.levelSettings}</button>
            {user.termination_date ? <span style={styles.fieldNotice}>{text.terminatedLevelReadOnly}</span> : null}
            {levelDraftChanged(user, levelDraft, draft.hire_date) ? <span style={styles.fieldNotice}>{text.levelPending} · {levelEffectiveFrom(levelDraft.effectiveMonth)}</span> : null}
          </div> : null}
          {canManageUserPayroll(user) ? (
            <PayrollBenefitsSection
              user={user}
              text={text}
              lang={lang}
              open={payrollOpen}
              onOpen={() => payroll.setOpen(user.id, true)}
              onClose={() => payroll.setOpen(user.id, false)}
              applicability={applicability}
              contracts={contracts}
              isSaving={isSaving}
              levelAction={hasLevelEditor ? <button type="button" style={styles.payrollLinkButton} disabled={isSaving || Boolean(user.termination_date)} onClick={openLevelModal}>{text.levelSettings}</button> : null}
              onUnsavedChange={payroll.setUnsaved}
              onMealChanged={payroll.onMealChanged}
              onOpenPayrollSettings={openPayrollSettings}
            />
          ) : null}
          {/* 급여 대상 예외: 기존 허용 대상(owner/master 등 사장 그룹)에게만, 기존 저장 조건 그대로. */}
          {isAdminGroupUser && !user.is_system_account ? <div style={styles.subsection}>
            <SubsectionTitle emoji="⚙️">{text.payrollException}</SubsectionTitle>
            <Toggle label={text.payrollEligibleOverride} checked={draft.payroll_eligible_override === true} onChange={value => update("payroll_eligible_override", value ? true : null)} />
            <span style={styles.modalHint}>{text.payrollEligibleOverrideHelp}</span>
          </div> : null}
          </section>
          {!isMasterUser ? <section style={sectionStyle("appAccess")}>
            <SectionTitle emoji="🔐">{text.appAccess}</SectionTitle>
            <Toggle label={text.appLoginAllowed} checked={draft.app_login_enabled !== false} onChange={value => update("app_login_enabled", value)} />
            <span style={styles.modalHint}>{text.appLoginAllowedHelp}</span>
            {/* 로그인은 재직 상태(is_active)와 앱 로그인 허용이 모두 켜져 있어야 가능하다(서버 인증과 같은 조건). */}
            {user.termination_date || user.is_active === false ? <span style={styles.fieldNotice}>{user.termination_date ? text.appLoginBlockedTerminated : text.appLoginBlockedInactive}</span> : null}
          </section> : null}
          <div style={styles.actionRow}>
            <button
              type="button"
              style={styles.secondaryButton}
              onClick={() => {
                cancelEdit();
              }}
              disabled={isSaving}
            >
              {text.cancel}
            </button>
            <button
              type="button"
              style={styles.primaryButton}
              onClick={async () => {
                if (savePending.current || isSaving || levelModalOpen) return;
                savePending.current = true;
                try {
                  if (await onSave(user, draft, levelDraft)) {
                    // 급여·복리후생에 저장하지 않은 입력이 있으면 상세를 닫지 않아 입력을 보존한다.
                    if (payrollOpen && hasPayrollUnsaved(payroll.unsaved())) return;
                    if (payrollOpen) payroll.setOpen(user.id, false);
                    setIsEditing(false);
                  }
                } finally { savePending.current = false; }
              }}
              disabled={isSaving}
            >
              {isSaving ? text.saving : text.save}
            </button>
          </div>
        </fieldset>
      ) : null}
      {isEditing && levelModalOpen ? <LevelSettingsModal user={user} draft={draft} initial={levelDraft} text={text} onCancel={() => { setLevelModalOpen(false); focusLevelOpener(); }} onApply={value => { setLevelDraft(value); setLevelModalOpen(false); focusLevelOpener(); }} /> : null}
    </article>
  );
}

function employmentStatusLabel(user: UserRow, text: AdminUsersPageText) {
  if (user.termination_date) return `${text.employmentTerminated} · ${user.termination_date}`;
  return user.is_active === false ? text.employmentInactive : text.employmentActive;
}

function employmentStatusStyle(user: UserRow): CSSProperties {
  if (user.termination_date) return { ...styles.statusBadge, ...styles.statusTerminated };
  return user.is_active === false ? { ...styles.statusBadge, ...styles.statusInactive } : { ...styles.statusBadge, ...styles.statusActive };
}

function payrollContractLabel(contract: Pick<PayrollContractView, "payType" | "calculationBasis">, text: AdminUsersPageText) {
  if (contract.calculationBasis === "fixed_monthly") return `${text.payTypeFixedMonthly} · ${text.contractBasisNoAttendance}`;
  const payType = contract.payType === "hourly" ? text.payTypeHourly : contract.payType === "daily" ? text.payTypeDaily : text.payTypeMonthly;
  return `${payType} · ${text.contractBasisAttendance}`;
}

// 급여설정 직원 목록(/api/admin/payroll/users)과 같은 조건: 재직 중(is_active)이고 급여 대상.
function canManageUserPayroll(user: UserRow) {
  return user.is_active === true && !user.termination_date && isPayrollEligible(user);
}

// 저장 전 이탈 확인에 쓰는 직원 상세의 편집 가능한 값(서버가 다시 내려준 표시용 값은 제외).
const EDITABLE_USER_KEYS = ["name", "full_name", "role", "part", "gender", "birth_date", "hire_date", "termination_date", "work_start_time", "work_end_time", "is_active", "attendance_tracking_enabled", "app_login_enabled", "payroll_eligible_override"] as const satisfies readonly (keyof UserRow)[];
function userDraftChanged(user: UserRow, draft: UserRow) {
  return EDITABLE_USER_KEYS.some(key => (draft[key] ?? null) !== (user[key] ?? null));
}

/** 현재 급여계약 한 줄 요약. 계약 조회는 카드가 소유한 usePayrollContracts 결과를 받아 쓴다(별도 조회 없음). */
function PayrollContractStatus({ user, draft, text, contracts }: {
  user: UserRow; draft: UserRow; text: AdminUsersPageText; contracts: PayrollContractsController;
}) {
  const canOpenPayrollSettings = canManageUserPayroll(user);
  const ready = !contracts.loading && !contracts.loadFailed;
  const current = ready ? contracts.current : null;
  const mismatch = current !== null
    && requiresFixedMonthlyContract(draft.role, draft.attendance_tracking_enabled !== false) !== (current.calculationBasis === "fixed_monthly");
  return <>
    <div style={styles.statusRow} aria-live="polite">
      <span style={styles.fieldLabel}>{text.payrollContractCurrent}</span>
      {contracts.loading ? <span style={styles.modalMuted}>{text.payrollContractLoading}</span>
        : contracts.loadFailed ? <span style={styles.contractError}>{text.payrollContractLoadFailed} <button type="button" style={styles.inlineEditButton} onClick={contracts.reload}>{text.retry}</button></span>
        : <strong style={styles.contractValue}>{current ? payrollContractLabel(current, text) : text.payrollContractNone}</strong>}
    </div>
    {ready && contracts.scheduled ? <span style={styles.modalMuted}>{text.payrollContractScheduled} {contracts.scheduled.effectiveFrom} · {payrollContractLabel(contracts.scheduled, text)}</span> : null}
    {mismatch ? <span role="status" style={styles.fieldNotice}>{text.payrollContractMismatch}</span> : null}
    {canOpenPayrollSettings ? null : <span style={styles.modalMuted}>{text.payrollSettingsUnavailable}</span>}
  </>;
}

// 직원 상세 카드별 은은한 배경색(입력창·버튼은 흰 바탕/기존 색 유지).
const SECTION_TONES = {
  basic: { background: "#f8fafc", borderColor: "#e2e8f0" },
  workPay: { background: "#f0f9ff", borderColor: "#e0f2fe" },
  appAccess: { background: "#f0fdf4", borderColor: "#dcfce7" },
} satisfies Record<string, CSSProperties>;

function sectionStyle(tone: keyof typeof SECTION_TONES): CSSProperties {
  return { ...styles.detailSection, ...SECTION_TONES[tone] };
}

function SectionTitle({ emoji, children }: { emoji: string; children: ReactNode }) {
  return <strong style={styles.sectionTitle}><span aria-hidden="true">{emoji}</span>{children}</strong>;
}

/** 근무·급여 카드 안의 소제목(장기근무 레벨·급여·복리후생·급여 대상 예외). 구분선으로 나눈다. */
function SubsectionTitle({ emoji, children }: { emoji: string; children: ReactNode }) {
  return <strong style={styles.subsectionTitle}><span aria-hidden="true">{emoji}</span>{children}</strong>;
}

/** 급여관리와 같은 판정의 적용 아이콘(목록 둘째 줄·급여·복리후생 카드 요약에서 함께 쓴다). */
function PayrollIconList({ icons }: { icons: PayrollApplicabilityIcon[] }) {
  return <>{icons.map((icon) => (
    <span key={icon.key} role={icon.key === "tax" ? undefined : "img"} style={icon.key === "tax" ? { ...styles.payrollIcon, ...styles.payrollTaxIcon } : styles.payrollIcon} title={icon.description} aria-label={icon.description}>{icon.symbol}</span>
  ))}</>;
}

/**
 * 급여·복리후생 전용 시트. 공용 패널을 그대로 담는다.
 * - 안쪽 계약 등록·정정 창(PayrollModal)은 시트 안에 그려지고 z-index가 더 높아 위에 뜬다.
 * - Escape는 안쪽 대화상자(계약 창, 레벨 설정 dialog)가 열려 있으면 그쪽만 닫히게 시트는 무시한다.
 * - 키보드 포커스는 최상단 모달 안에서만 순환하고(useModalFocusTrap), 닫으면 시트를 연 버튼으로 돌아간다.
 * - 닫기(×·배경·Escape·닫기 버튼)는 모두 onClose → 미저장 입력 확인(P0)을 거친다.
 */
function PayrollSheet({ title, closeLabel, onClose, children, footer }: {
  title: string; closeLabel: string; onClose: () => void; children: ReactNode; footer: ReactNode;
}) {
  const titleId = useId();
  const sheetRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // 포커스 가두기는 닫기 버튼 포커스보다 먼저 등록해야 연 버튼(관리)을 복원 대상으로 기억한다.
  useModalFocusTrap(sheetRef);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  useEffect(() => {
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!isTopModal(sheetRef.current)) return;
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", onKey); };
  }, []);
  return createPortal(
    <div role="presentation" style={styles.sheetOverlay} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={sheetRef} role="dialog" aria-modal="true" aria-labelledby={titleId} style={styles.sheet}>
        <header style={styles.sheetHeader}>
          <strong id={titleId} style={styles.sheetTitle}>{title}</strong>
          <button ref={closeRef} type="button" aria-label={closeLabel} onClick={onClose} style={styles.modalClose}>×</button>
        </header>
        <div style={styles.sheetBody}>{children}</div>
        <footer style={styles.sheetFooter}>{footer}</footer>
      </section>
    </div>,
    document.body,
  );
}

/**
 * 직원 상세의 "급여·복리후생" 카드. 카드에는 이번 달 적용 아이콘 요약과 "관리" 버튼만 두고,
 * 관리를 누르면 전용 시트에서 공용 패널(급여설정 직원 탭과 같은 EmployeePayrollSettingsPanel)을 연다.
 * 시트는 한 번에 한 직원만 열리며, 계약은 카드의 usePayrollContracts를 공유한다.
 */
function PayrollBenefitsSection({ user, text, lang, open, onOpen, onClose, applicability, contracts, levelAction, isSaving, onUnsavedChange, onMealChanged, onOpenPayrollSettings }: {
  user: UserRow; text: AdminUsersPageText; lang: "ko" | "vi"; open: boolean; onOpen: () => void; onClose: () => boolean;
  applicability: PayrollIconsForUser;
  contracts: PayrollContractsController; levelAction: ReactNode; isSaving: boolean;
  onUnsavedChange: (state: PayrollUnsavedState) => void; onMealChanged: () => void; onOpenPayrollSettings: () => void;
}) {
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  const lastMealHistory = useRef<string | null>(null);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const panelUser = useMemo<EmployeePayrollPanelUser>(() => ({
    id: Number(user.id), name: user.name || user.full_name, username: user.username, role: user.role,
    attendanceTrackingEnabled: user.attendance_tracking_enabled !== false, levelInfo: user.levelInfo,
  }), [user]);
  // 시트를 닫으면 "관리" 버튼으로 포커스를 돌려준다.
  useEffect(() => {
    if (wasOpen.current && !open) openButtonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  // 식대 대상 저장 후 이력이 바뀌면 목록의 식대 아이콘을 맞추기 위해 직원 목록을 다시 조회한다.
  const handleMealHistory = useCallback((state: SettingHistoryState<MealAllowanceVersion>) => {
    if (state.status !== "ready") return;
    const serialized = JSON.stringify(state.history);
    if (lastMealHistory.current !== null && lastMealHistory.current !== serialized) onMealChanged();
    lastMealHistory.current = serialized;
  }, [onMealChanged]);
  const name = user.name || user.full_name || user.username;
  const readyIcons = applicability.status === "ready" ? applicability.icons : null;
  return <div style={styles.subsection}>
    <div style={styles.sectionHead}>
      <SubsectionTitle emoji="💳">{text.payrollBenefits}</SubsectionTitle>
      <button ref={openButtonRef} type="button" aria-haspopup="dialog" aria-expanded={open} disabled={isSaving} onClick={onOpen} style={styles.payrollOpenButton}>{text.payrollManage}</button>
    </div>
    <div style={styles.statusRow}>
      <span style={styles.fieldLabel}>{text.payrollIconsGroup}</span>
      <span style={styles.payrollIcons} role="group" aria-label={text.payrollIconsGroup}>
        {applicability.status === "loading" ? <span style={styles.payrollIconsMuted} role="status">{text.payrollIconsLoading}</span>
          : applicability.status === "error" ? <span style={styles.payrollIconsMuted} role="status" title={text.payrollIconsUnavailable}>{text.payrollIconsUnavailableShort}</span>
          : readyIcons?.length ? <PayrollIconList icons={readyIcons} />
          : <span style={styles.payrollIconsMuted}>{text.payrollIconsNone}</span>}
      </span>
    </div>
    {open && typeof document !== "undefined" ? (
      <PayrollSheet
        title={`${text.payrollBenefits} · ${name}`}
        closeLabel={text.close}
        onClose={() => { onClose(); }}
        footer={<>
          <button type="button" style={styles.secondaryButton} disabled={isSaving} onClick={onOpenPayrollSettings}>{text.managePayrollSettings} →</button>
          <button type="button" style={styles.primaryButton} onClick={() => { onClose(); }}>{text.close}</button>
        </>}
      >
        <EmployeePayrollSettingsPanel
          user={panelUser}
          lang={lang}
          contracts={contracts}
          summaryReference={resolveSettingsSummaryReference(null, today)}
          showIdentity={false}
          anchorPrefix={`user-${user.id}-`}
          levelAction={levelAction}
          onUnsavedChange={onUnsavedChange}
          onMealHistoryChange={handleMealHistory}
        />
      </PayrollSheet>
    ) : null}
  </div>;
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} style={{ ...(checked ? styles.segmentActive : styles.segment), ...styles.toggle }}><span>{label}</span><strong>{checked ? "ON" : "OFF"}</strong></button>;
}

function LevelSettingsModal({ user, draft, initial, text, onCancel, onApply }: {
  user: UserRow; draft: UserRow; initial: LevelPolicyDraft; text: AdminUsersPageText;
  onCancel: () => void; onApply: (value: LevelPolicyDraft) => void;
}) {
  const { lang } = useLanguage();
  const [levelDraft, setLevelDraft] = useState<LevelPolicyDraft>(() => {
    const isLegacy = !isEmployeeLevelMonthBaseMode(initial.baseDateMode);
    const candidate = employeeLevelMonthCandidate({ mode: initial.baseDateMode,
      baseDate: initial.baseDateMode === "override" ? initial.baseDateOverride : null, hireDate: draft.hire_date });
    return { ...initial,
      ...(isLegacy ? { baseDateMode: candidate.mode, baseMonth: candidate.baseMonth, baseDateOverride: "" } : {}),
      effectiveMonth: isLegacy ? "next" : levelDraftChanged(user, initial, draft.hire_date) ? initial.effectiveMonth : "next",
    };
  });
  const dialogRef = useRef<HTMLDialogElement>(null);
  type HistoryResponse = { ok: boolean; history?: ReturnType<typeof buildEmployeeLevelHistory>;
    adminChanges?: { id: number; action: string; createdAt: string }[];
    contracts?: (CompensationContract & { effectiveFrom: string; effectiveTo: string | null })[] };
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    attendanceFetch(`/api/admin/users/${encodeURIComponent(String(user.id))}/level-history`, { cache: "no-store", signal: controller.signal })
      .then(async response => { const data = await response.json(); if (!response.ok || !data.ok) throw new Error("LEVEL_HISTORY_READ_FAILED"); return data as HistoryResponse; })
      .then(data => { if (!controller.signal.aborted) { setHistory(data); setHistoryError(false); } })
      .catch(() => { if (!controller.signal.aborted) setHistoryError(true); });
    return () => controller.abort();
  }, [user.id, historyAttempt]);
  useEffect(() => {
    const dialog = dialogRef.current;
    const viewport = window.visualViewport;
    const resize = () => {
      dialog?.style.setProperty("--level-vw", (viewport?.width ?? window.innerWidth) + "px");
      dialog?.style.setProperty("--level-vh", (viewport?.height ?? window.innerHeight) + "px");
      dialog?.style.setProperty("--level-vx", (viewport?.offsetLeft ?? 0) + "px");
      dialog?.style.setProperty("--level-vy", (viewport?.offsetTop ?? 0) + "px");
    };
    resize(); dialog?.showModal();
    viewport?.addEventListener("resize", resize); viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    return () => { viewport?.removeEventListener("resize", resize); viewport?.removeEventListener("scroll", resize); window.removeEventListener("resize", resize); dialog?.close(); };
  }, []);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const comparedBase = policyBaseForMonth(user, "current");
  const baseModeOptions = ["hire_month", "override_month"] as const;
  const draftHireMonth = hireMonthBase(draft.hire_date);
  const hasChanges = levelDraftChanged(user, { ...levelDraft, effectiveMonth: "current" }, draft.hire_date);
  const effectiveFrom = hasChanges ? levelEffectiveFrom("next") : today;
  const reserved = history?.history?.policies.filter(p => p.effectiveFrom > today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
  const scheduledDate = reserved?.effectiveFrom ?? (user.levelProgramPolicy?.hasScheduledChange ? user.levelProgramPolicy.nextEffectiveFrom : null);
  const transitionConflict = hasChanges && Boolean(scheduledDate);
  const dateLabel = (date: string) => new Intl.DateTimeFormat(lang === "vi" ? "vi-VN" : "ko-KR", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" }).format(new Date(date + "T00:00:00Z"));
  const before = calculateEmployeeLevel({ role: user.role, hireDate: user.hire_date, terminationDate: user.termination_date,
    levelProgramEnabled: currentPolicyEnabled(user), levelBaseMode: comparedBase.mode,
    levelBaseDateOverride: comparedBase.mode === "hire_date" ? null : comparedBase.baseDate,
    levelHireDateBase: comparedBase.baseDate, salaryRaiseEnabled: comparedBase.salaryRaiseEnabled, asOfDate: effectiveFrom });
  const after = calculateEmployeeLevel({ role: draft.role, hireDate: draft.hire_date, terminationDate: draft.termination_date,
    levelProgramEnabled: levelDraft.included, levelBaseMode: levelDraft.baseDateMode,
    levelBaseDateOverride: levelDraft.baseDateMode === "override_month" ? `${levelDraft.baseMonth}-01`
      : (!hasChanges && comparedBase.mode === "hire_month" ? comparedBase.baseDate : draftHireMonth ? `${draftHireMonth}-01` : null),
    salaryRaiseEnabled: hasChanges && levelDraft.included ? true : levelDraft.salaryRaiseEnabled, asOfDate: effectiveFrom });
  const raise = (info: EmployeeLevelInfo) => info.salaryRaiseEnabled === false ? 0 : info.cumulativeRaiseAmount;
  const valid = !transitionConflict && Boolean(draft.hire_date)
    && (levelDraft.baseDateMode !== "override_month" || (/^\d{4}-(0[1-9]|1[0-2])$/.test(levelDraft.baseMonth)
      && Boolean(draft.hire_date) && levelDraft.baseMonth >= draft.hire_date!.slice(0, 7)
      && (!draft.termination_date || levelDraft.baseMonth <= draft.termination_date.slice(0, 7))));
  const contractMatches = history?.contracts?.filter(c => c.effectiveFrom <= effectiveFrom && (!c.effectiveTo || c.effectiveTo > effectiveFrom)) ?? [];
  const contract = contractMatches.length === 1 ? contractMatches[0] : null;
  const compensationBefore = contract ? calculateCombinedSalary(contract, before) : null;
  const compensationAfter = contract ? calculateCombinedSalary(contract, after) : null;
  const raiseBefore = contractMatches.length > 1 ? null : compensationBefore ? compensationBefore.levelRaiseAmount : raise(before);
  const raiseAfter = contractMatches.length > 1 ? null : compensationAfter ? compensationAfter.levelRaiseAmount : raise(after);
  const raiseDelta = raiseBefore === null || raiseAfter === null ? null : raiseAfter - raiseBefore;
  const nextDateChanged = before.nextLevelDate !== after.nextLevelDate;
  const levelChanged = before.level !== after.level || before.eligible !== after.eligible;
  const showComparison = hasChanges && (levelChanged || (raiseDelta !== null && raiseDelta !== 0));
  const displayInfo = hasChanges ? after : before;
  const compactDate = (date: string) => date.replaceAll("-", ".");
  const nextLabel = displayInfo.nextLevelDate ? compactDate(displayInfo.nextLevelDate) + " · Lv." + Math.min(7, (displayInfo.level ?? 0) + 1)
    : displayInfo.eligible ? text.highestLevel : "-";
  const amount = (value: number) => value.toLocaleString("vi-VN") + "₫";

  return createPortal(<dialog ref={dialogRef} aria-label={text.levelSettings} onCancel={event => { event.preventDefault(); onCancel(); }} style={styles.dialog}>
    <form style={styles.modalForm} onSubmit={event => { event.preventDefault(); if (valid) onApply({ ...levelDraft, effectiveMonth: hasChanges ? "next" : "current", applied: hasChanges, salaryRaiseEnabled: hasChanges && levelDraft.included ? true : levelDraft.salaryRaiseEnabled }); }}>
      <header style={styles.modalHeader}>
        <div style={{ minWidth: 0 }}>
          <strong style={styles.modalTitle}>{text.longTermLevel}</strong>
          <div style={styles.modalMuted}>{draft.name || draft.full_name || user.username} · {user.levelInfo.displayLabel ?? text.levelDisabled}</div>
        </div>
        <button type="button" aria-label={text.levelClose} onClick={onCancel} style={styles.modalClose}>×</button>
      </header>
      <div style={styles.modalBody}>
        <fieldset style={styles.modalField} disabled={Boolean(user.termination_date)}>
          <legend style={styles.modalLabel}>{text.levelParticipation}</legend>
          <div style={styles.segmented}>
            {[true, false].map((enabled) => <label key={String(enabled)} style={levelDraft.included === enabled ? styles.segmentActive : styles.segment}>
              <input type="radio" name={"level-" + user.id} checked={levelDraft.included === enabled} onChange={() => setLevelDraft((current) => ({ ...current, included: enabled, salaryRaiseEnabled: enabled ? true : current.salaryRaiseEnabled }))} />
              {enabled ? text.levelEnabled : text.levelDisabled}
            </label>)}
          </div>
        </fieldset>
        {levelDraft.included ? <fieldset style={styles.modalField} disabled={Boolean(user.termination_date)}>
          <legend style={styles.modalLabel}>{text.levelBasisShort}</legend>
          <div style={styles.segmented}>
            {baseModeOptions.map((mode) => <label key={mode} style={levelDraft.baseDateMode === mode ? styles.segmentActive : styles.segment}>
              <input type="radio" name={"level-base-" + user.id} checked={levelDraft.baseDateMode === mode} onChange={() => setLevelDraft(current => ({ ...current, baseDateMode: mode, salaryRaiseEnabled: current.included ? true : current.salaryRaiseEnabled, baseMonth: mode === "override_month" && !current.baseMonth ? draftHireMonth ?? "" : current.baseMonth }))} />
              {mode === "hire_month" ? text.levelAutoShort : text.levelDirectShort}
            </label>)}
          </div>
          {levelDraft.baseDateMode === "hire_month"
            ? <p style={styles.modalHint}>{text.hireDate} {draft.hire_date ?? "-"} → {text.levelBaseMonth} {!hasChanges && comparedBase.mode === "hire_month" ? comparedBase.baseDate?.slice(0, 7) ?? "-" : draftHireMonth ?? "-"}</p>
            : <Field label={text.levelBaseMonth}><input type="month" required min={draft.hire_date?.slice(0, 7)} max={draft.termination_date?.slice(0, 7)} value={levelDraft.baseMonth} onChange={event => setLevelDraft(current => ({ ...current, baseMonth: event.target.value, salaryRaiseEnabled: current.included ? true : current.salaryRaiseEnabled }))} style={styles.input} /></Field>}
        </fieldset> : <section style={styles.levelOffCard} aria-label={text.levelChangeSummary} aria-live="polite">
          <strong style={styles.levelOffCardLabel}>{text.levelOffEmpty}</strong>
          {hasChanges ? <span style={styles.modalMuted}>{text.levelStartsAt}: {dateLabel(effectiveFrom)}</span> : null}
        </section>}
        {scheduledDate ? <p role="status" style={styles.modalMuted}>{text.levelScheduledPolicy}: {dateLabel(scheduledDate)}</p> : null}
        {transitionConflict ? <p role="alert" style={styles.fieldNotice}>{text.levelMonthTransitionConflict}</p> : null}
        {user.termination_date ? <p role="alert" style={styles.fieldNotice}>{text.terminatedLevelReadOnly}</p> : null}
        <details style={styles.modalHelp}>
          <summary style={styles.modalHelpTitle}>{text.levelHelp}</summary>
          <ul style={styles.levelHelpRules}>
            <li>{text.levelHelpBase}</li>
            <li>{text.levelHelpPromotion}</li>
            <li>{text.levelHelpSalary}</li>
            <li>{text.levelHelpEffective}</li>
            <li>{text.levelHelpTwoYears}</li>
          </ul>
        </details>
        {levelDraft.included ? <section style={styles.modalSummary} aria-label={text.levelChangeSummary} aria-live="polite">
          <strong>{hasChanges ? text.levelPreviewTitle : text.levelCurrentPolicy}</strong>
          {hasChanges ? <span style={styles.modalMuted}>{text.levelStartsAt}: {dateLabel(effectiveFrom)}</span> : null}
          <dl style={styles.modalSummaryGrid}>
            <dt>{hasChanges ? text.levelAfter : text.currentLevel}</dt><dd style={styles.modalValue}>{displayInfo.displayLabel ?? text.levelDisabled}</dd>
            <dt>{text.levelNextPromotion}</dt><dd style={styles.modalValue}>{nextLabel}</dd>
            {hasChanges && (raiseDelta === null || raiseDelta !== 0) ? <><dt>{contract?.payType === "hourly" ? text.levelHourlyDelta : contract ? text.levelRaiseDelta : text.levelRaisePreview}</dt><dd style={styles.modalValue}>{raiseDelta === null ? text.levelContractReview : (raiseDelta > 0 ? "+" : "") + amount(raiseDelta)}</dd></> : null}
          </dl>
          {showComparison ? <details>
            <summary style={styles.modalMuted}>{text.levelCompareDetails}</summary>
            {levelChanged ? <p style={styles.modalHint}>{text.currentLevel}: {before.displayLabel ?? text.levelDisabled} → {after.displayLabel ?? text.levelDisabled}</p> : null}
            {nextDateChanged ? <p style={styles.modalHint}>{text.nextLevelShort}: {before.nextLevelDate ?? "-"} → {after.nextLevelDate ?? "-"}</p> : null}
            {raiseDelta !== null && raiseDelta !== 0 && raiseBefore !== null && raiseAfter !== null ? <p style={styles.modalHint}>{contract?.payType === "hourly" ? text.levelHourlyDelta : text.levelRaisePreview}: {amount(raiseBefore)} → {amount(raiseAfter)}</p> : null}
          </details> : null}
        </section> : null}
        <details style={styles.modalHelp}>
          <summary style={styles.modalHelpTitle}>{text.levelHistory}</summary>
          {historyError ? <><p role="alert">{text.levelHistoryError}</p><button type="button" style={styles.secondaryButton} onClick={() => setHistoryAttempt(value => value + 1)}>{text.retry}</button></> : !history?.history ? <p role="status">{text.loading}</p> :
            <LevelHistoryView history={history.history} currentInfo={user.levelInfo} terminationDate={user.termination_date} pending={hasChanges || Boolean(scheduledDate)} text={text} />}
        </details>
      </div>
      {hasChanges ? <p style={{ ...styles.modalHint, margin: 0, padding: "6px 14px", flexShrink: 0 }}>{text.levelApplyHelp}</p> : null}
      <footer style={styles.modalFooter}>
        <button type="button" onClick={onCancel} style={styles.secondaryButton}>{text.cancel}</button>
        <button type="submit" disabled={!valid || Boolean(user.termination_date)} style={styles.primaryButton}>{text.levelApply}</button>
      </footer>
    </form>
  </dialog>, document.body);
}

function LevelHistoryView({ history, currentInfo, terminationDate, pending, text }: {
  history: ReturnType<typeof buildEmployeeLevelHistory>;
  currentInfo: EmployeeLevelInfo; terminationDate: string | null; pending: boolean;
  text: AdminUsersPageText;
}) {
  // Presentation only: a standard month schedule, never a reconstruction of actual history.
  const base = currentInfo.baseDate ? currentInfo.baseDate.slice(0, 7) + "-01" : null;
  const milestones = base ? Array.from({ length: 9 }, (_, index) => ({ month: index * 3, date: addCalendarMonthsClamped(base, index * 3)! })) : [];
  const beforeBase = Boolean(base && history.asOfDate < base);
  const terminated = Boolean(terminationDate && terminationDate < history.asOfDate);
  const active = currentInfo.eligible && !beforeBase && !terminated;
  const periodStart = currentInfo.level !== null && currentInfo.baseDate ? addCalendarMonthsClamped(currentInfo.baseDate, currentInfo.level * 3) : null;
  const periodLimit = currentInfo.nextLevelDate ?? (!currentInfo.negotiationEligible ? currentInfo.negotiationEligibleAt : null);
  const periodEnd = periodLimit ? new Date(new Date(periodLimit + "T00:00:00Z").getTime() - 86400000).toISOString().slice(0, 10) : null;
  const dateLabel = (date: string) => date.replaceAll("-", ".");
  const countLabel = (label: string, count: number) => label.replace("{count}", String(count));
  // Phase comes from the calculated current level (calculateEmployeeLevel), never from row order or labels.
  // Without an active level (before base, OFF, terminated) only the existing date comparison applies.
  const phaseOf = (index: number, date: string): "past" | "current" | "future" => {
    if (active && currentInfo.level !== null) {
      if (index === currentInfo.level || (index === 8 && currentInfo.negotiationEligible)) return "current";
      return index < currentInfo.level ? "past" : "future";
    }
    return date > history.asOfDate ? "future" : "past";
  };
  const timelineRows = milestones.map((event, index) => ({ ...event, index, phase: phaseOf(index, event.date) }));
  const pastRows = timelineRows.filter(row => row.phase === "past");
  const upcomingRows = timelineRows.filter(row => row.phase !== "past");
  const timelineRow = (row: (typeof timelineRows)[number]) => {
    const isCurrent = row.phase === "current";
    return <li key={row.month} aria-current={isCurrent ? "step" : undefined} style={{ ...styles.levelTimelineRow, ...(isCurrent ? styles.levelTimelineCurrentRow : {}) }}>
      <div><time dateTime={row.date}>{dateLabel(row.date)}</time><span style={{ ...styles.modalMuted, display: "block" }}>{text.levelMonthOffset.replace("{count}", String(row.month))}</span></div>
      <div style={{ textAlign: "right" }}><span>{row.index === 8 ? text.levelNegotiation : "Lv." + row.index}</span><span style={{ ...styles.modalMuted, ...(isCurrent ? { color: "#1d4ed8" } : {}), display: "block" }}>{isCurrent ? text.levelCurrentlyActive : row.phase === "future" ? text.levelScheduleFuture : text.levelSchedulePast}</span></div>
    </li>;
  };
  return <section aria-label={text.levelTimeline} style={styles.levelTimelinePanel}>
      <div style={styles.levelTimelineCurrent}>
        {terminated ? <strong>{text.levelAtTermination} {currentInfo.displayLabel ?? (currentInfo.reason === "PROGRAM_DISABLED" ? text.levelDisabled : text.levelUnset)}</strong> : null}
        {terminated ? <span>{text.terminatedLevelReadOnly}</span> : beforeBase ? <span>{text.levelBeforeBaseDate}</span>
          : active && periodStart ? <span>{text.levelPeriod} {dateLabel(periodStart)} ~ {periodEnd ? dateLabel(periodEnd) : text.levelContinues}</span> : null}
        {active && currentInfo.nextLevelDate ? <span>{text.nextLevelShort} Lv.{Math.min(7, (currentInfo.level ?? 0) + 1)} · {dateLabel(currentInfo.nextLevelDate)}</span>
          : active && currentInfo.negotiationEligible ? <span>{text.levelNegotiation}</span>
          : active && currentInfo.negotiationEligibleAt ? <span>{text.levelNegotiation} · {dateLabel(currentInfo.negotiationEligibleAt)}</span> : null}
        <span style={styles.modalMuted}>{text.levelTimelineStandard}{pending ? " · " + text.levelTimelineSaved : ""}</span>
      </div>
      {milestones.length ? <div role="region" aria-label={text.levelTimelineSchedule} tabIndex={0} style={styles.levelTimelineScroll}>
        {pastRows.length ? <details>
          <summary style={styles.modalHelpTitle}>{countLabel(text.levelPastSchedule, pastRows.length)}</summary>
          <ol style={styles.levelHistoryList}>{pastRows.map(timelineRow)}</ol>
        </details> : null}
        {upcomingRows.length ? <ol style={styles.levelHistoryList}>{upcomingRows.map(timelineRow)}</ol> : null}
      </div> : <p>{text.levelBaseRequired}</p>}
    </section>;
}

/** Current policy stays compact; comparisons belong in the settings modal. */
function LevelDetails({ levelInfo, text }: { levelInfo: EmployeeLevelInfo; text: AdminUsersPageText }) {
  if (!levelInfo.eligible) return null;
  return (
    <div style={styles.levelSummary}>
      <span>{text.currentLevel} {levelInfo.displayLabel}</span>
      {isEmployeeLevelMonthBaseMode(levelInfo.baseDateSource) ? <span>{text.nextLevel} {levelInfo.nextLevelDate ?? text.highestLevel}</span> : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={styles.field}>
      <span style={styles.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

export default function AdminUsersPage() {
  const { lang } = useLanguage();
  const text = adminUsersText[lang];
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [canAccess, setCanAccess] = useState(false);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [savingId, setSavingId] = useState<number | string | null>(null);
  const [message, setMessage] = useState("");
  const [hasLoadedUsers, setHasLoadedUsers] = useState(false);
  const [queryError, setQueryError] = useState<"login" | "forbidden" | "fetch" | null>(null);
  const [queryAttempt, setQueryAttempt] = useState(0);
  const [payrollApplicability, setPayrollApplicability] = useState<PayrollApplicabilityState>({ status: "loading" });
  // ?userId=&section= (급여설정의 "직원관리로 이동"·뒤로가기 복귀): 해당 직원 상세를 열어 둔다.
  const [initialFocus] = useState(() => {
    if (typeof window === "undefined") return { userId: null as string | null, section: null as PayrollFocusSection | null };
    const search = new URLSearchParams(window.location.search);
    const userId = search.get("userId");
    return { userId, section: userId ? (search.get("section") === "payroll" ? "payroll" : "detail") as PayrollFocusSection : null };
  });
  const [payrollOpenUserId, setPayrollOpenUserId] = useState<string | null>(initialFocus.section === "payroll" ? initialFocus.userId : null);
  const [payrollUnsaved, setPayrollUnsavedState] = useState<PayrollUnsavedState>(NO_PAYROLL_UNSAVED);
  // 이탈 확인은 패널이 알린 최신 값(ref)으로 한다. 입력 직후의 Escape·닫기·이동도 다음 렌더를 기다리지 않고 판단한다.
  const payrollUnsavedRef = useRef<PayrollUnsavedState>(NO_PAYROLL_UNSAVED);
  const setPayrollUnsaved = useCallback((state: PayrollUnsavedState) => {
    payrollUnsavedRef.current = state;
    setPayrollUnsavedState(state);
  }, []);
  const payrollLeave = payrollLeaveMessage(payrollUnsaved, lang === "vi");
  const latestPayrollLeave = () => payrollLeaveMessage(payrollUnsavedRef.current, lang === "vi");
  // 새로고침·창 닫기와 메뉴 링크 이동에서도 급여 패널의 미저장 입력을 확인한다.
  useLeaveGuard(payrollLeave, latestPayrollLeave);
  const refreshUsers = useCallback(() => setQueryAttempt(current => current + 1), []);
  const payrollControl: PayrollSectionControl = {
    openUserId: payrollOpenUserId,
    unsaved: () => payrollUnsavedRef.current,
    leaveMessage: latestPayrollLeave,
    initialFocusUserId: initialFocus.userId,
    initialSection: initialFocus.section,
    setOpen: (id, open) => {
      const key = String(id);
      // 지금 열린 패널이 닫히는 경우(같은 직원 접기, 다른 직원 열기)에만 확인한다.
      const closesOpenPanel = payrollOpenUserId !== null && (open ? payrollOpenUserId !== key : payrollOpenUserId === key);
      const message = closesOpenPanel ? latestPayrollLeave() : null;
      if (message && !window.confirm(message)) return false;
      setPayrollOpenUserId(open ? key : current => (current === key ? null : current));
      return true;
    },
    setUnsaved: setPayrollUnsaved,
    onMealChanged: refreshUsers,
    applicability: (id) => payrollApplicability.status !== "ready" || !payrollIconsByUser
      ? { status: payrollApplicability.status === "error" ? "error" : "loading" }
      // 급여관리 overview에 없는 직원(급여 대상이 아닌 계정)은 급여관리 카드도 없으므로 아이콘이 없다.
      : { status: "ready", icons: payrollIconsByUser.get(Number(id)) ?? [] },
  };
  const loadFailedTextRef = useRef(text.loadFailed);
  loadFailedTextRef.current = text.loadFailed;

  useEffect(() => {
    const user = getUser();
    if (user?.role === "leader") {
      router.replace("/admin");
      return;
    }
    setCanAccess(isAdmin(user));
    setChecked(true);
  }, [router]);

  useEffect(() => {
    if (!checked || !canAccess) return;

    let cancelled = false;
    const applicabilityController = new AbortController();

    // 급여관리와 같은 판정을 위해 기존 overview API를 이번 베트남 월로 1회만 읽는다(직원별 요청 없음).
    // 목록 조회가 끝난 뒤 시작해 목록 표시·병렬 prefetch를 늦추지 않는다.
    async function fetchPayrollApplicability() {
      const month = vietnamCurrentMonthStart().slice(0, 7);
      setPayrollApplicability({ status: "loading" });
      try {
        const res = await attendanceFetch(`/api/admin/payroll/overview?month=${month}`, { cache: "no-store", signal: applicabilityController.signal });
        const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (cancelled) return;
        if (!res.ok || !data || data.ok !== true || data.month !== month || !Array.isArray(data.employees)) throw new Error("PAYROLL_OVERVIEW_READ_FAILED");
        setPayrollApplicability(minimalPayrollApplicability(month, data));
      } catch {
        if (!cancelled) setPayrollApplicability({ status: "error" });
      }
    }

    async function fetchUsers() {
      setIsLoading(true);
      setMessage("");
      setQueryError(null);

      try {
        const res = await attendanceFetch("/api/admin/users", { cache: "no-store" });
        const result = (await res.json().catch(() => null)) as UsersResponse | null;
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          setQueryError(res.status === 401 ? "login" : "forbidden");
          return;
        }

        if (!res.ok || !result?.ok || !Array.isArray(result.users)) {
          throw new Error(result?.error || loadFailedTextRef.current);
        }

        if (!cancelled) {
          setUsers(result.users || []);
          setHasLoadedUsers(true);
          void fetchPayrollApplicability();
        }
      } catch {
        if (!cancelled) {
          setQueryError("fetch");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    fetchUsers();

    return () => {
      cancelled = true;
      applicabilityController.abort();
    };
  }, [canAccess, checked, queryAttempt]);
  const payrollIconsByUser = useMemo(() => {
    if (payrollApplicability.status !== "ready") return null;
    const { month, future, monthClosed, mealUserIds, bonusUserIds, employees } = payrollApplicability;
    return new Map([...employees].map(([userId, employee]) => [userId, payrollApplicabilityIcons({
      employee, month, future, monthClosed, lang,
      attendanceBonusEligible: bonusUserIds.has(userId),
      mealAllowanceEligible: mealUserIds.has(userId),
    })]));
  }, [lang, payrollApplicability]);

  const activeEmployeeCount = useMemo(
    () =>
      users.filter(
        (user) =>
          !isOwnerGroupUser(user) &&
          user.is_system_account !== true &&
          user.is_active === true &&
          user.termination_date === null
      ).length,
    [users]
  );
  // 파트별 목록 접힘 상태. 사용자가 바꾼 값만 기억해 재조회·저장 후에도 유지한다(목록 데이터와 분리).
  const [groupOpenOverrides, setGroupOpenOverrides] = useState<Partial<Record<UserGroupKey, boolean>>>({});
  // 급여설정에서 ?userId=로 돌아온 직원의 그룹은 (사장·비활성이어도) 처음에 펼친다.
  const focusGroupKey = useMemo(() => {
    if (!initialFocus.userId) return null;
    const focused = users.find((user) => String(user.id) === initialFocus.userId);
    return focused ? getActiveUserGroup(focused) : null;
  }, [initialFocus.userId, users]);
  const isGroupOpen = (key: UserGroupKey) => groupOpenOverrides[key] ?? (key === focusGroupKey || (key !== "owner" && key !== "inactive"));
  const groupedUsers = useMemo(
    () =>
      groupOrder
        .map((groupKey) => ({
          key: groupKey,
          users: sortUsersForDisplay(
            users.filter((user) => getActiveUserGroup(user) === groupKey)
          ),
        }))
        .filter((group) => group.users.length > 0),
    [users]
  );

  async function saveUser(original: UserRow, draft: UserRow, requestedLevelDraft: LevelPolicyDraft) {
    // Basic saves always preserve the current policy, including any future reservation.
    const levelDraft = levelDraftChanged(original, requestedLevelDraft, draft.hire_date)
      ? requestedLevelDraft
      : draftFromBase(currentPolicyEnabled(original), policyBaseForMonth(original, "current"), "current");
    setSavingId(original.id);
    setMessage("");

    try {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      if (levelDraftChanged(original, requestedLevelDraft, draft.hire_date) && !requestedLevelDraft.applied) throw new Error(text.levelHireDateReview);
      if (levelDraft.baseDateMode === "hire_month" || levelDraft.baseDateMode === "override_month") {
        // Month rules (the server re-validates): hire date needed; a direct base month is
        // "YYYY-MM", not before the actual hire month and not after the termination month.
        if (!draft.hire_date) throw new Error(lang === "vi" ? "Cần có ngày vào làm để tính cấp." : "레벨 기준월 계산에는 입사일이 필요합니다.");
        if (levelDraft.baseDateMode === "override_month") {
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(levelDraft.baseMonth)) throw new Error(lang === "vi" ? "Vui lòng chọn tháng mốc tính cấp." : "레벨 기준월을 선택해주세요.");
          if (levelDraft.baseMonth < draft.hire_date.slice(0, 7)) throw new Error(lang === "vi" ? "Tháng mốc tính cấp không thể sớm hơn tháng vào làm." : "레벨 기준월은 실제 입사월보다 빠를 수 없습니다.");
          if (draft.termination_date && levelDraft.baseMonth > draft.termination_date.slice(0, 7)) throw new Error(lang === "vi" ? "Tháng mốc tính cấp không thể sau tháng nghỉ việc." : "레벨 기준월은 퇴사월보다 늦을 수 없습니다.");
        }
      } else {
        // Legacy date basis kept as is (same checks as before).
        const levelBaseDate = levelDraft.baseDateMode === "hire_date" ? draft.hire_date : levelDraft.baseDateOverride;
        if (!levelBaseDate) throw new Error(lang === "vi" ? "Vui lòng nhập ngày bắt đầu tính cấp." : "레벨 기준일을 입력해주세요.");
        if (draft.hire_date && levelBaseDate < draft.hire_date) throw new Error(lang === "vi" ? "Ngày bắt đầu tính không thể trước ngày vào làm." : "레벨 기준일은 입사일보다 빠를 수 없습니다.");
        if (draft.termination_date && levelBaseDate > draft.termination_date) throw new Error(lang === "vi" ? "Ngày bắt đầu tính không thể sau ngày nghỉ việc." : "레벨 기준일은 퇴사일보다 늦을 수 없습니다.");
        if (levelBaseDate > today) throw new Error(lang === "vi" ? "Ngày bắt đầu tính không thể là ngày trong tương lai." : "레벨 기준일은 미래 날짜일 수 없습니다.");
      }
      if (
        original.role !== "master" &&
        draft.attendance_tracking_enabled !== false &&
        (!draft.work_start_time || !draft.work_end_time)
      ) {
        throw new Error(text.workTimeRequiredForTracking);
      }
      const updates: Record<string, unknown> = original.role === "master"
        ? { payroll_eligible_override: draft.payroll_eligible_override }
        : {
            name: draft.name,
            full_name: draft.full_name,
            role: draft.role,
            part: draft.part,
            gender: draft.gender,
            birth_date: draft.birth_date,
            hire_date: draft.hire_date,
            termination_date: draft.termination_date,
            work_start_time: draft.work_start_time,
            work_end_time: draft.work_end_time,
            attendance_tracking_enabled: draft.attendance_tracking_enabled !== false,
            app_login_enabled: draft.app_login_enabled !== false,
          };
      if (original.role === "owner") {
        updates.payroll_eligible_override = draft.payroll_eligible_override;
      }
      // 재직 상태는 일반 저장에서 보내지 않아 서버의 현재 값을 그대로 둔다(앱 로그인 변경도 재직 상태 불변).
      // 명시적으로 퇴사 취소를 확정했거나, 퇴사일 없는 비활성 직원을 "비활성 해제"한 경우에만 true를 보낸다.
      const confirmsCancelTermination = original.role !== "master" && Boolean(original.termination_date) && draft.termination_date === null && draft.is_active === true;
      const reactivatesInactive = original.role !== "master" && original.is_active === false && !original.termination_date && !draft.termination_date && draft.is_active === true;
      if (confirmsCancelTermination || reactivatesInactive) updates.is_active = true;
      if (levelDraftChanged(original, levelDraft, draft.hire_date) && levelDraft.effectiveMonth === "current"
        && !window.confirm(text.levelCurrentMonthWarning)) return false;
      const res = await attendanceFetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: confirmsCancelTermination ? "cancel_termination" : undefined,
          lang,
          id: original.id,
          updates,
          levelProgramEnabled: levelDraft.included,
          levelBaseDateMode: levelDraft.baseDateMode,
          levelBaseDateOverride: levelDraft.baseDateMode === "override" ? levelDraft.baseDateOverride : null,
          levelBaseMonth: levelDraft.baseDateMode === "override_month" ? levelDraft.baseMonth : null,
          levelSalaryRaiseEnabled: levelDraft.salaryRaiseEnabled,
          levelPolicyEdit: levelDraft.applied === true,
          levelExpectedVersionId: original.levelProgramPolicy?.currentVersionId ?? null,
          levelExpectedRevision: original.levelProgramPolicy?.currentRevision ?? null,
          levelEffectiveFrom: levelDraftChanged(original, levelDraft, draft.hire_date) ? levelEffectiveFrom(levelDraft.effectiveMonth) : null,
        }),
      });
      const result = (await res.json()) as UsersResponse;

      if (!res.ok || !result.ok || !result.user) {
        if (result.code === "ATTENDANCE_OPEN_RECORD_EXISTS") {
          // 열린 출근 기록 충돌은 실제 저장 시도 후 서버가 반환했을 때만 여기서 alert로
          // 알린다. draft(체크 해제 상태)는 그대로 두고 편집 화면도 닫지 않아, 관리자가
          // 다시 판단할 수 있게 한다. 페이지 상단 메시지에는 중복 표시하지 않는다.
          window.alert(result.error || text.saveFailed);
          return false;
        }
        throw new Error(result.error || text.saveFailed);
      }

      setUsers((current) =>
        current.map((user) => (user.id === original.id ? result.user! : user))
      );
      window.alert(text.saveSuccess);
      return true;
    } catch (error) {
      window.alert(error instanceof Error ? error.message : text.saveFailed);
      return false;
    } finally {
      setSavingId(null);
    }
  }

  async function rehireUser(user: UserRow, rehireDate: string, levelProgramEnabled: boolean, levelSalaryRaiseEnabled: boolean | null) {
    if (!window.confirm(text.rehireWarning)) return;
    setSavingId(user.id); setMessage("");
    try {
      const res = await attendanceFetch("/api/admin/users", { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action:"rehire",id:user.id,lang,rehireDate,levelProgramEnabled,levelSalaryRaiseEnabled,confirmPreviousPayrollCompleted:true}) });
      const result=(await res.json()) as UsersResponse;
      if(!res.ok||!result.ok||!result.user)throw new Error(result.error||text.saveFailed);
      setUsers(current=>current.map(item=>item.id===user.id?result.user!:item)); window.alert(text.saveSuccess);
    } catch(error) { window.alert(error instanceof Error?error.message:text.saveFailed); }
    finally { setSavingId(null); }
  }

  if (checked && !canAccess) {
    return (
      <Container noPaddingTop>
        <UserNav active="list" />
        <section style={styles.notice}>{text.noPermission}</section>
      </Container>
    );
  }

  return (
    <Container noPaddingTop>
      <UserNav active="list" />

      <section style={styles.summaryCard}>
        <span>{text.summaryLabel}</span>
        <strong>
          {hasLoadedUsers ? `${activeEmployeeCount}${text.peopleUnit}` : "—"}
        </strong>
      </section>

      {message ? <p style={styles.message}>{message}</p> : null}
      {queryError ? (
        <div role="alert" style={styles.notice}>
          <p>{queryError === "login" ? text.queryLoginRequired : queryError === "forbidden" ? text.queryForbidden : text.loadFailed}</p>
          {hasLoadedUsers ? <p>{text.queryStale}</p> : null}
          <button type="button" disabled={isLoading} onClick={() => setQueryAttempt(current => current + 1)} style={ui.subButton}>{text.retry}</button>
        </div>
      ) : null}
      {isLoading ? <p style={styles.notice}>{text.loading}</p> : null}
      {!isLoading && hasLoadedUsers && !queryError && users.length === 0 ? (
        <p style={styles.notice}>{text.noUsers}</p>
      ) : null}

      <section style={styles.list}>
        {groupedUsers.map((group) => (
          <UserGroup
            key={group.key}
            groupKey={group.key}
            users={group.users}
            text={text}
            onSave={saveUser}
            onRehire={rehireUser}
            savingId={savingId}
            payroll={payrollControl}
            open={isGroupOpen(group.key)}
            onToggle={() => setGroupOpenOverrides((current) => ({ ...current, [group.key]: !isGroupOpen(group.key) }))}
          />
        ))}
      </section>
    </Container>
  );
}

function UserGroup({
  groupKey,
  users,
  text,
  onSave,
  onRehire,
  savingId,
  payroll,
  open,
  onToggle,
}: {
  groupKey: UserGroupKey;
  users: UserRow[];
  text: AdminUsersPageText;
  onSave: (user: UserRow, draft: UserRow, levelDraft: LevelPolicyDraft) => Promise<boolean>;
  onRehire: (user: UserRow, rehireDate: string, levelEnabled: boolean, salaryRaiseEnabled: boolean | null) => void;
  savingId: number | string | null;
  payroll: PayrollSectionControl;
  open: boolean;
  onToggle: () => void;
}) {
  const meta = getGroupMeta(groupKey, text);
  const listId = useId();

  return (
    <div style={styles.group}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={onToggle}
        style={{
          ...styles.groupTitle,
          ...styles.groupToggle,
          color: meta.color,
          background: meta.bg,
          borderLeft: `4px solid ${meta.border}`,
        }}
      >
        <span style={styles.groupTitleText}>
          <span>{meta.emoji}</span>
          <span>{meta.label}</span>
        </span>
        <span style={styles.groupCount}>{users.length}</span>
        <span aria-hidden="true" style={{ ...styles.groupChevron, transform: open ? "rotate(180deg)" : "none" }}>▾</span>
      </button>
      {/* 접어도 카드는 남겨 두고 숨기기만 한다. 편집 중인 직원의 입력·상세 상태가 사라지지 않는다. */}
      <div id={listId} hidden={!open} style={open ? styles.groupList : { ...styles.groupList, display: "none" }}>
        {users.map((user) => (
          <UserCard
            key={user.id}
            user={user}
            onSave={onSave}
            onRehire={onRehire}
            isSaving={savingId === user.id}
            payroll={payroll}
          />
        ))}
      </div>
    </div>
  );
}

const styles = {
  header: {
    marginBottom: 12,
  },
  title: {
    margin: "0 0 5px",
    fontSize: 22,
    fontWeight: 950,
    color: "#111827",
  },
  description: {
    ...ui.metaText,
    margin: 0,
    fontWeight: 700,
  },
  summaryCard: {
    ...ui.card,
    borderRadius: 12,
    padding: "10px 12px",
    marginBottom: 10,
    display: "flex",
    justifyContent: "space-between",
    fontSize: 13,
    fontWeight: 900,
  },
  // minmax(0, 1fr): a long employee name must ellipsize instead of widening every card (320px).
  list: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: 12,
  },
  group: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: 6,
  },
  groupTitle: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    borderRadius: 10,
    padding: "7px 9px",
    fontSize: 13,
    fontWeight: 900,
  },
  groupTitleText: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  },
  groupCount: {
    marginLeft: "auto",
    fontSize: 11,
    fontWeight: 900,
    opacity: 0.75,
  },
  groupToggle: {
    width: "100%",
    border: "none",
    textAlign: "left",
    // font 축약형은 groupTitle의 fontSize·fontWeight를 덮어쓰므로 글꼴 계열만 상속한다.
    fontFamily: "inherit",
    cursor: "pointer",
  },
  groupChevron: {
    flexShrink: 0,
    fontSize: 12,
    lineHeight: 1,
    transition: "transform 0.15s ease",
  },
  groupList: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: 6,
  },
  userRow: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: "8px 9px",
  },
  rowMain: {
    width: "100%",
    border: "none",
    background: "transparent",
    padding: 0,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    textAlign: "left",
  },
  rowText: {
    minWidth: 0,
    overflow: "hidden",
  },
  rowTitle: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontSize: 13,
    fontWeight: 700,
    color: "#111827",
  },
  rowPosition: {
    fontSize: 12,
    fontWeight: 700,
    color: "#6b7280",
  },
  identity: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
  },
  name: {
    fontSize: 14,
    fontWeight: 950,
    color: "#111827",
    lineHeight: 1.25,
  },
  username: {
    ...ui.metaText,
    fontWeight: 800,
  },
  badgeRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 4,
    flexShrink: 0,
    flexWrap: "wrap",
  },
  rowSub: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 4, minWidth: 0 },
  payrollIcons: { display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: 4, minWidth: 0 },
  payrollIcon: { display: "inline-flex", alignItems: "center", color: "#475569", fontSize: 13, lineHeight: 1.3 },
  payrollTaxIcon: { fontSize: 11, fontWeight: 800 },
  payrollIconsMuted: { color: "#9ca3af", fontSize: 11, fontWeight: 700, lineHeight: 1.3 },
  rowSubRight: { display: "inline-flex", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: 4, marginLeft: "auto", flexShrink: 0 },
  workTimeText: {
    fontSize: 11,
    fontWeight: 800,
    color: "#6b7280",
    whiteSpace: "nowrap",
  },
  lockedBadge: {
    border: "1px solid #ef4444",
    borderRadius: 999,
    padding: "3px 7px",
    fontSize: 11,
    fontWeight: 800,
    background: "#fef2f2",
    color: "#991b1b",
    whiteSpace: "nowrap",
  },
  inlineEditButton: {
    width: "auto",
    border: "1px solid #d1d5db",
    background: "#ffffff",
    color: "#374151",
    borderRadius: 999,
    padding: "3px 7px",
    fontSize: 11,
    fontWeight: 800,
    cursor: "pointer",
  },
  dialog: { position: "fixed", margin: 0, right: "auto", bottom: "auto",
    left: "calc(var(--level-vx, 0px) + var(--level-vw, 100vw) / 2 + (env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)) / 2)",
    top: "calc(var(--level-vy, 0px) + var(--level-vh, 100dvh) / 2 + (env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)) / 2)",
    transform: "translate(-50%, -50%)", width: "min(520px, calc(var(--level-vw, 100vw) - max(12px, env(safe-area-inset-left)) - max(12px, env(safe-area-inset-right))))",
    maxWidth: "none", maxHeight: "calc(var(--level-vh, 100dvh) - max(12px, env(safe-area-inset-top)) - max(12px, env(safe-area-inset-bottom)))",
    overflow: "hidden", padding: 0, border: "1px solid #d1d5db", borderRadius: 12, boxSizing: "border-box", fontSize: 12, color: "#1f2937" },
  modalForm: { display: "flex", flexDirection: "column", maxHeight: "min(760px, calc(var(--level-vh, 100dvh) - max(12px, env(safe-area-inset-top)) - max(12px, env(safe-area-inset-bottom)) - 2px))", minHeight: 0 },
  modalHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 14px", borderBottom: "1px solid #e5e7eb", flexShrink: 0 },
  modalTitle: { display: "block", fontSize: 15, marginBottom: 3 },
  modalClose: { display: "grid", placeItems: "center", flexShrink: 0, width: 36, height: 36, border: 0, borderRadius: 8, background: "#f3f4f6", color: "#374151", fontSize: 24, cursor: "pointer" },
  modalBody: { display: "grid", gap: 14, overflowY: "auto", overscrollBehavior: "contain", minHeight: 0, padding: 14 },
  levelHelpRules: { margin: "8px 0", paddingLeft: 18, display: "grid", gap: 6, lineHeight: 1.6 },
  levelTimelinePanel: { display: "flex", flexDirection: "column", maxHeight: "min(420px, calc(var(--level-vh, 100dvh) * 0.55))", minHeight: 0 },
  levelTimelineCurrent: { display: "grid", gap: 5, paddingBottom: 10, flexShrink: 0 },
  levelTimelineScroll: { overflowY: "auto", minHeight: 0, overscrollBehavior: "contain" },
  levelTimelineRow: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12, padding: "7px 0", alignItems: "baseline", fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" },
  levelHistoryList: { listStyle: "none", margin: "6px 0", padding: 0, display: "grid", gap: 6 },
  levelHistoryNext: { display: "flex", justifyContent: "space-between", gap: 12, marginTop: 6, fontSize: 14, fontWeight: 700, fontVariantNumeric: "tabular-nums" },
  modalField: { margin: 0, padding: 0, border: 0, minWidth: 0 },
  modalLabel: { padding: 0, marginBottom: 6, fontSize: 12, fontWeight: 800, color: "#374151" },
  modalHint: { margin: "7px 0 0", fontSize: 11, color: "#6b7280", lineHeight: 1.5, overflowWrap: "anywhere" },
  modalMuted: { color: "#6b7280", fontSize: 11, fontWeight: 500, overflowWrap: "anywhere" },
  modalHelp: { color: "#111827", fontSize: 11, lineHeight: 1.5 },
  modalHelpTitle: { color: "#111827", fontWeight: 700, cursor: "pointer" },
  levelOffCard: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, minHeight: 96, padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, background: "#f9fafb", textAlign: "center" },
  levelOffCardLabel: { fontSize: 14, fontWeight: 800, color: "#374151" },
  levelTimelineCurrentRow: { fontWeight: 800, color: "#1d4ed8" },
  modalSummary: { display: "grid", gap: 8, padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, background: "#f9fafb" },
  modalSummaryGrid: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "6px 8px", margin: 0, fontSize: 11, alignItems: "start" },
  modalValue: { margin: 0, fontWeight: 800, textAlign: "right" },
  modalFooter: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "10px 14px", borderTop: "1px solid #e5e7eb", flexShrink: 0, background: "#fff" },
  detailSection: { display: "grid", gap: 8, padding: 10, border: "1px solid #e5e7eb", borderRadius: 9, minWidth: 0 },
  toggle: { width: "100%", justifyContent: "space-between", textAlign: "left" },
  statusRow: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "4px 8px", minWidth: 0 },
  statusBadge: { borderRadius: 999, padding: "2px 8px", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap" },
  statusActive: { background: "#ecfdf5", color: "#047857", border: "1px solid #a7f3d0" },
  statusInactive: { background: "#f3f4f6", color: "#4b5563", border: "1px solid #d1d5db" },
  statusTerminated: { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca" },
  contractValue: { marginLeft: "auto", fontSize: 12, fontWeight: 800, color: "#111827", textAlign: "right", overflowWrap: "anywhere" },
  payrollLinkButton: { border: "1px solid #c7d2fe", background: "#eef2ff", color: "#3730a3", borderRadius: 999, padding: "4px 9px", fontSize: 11, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" },
  contractError: { display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 11, fontWeight: 800, color: "#b91c1c" },
  sectionTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 800, color: "#111827" },
  sectionHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minWidth: 0 },
  payrollOpenButton: { flexShrink: 0, minHeight: 32, padding: "5px 12px", border: "1px solid #d97706", borderRadius: 999, background: "#fff", color: "#92400e", fontSize: 12, fontWeight: 800, cursor: "pointer" },
  sheetOverlay: { position: "fixed", inset: 0, zIndex: 1400, display: "flex", alignItems: "center", justifyContent: "center", padding: "max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom))", background: "rgba(15,23,42,.55)", overscrollBehavior: "contain" },
  sheet: { width: "min(720px, 100%)", maxHeight: "100%", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", borderRadius: 14, background: "#fff", boxShadow: "0 20px 60px rgba(0,0,0,.28)" },
  sheetHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 14px", borderBottom: "1px solid #e5e7eb", flexShrink: 0 },
  sheetTitle: { minWidth: 0, fontSize: 15, fontWeight: 900, overflowWrap: "anywhere" },
  sheetBody: { flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: 12, background: "#f9fafb" },
  sheetFooter: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, padding: "10px 14px calc(10px + env(safe-area-inset-bottom))", borderTop: "1px solid #e5e7eb", flexShrink: 0, background: "#fff" },
  subsection: { display: "grid", gap: 8, paddingTop: 10, marginTop: 2, borderTop: "1px solid #bae6fd", minWidth: 0 },
  subsectionTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 800, color: "#0f172a" },
  statusActions: { display: "inline-flex", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", gap: 6, minWidth: 0 },
  confirmCheck: { display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", border: "1px solid #fcd34d", borderRadius: 9, background: "#fffbeb", fontSize: 12, fontWeight: 700, color: "#92400e", lineHeight: 1.5, cursor: "pointer", overflowWrap: "anywhere" },
  rehireBox: { display: "grid", gap: 0, padding: 10, border: "1px solid #e5e7eb", borderRadius: 9, background: "#fff", minWidth: 0 },
  formGrid: {
    padding: 0,
    margin: 0,
    border: 0,
    minWidth: 0,
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 5,
    marginTop: 8,
    paddingTop: 7,
    borderTop: "1px dashed #e5e7eb",
  },
  fieldRow2: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 155px), 1fr))",
    gap: 7,
    minWidth: 0,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    gap: 4,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: 900,
    color: "#374151",
  },
  fieldNotice: {
    fontSize: 11,
    lineHeight: 1.4,
    fontWeight: 800,
    color: "#b45309",
  },
  payrollOverrideField: {
    display: "grid",
    gap: 4,
    padding: "8px 9px",
    borderRadius: 8,
    background: "#fffbeb",
  },
  levelIncludeField: {
    display: "grid",
    gap: 4,
    padding: "8px 9px",
    borderRadius: 8,
    border: "1px solid #ddd6fe",
    background: "#faf5ff",
  },
  levelSummary: {
    display: "flex",
    flexWrap: "wrap",
    gap: "3px 10px",
    marginTop: 6,
    fontSize: 11,
    lineHeight: 1.4,
    fontWeight: 750,
    color: "#4b5563",
  },
  levelEditor: {
    display: "grid",
    gap: 7,
    padding: "9px",
    border: "1px solid #ddd6fe",
    borderRadius: 9,
    background: "#faf5ff",
  },
  levelEditorTitle: {
    fontSize: 12,
    color: "#5b21b6",
  },
  segmented: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
  segment: { display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: 8, border: "1px solid #d1d5db", borderRadius: 8, background: "#fff", fontSize: 12, fontWeight: 800 },
  segmentActive: { display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: 8, border: "1px solid #4f46e5", borderRadius: 8, background: "#eef2ff", color: "#3730a3", fontSize: 12, fontWeight: 900 },
  readonlyDate: {
    padding: "7px 8px",
    borderRadius: 7,
    background: "#f3f4f6",
    fontSize: 12,
    fontWeight: 800,
    color: "#374151",
  },
  input: {
    ...ui.input,
    // 카드 배경색이 있어도 입력창은 흰 바탕으로 대비를 유지한다.
    background: "#fff",
    padding: "7px 8px",
    borderRadius: 7,
    fontSize: 12,
    minWidth: 0,
  },
  checkRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    fontWeight: 900,
    minWidth: 0,
  },
  checkboxFixed: {
    flexShrink: 0,
  },
  actionRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 6,
  },
  primaryButton: {
    ...ui.button,
    padding: "8px 10px",
    fontSize: 12,
    borderRadius: 8,
  },
  secondaryButton: {
    ...ui.subButton,
    padding: "8px 10px",
    fontSize: 12,
    borderRadius: 8,
  },
  notice: {
    ...ui.card,
    borderRadius: 12,
    padding: 13,
    fontSize: 13,
    fontWeight: 800,
    color: "#374151",
  },
  message: {
    margin: "0 0 10px",
    fontSize: 13,
    fontWeight: 900,
    color: "#111827",
  },
} satisfies Record<string, CSSProperties>;
