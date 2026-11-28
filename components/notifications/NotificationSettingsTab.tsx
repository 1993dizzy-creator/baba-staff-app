"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
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
type GroupKey = keyof Group;
// baseRevision = the saved revision this draft was started from; it is sent as expectedRevision so a
// draft kept across a reload can never silently overwrite another admin's newer save.
// pushEnabled is undefined while the 01-B push DB is not applied (the channel is then shown as
// pending and never sent, so the 01-A save contract is unchanged).
type Draft = { enabled: boolean; inAppEnabled: boolean; pushEnabled?: boolean; groups: Group[]; userIds: number[]; baseRevision: number };
type LoadState = "loading" | "ready" | "error" | "unavailable" | "forbidden";

// One icon per notification type; a new type without its own entry falls back to its domain, then to a bell,
// so a future type reuses the same card without extra UI work.
const TYPE_ICONS: Record<string, string> = {
  "attendance.leave_request_pending": "🗓️",
  "inventory.pos_deduction_pending": "📦",
};
const DOMAIN_ICONS: Record<string, string> = { attendance: "🗓️", inventory: "📦", payroll: "💵", ledger: "📒", pos: "🧾" };
const typeIcon = (code: string) => TYPE_ICONS[code] ?? DOMAIN_ICONS[code.split(".")[0]] ?? "🔔";

const toDraft = (type: NotificationTypePolicy): Draft => ({
  enabled: type.enabled,
  inAppEnabled: type.inAppEnabled,
  ...(typeof type.pushEnabled === "boolean" ? { pushEnabled: type.pushEnabled } : {}),
  groups: (type.rules.groups ?? []).map((group) => ({
    roles: [...(group.roles ?? [])], parts: [...(group.parts ?? [])],
  })),
  userIds: [...(type.rules.userIds ?? [])],
  baseRevision: type.revision,
});
const sameSettings = (a: Draft | undefined, b: Draft | undefined) =>
  !!a && !!b && JSON.stringify([a.enabled, a.inAppEnabled, a.pushEnabled ?? null, a.groups, a.userIds])
    === JSON.stringify([b.enabled, b.inAppEnabled, b.pushEnabled ?? null, b.groups, b.userIds]);
const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
const partLabel = (part: string | null) => (part ? getPartMeta(part).label : "-");
const toggleKey = (set: Set<string>, key: string) => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
};
const normalize = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().trim();

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
  // Only one role/part checklist is open at a time ("{code}:{groupIndex}:{roles|parts}").
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  // The people search only filters what is listed; it never touches draft.userIds.
  const [search, setSearch] = useState<Record<string, string>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  // Saved state as of the previous load: a draft that still differs from it is unsaved work and
  // survives the reload (e.g. after saving another type); an untouched draft follows the server.
  const savedRef = useRef<Record<string, Draft>>({});
  // The type whose save request is in flight: its draft is frozen until the response is handled, so an
  // edit made meanwhile can neither be lost by the reload nor be mistaken for the saved copy.
  const savingRef = useRef<string | null>(null);

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

  const update = (code: string, change: (draft: Draft) => Draft) => {
    if (savingRef.current === code) return;
    setDrafts((current) => (current[code] ? { ...current, [code]: change(current[code]) } : current));
  };

  async function save(type: NotificationTypePolicy) {
    const draft = drafts[type.code];
    if (!draft || saving || savingRef.current) return;
    savingRef.current = type.code;
    setSaving(type.code);
    setMessages((current) => ({ ...current, [type.code]: { ok: true, text: "" } }));
    try {
      const response = await fetch("/api/admin/notification-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          typeCode: type.code, expectedRevision: draft.baseRevision, enabled: draft.enabled, inAppEnabled: draft.inAppEnabled,
          ...(typeof draft.pushEnabled === "boolean" ? { pushEnabled: draft.pushEnabled } : {}),
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
      savingRef.current = null;
      setSaving(null);
    }
  }

  function discard(code: string) {
    if (!saved[code] || savingRef.current) return;
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

  const roleLabel = (role: string) => getEmployeeRoleLabel(role, lang);
  const groupSummary = (group: Group) => {
    const labels = [...group.roles.map(roleLabel), ...group.parts.map((part) => partLabel(part))];
    return labels.length ? labels.join(" · ") : t.any;
  };
  const listSummary = (values: string[], display: (value: string) => string) =>
    values.length ? values.map(display).join(", ") : t.any;

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
        const locked = saving === type.code;
        const open = openTypes.has(type.code);
        const peopleOpen = openPeople.has(type.code);
        const helpOpen = openHelp.has(type.code);
        const conditions = [
          ...draft.groups.map(groupSummary),
          ...(draft.userIds.length ? [t.peopleCount.replace("{n}", String(draft.userIds.length))] : []),
        ];
        const conditionText = conditions.length ? conditions.join(" / ") : t.noConditions;
        const picked = staff.filter((member) => draft.userIds.includes(member.id));
        const query = normalize(search[type.code] ?? "");
        const listed = query ? staff.filter((member) => normalize(member.name).includes(query)) : staff;
        const setGroupValues = (index: number, key: GroupKey, values: (current: string[]) => string[]) =>
          update(type.code, (d) => ({
            ...d,
            groups: d.groups.map((g, i) => (i === index ? { ...g, [key]: values(g[key]) } : g)),
          }));
        return (
          <div key={type.code} style={styles.card} data-testid={`notification-type-${type.code}`} data-enabled={draft.enabled}>
            <div style={styles.cardHeader}>
              <button
                type="button"
                style={styles.headerButton}
                aria-expanded={open}
                data-testid="notification-details-toggle"
                onClick={() => setOpenTypes((current) => toggleKey(current, type.code))}
              >
                <span style={{ ...styles.typeIcon, ...(draft.enabled ? null : styles.typeIconOff) }} aria-hidden="true">
                  {typeIcon(type.code)}
                </span>
                <span style={styles.headerText}>
                  <span style={styles.titleRow}>
                    <span style={{ ...styles.cardTitle, ...(draft.enabled ? null : styles.cardTitleOff) }}>
                      {t.typeNames[type.code] ?? type.code}
                    </span>
                    {dirty ? <span style={styles.unsavedBadge}>{t.unsaved}</span> : null}
                  </span>
                  <span style={styles.summary} data-testid="notification-summary">
                    {draft.enabled ? (
                      <>
                        {conditionText}
                        <span style={styles.summaryCount}> · {t.recipientsCount.replace("{n}", String(recipientCount))}</span>
                      </>
                    ) : (
                      <>
                        <span style={styles.offTag}>{t.offNote}</span>
                        <span style={styles.summaryOff}>{conditionText}</span>
                      </>
                    )}
                  </span>
                </span>
                <span style={styles.headerChevron}><ChevronIcon open={open} /></span>
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={draft.enabled}
                aria-label={t.enabled}
                title={draft.enabled ? t.on : t.off}
                disabled={locked}
                style={styles.switchButton}
                onClick={() => update(type.code, (d) => ({ ...d, enabled: !d.enabled }))}
              >
                <span aria-hidden="true" style={{ ...styles.switchTrack, ...(draft.enabled ? styles.switchTrackOn : null) }}>
                  <span style={{ ...styles.switchKnob, ...(draft.enabled ? styles.switchKnobOn : null) }} />
                </span>
              </button>
            </div>

            {open ? (
              // A disabled fieldset freezes every control of this card while its save is in flight.
              <fieldset disabled={locked} style={styles.body} data-testid="notification-body">
                <Section title={t.channels}>
                  <div style={styles.row}>
                    <label style={styles.checkRow}>
                      <input
                        type="checkbox"
                        style={styles.checkbox}
                        checked={draft.inAppEnabled}
                        onChange={(event) => update(type.code, (d) => ({ ...d, inAppEnabled: event.target.checked }))}
                      />
                      {t.inApp}
                    </label>
                    {typeof draft.pushEnabled === "boolean" ? (
                      <label style={styles.checkRow}>
                        <input
                          type="checkbox"
                          style={styles.checkbox}
                          checked={draft.pushEnabled}
                          onChange={(event) => update(type.code, (d) => ({ ...d, pushEnabled: event.target.checked }))}
                        />
                        {t.push}
                      </label>
                    ) : (
                      <span style={styles.mutedNote}>{t.pushPending}</span>
                    )}
                  </div>
                  {typeof draft.pushEnabled === "boolean" ? <p style={styles.mutedNote}>{t.pushNote}</p> : null}
                </Section>

                <Section
                  title={t.groups}
                  aside={
                    <button
                      type="button"
                      style={styles.helpButton}
                      aria-expanded={helpOpen}
                      onClick={() => setOpenHelp((current) => toggleKey(current, type.code))}
                    >
                      {t.conditionHelp}
                      <ChevronIcon open={helpOpen} size={12} />
                    </button>
                  }
                >
                  <p style={styles.help}>
                    {t.accessCeiling}: {type.accessRoles.map(roleLabel).join(", ")}
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
                          onClick={() => {
                            setOpenPicker(null);
                            update(type.code, (d) => ({ ...d, groups: d.groups.filter((_, i) => i !== index) }));
                          }}
                        >
                          {t.removeGroup}
                        </button>
                      </div>
                      {([
                        ["roles", t.roles, NOTIFICATION_RULE_ROLES as readonly string[], roleLabel],
                        ["parts", t.parts, NOTIFICATION_RULE_PARTS as readonly string[], (v: string) => partLabel(v)],
                      ] as const).map(([key, label, values, display]) => {
                        const pickerKey = `${type.code}:${index}:${key}`;
                        const pickerOpen = openPicker === pickerKey;
                        const all = group[key].length === 0;
                        return (
                          <div key={key} style={styles.attr} data-testid={`rule-${key}`}>
                            <button
                              type="button"
                              style={styles.attrRow}
                              aria-expanded={pickerOpen}
                              data-testid={`rule-${key}-toggle`}
                              onClick={() => setOpenPicker((current) => (current === pickerKey ? null : pickerKey))}
                            >
                              <span style={styles.attrLabel}>{label}</span>
                              <span style={{ ...styles.attrValue, ...(all ? styles.attrValueAll : null) }} data-testid={`rule-${key}-summary`}>
                                {listSummary(group[key], display)}
                              </span>
                              <ChevronIcon open={pickerOpen} size={12} />
                            </button>
                            {pickerOpen ? (
                              <div style={styles.checklist}>
                                <CheckItem
                                  label={t.selectAll}
                                  checked={all}
                                  wide
                                  onChange={() => setGroupValues(index, key, () => [])}
                                />
                                {values.map((value) => (
                                  <CheckItem
                                    key={value}
                                    label={display(value)}
                                    checked={group[key].includes(value)}
                                    onChange={() => setGroupValues(index, key, (current) => toggle(current, value))}
                                  />
                                ))}
                                <p style={{ ...styles.help, gridColumn: "1 / -1" }}>{t.emptyMeansAll}</p>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  <button
                    type="button"
                    style={styles.addButton}
                    disabled={draft.groups.length >= 20}
                    onClick={() => update(type.code, (d) => ({ ...d, groups: [...d.groups, { roles: [], parts: [] }] }))}
                  >
                    + {t.addGroup}
                  </button>
                </Section>

                <div style={styles.section}>
                  <button
                    type="button"
                    style={styles.subDisclosure}
                    aria-expanded={peopleOpen}
                    data-testid="notification-people-toggle"
                    onClick={() => setOpenPeople((current) => toggleKey(current, type.code))}
                  >
                    <span style={styles.sectionTitle}>{t.people}</span>
                    <span style={styles.subDisclosureRight}>
                      <span style={styles.subDisclosureNames} data-testid="notification-people-summary">
                        {picked.length
                          ? `${t.selectedCount.replace("{n}", String(draft.userIds.length))} · ${picked.map((member) => member.name).join(", ")}`
                          : t.noneSelected}
                      </span>
                      <ChevronIcon open={peopleOpen} />
                    </span>
                  </button>
                  {peopleOpen ? (
                    <div style={styles.peopleBody}>
                      <p style={styles.help}>{t.peopleHelp}</p>
                      <input
                        type="search"
                        style={styles.search}
                        placeholder={t.searchPlaceholder}
                        aria-label={t.searchPlaceholder}
                        value={search[type.code] ?? ""}
                        onChange={(event) => setSearch((current) => ({ ...current, [type.code]: event.target.value }))}
                      />
                      <div style={styles.peopleList} data-testid="notification-people-list">
                        {listed.length === 0 ? <p style={styles.emptyLine}>{t.noMatch}</p> : null}
                        {listed.map((member) => {
                          const inCeiling = member.role !== null && type.accessRoles.includes(member.role);
                          const on = draft.userIds.includes(member.id);
                          const blocked = !inCeiling && !on;
                          return (
                            <label key={member.id} style={{ ...styles.personRow, ...(on ? styles.personRowOn : null), ...(blocked ? styles.personRowBlocked : null) }}>
                              <input
                                type="checkbox"
                                style={styles.checkbox}
                                checked={on}
                                disabled={blocked}
                                onChange={() => update(type.code, (d) => ({
                                  ...d,
                                  userIds: d.userIds.includes(member.id) ? d.userIds.filter((id) => id !== member.id) : [...d.userIds, member.id],
                                }))}
                              />
                              <span style={styles.personName}>{member.name}</span>
                              <span style={styles.personMeta}>
                                {inCeiling ? `${roleLabel(member.role ?? "")} · ${partLabel(member.part)}` : t.noAccess}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div style={styles.preview}>
                  <div style={styles.previewTitle}>
                    {t.preview} <span style={styles.previewCount}>{recipientCount}</span>
                  </div>
                  <div style={styles.previewNames} data-testid="recipient-preview">
                    {draft.enabled && recipients.length > 0
                      ? recipients.map((member) => member.name).join(", ")
                      : t.previewNone}
                  </div>
                  <p style={styles.help}>{t.applyNote}</p>
                </div>
              </fieldset>
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
                {message.ok ? "✓ " : ""}{message.text}
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
            <span style={styles.historyTitle}><span aria-hidden="true">🗂️</span> {t.history}</span>
            <span style={styles.subDisclosureRight}>
              <span style={styles.countPill}>{audit.length}</span>
              <ChevronIcon open={historyOpen} />
            </span>
          </button>
          {historyOpen ? (
            <ul style={styles.audit} data-testid="notification-history-list">
              {audit.map((entry) => (
                <li key={entry.id} style={styles.auditRow}>
                  <span style={styles.auditMain}>
                    <span aria-hidden="true">{typeIcon(entry.typeCode)}</span>
                    {t.typeNames[entry.typeCode] ?? entry.typeCode} · {t.revision} {entry.revision}
                  </span>
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

function Section(props: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionHead}>
        <span style={styles.sectionTitle}>{props.title}</span>
        {props.aside}
      </div>
      {props.children}
    </div>
  );
}

function CheckItem(props: { label: string; checked: boolean; wide?: boolean; onChange: () => void }) {
  return (
    <label style={{ ...styles.checkItem, ...(props.checked ? styles.checkItemOn : null), ...(props.wide ? styles.checkItemWide : null) }}>
      <input type="checkbox" style={styles.checkbox} checked={props.checked} onChange={props.onChange} />
      <span style={styles.checkItemText}>{props.label}</span>
    </label>
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
  cardHeader: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  headerButton: {
    flex: 1, minWidth: 0, display: "grid", gridTemplateColumns: "32px minmax(0, 1fr) 14px", alignItems: "center", gap: 10,
    padding: "2px 0", border: 0, background: "transparent", textAlign: "left", color: "#111827", cursor: "pointer",
  },
  typeIcon: {
    width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 9,
    borderWidth: 1, borderStyle: "solid", borderColor: "#e5e7eb", background: "#fff", fontSize: 16, lineHeight: 1,
  },
  typeIconOff: { filter: "grayscale(1)", opacity: 0.55 },
  headerText: { display: "grid", gap: 2, minWidth: 0 },
  headerChevron: { display: "flex", justifyContent: "center", color: "#6b7280" },
  titleRow: { display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" },
  cardTitle: { fontSize: 14.5, fontWeight: 800, color: "#111827", lineHeight: 1.3 },
  cardTitleOff: { color: "#6b7280" },
  summary: { fontSize: 12, color: "#4b5563", lineHeight: 1.4, wordBreak: "break-word" },
  summaryCount: { color: "#9ca3af", whiteSpace: "nowrap" },
  summaryOff: { color: "#9ca3af" },
  offTag: {
    display: "inline-block", marginRight: 6, padding: "0 6px", borderRadius: 999, background: "#f3f4f6", color: "#6b7280",
    fontSize: 11, fontWeight: 800, lineHeight: "17px",
  },
  unsavedBadge: {
    padding: "1px 7px", borderRadius: 999, background: "#fffbeb", color: "#b45309",
    borderWidth: 1, borderStyle: "solid", borderColor: "#fde68a", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap",
  },
  // Same sliding switch as the employee settings toggles (green when on).
  switchButton: {
    display: "flex", alignItems: "center", gap: 6, flexShrink: 0, minHeight: 36, padding: "0 0 0 8px",
    borderWidth: "0 0 0 1px", borderStyle: "solid", borderColor: "#f1f2f4", background: "transparent", cursor: "pointer",
  },
  switchTrack: {
    position: "relative", display: "inline-block", flexShrink: 0, width: 40, height: 22, borderRadius: 999,
    background: "#d1d5db", transition: "background-color 0.18s ease",
  },
  switchTrackOn: { background: "#16a34a" },
  switchKnob: {
    position: "absolute", top: 2, left: 2, width: 18, height: 18, borderRadius: 999, background: "#fff",
    boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "transform 0.18s ease",
  },
  switchKnobOn: { transform: "translateX(18px)" },
  body: {
    margin: "10px 0 0", padding: 0, borderWidth: "1px 0 0", borderStyle: "solid", borderColor: "#f1f2f4", minWidth: 0, display: "grid", gap: 0,
  },
  section: { display: "grid", gap: 6, padding: "9px 0", borderBottom: "1px solid #f1f2f4", minWidth: 0 },
  sectionHead: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },
  sectionTitle: { fontSize: 12.5, fontWeight: 800, color: "#111827" },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 12px" },
  checkRow: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: "#111827" },
  checkbox: { width: 16, height: 16, margin: 0, flexShrink: 0, accentColor: "#111827" },
  mutedNote: { fontSize: 11.5, color: "#9ca3af" },
  helpButton: { display: "inline-flex", alignItems: "center", gap: 3, border: 0, background: "transparent", padding: "2px 0", color: "#6b7280", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
  help: { fontSize: 11.5, color: "#6b7280", lineHeight: 1.45, margin: 0 },
  helpBox: { background: "#f9fafb", borderRadius: 8, padding: "8px 10px", display: "grid", gap: 4 },
  helpLine: { fontSize: 11.5, color: "#4b5563", lineHeight: 1.45, margin: 0 },
  group: {
    borderWidth: 1, borderStyle: "solid", borderColor: "#e5e7eb", borderRadius: 10, padding: "6px 10px 4px", display: "grid", minWidth: 0,
  },
  groupHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", minHeight: 24 },
  groupTitle: { fontSize: 12, fontWeight: 800, color: "#374151" },
  linkButton: { border: 0, background: "transparent", color: "#9ca3af", fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: "2px 0" },
  attr: { borderTop: "1px solid #f1f2f4", minWidth: 0 },
  attrRow: {
    display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) 12px", alignItems: "center", gap: 8, width: "100%",
    minHeight: 36, padding: "6px 0", border: 0, background: "transparent", color: "#6b7280", textAlign: "left", cursor: "pointer",
  },
  attrLabel: { fontSize: 11.5, fontWeight: 700, color: "#6b7280", whiteSpace: "nowrap" },
  attrValue: { fontSize: 12.5, fontWeight: 800, color: "#111827", textAlign: "right", lineHeight: 1.35, overflowWrap: "anywhere" },
  attrValueAll: { color: "#6b7280", fontWeight: 700 },
  checklist: {
    display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6, padding: "2px 0 8px", minWidth: 0,
  },
  checkItem: {
    display: "flex", alignItems: "center", gap: 7, minWidth: 0, minHeight: 34, padding: "6px 8px", borderRadius: 8,
    borderWidth: 1, borderStyle: "solid", borderColor: "#e5e7eb", background: "#fff", color: "#374151",
    fontSize: 12.5, fontWeight: 700, lineHeight: 1.25, cursor: "pointer",
  },
  checkItemOn: { borderColor: "#111827", background: "#f9fafb", color: "#111827" },
  checkItemWide: { gridColumn: "1 / -1" },
  checkItemText: { minWidth: 0, overflowWrap: "anywhere" },
  addButton: {
    justifySelf: "start", border: 0, background: "transparent", padding: "2px 0", color: "#374151",
    fontSize: 12.5, fontWeight: 700, cursor: "pointer",
  },
  subDisclosure: {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, width: "100%", minWidth: 0,
    padding: 0, border: 0, background: "transparent", cursor: "pointer", textAlign: "left",
  },
  subDisclosureRight: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  subDisclosureNames: { fontSize: 12, color: "#4b5563", textAlign: "right", wordBreak: "break-word" },
  peopleBody: { display: "grid", gap: 6, minWidth: 0 },
  search: {
    width: "100%", minWidth: 0, height: 34, padding: "6px 10px", borderRadius: 8, borderWidth: 1, borderStyle: "solid",
    borderColor: "#d1d5db", fontSize: 13, color: "#111827", background: "#fff", boxSizing: "border-box",
  },
  peopleList: {
    display: "grid", maxHeight: 280, overflowY: "auto", borderWidth: 1, borderStyle: "solid", borderColor: "#e5e7eb",
    borderRadius: 10, minWidth: 0,
  },
  personRow: {
    display: "grid", gridTemplateColumns: "16px minmax(0, 1fr) auto", alignItems: "center", gap: 8, minHeight: 38,
    padding: "6px 10px", borderBottom: "1px solid #f1f2f4", fontSize: 13, color: "#374151", cursor: "pointer",
  },
  personRowOn: { background: "#f9fafb", color: "#111827" },
  personRowBlocked: { opacity: 0.45, cursor: "not-allowed" },
  personName: { minWidth: 0, fontWeight: 700, overflowWrap: "anywhere" },
  personMeta: { fontSize: 11.5, color: "#6b7280", textAlign: "right", maxWidth: 150, overflowWrap: "anywhere" },
  emptyLine: { margin: 0, padding: "10px", fontSize: 12, color: "#6b7280", textAlign: "center" },
  preview: { display: "grid", gap: 4, padding: "9px 0 0" },
  previewTitle: { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 800, color: "#111827" },
  previewCount: {
    minWidth: 20, padding: "0 6px", borderRadius: 999, background: "#111827", color: "#fff", fontSize: 11, fontWeight: 800,
    lineHeight: "18px", textAlign: "center",
  },
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
  historyTitle: { fontSize: 14.5, fontWeight: 800, color: "#111827" },
  countPill: { padding: "0 7px", borderRadius: 999, background: "#f3f4f6", color: "#6b7280", fontSize: 11.5, fontWeight: 800, lineHeight: "18px" },
  audit: { listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 6 },
  auditRow: { display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 4, fontSize: 12.5, color: "#374151", borderTop: "1px solid #f1f2f4", paddingTop: 6 },
  auditMain: { display: "inline-flex", gap: 6, alignItems: "center", fontWeight: 700 },
} satisfies Record<string, CSSProperties>;
