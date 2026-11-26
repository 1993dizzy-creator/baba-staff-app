"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";
import Container from "@/components/Container";
import { useLanguage } from "@/lib/language-context";
import { notificationText } from "@/lib/text/notifications";
import {
  NOTIFICATION_FILTERS,
  isSafeInternalHref,
  type NotificationFilter,
  type NotificationItem,
} from "@/lib/notifications/types";
import { announceNotificationsChanged, readCachedUserKey } from "@/lib/notifications/client";

type LoadState = "loading" | "ready" | "error" | "unavailable";

const SEVERITY_STYLE: Record<string, CSSProperties> = {
  urgent: { background: "#fef2f2", color: "#b91c1c", border: "1px solid #fecaca" },
  warning: { background: "#fffbeb", color: "#b45309", border: "1px solid #fde68a" },
  normal: { background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb" },
};

function formatTime(value: string, lang: "ko" | "vi") {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(lang === "vi" ? "vi-VN" : "ko-KR", {
    timeZone: "Asia/Ho_Chi_Minh", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

export default function NotificationsPage() {
  const { lang } = useLanguage();
  const t = notificationText[lang];
  const router = useRouter();
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<number | "all" | null>(null);
  const [actionError, setActionError] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const userKeyRef = useRef<string | null>(null);

  const fetchPage = useCallback(async (nextFilter: NotificationFilter, before: number | null) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const query = new URLSearchParams({ filter: nextFilter });
    if (before) query.set("before", String(before));
    try {
      const response = await fetch(`/api/notifications?${query}`, { cache: "no-store", signal: controller.signal });
      const json = await response.json().catch(() => null);
      if (controller.signal.aborted) return null;
      if (response.ok && json?.ok === true && json.available === false) return { unavailable: true as const };
      if (!response.ok || json?.ok !== true || !Array.isArray(json.items)) return { error: true as const };
      return { items: json.items as NotificationItem[], nextBeforeId: (json.nextBeforeId as number | null) ?? null };
    } catch {
      return controller.signal.aborted ? null : { error: true as const };
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, []);

  const loadFirst = useCallback(async (nextFilter: NotificationFilter) => {
    userKeyRef.current = readCachedUserKey();
    setState("loading");
    setActionError("");
    const result = await fetchPage(nextFilter, null);
    if (!result) return;
    if ("unavailable" in result) { setItems([]); setState("unavailable"); return; }
    if ("error" in result) { setState("error"); return; }
    setItems(result.items);
    setNextBeforeId(result.nextBeforeId);
    setState("ready");
  }, [fetchPage]);

  useEffect(() => {
    void loadFirst(filter);
    announceNotificationsChanged();
  }, [filter, loadFirst]);

  useEffect(() => {
    // Another user on this device: never show the previous user's list.
    const onUser = () => {
      if (readCachedUserKey() !== userKeyRef.current) { setItems([]); void loadFirst(filter); }
    };
    const onVisible = () => { if (document.visibilityState === "visible") onUser(); };
    window.addEventListener("baba_user_updated", onUser);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("baba_user_updated", onUser);
      document.removeEventListener("visibilitychange", onVisible);
      requestRef.current?.abort();
    };
  }, [filter, loadFirst]);

  async function loadMore() {
    if (!nextBeforeId || loadingMore) return;
    setLoadingMore(true);
    const result = await fetchPage(filter, nextBeforeId);
    setLoadingMore(false);
    if (!result) return;
    if ("error" in result || "unavailable" in result) { setActionError(t.error); return; }
    setItems((current) => {
      const seen = new Set(current.map((item) => item.id));
      return [...current, ...result.items.filter((item) => !seen.has(item.id))];
    });
    setNextBeforeId(result.nextBeforeId);
  }

  async function postRead(body: Record<string, unknown>) {
    const response = await fetch("/api/notifications/read", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store",
    });
    const json = await response.json().catch(() => null);
    return response.ok && json?.ok === true ? json : null;
  }

  async function markRead(item: NotificationItem) {
    if (item.readAt || busyId) return true;
    setBusyId(item.id);
    setActionError("");
    try {
      const json = await postRead({ id: item.id });
      if (!json) { setActionError(t.actionFailed); return false; }
      const readAt = (json.item as NotificationItem | undefined)?.readAt ?? new Date().toISOString();
      setItems((current) => filter === "unread"
        ? current.filter((entry) => entry.id !== item.id)
        : current.map((entry) => (entry.id === item.id ? { ...entry, readAt } : entry)));
      announceNotificationsChanged();
      return true;
    } catch {
      setActionError(t.actionFailed);
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function markAll() {
    const upToId = items.reduce((max, item) => Math.max(max, item.id), 0);
    if (!upToId || busyId) return;
    setBusyId("all");
    setActionError("");
    try {
      const json = await postRead({ all: true, upToId });
      if (!json) { setActionError(t.actionFailed); return; }
      announceNotificationsChanged();
      await loadFirst(filter);
    } catch {
      setActionError(t.actionFailed);
    } finally {
      setBusyId(null);
    }
  }

  async function openItem(item: NotificationItem) {
    if (!isSafeInternalHref(item.href)) return;
    await markRead(item);
    router.push(item.href);
  }

  const hasUnread = items.some((item) => !item.readAt);

  return (
    <Container>
      <div style={styles.headerRow}>
        <h1 style={styles.title}>{t.title}</h1>
        {state === "ready" && hasUnread ? (
          <button type="button" style={styles.secondaryButton} disabled={busyId !== null} onClick={markAll}>
            {t.markAllRead}
          </button>
        ) : null}
      </div>

      <nav style={styles.filters} aria-label={t.title}>
        {NOTIFICATION_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            style={{ ...styles.filter, ...(filter === value ? styles.filterActive : null) }}
          >
            {t.filters[value]}
          </button>
        ))}
      </nav>

      {actionError ? <p role="alert" style={styles.error}>{actionError}</p> : null}

      {state === "loading" ? <p style={styles.status}>{t.loading}</p> : null}
      {state === "unavailable" ? <p style={styles.status}>{t.notInstalled}</p> : null}
      {state === "error" ? (
        <div style={styles.errorBox} role="alert">
          <span>{t.error}</span>
          <button type="button" style={styles.secondaryButton} onClick={() => void loadFirst(filter)}>{t.retry}</button>
        </div>
      ) : null}
      {state === "ready" && items.length === 0 ? <p style={styles.status}>{t.empty}</p> : null}

      {state === "ready" && items.length > 0 ? (
        <ul style={styles.list}>
          {items.map((item) => {
            const unread = !item.readAt;
            const title = lang === "vi" ? item.titleVi : item.titleKo;
            const body = lang === "vi" ? item.bodyVi : item.bodyKo;
            const canOpen = isSafeInternalHref(item.href);
            return (
              <li key={item.id} style={{ ...styles.card, ...(unread ? styles.cardUnread : null) }}>
                <div style={styles.metaRow}>
                  <span style={{ ...styles.chip, ...(SEVERITY_STYLE[item.severity] ?? SEVERITY_STYLE.normal) }}>
                    {t.severity[item.severity] ?? item.severity}
                  </span>
                  <span style={styles.domain}>{t.domains[item.domain] ?? item.domain}</span>
                  <span style={{ ...styles.chip, ...(item.status === "open" ? styles.open : styles.resolved) }}>
                    {t.status[item.status]}
                  </span>
                  {unread ? <span style={styles.unreadDot} aria-label={t.unread} /> : null}
                  <span style={styles.time}>{t.occurredAt} {formatTime(item.firstObservedAt, lang)}</span>
                </div>
                <div style={{ ...styles.itemTitle, fontWeight: unread ? 800 : 600 }}>{title}</div>
                {body ? <div style={styles.body}>{body}</div> : null}
                <div style={styles.actions}>
                  {unread ? (
                    <button type="button" style={styles.secondaryButton} disabled={busyId !== null} onClick={() => void markRead(item)}>
                      {t.markRead}
                    </button>
                  ) : null}
                  {canOpen ? (
                    <button type="button" style={styles.primaryButton} disabled={busyId !== null} onClick={() => void openItem(item)}>
                      {t.open}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {state === "ready" && nextBeforeId ? (
        <button type="button" style={styles.moreButton} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? t.loading : t.loadMore}
        </button>
      ) : null}
    </Container>
  );
}

const styles = {
  headerRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 },
  title: { margin: 0, fontSize: 20, fontWeight: 800, color: "#111827" },
  filters: { display: "flex", borderBottom: "1px solid #e5e7eb", marginBottom: 12 },
  filter: {
    flex: 1, minWidth: 0, padding: "12px 0 10px", fontSize: 14, fontWeight: 600, color: "#9ca3af",
    background: "transparent", border: 0, borderBottom: "3px solid transparent", whiteSpace: "nowrap", cursor: "pointer",
  },
  filterActive: { fontWeight: 800, color: "#111827", borderBottom: "3px solid #111827" },
  status: { padding: "28px 0", textAlign: "center", color: "#6b7280", fontSize: 14 },
  error: { color: "#b91c1c", fontSize: 13, fontWeight: 700, margin: "0 0 10px" },
  errorBox: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: 14, borderRadius: 14,
    background: "#fef2f2", color: "#b91c1c", fontSize: 14, fontWeight: 700, border: "1px solid #fecaca",
  },
  list: { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 },
  card: {
    background: "#fff", border: "1px solid #d8dce3", borderRadius: 14, padding: 14,
    boxShadow: "0 1px 3px rgba(15,23,42,0.05)", minWidth: 0,
  },
  cardUnread: { borderColor: "#111827", background: "#fafafa" },
  metaRow: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginBottom: 6 },
  chip: { fontSize: 11, fontWeight: 800, borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" },
  open: { background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe" },
  resolved: { background: "#ecfdf5", color: "#047857", border: "1px solid #a7f3d0" },
  domain: { fontSize: 12, fontWeight: 700, color: "#4b5563" },
  unreadDot: { width: 8, height: 8, borderRadius: 4, background: "#ef4444", display: "inline-block" },
  time: { marginLeft: "auto", fontSize: 12, color: "#6b7280", whiteSpace: "nowrap" },
  itemTitle: { fontSize: 15, color: "#111827", wordBreak: "break-word" },
  body: { marginTop: 4, fontSize: 13, color: "#374151", lineHeight: 1.5, wordBreak: "break-word" },
  actions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 },
  primaryButton: {
    border: 0, borderRadius: 10, padding: "8px 12px", background: "#111827", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer",
  },
  secondaryButton: {
    border: "1px solid #d1d5db", borderRadius: 10, padding: "8px 12px", background: "#fff", color: "#111827",
    fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
  },
  moreButton: {
    width: "100%", marginTop: 12, border: "1px solid #d1d5db", borderRadius: 12, padding: "12px 0", background: "#fff",
    color: "#111827", fontSize: 14, fontWeight: 700, cursor: "pointer",
  },
} satisfies Record<string, CSSProperties>;
