"use client";

import { Component, useEffect, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useLanguage } from "@/lib/language-context";
import { notificationText } from "@/lib/text/notifications";
import { formatUnreadBadge } from "@/lib/notifications/types";
import {
  NOTIFICATION_POLL_MS,
  NOTIFICATIONS_CHANGED_EVENT,
  getNotificationSummary,
  getServerNotificationSummary,
  refreshNotificationSummary,
  subscribeNotificationSummary,
  syncNotificationUser,
} from "@/lib/notifications/client";

function Bell() {
  const { lang } = useLanguage();
  const t = notificationText[lang];
  const summary = useSyncExternalStore(subscribeNotificationSummary, getNotificationSummary, getServerNotificationSummary);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const visible = () => document.visibilityState === "visible";
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const start = () => {
      stop();
      if (!visible()) return;
      timer = setInterval(() => { if (visible()) void refreshNotificationSummary(); }, NOTIFICATION_POLL_MS);
    };
    const onVisibility = () => {
      if (visible()) { void refreshNotificationSummary(); start(); } else stop();
    };
    const onUserChange = () => { syncNotificationUser(); void refreshNotificationSummary(); };
    const onChanged = () => { void refreshNotificationSummary(); };
    const onStorage = (event: StorageEvent) => { if (event.key === "baba_user") onUserChange(); };

    void refreshNotificationSummary();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("baba_user_updated", onUserChange);
    window.addEventListener("storage", onStorage);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("baba_user_updated", onUserChange);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    };
  }, []);

  // Not installed (or not known yet): render nothing so the header stays exactly as before.
  if (summary.available !== true) return null;
  const badge = formatUnreadBadge(summary.unreadCount);
  const label = summary.failed
    ? `${t.bellLabel} · ${t.bellUnavailable}`
    : badge ? `${t.bellLabel} ${badge}` : t.bellLabel;

  return (
    <Link
      href="/notifications"
      aria-label={label}
      title={label}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 6,
        color: "#ffffff",
        textDecoration: "none",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M18 16V11C18 7.69 15.31 5 12 5C8.69 5 6 7.69 6 11V16L4 18H20L18 16Z" stroke="#ffffff" strokeWidth="2" strokeLinejoin="round" />
        <path d="M10 20.5C10.4 21.4 11.1 22 12 22C12.9 22 13.6 21.4 14 20.5" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" />
        <path d="M12 3V5" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {badge ? (
        <span
          data-testid="notification-badge"
          style={{
            position: "absolute",
            top: 0,
            right: -4,
            minWidth: 18,
            height: 18,
            padding: "0 5px",
            borderRadius: 9,
            background: summary.failed ? "#6b7280" : "#ef4444",
            color: "#ffffff",
            fontSize: 11,
            fontWeight: 800,
            lineHeight: "18px",
            textAlign: "center",
            boxSizing: "border-box",
            border: "1.5px solid #111827",
          }}
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

// A notification failure must never take the header (or the page) down with it.
class BellBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.warn("Notification bell disabled", (error as Error)?.name); }
  render() { return this.state.failed ? null : this.props.children; }
}

export default function NotificationBell() {
  return (
    <BellBoundary>
      <Bell />
    </BellBoundary>
  );
}
