"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/language-context";
import {
  getNotificationSummary,
  getServerNotificationSummary,
  readCachedUserKey,
  subscribeNotificationSummary,
} from "@/lib/notifications/client";
import { setAppBadgeCount, syncPushDevice } from "@/lib/notifications/push-client";

// Invisible 01-B helper in the protected layout:
// - reconciles an existing browser push subscription with the signed-in user on start and on every
//   user change (another account's subscription is revoked + unsubscribed);
// - mirrors the existing unread count onto the home-screen icon badge (supported browsers only);
// - follows a push click delivered to an already open window.
// It never asks for permission, never registers a worker and renders nothing.
export default function PushDeviceSync() {
  const router = useRouter();
  const { lang } = useLanguage();
  const summary = useSyncExternalStore(subscribeNotificationSummary, getNotificationSummary, getServerNotificationSummary);

  useEffect(() => {
    // baba_user_updated also fires for routine profile refreshes: only a different user re-syncs.
    // A language change re-runs this effect (the device's push language follows the app).
    // syncPushDevice itself reuses a recent result across tabs and sends nothing without a subscription.
    let lastUser = readCachedUserKey();
    const run = () => { void syncPushDevice(lang).catch(() => undefined); };
    const onUser = () => {
      const user = readCachedUserKey();
      if (user === lastUser) return;
      lastUser = user;
      run();
    };
    const onStorage = (event: StorageEvent) => { if (event.key === "baba_user") onUser(); };
    run();
    window.addEventListener("baba_user_updated", onUser);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("baba_user_updated", onUser);
      window.removeEventListener("storage", onStorage);
    };
  }, [lang]);

  useEffect(() => {
    if (summary.available !== true || typeof summary.unreadCount !== "number") {
      if (summary.userKey === null) setAppBadgeCount(null);
      return;
    }
    setAppBadgeCount(summary.unreadCount);
  }, [summary.available, summary.unreadCount, summary.userKey]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type === "baba-push-open" && typeof data.url === "string" && /^\/notifications\/open\?id=[1-9]\d{0,15}$/.test(data.url)) {
        router.push(data.url);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);

  return null;
}
