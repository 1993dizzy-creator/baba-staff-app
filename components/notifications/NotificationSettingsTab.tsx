"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import ChevronIcon from "@/components/ChevronIcon";
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
// baseRevision = the saved revision this draft was started from; it is sent as expectedRevision so a
// draft kept across a reload can never silently overwrite another admin's newer save.
type Draft = { enabled: boolean; inAppEnabled: boolean; groups: Group[]; userIds: number[]; baseRevision: number };
type LoadState = "loading" | "ready" | "error" | "unavailable" | "forbidden";

const toDraft = (type: NotificationTypePolicy): Draft => ({
  enabled: type.enabled,
  inAppEnabled: type.inAppEnabled,
  groups: (type.rules.groups ?? []).map((group) => ({
    roles: [...(group.roles ?? [])], parts: [...(group.parts ?? [])],
  })),
  userIds: [...(type.rules.userIds ?? [])],
  baseRevision: type.revision,
});
const sameSettings = (a: Draft | undefined, b: Draft | undefined) =>
  !!a && !!b && JSON.stringify([a.enabled, a.inAppEnabled, a.groups, a.userIds]) === JSON.stringify([b.enabled, b.inAppEnabled, b.groups, b.userIds]);
const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
const partLabel = (part: string | null) => (part ? getPartMeta(part).label : "-");
const toggleKey = (set: Set<string>, key: string) => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
};

export default function NotificationSettingsTab({ lang }: { lang: Lang }) {
  const t = notificationSettingsText[lang];
  const [state, setState] = useState<LoadState>("loading");
  const [types, setTypes] = useState<NotificationTypePolicy[]>([]);
  const [staff, setStaff] = useState<NotificationStaff[]>([]);
  const [audit, setAudit] = useState<NotificationPolicyAudit[]>([]);
  const [saved, setSaved] = useState<Record<string, Draft>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [openTypes, setOpenTypes] = useState<Set<string>>(() => new Set());
  const [openPeople, setOpenPeople] = useState<Set<string>>(() => new Set());
  const [openHelp, setOpenHelp] = useState<Set<string>>(() => new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  // Saved state as of the previous load: a draft that still differs from it is unsaved work and
  // survives the reload (e.g. after saving another type); an untouched draft follows the server.
  const savedRef = useRef<Record<string, Draft>>({});

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/notification-settings", { cache: "no-store" });
      const json = await response.json().catch(() => null);
      if (response.status === 403) { setState("forbidden"); return; }
      if (response.ok && json?.ok === true && json.available === false) { setState("unavailable"); return; }
      if (!response.ok || json?.ok !== true || !Array.isArray(json.types)) { setState("error"); return; }
      const nextTypes = json.types as NotificationTypePolicy[];
      const nextSaved = Object.fromEntries(nextTypes.map((type) => [type.code, toDraft(type)]));
      const previousSaved = savedRef.current;
      savedRef.current = nextSaved;
      setTypes(nextTypes);
      setStaff(Array.isArray(json.staff) ? json.staff : []);
      setAudit(Array.isArray(json.audit) ? json.audit : []);
      setSaved(nextSaved);
      setDrafts((current) => Object.fromEntries(nextTypes.map((type) => {
        const draft = current[type.code];
        const unsaved = draft && previousSaved[type.code] && !sameSettings(draft, previousSaved[type.code]);
        return [type.code, unsaved ? draft : nextSaved[type.code]];
      })));
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
          typeCode: type.code, expectedRevision: draft.baseRevision, enabled: draft.enabled, inAppEnabled: draft.inAppEnabled,
          rules: { groups: draft.groups, userIds: draft.userIds },
        }),
      });
      const json = await response.json().catch(() => null);
      if (response.ok && json?.ok === true) {
        // The saved draft is no longer unsaved work: let the reload replace it with the server copy.
        savedRef.current = { ...savedRef.current, [type.code]: draft };
        await load();
        setMessages((current) => ({ ...current, [type.code]: { ok: true, text: t.saved } }));
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

  function discard(code: string) {
    if (!saved[code]) return;
    setDrafts((current) => ({ ...current, [code]: saved[code] }));
    setMessages((current) => ({ ...current, [code]: { ok: true, text: "" } }));
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

  const groupSummary = (group: Group) => {
    const labels = [
      ...group.roles.map((role) => getEmployeeRoleLabel(role, lang)),
      ...group.parts.map((part) => partLabel(part)),
    ];
    return labels.length ? labels.join(" · ") : t.any;
  };

  return (
    <section>
      <p style={styles.intro}>{t.intro}</p>
      {types.length === 0 ? <p style={styles.status}>{t.noTypes}</p> : null}
      {types.map((type) => {
        const draft = drafts[type.code];
        if (!draft) return null;
        const rules = { groups: draft.groups, userIds: draft.userIds };
        const recipients = previewRecipients(rules, type.accessRoles, staff);
        const recipientCount = draft.enabled ? recipients.length : 0;
        const message = messages[type.code];
        const dirty = !sameSettings(draft, saved[type.code]);
        const open = openTypes.has(type.code);
        const peopleOpen = openPeople.has(type.code);
        const helpOpen = openHelp.has(type.code);
        const conditions = [
          ...draft.groups.map(groupSummary),
          ...(draft.userIds.length ? [t.peopleCount.replace("{n}", String(draft.userIds.length))] : []),
        ];
        const pickedNames = staff.filter((member) => draft.userIds.includes(member.id)).map((member) => member.name);
        return (
          <div key={type.code} style={styles.card} data-testid={`notification-type-${type.code}`}>
            <div style={styles.cardHeader}>
              <button
                type="button"
                style={styles.headerButton}
                aria-expanded={open}
                data-testid="notification-details-toggle"
                onClick={() => setOpenTypes((current) => toggleKey(current, type.code))}
              >
                <span style={styles.titleRow}>
                  <span style={styles.cardTitle}>{t.typeNames[type.code] ?? type.code}</span>
                  {dirty ? <span style={styles.unsavedBadge}>{t.unsaved}</span> : null}
                  <ChevronIcon open={open} />
                </span>
                <span style={styles.summary} data-testid="notification-summary">
                  {conditions.length ? conditions.join(" / ") : t.noConditions}
                  <span style={styles.summaryCount}> · {t.recipientsCount.replace("{n}", String(recipientCount))}</span>
                </span>
              </button>
              <div style={styles.switchWrap}>
                <span style={{ ...styles.switchText, color: draft.enabled ? "#111827" : "#9ca3af" }}>{draft.enabled ? t.on : t.off}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={draft.enabled}
                  aria-label={t.enabled}
                  style={{ ...styles.switchTrack, ...(draft.enabled ? styles.switchTrackOn : null) }}
                  onClick={() => update(type.code, (d) => ({ ...d, enabled: !d.enabled }))}
                >
                  <span style={{ ...styles.switchKnob, ...(draft.enabled ? styles.switchKnobOn : null) }} />
                </button>
              </div>
            </div>

            {open ? (
              <div style={styles.body}>
                <div style={styles.label}>{t.channels}</div>
                <div style={styles.row}>
                  <label style={styles.checkRow}>
                    <input
                      type="checkbox"
                      checked={draft.inAppEnabled}
                      onChange={(event) => update(type.code, (d) => ({ ...d, inAppEnabled: event.target.checked }))}
                    />
                    {t.inApp}
                  </label>
                  <span style={styles.mutedNote}>{t.pushLater}</span>
                </div>

                <div style={styles.labelRow}>
                  <span style={styles.label}>{t.groups}</span>
                  <button
                    type="button"
                    style={styles.helpButton}
                    aria-expanded={helpOpen}
                    onClick={() => setOpenHelp((current) => toggleKey(current, type.code))}
                  >
                    {t.conditionHelp}
                    <ChevronIcon open={helpOpen} size={12} />
                  </button>
                </div>
                <p style={styles.help}>
                  {t.accessCeiling}: {type.accessRoles.map((role) => getEmployeeRoleLabel(role, lang)).join(", ")}
                </p>
                {helpOpen ? (
                  <div style={styles.helpBox}>
                    <p style={styles.helpLine}>{t.groupHelp}</p>
                    <p style={styles.helpLine}>{t.nullPartNote}</p>
                  </div>
                ) : null}
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

                <button
                  type="button"
                  style={styles.subDisclosure}
                  aria-expanded={peopleOpen}
                  data-testid="notification-people-toggle"
                  onClick={() => setOpenPeople((current) => toggleKey(current, type.code))}
                >
                  <span style={styles.label}>{t.people}</span>
                  <span style={styles.subDisclosureRight}>
                    <span style={styles.subDisclosureNames}>{pickedNames.length ? pickedNames.join(", ") : "-"}</span>
                    <ChevronIcon open={peopleOpen} />
                  </span>
                </button>
                {peopleOpen ? (
                  <div>
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
                  </div>
                ) : null}

                <div style={styles.preview}>
                  <div style={styles.label}>{t.preview} ({recipientCount})</div>
                  <div style={styles.previewNames} data-testid="recipient-preview">
                    {draft.enabled && recipients.length > 0
                      ? recipients.map((member) => member.name).join(", ")
                      : t.previewNone}
                  </div>
                </div>
                <p style={styles.help}>{t.applyNote}</p>
              </div>
            ) : null}

            {open || dirty || message?.text ? (
              <div style={styles.footer}>
                <span style={styles.meta}>
                  {t.revision} {type.revision}
                  {type.updatedByName ? ` · ${t.lastUpdated}: ${type.updatedByName}` : ""}
                </span>
                <span style={styles.actions}>
                  {dirty ? (
                    <button type="button" style={styles.secondary} disabled={saving !== null} onClick={() => discard(type.code)}>
                      {t.discard}
                    </button>
                  ) : null}
                  <button type="button" style={styles.primary} disabled={saving !== null} onClick={() => void save(type)}>
                    {saving === type.code ? t.saving : t.save}
                  </button>
                </span>
              </div>
            ) : null}
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
          <button
            type="button"
            style={styles.historyToggle}
            aria-expanded={historyOpen}
            data-testid="notification-history-toggle"
            onClick={() => setHistoryOpen((value) => !value)}
          >
            <span style={styles.cardTitle}>{t.history}</span>
            <span style={styles.subDisclosureRight}>
              <span style={styles.meta}>{audit.length}</span>
              <ChevronIcon open={historyOpen} />
            </span>
          </button>
          {historyOpen ? (
            <ul style={styles.audit} data-testid="notification-history-list">
              {audit.map((entry) => (
                <li key={entry.id} style={styles.auditRow}>
                  <span>{t.typeNames[entry.typeCode] ?? entry.typeCode} · {t.revision} {entry.revision}</span>
                  <span style={styles.meta}>
                    {entry.actorName ?? "-"} · {new Date(entry.changedAt).toLocaleString(lang === "vi" ? "vi-VN" : "ko-KR", { timeZone: "Asia/Ho_Chi_Minh" })}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const styles = {
  status: { padding: "24px 0", textAlign: "center", color: "#6b7280", fontSize: 14 },
  notice: { padding: 12, borderRadius: 12, background: "#f9fafb", border: "1px solid #e5e7eb", color: "#374151", fontSize: 13 },
  errorBox: {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: 12, borderRadius: 12,
    background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", fontSize: 13, fontWeight: 700,
  },
  intro: { fontSize: 12, color: "#6b7280", lineHeight: 1.5, margin: "0 0 10px" },
  card: {
    background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
    padding: "10px 12px", marginBottom: 10, minWidth: 0,
  },
  cardHeader: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
  headerButton: {
    flex: 1, minWidth: 0, display: "grid", gap: 3, padding: "2px 0", border: 0, background: "transparent",
    textAlign: "left", color: "#111827", cursor: "pointer",
  },
  titleRow: { display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" },
  cardTitle: { fontSize: 15, fontWeight: 800, color: "#111827", lineHeight: 1.3 },
  summary: { fontSize: 12, color: "#4b5563", lineHeight: 1.4, wordBreak: "break-word" },
  summaryCount: { color: "#9ca3af" },
  unsavedBadge: {
    padding: "1px 7px", borderRadius: 999, background: "#fffbeb", color: "#b45309",
    borderWidth: 1, borderStyle: "solid", borderColor: "#fde68a", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap",
  },
  switchWrap: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
  switchText: { fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" },
  switchTrack: {
    position: "relative", width: 40, height: 24, flexShrink: 0, padding: 0, borderRadius: 999, borderWidth: 0,
    borderStyle: "solid", background: "#d1d5db", cursor: "pointer", transition: "background 0.15s ease",
  },
  switchTrackOn: { background: "#111827" },
  switchKnob: {
    position: "absolute", top: 3, left: 3, width: 18, height: 18, borderRadius: 999, background: "#fff",
    boxShadow: "0 1px 2px rgba(0,0,0,0.25)", transition: "left 0.15s ease",
  },
  switchKnobOn: { left: 19 },
  body: { marginTop: 10, paddingTop: 10, borderTop: "1px solid #f1f2f4", display: "grid", gap: 8, minWidth: 0 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 12px" },
  checkRow: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: "#111827" },
  mutedNote: { fontSize: 11.5, color: "#9ca3af" },
  label: { fontSize: 12.5, fontWeight: 800, color: "#111827" },
  labelRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 4 },
  helpButton: { display: "inline-flex", alignItems: "center", gap: 3, border: 0, background: "transparent", padding: "4px 0", color: "#6b7280", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
  help: { fontSize: 11.5, color: "#6b7280", lineHeight: 1.45, margin: 0 },
  helpBox: { background: "#f9fafb", borderRadius: 8, padding: "8px 10px", display: "grid", gap: 4 },
  helpLine: { fontSize: 11.5, color: "#4b5563", lineHeight: 1.45, margin: 0 },
  chips: { display: "flex", flexWrap: "wrap", gap: 6 },
  chip: {
    // Longhand border properties only: chipOn changes borderColor, and mixing that with a `border`
    // shorthand makes React report a style conflict on every select/deselect.
    borderWidth: 1, borderStyle: "solid", borderColor: "#d1d5db", borderRadius: 999, padding: "5px 10px", fontSize: 12, fontWeight: 700,
    lineHeight: 1.2, background: "#fff", color: "#374151", cursor: "pointer",
  },
  chipOn: { background: "#111827", borderColor: "#111827", color: "#fff" },
  chipDisabled: { opacity: 0.4, cursor: "not-allowed" },
  group: { background: "#f9fafb", borderRadius: 10, padding: "8px 10px", display: "grid", gap: 6 },
  groupHeader: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  groupTitle: { fontSize: 12, fontWeight: 800, color: "#374151" },
  attrRow: { display: "grid", gridTemplateColumns: "60px minmax(0, 1fr)", gap: 8, alignItems: "start" },
  attrLabel: { fontSize: 11.5, fontWeight: 700, color: "#6b7280", paddingTop: 5, lineHeight: 1.3 },
  linkButton: { border: 0, background: "transparent", color: "#b91c1c", fontSize: 12, fontWeight: 700, cursor: "pointer", padding: "2px 0" },
  subDisclosure: {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, width: "100%", minWidth: 0,
    padding: "8px 0 2px", border: 0, borderTop: "1px solid #f1f2f4", background: "transparent", cursor: "pointer", textAlign: "left",
  },
  subDisclosureRight: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  subDisclosureNames: { fontSize: 12, color: "#4b5563", textAlign: "right", wordBreak: "break-word" },
  preview: { background: "#f9fafb", borderRadius: 10, padding: "8px 10px", display: "grid", gap: 3 },
  previewNames: { fontSize: 12.5, color: "#374151", lineHeight: 1.45, wordBreak: "break-word" },
  footer: {
    display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8,
    marginTop: 10, paddingTop: 8, borderTop: "1px solid #f1f2f4",
  },
  actions: { display: "flex", gap: 6, marginLeft: "auto" },
  meta: { fontSize: 11.5, color: "#6b7280" },
  message: { fontSize: 12.5, fontWeight: 700, margin: "6px 0 0" },
  primary: { border: 0, borderRadius: 9, padding: "8px 16px", background: "#111827", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer" },
  secondary: {
    border: "1px solid #d1d5db", borderRadius: 9, padding: "7px 12px", background: "#fff", color: "#111827",
    fontSize: 12.5, fontWeight: 700, cursor: "pointer", justifySelf: "start",
  },
  historyToggle: {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, width: "100%",
    padding: "2px 0", border: 0, background: "transparent", cursor: "pointer", textAlign: "left",
  },
  audit: { listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 6 },
  auditRow: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 4, fontSize: 12.5, color: "#374151", borderTop: "1px solid #f1f2f4", paddingTop: 6 },
} satisfies Record<string, CSSProperties>;
