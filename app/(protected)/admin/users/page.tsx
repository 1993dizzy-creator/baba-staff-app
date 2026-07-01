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
  work_start_time: string | null;
  work_end_time: string | null;
  is_active: boolean | null;
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

function getUserGroup(user: UserRow): UserGroupKey {
  if (user.role === "owner" || user.role === "master") return "owner";
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
  isSaving,
}: {
  user: UserRow;
  onSave: (user: UserRow, draft: UserRow) => void;
  isSaving: boolean;
}) {
  const { lang } = useLanguage();
  const text = adminUsersText[lang];
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<UserRow>(user);

  useEffect(() => {
    setDraft(user);
  }, [user]);

  const displayName = user.name || user.full_name || user.username;
  const isMasterUser = user.role === "master";
  const age = getAge(user.birth_date);
  const isAdminGroupUser = user.role === "owner" || user.role === "master";
  const positionText = getPositionLabel(user.position || user.role, text);
  const nameText = `${displayName}${age ? ` (${age})` : ""}`;
  const workTime = !isAdminGroupUser ? formatWorkTime(user) : "";
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
            <span style={styles.rowName}>{nameText}</span>
            <span style={styles.rowPosition}> · {positionText}</span>
          </span>
        </div>
        <div style={styles.badgeRow}>
          {workTime ? <span style={styles.workTimeText}>{workTime}</span> : null}
          {isMasterUser ? (
            <span style={styles.lockedBadge}>{text.cannotEdit}</span>
          ) : null}
          {isMasterUser ? null : (
            <button
              type="button"
              style={styles.inlineEditButton}
              onClick={() => setIsEditing((current) => !current)}
            >
              {isEditing ? text.cancel : text.edit}
            </button>
          )}
        </div>
      </div>

      {isEditing ? (
        <div style={styles.formGrid}>
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
              checked={draft.is_active !== false}
              onChange={(event) => update("is_active", event.target.checked)}
            />
            {text.activeStatus}
          </label>
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
        </div>
      ) : null}
    </article>
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
  const [actorUsername, setActorUsername] = useState("");
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
    setActorUsername(user?.username || "");
    setChecked(true);
  }, [router]);

  useEffect(() => {
    if (!checked || !canAccess || !actorUsername) return;

    let cancelled = false;

    async function fetchUsers() {
      setIsLoading(true);
      setMessage("");

      try {
        const res = await fetch(
          `/api/admin/users?actorUsername=${encodeURIComponent(actorUsername)}`,
          { cache: "no-store" }
        );
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
  }, [actorUsername, canAccess, checked, text.loadFailed]);

  const activeCount = useMemo(
    () => users.filter((user) => user.is_active !== false).length,
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
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorUsername,
          lang,
          id: original.id,
          updates: {
            name: draft.name,
            full_name: draft.full_name,
            role: draft.role,
            part: draft.part,
            position: draft.position,
            gender: draft.gender,
            birth_date: draft.birth_date,
            hire_date: draft.hire_date,
            work_start_time: draft.work_start_time,
            work_end_time: draft.work_end_time,
            is_active: draft.is_active !== false,
          },
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
        <span>{text.listTab}</span>
        <strong>
          {activeCount} / {users.length}
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
  savingId,
}: {
  groupKey: UserGroupKey;
  users: UserRow[];
  text: AdminUsersPageText;
  onSave: (user: UserRow, draft: UserRow) => void;
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
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowName: {
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
