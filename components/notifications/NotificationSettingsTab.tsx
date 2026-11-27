"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { getEmployeeRoleLabel } from "@/lib/common/roles";
import { getPartMeta } from "@/lib/common/parts";
import { notificationSettingsText } from "@/lib/text/notifications";
import {
  NOTIFICATION_RULE_PARTS,
  NOTIFICATION_RULE_ROLES,
  previewRecipients,
} from "@/lib/notifications/rules";
import type {
  NotificationPolicyAudit,
  NotificationStaff,
  NotificationTypePolicy,
} from "@/lib/notifications/types";

type Lang = "ko" | "vi";
type Group = { roles: string[]; parts: string[] };
type Draft = { enabled: boolean; inAppEnabled: boolean; groups: Group[]; userIds: number[] };
type LoadState = "loading" | "ready" | "error" | "unavailable" | "forbidden";

const toDraft = (type: NotificationTypePolicy): Draft => ({
  enabled: type.enabled,
  inAppEnabled: type.inAppEnabled,
  groups: (type.rules.groups ?? []).map((group) => ({
    roles: [...(group.roles ?? [])], parts: [...(group.parts ?? [])],
  })),
  userIds: [...(type.rules.userIds ?? [])],
});
const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
const partLabel = (part: string | null) => (part ? getPartMeta(part).label : "-");

export default function NotificationSettingsTab({ lang }: { lang: Lang }) {
  const t = notificationSettingsText[lang];
  const [state, setState] = useState<LoadState>("loading");
  const [types, setTypes] = useState<NotificationTypePolicy[]>([]);
  const [staff, setStaff] = useState<NotificationStaff[]>([]);
  const [audit, setAudit] = useState<NotificationPolicyAudit[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string }>>({});

  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch("/api/admin/notification-settings", { cache: "no-store" });
      const json = await response.json().catch(() => null);
      if (response.status === 403) { setState("forbidden"); return; }
      if (response.ok && json?.ok === true && json.available === false) { setState("unavailable"); return; }
      if (!response.ok || json?.ok !== true || !Array.isArray(json.types)) { setState("error"); return; }
      const nextTypes = json.types as NotificationTypePolicy[];
      setTypes(nextTypes);
      setStaff(Array.isArray(json.staff) ? json.staff : []);
      setAudit(Array.isArray(json.audit) ? json.audit : []);
      setDrafts(Object.fromEntries(nextTypes.map((type) => [type.code, toDraft(type)])));
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const update = (code: string, change: (draft: Draft) => Draft) =>
    setDrafts((current) => (current[code] ? { ...current, [code]: change(current[code]) } : current));

  async function save(type: NotificationTypePolicy) {
    const draft = drafts[type.code];
    if (!draft || saving) return;
    setSaving(type.code);
    setMessages((current) => ({ ...current, [type.code]: { ok: true, text: "" } }));
    try {
      const response = await fetch("/api/admin/notification-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          typeCode: type.code, expectedRevision: type.revision, enabled: draft.enabled, inAppEnabled: draft.inAppEnabled,
          rules: { groups: draft.groups, userIds: draft.userIds },
        }),
      });
      const json = await response.json().catch(() => null);
      if (response.ok && json?.ok === true) {
        setMessages((current) => ({ ...current, [type.code]: { ok: true, text: t.saved } }));
        await load();
        return;
      }
      const text = json?.code === "VERSION_CONFLICT" ? t.conflict
        : json?.code === "FORBIDDEN" ? t.forbidden
        : json?.code === "NOTIFICATIONS_DB_PENDING" ? t.notInstalled : t.failed;
      setMessages((current) => ({ ...current, [type.code]: { ok: false, text } }));
    } catch {
      setMessages((current) => ({ ...current, [type.code]: { ok: false, text: t.failed } }));
    } finally {
      setSaving(null);
    }
  }

  if (state === "loading") return <p style={styles.status}>…</p>;
  if (state === "unavailable") return <p style={styles.notice}>{t.notInstalled}</p>;
  if (state === "forbidden") return <p style={styles.notice}>{t.forbidden}</p>;
  if (state === "error") {
    return (
      <div style={styles.errorBox} role="alert">
        <span>{t.loadFailed}</span>
        <button type="button" style={styles.secondary} onClick={() => void load()}>↻</button>
      </div>
    );
  }

  return (
    <section>
      <p style={styles.intro}>{t.intro}</p>
      {types.length === 0 ? <p style={styles.status}>{t.noTypes}</p> : null}
      {types.map((type) => {
        const draft = drafts[type.code];
        if (!draft) return null;
        const rules = { groups: draft.groups, userIds: draft.userIds };
        const recipients = previewRecipients(rules, type.accessRoles, staff);
        const message = messages[type.code];
        return (
          <div key={type.code} style={styles.card} data-testid={`notification-type-${type.code}`}>
            <div style={styles.cardHeader}>
              <div style={{ minWidth: 0 }}>
                <div style={styles.cardTitle}>{t.typeNames[type.code] ?? type.code}</div>
                <div style={styles.code}>{type.code}</div>
              </div>
              <label style={styles.switchRow}>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => update(type.code, (d) => ({ ...d, enabled: event.target.checked }))}
                />
                {t.enabled}
              </label>
            </div>

            <div style={styles.row}>
              <label style={styles.switchRow}>
                <input
                  type="checkbox"
                  checked={draft.inAppEnabled}
                  onChange={(event) => update(type.code, (d) => ({ ...d, inAppEnabled: event.target.checked }))}
                />
                {t.inApp}
              </label>
              <label style={{ ...styles.switchRow, color: "#9ca3af" }}>
                <input type="checkbox" checked={false} disabled readOnly />
                {t.pushLater}
              </label>
            </div>

            <div style={styles.label}>{t.accessCeiling}</div>
            <div style={styles.chips}>
              {type.accessRoles.map((role) => <span key={role} style={styles.ceilingChip}>{getEmployeeRoleLabel(role, lang)}</span>)}
            </div>

            <div style={styles.label}>{t.groups}</div>
            <p style={styles.help}>{t.groupHelp}</p>
            {draft.groups.map((group, index) => (
              <div key={index} style={styles.group} data-testid={`rule-group-${index}`}>
                <div style={styles.groupHeader}>
                  <span style={styles.groupTitle}>{t.group} {index + 1}</span>
                  <button
                    type="button"
                    style={styles.linkButton}
                    onClick={() => update(type.code, (d) => ({ ...d, groups: d.groups.filter((_, i) => i !== index) }))}
                  >
                    {t.removeGroup}
                  </button>
                </div>
                {([
                  ["roles", t.roles, NOTIFICATION_RULE_ROLES, (v: string) => getEmployeeRoleLabel(v, lang)],
                  ["parts", t.parts, NOTIFICATION_RULE_PARTS, (v: string) => partLabel(v)],
                ] as const).map(([key, label, values, display]) => (
                  <div key={key} style={styles.attrRow} data-testid={`rule-${key}`}>
                    <span style={styles.attrLabel}>{label}</span>
                    <div style={styles.chips}>
                      <span style={{ ...styles.chip, ...(group[key].length === 0 ? styles.chipOn : null) }}>{t.any}</span>
                      {values.map((value) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={group[key].includes(value)}
                          style={{ ...styles.chip, ...(group[key].includes(value) ? styles.chipOn : null) }}
                          onClick={() => update(type.code, (d) => ({
                            ...d,
                            groups: d.groups.map((g, i) => (i === index ? { ...g, [key]: toggle(g[key], value) } : g)),
                          }))}
                        >
                          {display(value)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
            <button
              type="button"
              style={styles.secondary}
              disabled={draft.groups.length >= 20}
              onClick={() => update(type.code, (d) => ({ ...d, groups: [...d.groups, { roles: [], parts: [] }] }))}
            >
              + {t.addGroup}
            </button>
            <p style={styles.help}>{t.nullPartNote}</p>

            <div style={styles.label}>{t.people}</div>
            <p style={styles.help}>{t.peopleHelp}</p>
            <div style={styles.chips}>
              {staff.map((member) => {
                const inCeiling = member.role !== null && type.accessRoles.includes(member.role);
                const on = draft.userIds.includes(member.id);
                return (
                  <button
                    key={member.id}
                    type="button"
                    aria-pressed={on}
                    disabled={!inCeiling && !on}
                    title={`${getEmployeeRoleLabel(member.role, lang)} · ${partLabel(member.part)}`}
                    style={{ ...styles.chip, ...(on ? styles.chipOn : null), ...(!inCeiling ? styles.chipDisabled : null) }}
                    onClick={() => update(type.code, (d) => ({
                      ...d,
                      userIds: on ? d.userIds.filter((id) => id !== member.id) : [...d.userIds, member.id],
                    }))}
                  >
                    {member.name}
                  </button>
                );
              })}
            </div>

            <div style={styles.preview}>
              <div style={styles.label}>{t.preview} ({draft.enabled ? recipients.length : 0})</div>
              <div style={styles.previewNames} data-testid="recipient-preview">
                {draft.enabled && recipients.length > 0
                  ? recipients.map((member) => member.name).join(", ")
                  : t.previewNone}
              </div>
            </div>

            <p style={styles.help}>{t.applyNote}</p>
            <div style={styles.footer}>
              <span style={styles.meta}>
                {t.revision} {type.revision}
                {type.updatedByName ? ` · ${t.lastUpdated}: ${type.updatedByName}` : ""}
              </span>
              <button type="button" style={styles.primary} disabled={saving !== null} onClick={() => void save(type)}>
                {saving === type.code ? t.saving : t.save}
              </button>
            </div>
            {message?.text ? (
              <p role={message.ok ? "status" : "alert"} style={{ ...styles.message, color: message.ok ? "#047857" : "#b91c1c" }}>
                {message.text}
              </p>
            ) : null}
          </div>
        );
      })}

      {audit.length > 0 ? (
        <div style={styles.card}>
          <div style={styles.cardTitle}>{t.history}</div>
          <ul style={styles.audit}>
            {audit.map((entry) => (
              <li key={entry.id} style={styles.auditRow}>
                <span>{t.typeNames[entry.typeCode] ?? entry.typeCode} · {t.revision} {entry.revision}</span>
                <span style={styles.meta}>
                  {entry.actorName ?? "-"} · {new Date(entry.changedAt).toLocaleString(lang === "vi" ? "vi-VN" : "ko-KR", { timeZone: "Asia/Ho_Chi_Minh" })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

const styles = {
  status: { padding: "24px 0", textAlign: "center", color: "#6b7280", fontSize: 14 },
  notice: { padding: 14, borderRadius: 14, background: "#f9fafb", border: "1px solid #e5e7eb", color: "#374151", fontSize: 14 },
  errorBox: {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: 14, borderRadius: 14,
    background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", fontSize: 14, fontWeight: 700,
  },
  intro: { fontSize: 13, color: "#4b5563", lineHeight: 1.5, margin: "0 0 12px" },
  card: {
    background: "#fff", border: "1px solid #d8dce3", borderRadius: 14, boxShadow: "0 1px 3px rgba(15,23,42,0.05)",
    padding: 14, marginBottom: 12, minWidth: 0,
  },
  cardHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 8 },
  cardTitle: { fontSize: 16, fontWeight: 800, color: "#111827" },
  code: { fontSize: 11, color: "#9ca3af", wordBreak: "break-all" },
  row: { display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 8 },
  switchRow: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 700, color: "#111827", whiteSpace: "nowrap" },
  label: { fontSize: 13, fontWeight: 800, color: "#111827", marginTop: 12, marginBottom: 6 },
  help: { fontSize: 12, color: "#6b7280", lineHeight: 1.5, margin: "4px 0 8px" },
  chips: { display: "flex", flexWrap: "wrap", gap: 6 },
  chip: {
    // Longhand border properties only: chipOn changes borderColor, and mixing that with a `border`
    // shorthand makes React report a style conflict on every select/deselect.
    borderWidth: 1, borderStyle: "solid", borderColor: "#d1d5db", borderRadius: 999, padding: "5px 10px", fontSize: 12, fontWeight: 700,
    background: "#fff", color: "#374151", cursor: "pointer",
  },
  chipOn: { background: "#111827", borderColor: "#111827", color: "#fff" },
  chipDisabled: { opacity: 0.4, cursor: "not-allowed" },
  ceilingChip: { borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 700, background: "#eff6ff", color: "#1d4ed8" },
  group: { border: "1px dashed #d1d5db", borderRadius: 12, padding: 10, marginBottom: 8 },
  groupHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  groupTitle: { fontSize: 13, fontWeight: 800, color: "#374151" },
  attrRow: { display: "grid", gridTemplateColumns: "64px minmax(0, 1fr)", gap: 8, alignItems: "start", marginBottom: 6 },
  attrLabel: { fontSize: 12, fontWeight: 700, color: "#6b7280", paddingTop: 6 },
  linkButton: { border: 0, background: "transparent", color: "#b91c1c", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  preview: { background: "#f9fafb", borderRadius: 12, padding: "2px 10px 10px", marginTop: 12 },
  previewNames: { fontSize: 13, color: "#374151", lineHeight: 1.5, wordBreak: "break-word" },
  footer: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 8 },
  meta: { fontSize: 12, color: "#6b7280" },
  message: { fontSize: 13, fontWeight: 700, margin: "8px 0 0" },
  primary: { border: 0, borderRadius: 10, padding: "10px 16px", background: "#111827", color: "#fff", fontSize: 14, fontWeight: 800, cursor: "pointer" },
  secondary: {
    border: "1px solid #d1d5db", borderRadius: 10, padding: "8px 12px", background: "#fff", color: "#111827",
    fontSize: 13, fontWeight: 700, cursor: "pointer",
  },
  audit: { listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 6 },
  auditRow: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 6, fontSize: 13, color: "#374151" },
} satisfies Record<string, CSSProperties>;
