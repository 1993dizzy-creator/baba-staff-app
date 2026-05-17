"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getUser, isAdmin } from "@/lib/supabase/auth";
import { ui } from "@/lib/styles/ui";
import { adminUsersText } from "@/lib/text";

type CreateResponse = {
  ok: boolean;
  error?: string;
};

type FormState = {
  username: string;
  password: string;
  name: string;
  full_name: string;
  role: string;
  part: string;
  position: string;
  gender: string;
  birth_date: string;
  hire_date: string;
  work_start_time: string;
  work_end_time: string;
  is_active: boolean;
};

const roleOptions = ["owner", "manager", "staff"] as const;
const partOptions = ["owner", "kitchen", "hall", "bar"] as const;
const positionOptions = ["owner", "manager", "leader", "staff"] as const;
const genders = ["", "male", "female", "other"];

const initialForm: FormState = {
  username: "",
  password: "",
  name: "",
  full_name: "",
  role: "staff",
  part: "kitchen",
  position: "staff",
  gender: "",
  birth_date: "",
  hire_date: "",
  work_start_time: "16:00",
  work_end_time: "01:00",
  is_active: true,
};

type AdminUsersPageText = (typeof adminUsersText)[keyof typeof adminUsersText];

function getRoleLabel(role: string, text: AdminUsersPageText) {
  if (role === "owner") return text.ownerGroup;
  if (role === "manager") return text.managerRole;
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

function getPositionLabel(position: string, text: AdminUsersPageText) {
  if (position === "owner") return text.ownerGroup;
  if (position === "manager") return text.managerRole;
  if (position === "leader") return text.leaderRole;
  if (position === "staff") return text.staffRole;
  return position;
}

function getAge(birthDate: string) {
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

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={styles.formSection}>
      <div style={styles.sectionTitle}>{title}</div>
      <div style={styles.formGrid}>{children}</div>
    </div>
  );
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={styles.field}>
      <span style={styles.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}

export default function AdminUserCreatePage() {
  const { lang } = useLanguage();
  const text = adminUsersText[lang];
  const [checked, setChecked] = useState(false);
  const [canAccess, setCanAccess] = useState(false);
  const [actorUsername, setActorUsername] = useState("");
  const [form, setForm] = useState<FormState>(initialForm);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");
  const age = getAge(form.birth_date);
  const previewName = form.name.trim() || text.name;
  const previewPosition = getPositionLabel(form.position, text);
  const previewWorkTime =
    form.position === "owner" ? "" : `${form.work_start_time}-${form.work_end_time}`;

  useEffect(() => {
    const user = getUser();
    setCanAccess(isAdmin(user));
    setActorUsername(user?.username || "");
    setChecked(true);
  }, []);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit() {
    if (!form.username.trim() || !form.password.trim() || !form.name.trim()) {
      setMessage(text.required);
      return;
    }

    setIsSaving(true);
    setMessage("");

    try {
      const res = await fetch("/api/admin/users/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorUsername,
          lang,
          ...form,
        }),
      });
      const result = (await res.json()) as CreateResponse;

      if (!res.ok || !result.ok) {
        const fallback =
          res.status === 409 ? text.duplicateUsername : text.createFailed;
        throw new Error(result.error || fallback);
      }

      setForm(initialForm);
      setMessage(text.createSuccess);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : text.createFailed);
    } finally {
      setIsSaving(false);
    }
  }

  if (checked && !canAccess) {
    return (
      <Container noPaddingTop>
        <UserNav active="create" />
        <section style={styles.notice}>{text.noPermission}</section>
      </Container>
    );
  }

  return (
    <Container noPaddingTop>
      <UserNav active="create" />

      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <span style={styles.cardTitle}>{text.createTab}</span>
          <span style={styles.cardDescription}>{text.createDescription}</span>
        </div>

        <div style={styles.previewBlock}>
          <div style={styles.sectionTitle}>{text.preview}</div>
          <div style={styles.previewRow}>
            <div style={styles.previewText}>
              <span style={styles.previewName}>
                {previewName}
                {age ? ` (${age})` : ""}
              </span>
              <span style={styles.previewPosition}> · {previewPosition}</span>
            </div>
            {previewWorkTime ? (
              <span style={styles.workTimeText}>{previewWorkTime}</span>
            ) : null}
          </div>
        </div>

        <div style={styles.sections}>
          <Section title={text.basicInfo}>
            <Field label={text.username}>
              <input
                value={form.username}
                onChange={(event) => update("username", event.target.value)}
                style={styles.input}
                autoComplete="off"
              />
            </Field>
            <Field label={text.password}>
              <input
                type="password"
                value={form.password}
                onChange={(event) => update("password", event.target.value)}
                style={styles.input}
                autoComplete="new-password"
              />
            </Field>
            <Field label={text.name}>
              <input
                value={form.name}
                onChange={(event) => update("name", event.target.value)}
                style={styles.input}
              />
            </Field>
            <Field label={text.fullName}>
              <input
                value={form.full_name}
                onChange={(event) => update("full_name", event.target.value)}
                style={styles.input}
              />
            </Field>
          </Section>

          <Section title={text.accessInfo}>
            <Field label={text.role}>
              <select
                value={form.role}
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
                value={form.part}
                onChange={(event) => update("part", event.target.value)}
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
                value={form.position}
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
                value={form.gender}
                onChange={(event) => update("gender", event.target.value)}
                style={styles.input}
              >
                {genders.map((gender) => (
                  <option key={gender || "none"} value={gender}>
                    {gender || "-"}
                  </option>
                ))}
              </select>
            </Field>
          </Section>

          <Section title={text.workInfo}>
            <Field label={text.birthDate}>
              <input
                type="date"
                value={form.birth_date}
                onChange={(event) => update("birth_date", event.target.value)}
                style={styles.input}
              />
            </Field>
            <Field label={text.hireDate}>
              <input
                type="date"
                value={form.hire_date}
                onChange={(event) => update("hire_date", event.target.value)}
                style={styles.input}
              />
            </Field>
            <Field label={text.workStartTime}>
              <input
                type="time"
                value={form.work_start_time}
                onChange={(event) => update("work_start_time", event.target.value)}
                style={styles.input}
              />
            </Field>
            <Field label={text.workEndTime}>
              <input
                type="time"
                value={form.work_end_time}
                onChange={(event) => update("work_end_time", event.target.value)}
                style={styles.input}
              />
            </Field>
            <label style={styles.checkRow}>
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(event) => update("is_active", event.target.checked)}
              />
              {text.activeStatus}
            </label>
          </Section>

          {message ? <p style={styles.message}>{message}</p> : null}

          <button
            type="button"
            style={styles.primaryButton}
            onClick={submit}
            disabled={isSaving}
          >
            {isSaving ? text.creating : text.create}
          </button>
        </div>
      </section>
    </Container>
  );
}

const styles = {
  card: {
    ...ui.card,
    borderRadius: 12,
    padding: 10,
    display: "grid",
    gap: 10,
  },
  cardHeader: {
    display: "grid",
    gap: 2,
    padding: "2px 1px",
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: 900,
    color: "#111827",
  },
  cardDescription: {
    ...ui.metaText,
    fontSize: 11,
    fontWeight: 700,
  },
  sections: {
    display: "grid",
    gap: 8,
  },
  formSection: {
    display: "grid",
    gap: 6,
  },
  sectionTitle: {
    display: "flex",
    alignItems: "center",
    borderRadius: 10,
    padding: "7px 9px",
    fontSize: 13,
    fontWeight: 900,
    color: "#374151",
    background: "#f9fafb",
    borderLeft: "4px solid #d1d5db",
  },
  formGrid: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 6,
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
    color: "#374151",
  },
  primaryButton: {
    ...ui.button,
    padding: "9px 12px",
    fontSize: 13,
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
    margin: "0",
    fontSize: 12,
    fontWeight: 900,
    color: "#111827",
  },
  previewBlock: {
    display: "grid",
    gap: 6,
  },
  previewRow: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 12,
    padding: "8px 9px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  previewText: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  previewName: {
    fontSize: 13,
    fontWeight: 700,
    color: "#111827",
  },
  previewPosition: {
    fontSize: 12,
    fontWeight: 700,
    color: "#6b7280",
  },
  workTimeText: {
    fontSize: 11,
    fontWeight: 800,
    color: "#6b7280",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
} satisfies Record<string, CSSProperties>;
