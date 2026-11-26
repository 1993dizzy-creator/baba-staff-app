// Client contracts: summary store (no duplicate requests, failure != 0, user switch / logout
// reset, not-installed hides the bell), badge formatting, internal href guard, and static
// guarantees on the header, bell, center and existing leave popup / bottom nav.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatUnreadBadge, isSafeInternalHref } from '../lib/notifications/types.ts';

function browser() {
  const store = new Map();
  const listeners = new Map();
  globalThis.window = {
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    addEventListener: (n, f) => listeners.set(n, f), removeEventListener: () => {}, dispatchEvent: e => listeners.get(e.type)?.(e),
  };
  const login = id => store.set('baba_user', JSON.stringify({ id, role: 'staff' }));
  return { store, login };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('summary store: one request in flight, failure keeps unknown, user switch and logout reset', async () => {
  const { store, login } = browser();
  const client = await import(`../lib/notifications/client.ts?${Date.now()}`);
  let calls = 0; let pending;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(url, '/api/notifications/summary'); assert.equal(init.cache, 'no-store');
    pending = deferred(); return pending.promise;
  };
  login(8);
  const a = client.refreshNotificationSummary(), b = client.refreshNotificationSummary();
  assert.equal(calls, 1, 'concurrent refreshes share one request');
  pending.resolve(reply(200, { ok: true, available: true, unreadCount: 3 }));
  await Promise.all([a, b]);
  assert.deepEqual(client.getNotificationSummary(), { userKey: '8', available: true, unreadCount: 3, failed: false });

  const failing = client.refreshNotificationSummary();
  pending.resolve(reply(503, { ok: false, code: 'NOTIFICATIONS_UNAVAILABLE' }));
  await failing;
  assert.deepEqual(client.getNotificationSummary(), { userKey: '8', available: true, unreadCount: 3, failed: true },
    'a failure keeps the last known count and flags it; never 0');

  // Another user logs in on the device: the previous count disappears before any response.
  login(9);
  const switching = client.refreshNotificationSummary();
  assert.deepEqual(client.getNotificationSummary(), { userKey: '9', available: null, unreadCount: null, failed: false });
  pending.resolve(reply(500, null));
  await switching;
  assert.equal(client.getNotificationSummary().unreadCount, null, 'first-ever failure stays unknown, not 0');

  // Late answer for the previous user is dropped.
  login(8);
  const stale = client.refreshNotificationSummary();
  const stalePending = pending;
  login(9);
  client.syncNotificationUser();
  stalePending.resolve(reply(200, { ok: true, available: true, unreadCount: 42 }));
  await stale;
  assert.notEqual(client.getNotificationSummary().unreadCount, 42);

  // Logout clears and stops requests.
  store.delete('baba_user');
  client.resetNotificationSummary();
  const before = calls;
  await client.refreshNotificationSummary();
  assert.equal(calls, before, 'no request without a cached user');
  assert.equal(client.getNotificationSummary().unreadCount, null);

  // DB not installed -> available false (bell renders nothing).
  login(8);
  const missing = client.refreshNotificationSummary();
  pending.resolve(reply(200, { ok: true, available: false }));
  await missing;
  assert.equal(client.getNotificationSummary().available, false);
  delete globalThis.fetch; delete globalThis.window;
});

test('badge formatting and internal href guard', () => {
  assert.deepEqual([0, -1, null, undefined, NaN, 1, 99, 100, 250].map(formatUnreadBadge), [null, null, null, null, null, '1', '99', '99+', '99+']);
  for (const ok of ['/notifications', '/admin/sales/receipts?date=2026-11-26', '/attendance/leave?month=2026-11#top']) assert.ok(isSafeInternalHref(ok), ok);
  for (const bad of ['https://evil.test', '//evil.test', 'javascript:alert(1)', '/a/../b', '/a\\b', 'admin', '', null, '/a b', '/' + 'a'.repeat(300)]) {
    assert.ok(!isSafeInternalHref(bad), String(bad));
  }
});

test('static UI contracts: header kept, bell isolated, center safe, leave popup and bottom nav untouched', () => {
  const layout = readFileSync('app/(protected)/layout.tsx', 'utf8');
  const bell = readFileSync('components/notifications/NotificationBell.tsx', 'utf8');
  const center = readFileSync('app/(protected)/notifications/page.tsx', 'utf8');
  const nav = readFileSync('components/BottomNav.tsx', 'utf8');
  const client = readFileSync('lib/notifications/client.ts', 'utf8');
  // Header geometry, language toggle, user menu and the leave popup are unchanged.
  assert.match(layout, /height: "calc\(54px \+ env\(safe-area-inset-top\)\)"/);
  assert.match(layout, /paddingTop: "env\(safe-area-inset-top\)"/);
  assert.match(layout, /onClick=\{handleToggleLanguage\}/);
  assert.match(layout, /\/api\/attendance\/leave-pending-summary/);
  assert.match(layout, /baba_leave_pending_alert_shown/);
  assert.ok(layout.indexOf('<NotificationBell />') > layout.indexOf('handleToggleLanguage}'), 'bell sits after the language toggle');
  assert.ok(layout.indexOf('<NotificationBell />') < layout.indexOf('ref={menuRef}'), 'and before the user menu');
  assert.match(layout, /localStorage\.removeItem\("baba_user"\);\n\s*resetNotificationSummary\(\);/);
  assert.ok(!/notification/i.test(nav), 'bottom nav not changed');
  // Bell: 120 s polling only while visible, error boundary, hidden until available.
  assert.match(client, /NOTIFICATION_POLL_MS = 120_000/);
  assert.match(bell, /document\.visibilityState === "visible"/);
  assert.match(bell, /if \(visible\(\)\) void refreshNotificationSummary\(\)/);
  assert.match(bell, /class BellBoundary/);
  assert.match(bell, /if \(summary\.available !== true\) return null;/);
  assert.ok(!/Audio|vibrate|Notification\.requestPermission|serviceWorker|PushManager/.test(bell + center + client), 'no sound, vibration or push in 01-A');
  // Center: validated internal navigation only.
  assert.match(center, /if \(!isSafeInternalHref\(item\.href\)\) return;/);
  assert.ok(!/dangerouslySetInnerHTML|window\.open|location\.href\s*=/.test(center));
  for (const filter of ['all', 'unread', 'open', 'resolved']) assert.match(readFileSync('lib/text/notifications.ts', 'utf8'), new RegExp(`${filter}: "`));
});
