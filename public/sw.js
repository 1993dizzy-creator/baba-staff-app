/* BABA Web Push service worker (BABA-NOTIFICATION-01B).
 *
 * Push display and click only. There is deliberately NO fetch handler: no page, API, auth or
 * business response is intercepted or cached, and the app's normal network/update behavior is
 * unchanged (offline caching is out of scope). Registered only after a staff member turns device
 * push on (explicit click), at scope "/" with updateViaCache "none".
 *
 * - push: shows the generic KO/VI text from the server payload (no sensitive data is ever sent).
 *   The same event always uses the same tag, so a repeated/duplicate delivery replaces the shown
 *   notification silently instead of alerting twice. Receiving a push never marks anything read.
 * - notificationclick: opens /notifications/open?id=N only (an in-app page that re-checks the
 *   recipient and permission on the server before moving to the business screen).
 * - pushsubscriptionchange: re-registers the renewed subscription for the signed-in session.
 */
"use strict";

const OPEN_URL = /^\/notifications\/open\?id=[1-9][0-9]{0,15}$/;
const TAG = /^baba-n-[1-9][0-9]{0,15}$/;
const FALLBACK = {
  title: "BABA",
  body: "새 업무 알림이 있습니다. / Có thông báo công việc mới.",
};

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function readPayload(event) {
  try {
    const data = event.data ? event.data.json() : null;
    if (!data || data.v !== 1 || typeof data.title !== "string" || typeof data.body !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

async function updateBadge(count) {
  const nav = self.navigator;
  if (!nav || typeof nav.setAppBadge !== "function") return;
  try {
    if (Number.isInteger(count) && count > 0) await nav.setAppBadge(Math.min(count, 99));
    else if (count === 0 && typeof nav.clearAppBadge === "function") await nav.clearAppBadge();
  } catch {
    // badge support is optional
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const data = readPayload(event);
    const title = data ? data.title.slice(0, 80) : FALLBACK.title;
    const body = data ? data.body.slice(0, 160) : FALLBACK.body;
    const url = data && typeof data.url === "string" && OPEN_URL.test(data.url) ? data.url : "/notifications";
    const tag = data && typeof data.tag === "string" && TAG.test(data.tag) ? data.tag : "baba-notification";
    if (data && Number.isInteger(data.badge)) await updateBadge(data.badge);
    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: false,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url;
  const path = typeof raw === "string" && OPEN_URL.test(raw) ? raw : "/notifications";
  const target = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try {
        if (typeof client.navigate === "function") {
          const navigated = await client.navigate(target);
          if (navigated) { await navigated.focus(); return; }
        }
        await client.focus();
        client.postMessage({ type: "baba-push-open", url: path });
        return;
      } catch {
        // fall through to a new window
      }
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const previous = event.oldSubscription;
    let next = event.newSubscription;
    const key = previous && previous.options ? previous.options.applicationServerKey : null;
    if (!next && key) next = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    if (!next || !previous) return;
    await fetch("/api/notifications/push", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "subscribe", subscription: next.toJSON(), oldEndpoint: previous.endpoint }),
    });
  })().catch(() => undefined));
});
