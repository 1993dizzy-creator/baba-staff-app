# BABA-NOTIFICATION-01B — Common background Web Push foundation

Status: code + formal migration `supabase/migrations/20261128073109_notification_web_push_foundation.sql` on main.
**Production DB not applied** (GPT review + Owner approval → GPT applies, repairs history, runs postflight).
01-A (`20261126124217`) is applied in Production; this migration builds on it and does not modify it.
No business writer calls `upsertNotification` yet (POS / leave linkage are later tasks), so nothing is sent
until a writer exists **and** every switch below is on.

## Switches (all default OFF)

| Layer | Switch | Default |
|---|---|---|
| Server env | `WEB_PUSH_ENABLED` must be exactly `true` | unset = OFF |
| Server env | `VAPID_PUBLIC_KEY` (65-byte P-256, base64url), `VAPID_PRIVATE_KEY` (32-byte), `VAPID_SUBJECT` (`mailto:` / `https:`) | unset = push unavailable |
| Type policy | `notification_private.policies.push_enabled` (store settings → 알림설정 → 수신 채널 → 기기 푸시) | `false` |
| Device | each staff member turns on push for their own device (알림 화면 → 이 기기 푸시 알림) | not registered |

Env values are never logged, returned (except the public key) or stored in Git. 01-B did not create, rotate or
register any VAPID key or Vercel variable. Missing/invalid VAPID → push reported "not ready", everything else works.

## Delivery architecture (no cron, no queue service, no in-memory queue)

1. `notification_upsert_v1` (unchanged) creates the event and fixes recipients. A statement trigger on
   `recipients` (`recipients_enqueue_push`) inserts one `push_deliveries` row per (recipient × active device) **in
   the same transaction**, only if the type is `enabled` + `push_enabled` and the recipient passes `can_push`.
   Re-observing an open event inserts no recipients → no new delivery. A recurrence after resolution is a new event.
2. `upsertNotification()` (server) schedules `dispatchPushDeliveries(id)` with Next.js `after()` when push is
   configured. The business result is returned first; a push error never changes it. `{ push: "none" }` skips it.
3. `notification_push_claim_v1` claims due rows (`FOR UPDATE SKIP LOCKED`, claim token, lease 120 s) and re-checks the
   send gate per row. Each claimed row is sent once with `web-push@3.6.7` (VAPID, aes128gcm, TTL = remaining TTL,
   `Topic: n<id>`, `Urgency: high` for urgent else normal, 10 s timeout) and reported with `notification_push_report_v1`.
4. Limited recovery: the same claim with no event filter, scheduled with `after()` from the bell's
   `GET /api/notifications/summary` (≤ once/minute per server instance, only when push is configured). Retries
   and abandoned claims therefore progress only while someone has the app open; otherwise rows expire with their TTL.

### Send-time gate (claim)

Delivery TTL not passed · event still `open` · subscription `active`, unexpired and still owned by the recipient ·
recipient active + `app_login_enabled` · current role within `types.access_roles` · current rules match ·
`enabled` and `push_enabled`. `in_app_enabled` is **not** a push condition (`can_push` mirrors `can_see` without it).
Refused rows are closed as `skipped` (reason in `last_error`), `expired` (TTL) or `failed` (`result_unknown`).

### Failure handling

| Push service answer | Result |
|---|---|
| 2xx | `accepted` (accepted by the push service ≠ shown on the device) |
| 404 / 410 | `failed` + subscription revoked (`gone`) |
| 429 | retry, `Retry-After` honoured (capped 1 h) |
| 5xx, network error, timeout | retry |
| 401 / 403 / 400 / 413 / other 4xx, endpoint rejected | `failed`, never retried |

Max 3 attempts; backoff 1 min then 5 min (or a longer `Retry-After`); a retry that would land after the TTL
(1 h from event creation) ends as `expired`. Resolved events and recipients who lost permission are never retried.

**Duplicates / uncertainty**: if the process dies after the push service accepted but before the report, the row
stays `sending`; after the lease it is re-claimed and sent again (attempt counted). The same `Topic` lets the push
service replace an undelivered copy and the same notification `tag` (`baba-n-<id>`) makes the device replace the
shown one silently (`renotify: false`). After 3 unreported claims the row ends as `failed/result_unknown`.
Messages already accepted by a push service cannot be recalled.

## Devices, sessions and accounts

- A device row = (push endpoint, keys) bound to the user **and the `iat` of the signed server session** that
  registered it; `expires_at` = that session's idle expiry. A normal `/api/session` refresh extends it
  (`notification_push_session_touch_v1`, after the response). The login/session policy itself is unchanged.
- One active owner per endpoint (partial unique index + per-endpoint advisory lock). Registering an endpoint another
  account owns revokes the old row (`owner_changed`). Max 10 active devices per staff member (oldest retired).
- Logout: `/api/logout` revokes the session's rows (awaited, 2 s timeout, never fails logout), then the client
  unsubscribes the browser and clears the icon badge (bounded waits).
- Every app start / user switch: `PushDeviceSync` reports the browser's existing subscription (`sync`); another
  account's row is revoked and the browser unsubscribes, so the next user never inherits it. A registration answer
  that arrives after the cached user changed is undone immediately.
- Deactivation, login off, role/part/policy change: checked at every claim and click.
- Limits: an **offline logout** cannot reach the server; that row keeps its session expiry until the next sync on
  that browser, a `404/410`, or expiry. Stateless session tokens are not revoked by logout (unchanged 01-A/auth
  behavior). Safari may not fire `pushsubscriptionchange`; the next app start re-registers when the same user had
  opted in on that device.

## Security

- Device routes (`GET|POST /api/notifications/push`): server session only (user/role/part never from the client),
  same-origin required (`Origin` = host, or `Sec-Fetch-Site: same-origin`), `application/json` only, body ≤ 4 KB,
  strict shape (`toJSON()` of `PushSubscription`), endpoint never echoed.
- SSRF: endpoints must be `https://` on `fcm.googleapis.com`, `android.googleapis.com`,
  `updates.push.services.mozilla.com`, `push.services.mozilla.com`, `web.push.apple.com`, `*.push.apple.com`,
  `*.notify.windows.com` — no port, user info, IP literal, `..`; checked in TS, by a DB check constraint, and again
  before each send. The HTTP client does not follow redirects; no generic "send to URL" path exists.
- Lock screen: fixed KO/VI text + the type's generic name, built from type code + id only (event title/body,
  names, amounts, customers, receipts never enter the payload). Language = the device's registration language.
- Click: the worker opens only `/notifications/open?id=N`; that page asks `GET /api/notifications/push/open`,
  which requires the user to be a recipient and currently allowed on a channel, and returns only the internal
  `href` (validated again); otherwise the user lands on `/notifications`. Click/receipt never marks read or resolves.
- `public/sw.js` has **no fetch handler** (nothing cached or intercepted; app update behavior unchanged); served with
  `Cache-Control: no-cache, no-store, must-revalidate`. Registered only from the "turn on" click (scope `/`,
  `updateViaCache: "none"`); permission is requested only from that click.
- Logs carry codes/counts only (no endpoint, keys, VAPID, payload).

## DB objects (migration `20261128073109`)

- `notification_private.policies.push_enabled boolean not null default false`.
- `notification_private.push_subscriptions` (RLS on, no policies, no grants).
- `notification_private.push_deliveries` (RLS on, unique `(notification_id, subscription_id)`, status
  `pending|sending|accepted|failed|skipped|expired`, attempts 0–3, TTL, claim token).
- Private helpers: `can_push`, `revoke_subscription`, `lock_endpoint`, `enqueue_push_deliveries` (trigger),
  `valid_session_expiry`. All definer functions pin `search_path = pg_catalog, public`.
- Replaced (same signature/contract + `pushEnabled`): `notification_policy_list_v1`, `notification_policy_update_v1`
  (omitted `pushEnabled` keeps the stored value; audit before/after include it).
- New RPCs, `service_role` only: `notification_push_subscribe_v1`, `_unsubscribe_v1`, `_sync_v1`, `_status_v1`,
  `_session_revoke_v1`, `_session_touch_v1`, `_open_v1`, `_claim_v1`, `_report_v1`.
- No retention job: delivery history is kept (no bulk delete without approval).

## Compatibility

- New app + DB without 01-B: push routes answer `available:false / db_pending`; settings show "기기 푸시 (푸시 DB 적용
  후 사용 가능)" and never send `pushEnabled`; 01-A center, bell, read and settings work as before.
- Old app + DB with 01-B: 01-A RPC calls unchanged; policy saves without `pushEnabled` keep it.
- No VAPID / switch off / type off: nothing scheduled or sent; deliveries (if enqueued while the type is on)
  expire with their TTL.

## Tests

`tests/notifications-push-db.test.mjs` (PGlite), `tests/notifications-push-concurrency.test.mjs` (real PostgreSQL),
`tests/notifications-push-api.test.mjs` (routes + sender with a mocked push service; real web-push request building and
aes128gcm decryption with the test device key; service worker in a VM), `tests/notifications-push-browser.test.mjs`
(isolated Next production build, headless Chrome with a stubbed `PushManager`). The 01-A suites run unchanged against
01-A only and, with `BABA_NOTIFICATION_WITH_PUSH=1`, against 01-A + 01-B. Mocked delivery ≠ real-device delivery:
real iOS / Android / PC delivery has not been verified.
