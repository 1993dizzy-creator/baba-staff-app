# BABA-NOTIFICATION-01B — Common background Web Push foundation

Status: code + formal migration `supabase/migrations/20261128073109_notification_web_push_foundation.sql` on main
(01B-FINAL and 01B-FINAL-2 revised the same, still unapplied migration version in place: sender bounds, recovery
gate, queue plans, sync writes; FINAL-2: account-switch ordering by a signed per-browser generation; FINAL-3:
generation-aware logout, whole-session markers by time, scoped session touch, login floor advance).
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
3. Just-in-time rounds (01B-FINAL): each round claims only the rows it sends at once — **5** (`FOR UPDATE SKIP
   LOCKED`, claim token, lease **90 s**). The claim RPC re-checks the send gate per row and returns immediately, so no
   DB transaction or lock is open while a push service is contacted. Right before each send the sender re-checks the
   claim age (> 20 s → released unsent, `claim_too_old`) and the remaining TTL (< 5 s → `expired`, not sent). Each
   send is bounded (10 s socket timeout, 12 s hard bound → `send_timeout` retry) and so is its report (5 s), far
   below the lease, so a live claim is never re-claimed. Claim age and remaining TTL are measured from the moment the
   claim **request** was sent (conservative: the claim round trip counts). A round is reported before the next is
   claimed. One dispatch has a **hard total bound of 30 s** (`dispatchBudgetMs`): a new round starts only if even its
   worst case (claim 5 s + send 12 s + report 5 s = 22 s) still ends inside it; at most 10 rounds; the rest waits for
   recovery. Sent with `web-push@3.6.7` (VAPID, aes128gcm,
   TTL = remaining TTL, `Topic: n<id>`, `Urgency: high` for urgent else normal).
4. Limited recovery: the same claim with no event filter, one round of 5, scheduled with `after()` from the bell's
   `GET /api/notifications/summary` (instance throttle 60 s; nothing at all while push is off or not configured).
   Inside the claim: an empty queue is answered by two partial-index probes **without any write**; otherwise a
   DB-wide gate (`push_runtime`, one row) lets **one** recovery scan per 60 s through across all server instances.
   Retries and abandoned claims progress only while someone has the app open; otherwise rows expire with their TTL.

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

**Duplicates / uncertainty**: *preventable* duplicates (a slow but live sender re-claimed by another instance) are
excluded by the bounds above (lease 90 s ≥ 3 × (12 s send + 5 s report); tested with a held send and repeated
recovery from a second instance). *Inherent* duplicates remain: the push service accepted but the report was lost
(process died / report RPC failed), or a send passed its 12 s bound and was still accepted. The row then stays
`sending` (re-claimed after the lease) or goes back to `pending` (retry), and is sent again (attempt counted). The same `Topic` lets the push
service replace an undelivered copy and the same notification `tag` (`baba-n-<id>`) makes the device replace the
shown one silently (`renotify: false`). After 3 unreported claims the row ends as `failed/result_unknown`.
Messages already accepted by a push service cannot be recalled.

## Devices, sessions and accounts

- A device row = (push endpoint, keys) bound to the user, the `iat` of the signed server session that registered it,
  and the browser's push identity + generation; `expires_at` = that session's idle expiry. A normal `/api/session`
  refresh extends it (`notification_push_session_touch_v1`, after the response). The login/session policy and
  lifetimes are unchanged.
- **Push device cookie (FINAL-2)**: `baba_push_device`, httpOnly, **signed by the server** (HMAC-SHA256 with the
  existing session secret, separate tag). It carries the browser's device id `d` (the DB keeps only SHA-256), the
  server time the id was created, a **generation `g`**, a nonce, and the session it belongs to (user id, iat).
  - Login: `g + 1` computed from the cookie the browser sends, bound to the new session. If the browser already had
    a push identity, the DB floor moves to the new generation **before the login response** (FINAL-4; awaited,
    bounded 1.5 s; `notification_push_device_login_v1`; the same applies when `/api/session` re-issues the cookie):
    from the moment the next account is signed in, the previous account's rows stop at the send gate
    (`device_moved`), with no window until a sync. No push network call is involved. A browser unknown to push: no DB write; same/older generation: no write.
    A missing push DB or a failure never affects the login; the previous rows then wait for the first sync (limit).
  - Every generation also carries its issue time `s` (ms).
  - Logout: `g + 1` with no user.
  - `/api/session`: issues one only when it is missing or belongs to another session (logins made before this
    cookie existed). Cookie only, no DB write; nothing when it already matches.
  - Push routes act only when the cookie verifies **and** matches the authenticated session; otherwise
    `409 PUSH_DEVICE_INIT` (the client calls `/api/session` once and retries). No push action ever runs without an
    identity and generation.
- **Request ordering per browser** (`push_devices`, one row per browser identity): every device RPC passes
  (identity, generation, nonce, issue time). A request with a **lower** generation than the browser's floor — or the
  same generation with another nonce/session — is refused as `superseded` **without any write**. The floor is written
  only when a request carries a new generation (once per login/logout per browser that uses push). This replaces
  any iat comparison: within one browser, every login is strictly later than the previous one even in the same
  second, so a request issued before an account switch, a re-login or a logout can never register, restore, renew,
  unsubscribe or revoke anything afterwards. There is no "last request wins".
- One active owner per endpoint (partial unique index + per-endpoint advisory lock; lock order endpoint → device →
  session). Ownership history (revoked rows included) is kept: if an endpoint was last held by a **different
  browser identity** (cookie reset), the identity created later (signed issue time) wins and the older identity is
  **retired** — all its later requests are refused; an older identity is refused outright.
- Consent is not inherited: a user registration carries `expectUserId` (the account that clicked, captured at the
  click). If the session in the browser became another account while the permission prompt / worker registration was
  pending, the server answers `409 PUSH_USER_CHANGED` and registers nothing. The worker's renewal (old endpoint) may
  omit it: the DB only renews an active row of the same account **and** browser.
- Session refresh (FINAL-3): extends only the rows of this browser generation (device + generation + session);
  another browser of the same user/second is never extended, and an older generation never extends a newer one.
- `sync` and `unsubscribe` also carry `expectUserId` (FINAL-3): an operation started for one account that reaches the
  server with another account's cookies is refused (`409 PUSH_USER_CHANGED`).
- Client: the current account (and, for disable/sync, the cross-tab operation stamp) is re-checked right before every
  POST, including the `PUSH_DEVICE_INIT` retry after `/api/session`; a late or refused answer never unsubscribes the
  browser (it may already serve the next account). Destructive local steps of a passive sync require that the
  account and a cross-tab operation stamp (changed by every enable/disable in any tab) are unchanged.
- Logout (FINAL-3): with the push cookie, `/api/logout` passes the browser's LOGOUT generation. It acts only if that
  generation is not older than the browser's floor and does not conflict with it (same generation, other nonce);
  a delayed logout that arrives after a newer login changes nothing (`stale`), and a retried logout is idempotent.
  It raises the floor and stops only rows registered by **older** generations of that browser; other browsers (even
  of the same user and second) are untouched. No marker is written — the floor refuses every older request, while a
  new login in the same second (higher generation) registers normally. Without the push cookie (sessions older
  than the cookie) the session's rows are revoked and a whole-session marker
  (`push_session_revocations`: user, session iat, logout time) refuses generations issued up to that logout, not a
  later re-login. The revoke uses the same condition (FINAL-4): only rows whose generation was issued up to the
  logout time (`push_subscriptions.generation_ms`) are revoked; a newer generation already registered is kept. Awaited, 2 s timeout, never fails logout. The client then unsubscribes the browser and clears the badge — the server
  no longer depends on it.
- Send gate addition: a row whose browser moved on to another account (higher generation, other user, or logged out)
  or whose identity was retired is skipped (`device_moved`) and revoked — even if no sync revoked it yet.
- Same user, same second, two different browsers: independent identities; logout of one keeps the other.
- Replacement safety: revoking the current/renewed row and inserting the new one happen in one block; an invalid new
  subscription leaves the existing registration untouched.
- Every app start / user switch / app language change: `PushDeviceSync` reports the browser's existing subscription
  (`sync`, with the language). Another account's row on this browser is revoked and the browser unsubscribes, so the
  next user never inherits it. `sync` writes only when session / expiry / generation / language actually changed; the
  client reuses a sync result for 10 minutes across tabs and reloads and ignores routine `baba_user_updated` refreshes
  for the same user. No subscription in the browser = no request. No new polling.
- Panel: a registered device while the service is switched off / not configured shows **발송 중지 / Tạm dừng gửi**
  (never "on"); it can still be turned off.
- Deactivation, login off, role/part/policy change: checked at every claim and click.
- Limits (unchanged): an **offline logout** cannot reach the server — that browser's rows stay until its next push
  request (any request with the next generation moves the floor and the send gate then skips them), a `404/410`, or
  session expiry. A browser switched to another account that never opens a protected page keeps the previous rows
  until then (the first page load syncs). Stateless session tokens are not revoked by logout (unchanged auth
  behavior). Messages already accepted by a push service cannot be recalled. Safari may not fire
  `pushsubscriptionchange`; the next app start re-registers when the same user had opted in on that device.

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
- `notification_private.push_subscriptions` (RLS on, no policies, no grants; `device_hash`, `device_generation`;
  history index `(endpoint, id desc)`).
- `notification_private.push_devices` (per-browser identity: issue time, generation floor, nonce, current session,
  retired state).
- `notification_private.push_session_revocations` (whole-session logout markers for cookie-less logouts; PK user,
  session iat; `revoked_ms`).
- `notification_private.push_deliveries` (RLS on, unique `(notification_id, subscription_id)`, status
  `pending|sending|accepted|failed|skipped|expired`, attempts 0–3, TTL, claim token). Queue indexes are partial
  (`pending` by `next_attempt_at, id`; `sending` by `claimed_at, id`), so finished history never enters a claim scan.
- `notification_private.push_runtime` (single row: global recovery gate).
- Private helpers: `can_push`, `revoke_subscription`, `lock_endpoint`, `lock_device`, `check_device`,
  `claim_endpoint_identity`, `lock_session`, `session_revoked`,
  `enqueue_push_deliveries` (trigger), `valid_session_expiry`. All definer functions pin
  `search_path = pg_catalog, public`.
- Claim RPC limits: batch ≤ 20 (sender uses 5), lease 60–600 s (sender uses 90); unread count for the badge is
  computed once per staff member per batch.
- Measured on real PostgreSQL 18.6 with 10k / 100k finished deliveries (`tests/notifications-push-plan.test.mjs`):
  every queue query is an index scan on the partial indexes (1–11 shared buffers), event claims use the
  `(notification_id, …)` unique index with an in-memory sort of ≤ 15 rows, no sequential scan of `push_deliveries`,
  no external sort, 0 temp files; idle claim 2.6–4.1 ms, recovery claim 11.7–15.9 ms, event claim 3.7–5.5 ms
  (local cluster; not Production).
- Replaced (same signature/contract + `pushEnabled`): `notification_policy_list_v1`, `notification_policy_update_v1`
  (omitted `pushEnabled` keeps the stored value; audit before/after include it).
- New RPCs, `service_role` only. Device RPCs end with `(p_device_hash, p_device_generation, p_device_nonce,
  p_device_issued_ms)`: `notification_push_subscribe_v1(actor, iat, exp, endpoint, p256dh, auth, lang, old, …)`,
  `_unsubscribe_v1(actor, iat, endpoint, …)`, `_sync_v1(actor, iat, exp, endpoint, lang, …)`,
  `_session_revoke_v1(user, iat, …, p_logout_ms)` (logout generation, or device fields null + logout time = whole
  session). Subscribe/sync also take `p_device_generation_ms`. Also `_status_v1`,
  `_session_touch_v1(user, iat, exp, device_hash, generation)`, `_device_login_v1(device_hash, generation, nonce,
  user, iat)`, `_open_v1`, `_claim_v1`, `_report_v1` (outcomes `accepted|retry|gone|failed|expired`).
  Device RPC statuses add `session_revoked` and `superseded` (HTTP 409 `PUSH_SESSION_REVOKED` / `PUSH_SUPERSEDED`);
  routes add `409 PUSH_DEVICE_INIT` and `409 PUSH_USER_CHANGED`.
- No retention job: delivery history is kept (no bulk delete without approval).

## Compatibility

- New app + DB without 01-B: push routes answer `available:false / db_pending`; settings show "기기 푸시 (푸시 DB 적용
  후 사용 가능)" and never send `pushEnabled`; 01-A center, bell, read and settings work as before.
- Old app + DB with 01-B: 01-A RPC calls unchanged; policy saves without `pushEnabled` keep it.
- No VAPID / switch off / type off: nothing scheduled or sent; deliveries (if enqueued while the type is on)
  expire with their TTL.

## Tests

`tests/notifications-push-db.test.mjs` (PGlite), `tests/notifications-push-concurrency.test.mjs` (real PostgreSQL:
same-second account switches on one browser, revoke-then-late-restore, same-user re-login vs old unsubscribe,
logout vs registration, slow live claim vs other instances, multi-instance recovery, idle no-write),
`tests/notifications-push-plan.test.mjs` (real PostgreSQL, EXPLAIN ANALYZE BUFFERS + auto_explain at 10k/100k rows),
`tests/notifications-push-api.test.mjs` (routes + sender with a mocked push service; real web-push request building and
aes128gcm decryption with the test device key; service worker in a VM), `tests/notifications-push-browser.test.mjs`
(isolated Next production build, headless Chrome with a stubbed `PushManager`). The 01-A suites run unchanged against
01-A only and, with `BABA_NOTIFICATION_WITH_PUSH=1`, against 01-A + 01-B. Mocked delivery ≠ real-device delivery:
real iOS / Android / PC delivery has not been verified.
