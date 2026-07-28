"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname, useRouter } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { getPartMeta } from "@/lib/common/parts";
import { useLanguage } from "@/lib/language-context";
import { getUser, isAdmin } from "@/lib/supabase/auth";
import { ui } from "@/lib/styles/ui";
import { adminUsersText } from "@/lib/text";
import { attendanceFetch } from "@/lib/auth/client-session";
import EmployeeLevelBadge from "@/components/employee/EmployeeLevelBadge";
import type { EmployeeLevelInfo } from "@/lib/employee-level/types";

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
  levelInfo: EmployeeLevelInfo;
};

type LevelPolicyDraft = {
  status: "unset" | "enabled" | "disabled";
  baseDateMode: "hire_date" | "override";
  levelBaseDateOverride: string;
  changeReason: string;
};

type UsersResponse = {
  ok: boolean;
  error?: string;
  users?: UserRow[];
  user?: UserRow;
};

type AdminUsersPageText = (typeof adminUsersText)[keyof typeof adminUsersText];

const roleOptions = ["owner", "manager", "leader", "staff"] as const;
const partOptions = ["owner", "kitchen", "hall", "bar"] as const;
const positionOptions = ["owner", "manager", "leader", "staff"] as const;
const genders = ["", "male", "female", "other"];
const groupOrder = ["owner", "kitchen", "hall", "bar", "inactive"] as const;

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
  return roleOptions.includes(value as (typeof roleOptions)[number]);
}

function isPartOption(value: string | null): value is (typeof partOptions)[number] {
  return partOptions.includes(value as (typeof partOptions)[number]);
}

function isPositionOption(
  value: string | null
): value is (typeof positionOptions)[number] {
  return positionOptions.includes(value as (typeof positionOptions)[number]);
}

function getRoleLabel(role: string, text: AdminUsersPageText) {
  if (role === "owner") return text.ownerGroup;
  if (role === "manager") return text.managerRole;
  if (role === "leader") return text.leaderRole;
  if (role === "staff") return text.staffRole;
  return role;
}

function getPartLabel(part: string, text: AdminUsersPageText) {
  if (part === "owner") return text.ownerGroup;
  if (part === "kitchen") return text.kitchenGroup;
  if (part === "hall") return text.hallGroup;
  if (part === "bar") return text.barGroup;
  return part;
}

function getPositionLabel(position: string | null, text: AdminUsersPageText) {
  if (position === "owner") return text.ownerGroup;
  if (position === "manager") return text.managerRole;
  if (position === "leader") return text.leaderRole;
  if (position === "staff") return text.staffRole;
  return position || "-";
}

function isOwnerGroupUser(user: Pick<UserRow, "role">) {
  return user.role === "owner" || user.role === "master";
}

function getUserGroup(user: UserRow): UserGroupKey {
  if (isOwnerGroupUser(user)) return "owner";
  if (user.part === "kitchen") return "kitchen";
  if (user.part === "hall") return "hall";
  if (user.part === "bar") return "bar";
  return "kitchen";
}

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

  if (key === "kitchen") {
    const meta = getPartMeta("kitchen");

    return {
      label: text.kitchenGroup,
      emoji: meta.emoji,
      color: meta.color,
      bg: meta.bg,
      border: meta.border,
    };
  }

  if (key === "hall") {
    const meta = getPartMeta("hall");

    return {
      label: text.hallGroup,
      emoji: meta.emoji,
      color: meta.color,
      bg: meta.bg,
      border: meta.border,
    };
  }

  const meta = getPartMeta("bar");

  return {
    label: text.barGroup,
    emoji: meta.emoji,
    color: meta.color,
    bg: meta.bg,
    border: meta.border,
  };
}

function getRank(user: UserRow) {
  if (user.role === "owner") return 1;
  if (user.role === "master") return 2;

  const position = (user.position || "").toLowerCase();
  if (position === "manager") return 3;
  if (position === "leader") return 4;
  if (position === "staff") return 5;
  return 6;
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
  onSaveLevelPolicy,
  isSaving,
}: {
  user: UserRow;
  onSave: (user: UserRow, draft: UserRow) => void;
  onRehire: (user: UserRow, rehireDate: string) => void;
  onSaveLevelPolicy: (user: UserRow, draft: LevelPolicyDraft) => Promise<boolean>;
  isSaving: boolean;
}) {
  const { lang } = useLanguage();
  const text = adminUsersText[lang];
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<UserRow>(user);
  const [rehireOpen, setRehireOpen] = useState(false);
  const [rehireDate, setRehireDate] = useState("");
  const [levelDraft, setLevelDraft] = useState<LevelPolicyDraft>({
    status: user.level_program_enabled === null ? "unset" : user.level_program_enabled ? "enabled" : "disabled",
    baseDateMode: user.level_base_date_override ? "override" : "hire_date",
    levelBaseDateOverride: user.level_base_date_override || "",
    changeReason: "",
  });

  const displayName = user.name || user.full_name || user.username;
  const isMasterUser = user.role === "master";
  const age = getAge(user.birth_date);
  const isAdminGroupUser = isOwnerGroupUser(user);
  const positionText = getPositionLabel(user.position || user.role, text);
  const nameText = `${displayName}${age ? ` (${age})` : ""}`;
  const workTime = !isAdminGroupUser && !user.termination_date ? formatWorkTime(user) : "";
  const roleValue = isRoleOption(draft.role) ? draft.role : "staff";
  const partValue = isPartOption(draft.part) ? draft.part : "kitchen";
  const positionValue = isPositionOption(draft.position)
    ? draft.position
    : draft.role === "owner"
      ? "owner"
      : "staff";

  function update<K extends keyof UserRow>(key: K, value: UserRow[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <article style={styles.userRow}>
      <div style={styles.rowMain}>
        <div style={styles.rowText}>
          <span style={styles.rowTitle}>
            {user.level_program_enabled === true && user.levelInfo.eligible && user.levelInfo.level ? (
              <EmployeeLevelBadge level={user.levelInfo.level} negotiationEligible={user.levelInfo.negotiationEligible} lang={lang} />
            ) : null}
            <span style={styles.rowName}>{nameText}</span>
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
                  setLevelDraft({
                    status: user.level_program_enabled === null ? "unset" : user.level_program_enabled ? "enabled" : "disabled",
                    baseDateMode: user.level_base_date_override ? "override" : "hire_date",
                    levelBaseDateOverride: user.level_base_date_override || "",
                    changeReason: "",
                  });
                }
                setIsEditing((current) => !current);
              }}
            >
              {isEditing ? text.cancel : text.edit}
            </button>
          ) : null}
        </div>
      </div>

      <LevelSummary user={user} text={text} lang={lang} />

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
              onChange={(event) => update("role", event.target.value)}
              style={styles.input}
            >
              {roleOptions.map((role) => (
                <option key={role} value={role}>
                  {getRoleLabel(role, text)}
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
          <Field label={text.position}>
            <select
              value={positionValue}
              onChange={(event) => update("position", event.target.value)}
              style={styles.input}
            >
              {positionOptions.map((position) => (
                <option key={position} value={position}>
                  {getPositionLabel(position, text)}
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
          <section style={styles.levelEditor}>
            <strong style={styles.levelEditorTitle}>{text.employeeLevel}</strong>
            {user.termination_date ? (
              <span style={styles.fieldNotice}>{text.terminatedLevelReadOnly}</span>
            ) : (
              <>
                <Field label={text.employeeLevel}>
                  <select value={levelDraft.status} onChange={(event) => setLevelDraft((current) => ({ ...current, status: event.target.value as LevelPolicyDraft["status"] }))} style={styles.input}>
                    <option value="unset">{text.levelStatusUnset}</option>
                    <option value="enabled">{text.levelProgramEnabled}</option>
                    <option value="disabled">{text.levelProgramDisabled}</option>
                  </select>
                </Field>
                {levelDraft.status === "enabled" ? (
                  <>
                    <Field label={text.levelBaseDate}>
                      <select value={levelDraft.baseDateMode} onChange={(event) => setLevelDraft((current) => ({ ...current, baseDateMode: event.target.value as LevelPolicyDraft["baseDateMode"] }))} style={styles.input}>
                        <option value="hire_date">{text.hireDateBase}</option>
                        <option value="override">{text.directBase}</option>
                      </select>
                    </Field>
                    {levelDraft.baseDateMode === "hire_date" ? <span style={styles.readonlyDate}>{user.hire_date || "-"}</span> : (
                      <input type="date" value={levelDraft.levelBaseDateOverride} onChange={(event) => setLevelDraft((current) => ({ ...current, levelBaseDateOverride: event.target.value }))} style={styles.input} />
                    )}
                  </>
                ) : null}
                {levelDraft.status !== "unset" ? (
                  <>
                    <Field label={text.changeReason}><input value={levelDraft.changeReason} onChange={(event) => setLevelDraft((current) => ({ ...current, changeReason: event.target.value }))} style={styles.input} /></Field>
                    <button type="button" style={styles.primaryButton} disabled={isSaving || levelDraft.changeReason.trim().length < 2} onClick={async () => { if (await onSaveLevelPolicy(user, levelDraft)) setLevelDraft((current) => ({ ...current, changeReason: "" })); }}>
                      {isSaving ? text.saving : text.saveLevelPolicy}
                    </button>
                  </>
                ) : null}
              </>
            )}
          </section>
          <div style={styles.actionRow}>
            <button
              type="button"
              style={styles.secondaryButton}
              onClick={() => {
                setDraft(user);
                setIsEditing(false);
              }}
              disabled={isSaving}
            >
              {text.cancel}
            </button>
            <button
              type="button"
              style={styles.primaryButton}
              onClick={() => {
                onSave(user, draft);
                setIsEditing(false);
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
                <button type="button" disabled={!rehireDate||isSaving} style={styles.primaryButton} onClick={()=>onRehire(user,rehireDate)}>{text.rehire}</button>
              </div> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function LevelSummary({ user, text, lang }: { user: UserRow; text: AdminUsersPageText; lang: "ko" | "vi" }) {
  if (user.level_program_enabled === null) return <div style={styles.levelSummary}>{text.levelUnset}</div>;
  if (user.level_program_enabled === false) return <div style={styles.levelSummary}>{text.levelProgramDisabled}</div>;
  const info = user.levelInfo;
  if (!info.eligible || !info.displayLabel) return <div style={styles.levelSummary}>{text.levelUnset}</div>;
  const amount = new Intl.NumberFormat(lang === "vi" ? "vi-VN" : "ko-KR").format(info.cumulativeRaiseAmount);
  return (
    <div style={styles.levelSummary}>
      <span>{text.currentLevel} {info.displayLabel}</span>
      <span>{text.levelBaseDate} {info.baseDate} · {info.baseDateSource === "override" ? text.directBase : text.hireDateBase}</span>
      <span>{text.cumulativeRaise} {amount} VND</span>
      {info.negotiationEligible ? <span>{text.negotiationEligible} · {text.negotiationEligibleAt} {info.negotiationEligibleAt}</span> : info.nextLevelDate ? <span>{text.nextLevel} Lv.{Math.min(8, (info.level || 1) + 1)} {info.nextLevelDate}</span> : <span>{text.negotiationEligibleAt} {info.negotiationEligibleAt}</span>}
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

  async function saveUser(original: UserRow, draft: UserRow) {
    setSavingId(original.id);
    setMessage("");

    try {
      const updates: Record<string, unknown> = original.role === "master"
        ? { payroll_eligible_override: draft.payroll_eligible_override }
        : {
            name: draft.name,
            full_name: draft.full_name,
            role: draft.role,
            part: draft.part,
            position: draft.position,
            gender: draft.gender,
            birth_date: draft.birth_date,
            hire_date: draft.hire_date,
            termination_date: draft.termination_date,
            work_start_time: draft.work_start_time,
            work_end_time: draft.work_end_time,
            is_active: draft.is_active !== false,
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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : text.saveFailed);
    } finally {
      setSavingId(null);
    }
  }

  async function rehireUser(user: UserRow, rehireDate: string) {
    if (!window.confirm(text.rehireWarning)) return;
    setSavingId(user.id); setMessage("");
    try {
      const res = await attendanceFetch("/api/admin/users", { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action:"rehire",id:user.id,lang,rehireDate,confirmPreviousPayrollCompleted:true}) });
      const result=(await res.json()) as UsersResponse;
      if(!res.ok||!result.ok||!result.user)throw new Error(result.error||text.saveFailed);
      setUsers(current=>current.map(item=>item.id===user.id?result.user!:item)); setMessage(text.saveSuccess);
    } catch(error) { setMessage(error instanceof Error?error.message:text.saveFailed); }
    finally { setSavingId(null); }
  }

  async function saveLevelPolicy(user: UserRow, draft: LevelPolicyDraft) {
    if (draft.status === "unset") return false;
    setSavingId(user.id);
    setMessage("");
    try {
      const res = await attendanceFetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_employee_level_policy",
          id: user.id,
          lang,
          levelProgramEnabled: draft.status === "enabled",
          baseDateMode: draft.baseDateMode,
          levelBaseDateOverride: draft.baseDateMode === "override" ? draft.levelBaseDateOverride : null,
          changeReason: draft.changeReason,
        }),
      });
      const result = (await res.json()) as UsersResponse;
      if (!res.ok || !result.ok || !result.user) throw new Error(result.error || text.saveFailed);
      setUsers((current) => current.map((item) => item.id === user.id ? result.user! : item));
      setMessage(text.levelSaveSuccess);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : text.saveFailed);
      return false;
    } finally {
      setSavingId(null);
    }
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
            onSaveLevelPolicy={saveLevelPolicy}
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
  onSaveLevelPolicy,
  savingId,
}: {
  groupKey: UserGroupKey;
  users: UserRow[];
  text: AdminUsersPageText;
  onSave: (user: UserRow, draft: UserRow) => void;
  onRehire: (user: UserRow, rehireDate: string) => void;
  onSaveLevelPolicy: (user: UserRow, draft: LevelPolicyDraft) => Promise<boolean>;
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
            onSaveLevelPolicy={onSaveLevelPolicy}
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
