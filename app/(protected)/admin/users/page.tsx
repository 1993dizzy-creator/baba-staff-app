"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
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
}: {
  user: UserRow;
  onSave: (user: UserRow, draft: UserRow, levelDraft: LevelPolicyDraft) => Promise<boolean>;
  onRehire: (user: UserRow, rehireDate: string, levelEnabled: boolean, salaryRaiseEnabled: boolean | null) => void;
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
  const currentBase = policyBaseForMonth(user, "current");
  const [levelModalOpen, setLevelModalOpen] = useState(false);
  const savePending = useRef(false);
  const levelButtonRef = useRef<HTMLButtonElement>(null);

  function cancelEdit() {
    if (isSaving || savePending.current) return;
    setDraft(user);
    setLevelDraft(initialLevelPolicyDraft(user));
    setLevelModalOpen(false);
    setIsEditing(false);
  }

  function update<K extends keyof UserRow>(key: K, value: UserRow[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <article style={styles.userRow}>
      <div style={styles.rowMain}>
        <div style={styles.rowText}>
          <span style={styles.rowTitle}>
            <EmployeeNameWithLevel name={nameText} levelInfo={user.levelInfo} lang={lang} nameStyle={styles.rowName} showDisabledBadge />
            {user.mealAllowanceEligible ? (
              <span style={styles.mealBadge} title={text.mealAllowanceEligibleBadge} aria-label={text.mealAllowanceEligibleBadge}>🍚</span>
            ) : null}
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

      {hasLevelEditor ? <LevelSummary user={user} text={text} /> : null}

      {isEditing ? (
        <fieldset disabled={isSaving} style={styles.formGrid}>
          {!isMasterUser ? (
            <>
          <section style={styles.detailSection}>
          <strong>{text.basicInfo}</strong>
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
          </section>
          {draft.attendance_tracking_enabled !== false ? (
            <section style={styles.detailSection}>
            <strong>{text.workInfo}</strong>
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
            </section>
          ) : null}
            </>
          ) : null}
          {hasLevelEditor ? <section style={styles.detailSection}>
            <strong>{text.longTermLevel}</strong>
            <LevelDetails levelInfo={user.levelInfo} text={text} />
            {isEmployeeLevelMonthBaseMode(currentBase.mode) ? <span style={styles.fieldNotice}>{text.levelBaseMonth}: {currentBase.baseDate?.slice(0, 7) ?? "-"}</span> : null}
            <button ref={levelButtonRef} type="button" style={styles.secondaryButton} disabled={isSaving || Boolean(user.termination_date)} onClick={() => setLevelModalOpen(true)}>{text.levelSettings}</button>
            {user.termination_date ? <span style={styles.fieldNotice}>{text.terminatedLevelReadOnly}</span> : null}
            {levelDraftChanged(user, levelDraft, draft.hire_date) ? <span style={styles.fieldNotice}>{text.levelPending} · {levelEffectiveFrom(levelDraft.effectiveMonth)}</span> : null}
          </section> : null}
          <section style={styles.detailSection}>
            <strong>{text.usageSettings}</strong>
            {!isMasterUser ? <>
              <Toggle label={text.attendanceTracking} checked={draft.attendance_tracking_enabled !== false} onChange={value => update("attendance_tracking_enabled", value)} />
              <Toggle label={text.appLoginEnabled} checked={draft.app_login_enabled !== false} onChange={value => update("app_login_enabled", value)} />
              <Toggle label={text.activeStatus} checked={!draft.termination_date && draft.is_active !== false} disabled={Boolean(draft.termination_date)} onChange={value => update("is_active", value)} />
              <span style={styles.fieldNotice}>{text.attendanceTrackingHelp}</span>
            </> : null}
            {isAdminGroupUser && !user.is_system_account ? <>
              <Toggle label={text.payrollEligibleOverride} checked={draft.payroll_eligible_override === true} onChange={value => update("payroll_eligible_override", value ? true : null)} />
              <span style={styles.fieldNotice}>{text.payrollEligibleOverrideHelp}</span>
            </> : null}
          </section>
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
                  if (await onSave(user, draft, levelDraft)) setIsEditing(false);
                } finally { savePending.current = false; }
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
                <button type="button" disabled={!rehireDate||isSaving} style={styles.primaryButton} onClick={()=>onRehire(user,rehireDate,rehireLevelEnabled,rehireLevelEnabled?true:null)}>{text.rehire}</button>
              </div> : null}
            </div>
          ) : null}
        </fieldset>
      ) : null}
      {isEditing && levelModalOpen ? <LevelSettingsModal user={user} draft={draft} initial={levelDraft} text={text} onCancel={() => { setLevelModalOpen(false); levelButtonRef.current?.focus(); }} onApply={value => { setLevelDraft(value); setLevelModalOpen(false); levelButtonRef.current?.focus(); }} /> : null}
    </article>
  );
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
  if (!isEmployeeLevelMonthBaseMode(info.baseDateSource)) {
    return <div style={styles.levelSummary}>{text.levelMonthTransitionRequired}</div>;
  }
  const baseLabel = `${text.levelBaseMonth} ${info.baseMonth ?? info.baseDate?.slice(0, 7) ?? "-"}`;
  const nextLabel = info.nextLevelDate
    ? `${text.nextLevelShort} Lv.${Math.min(7, (info.level ?? 0) + 1)} ${info.nextLevelDate}`
    : text.highestLevel;
  return (
    <div style={styles.levelSummary}>
      <span>{baseLabel} · {nextLabel}</span>
    </div>
  );
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
    };
  }, [canAccess, checked, queryAttempt]);

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
            is_active: draft.is_active !== false,
            attendance_tracking_enabled: draft.attendance_tracking_enabled !== false,
            app_login_enabled: draft.app_login_enabled !== false,
          };
      if (original.role === "owner") {
        updates.payroll_eligible_override = draft.payroll_eligible_override;
      }
      if (levelDraftChanged(original, levelDraft, draft.hire_date) && levelDraft.effectiveMonth === "current"
        && !window.confirm(text.levelCurrentMonthWarning)) return false;
      const res = await attendanceFetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action:
            original.termination_date &&
            draft.termination_date === null &&
            draft.is_active !== false
              ? "cancel_termination"
              : undefined,
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
  onRehire: (user: UserRow, rehireDate: string, levelEnabled: boolean, salaryRaiseEnabled: boolean | null) => void;
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
  mealBadge: {
    fontSize: 12,
    lineHeight: 1,
    flexShrink: 0,
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
