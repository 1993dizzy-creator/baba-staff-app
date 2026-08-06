"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
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
import { useLanguage } from "@/lib/language-context";
import { getUser, isAdmin } from "@/lib/supabase/auth";
import { ui } from "@/lib/styles/ui";
import { adminUsersText } from "@/lib/text";
import { attendanceFetch } from "@/lib/auth/client-session";
import EmployeeNameWithLevel from "@/components/employee/EmployeeNameWithLevel";
import {
  isEmployeeLevelAutomaticRole,
  isEmployeeLevelManualRole,
  type EmployeeLevelInfo,
} from "@/lib/employee-level/types";

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
  attendance_tracking_enabled: boolean;
  app_login_enabled: boolean;
  levelInfo: EmployeeLevelInfo;
  levelProgramPolicy?: {
    currentEnabled: boolean;
    nextEnabled: boolean;
    currentBaseDateMode: "hire_date" | "override";
    nextBaseDateMode: "hire_date" | "override";
    currentBaseDate: string | null;
    nextBaseDate: string | null;
    hasScheduledChange: boolean;
    nextEffectiveFrom: string;
  };
};

type LevelPolicyDraft = {
  included: boolean;
  baseDateMode: "hire_date" | "override";
  baseDateOverride: string;
  effectiveMonth: "current" | "next";
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
  return {
    mode: mode ?? (user.level_base_date_override ? "override" : "hire_date"),
    baseDate: baseDate ?? user.level_base_date_override ?? user.hire_date,
  } as const;
}

function initialLevelPolicyDraft(user: UserRow): LevelPolicyDraft {
  if (user.levelProgramPolicy?.hasScheduledChange) {
    return { included: user.levelProgramPolicy.nextEnabled, baseDateMode: user.levelProgramPolicy.nextBaseDateMode, baseDateOverride: user.levelProgramPolicy.nextBaseDateMode === "override" ? user.levelProgramPolicy.nextBaseDate ?? "" : "", effectiveMonth: "next" };
  }
  const base = policyBaseForMonth(user, "current");
  return { included: currentPolicyEnabled(user), baseDateMode: base.mode, baseDateOverride: base.mode === "override" ? base.baseDate ?? "" : "", effectiveMonth: "current" };
}

type UsersResponse = {
  ok: boolean;
  error?: string;
  users?: UserRow[];
  user?: UserRow;
};

type AdminUsersPageText = (typeof adminUsersText)[keyof typeof adminUsersText];

const roleOptions = EDITABLE_EMPLOYEE_ROLE_VALUES;
const partOptions = PART_VALUES;
const genders = ["", "male", "female", "other"];
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

function formatWorkTime(user: UserRow) {
  const start = user.work_start_time || "-";
  const end = user.work_end_time || "-";
  return `${start}-${end}`;
}

function shiftHours(start: string | null, end: string | null) {
  if (!start || !end) return null;
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  if (![startHour, startMinute, endHour, endMinute].every(Number.isFinite)) return null;
  const minutes = (endHour * 60 + endMinute - startHour * 60 - startMinute + 1440) % 1440;
  return Number((minutes / 60).toFixed(1));
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
}: {
  user: UserRow;
  onSave: (user: UserRow, draft: UserRow, levelDraft: LevelPolicyDraft) => Promise<boolean>;
  onRehire: (user: UserRow, rehireDate: string, levelEnabled: boolean) => void;
  isSaving: boolean;
}) {
  const { lang } = useLanguage();
  const text = adminUsersText[lang];
  const [isEditing, setIsEditing] = useState(false);
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
  const workTime = !isAdminGroupUser && !user.termination_date ? formatWorkTime(user) : "";
  const roleValue = isRoleOption(draft.role) ? draft.role : "staff";
  const partValue = isPartOption(draft.part) ? draft.part : "kitchen";
  const hasLevelEditor = !user.is_system_account;
  const comparedBase = policyBaseForMonth(user, levelDraft.effectiveMonth);
  const levelStateChanged = levelDraft.included !== policyEnabledForMonth(user, levelDraft.effectiveMonth)
    || levelDraft.baseDateMode !== comparedBase.mode
    || (levelDraft.baseDateMode === "override" && levelDraft.baseDateOverride !== comparedBase.baseDate);
  const hours = shiftHours(draft.work_start_time, draft.work_end_time);

  function update<K extends keyof UserRow>(key: K, value: UserRow[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <article style={styles.userRow}>
      <div style={styles.rowMain}>
        <div style={styles.rowText}>
          <span style={styles.rowTitle}>
            <EmployeeNameWithLevel name={nameText} levelInfo={user.levelInfo} lang={lang} nameStyle={styles.rowName} showDisabledBadge />
            <span style={styles.rowPosition}> · {positionText}</span>
          </span>
        </div>
        <div style={styles.badgeRow}>
          {workTime ? <span style={styles.workTimeText}>{workTime}</span> : null}
          {user.termination_date ? <span style={styles.lockedBadge}>{text.terminatedOn} {user.termination_date}</span> : null}
          {!user.is_system_account ? (
            <button
              type="button"
              style={styles.inlineEditButton}
              onClick={() => {
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

      {hasLevelEditor ? <LevelSummary user={user} text={text} /> : null}

      {isEditing ? (
        <div style={styles.formGrid}>
          {!isMasterUser ? (
            <>
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
          <Field label={text.role}>
            <select
              value={roleValue}
              onChange={(event) => {
                const nextRole = event.target.value;
                update("role", nextRole);
                if (isEmployeeLevelManualRole(nextRole) && !isEmployeeLevelManualRole(draft.role)) {
                  setLevelDraft((current) => ({ ...current, included: false }));
                }
              }}
              style={styles.input}
            >
              {roleOptions.map((role) => (
                <option key={role} value={role}>
                  {getEmployeeRoleLabel(role, lang)}
                </option>
              ))}
            </select>
            <span style={styles.fieldNotice}>{text.roleFieldHelp}</span>
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
          <Field label={text.gender}>
            <select
              value={draft.gender || ""}
              onChange={(event) => update("gender", emptyToNull(event.target.value))}
              style={styles.input}
            >
              {genders.map((gender) => (
                <option key={gender || "none"} value={gender}>
                  {gender || "-"}
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
            {draft.termination_date ? (
              <span style={styles.fieldNotice}>
                {text.terminationDeactivationNotice}
              </span>
            ) : null}
          </Field>
          <label style={styles.checkRow}>
            <input
              type="checkbox"
              checked={draft.attendance_tracking_enabled !== false}
              onChange={(event) =>
                update("attendance_tracking_enabled", event.target.checked)
              }
            />
            {text.attendanceTracking}
          </label>
          <span style={styles.fieldNotice}>{text.attendanceTrackingHelp}</span>
          <span style={styles.fieldNotice}>{text.attendanceTrackingOpenRecordNotice}</span>
          {draft.attendance_tracking_enabled !== false ? (
            <>
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
            </>
          ) : null}
          <label style={styles.checkRow}>
            <input
              type="checkbox"
              checked={draft.app_login_enabled !== false}
              onChange={(event) => update("app_login_enabled", event.target.checked)}
            />
            {text.appLoginEnabled}
          </label>
          <span style={styles.fieldNotice}>{text.appLoginEnabledHelp}</span>
          <label style={styles.checkRow}>
            <input
              type="checkbox"
              checked={draft.termination_date ? false : draft.is_active !== false}
              onChange={(event) => update("is_active", event.target.checked)}
              disabled={Boolean(draft.termination_date)}
            />
            {text.activeStatus}
          </label>
            </>
          ) : null}
          {isAdminGroupUser && !user.is_system_account ? (
            <label style={styles.payrollOverrideField}>
              <span style={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={draft.payroll_eligible_override === true}
                  onChange={(event) =>
                    update(
                      "payroll_eligible_override",
                      event.target.checked ? true : null
                    )
                  }
                />
                {text.payrollEligibleOverride}
              </span>
              <span style={styles.fieldNotice}>{text.payrollEligibleOverrideHelp}</span>
            </label>
          ) : null}
          {hasLevelEditor ? <section style={styles.levelEditor}>
            <strong style={styles.levelEditorTitle}>{text.longTermLevel}</strong>
            {user.termination_date ? (
              <span style={styles.fieldNotice}>{text.terminatedLevelReadOnly}</span>
            ) : (
              <>
                <div style={styles.segmented}>
                  {[true, false].map((enabled) => <label key={String(enabled)} style={levelDraft.included === enabled ? styles.segmentActive : styles.segment}>
                    <input type="radio" name={`level-${user.id}`} checked={levelDraft.included === enabled} onChange={() => setLevelDraft((current) => ({ ...current, included: enabled }))} />
                    {enabled ? text.levelEnabled : text.levelDisabled}
                  </label>)}
                </div>
                <span style={styles.fieldNotice}>{text.levelPolicyHelp}</span>
                {hours !== null && hours < 9 ? <span style={styles.shortShiftNotice}>{text.shortShiftNotice.replace("{hours}", String(hours))}</span> : null}
                <strong style={styles.levelEditorTitle}>{text.levelCalculationBasis}</strong>
                <div style={styles.segmented}>
                  {(["hire_date", "override"] as const).map((mode) => <label key={mode} style={levelDraft.baseDateMode === mode ? styles.segmentActive : styles.segment}>
                    <input type="radio" name={`level-base-${user.id}`} checked={levelDraft.baseDateMode === mode} onChange={() => setLevelDraft((current) => ({ ...current, baseDateMode: mode }))} />
                    {mode === "hire_date" ? text.levelHireDateMode : text.levelOverrideMode}
                  </label>)}
                </div>
                {levelDraft.baseDateMode === "hire_date"
                  ? <span style={styles.fieldNotice}>{text.hireDate}: {draft.hire_date ?? "-"}</span>
                  : <Field label={text.levelCalculationStartDate}><input type="date" required value={levelDraft.baseDateOverride} onChange={(event) => setLevelDraft((current) => ({ ...current, baseDateOverride: event.target.value }))} style={styles.input} /></Field>}
                {levelStateChanged ? <>
                  <Field label={text.levelEffectiveMonth}><select value={levelDraft.effectiveMonth} onChange={(event) => setLevelDraft((current) => ({ ...current, effectiveMonth: event.target.value as LevelPolicyDraft["effectiveMonth"] }))} style={styles.input}><option value="current">{text.thisMonth}</option><option value="next">{text.nextMonth}</option></select></Field>
                </> : null}
              </>
            )}
          </section> : null}
          <div style={styles.actionRow}>
            <button
              type="button"
              style={styles.secondaryButton}
              onClick={() => {
                setDraft(user);
                setLevelDraft(initialLevelPolicyDraft(user));
                setIsEditing(false);
              }}
              disabled={isSaving}
            >
              {text.cancel}
            </button>
            <button
              type="button"
              style={styles.primaryButton}
              onClick={async () => {
                if (await onSave(user, draft, levelDraft)) setIsEditing(false);
              }}
              disabled={isSaving}
            >
              {isSaving ? text.saving : text.save}
            </button>
          </div>
          {!isMasterUser && user.is_active === false && user.termination_date ? (
            <div style={{...styles.notice, gridColumn: "1 / -1"}}>
              <button type="button" style={styles.secondaryButton} onClick={() => setRehireOpen(current => !current)}>{text.rehire}</button>
              {rehireOpen ? <div style={{display:"grid",gap:8,marginTop:8}}>
                <p style={{margin:0,fontSize:12,lineHeight:1.5}}>{text.rehireWarning}</p>
                <Field label={text.rehireDate}><input type="date" value={rehireDate} onChange={event=>setRehireDate(event.target.value)} style={styles.input}/></Field>
                <div style={styles.segmented}>{[true,false].map(enabled=><label key={String(enabled)} style={rehireLevelEnabled===enabled?styles.segmentActive:styles.segment}><input type="radio" name={`rehire-level-${user.id}`} checked={rehireLevelEnabled===enabled} onChange={()=>setRehireLevelEnabled(enabled)}/>{enabled?text.levelEnabled:text.levelDisabled}</label>)}</div>
                <button type="button" disabled={!rehireDate||isSaving} style={styles.primaryButton} onClick={()=>onRehire(user,rehireDate,rehireLevelEnabled)}>{text.rehire}</button>
              </div> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function LevelSummary({ user, text }: { user: UserRow; text: AdminUsersPageText }) {
  const info = user.levelInfo;
  if (!info.eligible || !info.displayLabel) {
    const label = info.reason === "PROGRAM_DISABLED" ? text.levelProgramDisabled
      : info.reason === "MISSING_BASE_DATE" ? text.levelBaseRequired
      : info.reason === "ROLE_NOT_ELIGIBLE" ? text.levelRoleNotEligible
      : info.reason === "BEFORE_BASE_DATE" ? text.levelBeforeBaseDate
      : info.reason === "INVALID_DATE" ? text.levelInvalidDate : text.levelUnset;
    return <div style={styles.levelSummary}>{label}</div>;
  }
  const baseLabel = info.baseDateSource === "override"
    ? `${text.directBaseShort} ${info.baseDate}`
    : text.hireDateBase;
  const nextLabel = info.nextLevelDate
    ? `${text.nextLevelShort} Lv.${Math.min(7, (info.level ?? 0) + 1)} ${info.nextLevelDate}`
    : text.highestLevel;
  return (
    <div style={styles.levelSummary}>
      <span>{baseLabel} · {nextLabel}</span>
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

    async function fetchUsers() {
      setIsLoading(true);
      setMessage("");

      try {
        const res = await attendanceFetch("/api/admin/users", { cache: "no-store" });
        const result = (await res.json()) as UsersResponse;

        if (!res.ok || !result.ok) {
          throw new Error(result.error || text.loadFailed);
        }

        if (!cancelled) {
          setUsers(result.users || []);
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : text.loadFailed);
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
    };
  }, [canAccess, checked, text.loadFailed]);

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

  async function saveUser(original: UserRow, draft: UserRow, levelDraft: LevelPolicyDraft) {
    setSavingId(original.id);
    setMessage("");

    try {
      const levelBaseDate = levelDraft.baseDateMode === "hire_date" ? draft.hire_date : levelDraft.baseDateOverride;
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      if (!levelBaseDate) throw new Error(lang === "vi" ? "Vui lòng nhập ngày bắt đầu tính cấp." : "레벨 기준일을 입력해주세요.");
      if (draft.hire_date && levelBaseDate < draft.hire_date) throw new Error(lang === "vi" ? "Ngày bắt đầu tính không thể trước ngày vào làm." : "레벨 기준일은 입사일보다 빠를 수 없습니다.");
      if (draft.termination_date && levelBaseDate > draft.termination_date) throw new Error(lang === "vi" ? "Ngày bắt đầu tính không thể sau ngày nghỉ việc." : "레벨 기준일은 퇴사일보다 늦을 수 없습니다.");
      if (levelBaseDate > today) throw new Error(lang === "vi" ? "Ngày bắt đầu tính không thể là ngày trong tương lai." : "레벨 기준일은 미래 날짜일 수 없습니다.");
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
            is_active: draft.is_active !== false,
            attendance_tracking_enabled: draft.attendance_tracking_enabled !== false,
            app_login_enabled: draft.app_login_enabled !== false,
          };
      if (original.role === "owner") {
        updates.payroll_eligible_override = draft.payroll_eligible_override;
      }
      const res = await attendanceFetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lang,
          id: original.id,
          updates,
          levelProgramEnabled: levelDraft.included,
          levelBaseDateMode: levelDraft.baseDateMode,
          levelBaseDateOverride: levelDraft.baseDateMode === "override" ? levelDraft.baseDateOverride : null,
          levelEffectiveFrom: levelDraft.included !== policyEnabledForMonth(original, levelDraft.effectiveMonth)
            || levelDraft.baseDateMode !== policyBaseForMonth(original, levelDraft.effectiveMonth).mode
            || (levelDraft.baseDateMode === "override" && levelDraft.baseDateOverride !== policyBaseForMonth(original, levelDraft.effectiveMonth).baseDate)
            ? levelEffectiveFrom(levelDraft.effectiveMonth) : null,
        }),
      });
      const result = (await res.json()) as UsersResponse;

      if (!res.ok || !result.ok || !result.user) {
        throw new Error(result.error || text.saveFailed);
      }

      setUsers((current) =>
        current.map((user) => (user.id === original.id ? result.user! : user))
      );
      setMessage(text.saveSuccess);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : text.saveFailed);
      return false;
    } finally {
      setSavingId(null);
    }
  }

  async function rehireUser(user: UserRow, rehireDate: string, levelProgramEnabled: boolean) {
    if (!window.confirm(text.rehireWarning)) return;
    setSavingId(user.id); setMessage("");
    try {
      const res = await attendanceFetch("/api/admin/users", { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action:"rehire",id:user.id,lang,rehireDate,levelProgramEnabled,confirmPreviousPayrollCompleted:true}) });
      const result=(await res.json()) as UsersResponse;
      if(!res.ok||!result.ok||!result.user)throw new Error(result.error||text.saveFailed);
      setUsers(current=>current.map(item=>item.id===user.id?result.user!:item)); setMessage(text.saveSuccess);
    } catch(error) { setMessage(error instanceof Error?error.message:text.saveFailed); }
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
          {activeEmployeeCount}{text.peopleUnit}
        </strong>
      </section>

      {message ? <p style={styles.message}>{message}</p> : null}
      {isLoading ? <p style={styles.notice}>{text.loading}</p> : null}
      {!isLoading && users.length === 0 ? (
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
}: {
  groupKey: UserGroupKey;
  users: UserRow[];
  text: AdminUsersPageText;
  onSave: (user: UserRow, draft: UserRow, levelDraft: LevelPolicyDraft) => Promise<boolean>;
  onRehire: (user: UserRow, rehireDate: string, levelEnabled: boolean) => void;
  savingId: number | string | null;
}) {
  const meta = getGroupMeta(groupKey, text);

  return (
    <div style={styles.group}>
      <div
        style={{
          ...styles.groupTitle,
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
      </div>
      <div style={styles.groupList}>
        {users.map((user) => (
          <UserCard
            key={user.id}
            user={user}
            onSave={onSave}
            onRehire={onRehire}
            isSaving={savingId === user.id}
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
  list: {
    display: "grid",
    gap: 12,
  },
  group: {
    display: "grid",
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
  groupList: {
    display: "grid",
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
  formGrid: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 5,
    marginTop: 8,
    paddingTop: 7,
    borderTop: "1px dashed #e5e7eb",
  },
  field: {
    display: "flex",
    flexDirection: "column",
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
  shortShiftNotice: { padding: 8, borderRadius: 8, background: "#fffbeb", color: "#92400e", fontSize: 11, lineHeight: 1.5 },
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
    padding: "7px 8px",
    borderRadius: 7,
    fontSize: 12,
  },
  checkRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    fontWeight: 900,
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
