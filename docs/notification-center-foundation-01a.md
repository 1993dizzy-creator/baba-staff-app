# BABA-NOTIFICATION-01A — Common notification foundation

Status: code + formal migration on main. **Production DB not applied** (GPT review + Owner
approval → GPT applies `supabase/migrations/20261126124217_notification_center_foundation.sql`).
Until then the app hides the bell and shows "not ready" in the center and settings tab.

## Storage (`notification_private`, RLS on, no policies, all API roles revoked)

| Table | Purpose |
|---|---|
| `types` | Stable type code catalog + `access_roles` ceiling (= the business screen's existing permission). Migration-managed only. `payroll`/`ledger` domains are capped at owner/master by a check constraint. |
| `policies` | One per type: `enabled`, `in_app_enabled`, `rules`, `revision`, `updated_by/at`. |
| `policy_audit` | Append-only before/after of every policy change (update/delete/truncate rejected). |
| `notifications` | One row per business occurrence: type, domain, `dedupe_key`, severity, KO/VI title/body, subject type/id, internal `href`, `status` open/resolved, first/last observed, observation count, resolved at/reason/evidence, policy revision, recipient count. |
| `recipients` | Recipients fixed at creation + per-user `read_at`. |

Indexes: partial unique `(type_code, dedupe_key) where status='open'`; `recipients (user_id, notification_id desc)`;
partial `recipients (user_id, notification_id desc) where read_at is null`.

## RPCs (security definer, `service_role` only)

Server-internal writer (no browser route calls them; `lib/notifications/server.ts` `upsertNotification` / `resolveNotification`):

- `notification_upsert_v1(type, dedupe_key, payload)` → `created | observed | disabled | unknown_type | invalid_input`
- `notification_resolve_v1(type, dedupe_key, reason, evidence)` → `resolved | not_open | invalid_input`

Actor RPCs (server passes the session user id; role/position/part/active are re-read from `users`):

- `notification_unread_count_v1(actor)` (capped at 100), `notification_list_v1(actor, filter, before_id, limit≤50)`,
  `notification_mark_read_v1(actor, id)`, `notification_mark_all_read_v1(actor, up_to_id)`
- `notification_policy_list_v1(actor)`, `notification_policy_update_v1(actor, type, expected_revision, policy)` — owner/master.

HTTP: `GET /api/notifications/summary`, `GET /api/notifications?filter=&before=`, `POST /api/notifications/read`,
`GET|PUT /api/admin/notification-settings`. All `Cache-Control: private, no-store`, `Vary: Cookie`.
Missing RPC (PGRST202/42883/3F000/42P01) → `{ ok: true, available: false }`. Other failures → 503, never a count.

## Contracts

- **Dedupe**: first observation creates; repeats while open only update last observed / count / severity / body;
  read state is never reset; after resolution the same key creates a new occurrence. Atomic `INSERT … ON CONFLICT`
  on the partial unique index (verified with 60 concurrent calls on real PostgreSQL 18).
- **Read ≠ resolve**: read/mark-all only touch `recipients.read_at`; resolution only touches `notifications`.
- **Mark all**: marks visible unread rows with `id <= up_to_id` (newest id shown); later events stay unread.
- **Rules**: `{"groups":[{"roles":[],"positions":[],"parts":[]}],"userIds":[]}`. AND inside a group, OR across
  groups, `userIds` is an extra allow list. Empty list = any value including NULL; a non-empty list never matches
  NULL. A group with all lists empty = every active staff member. Always intersected with `types.access_roles`.
  `position` is kept as a separate attribute; in current data it mirrors `role` (master → `owner`, see `lib/common/roles.ts`).
- **Policy change timing**: recipients are fixed when an event is created (policy revision stored). Display always
  re-checks current account state (active + app login), current role vs ceiling and the current policy. No back-fill
  to new recipients; people who no longer qualify stop seeing old events and their count.
- **Disabled type**: no new events; existing events hidden. In-app off: events still recorded (for 01-B channels) but hidden.
- **href**: internal path only (`^/[A-Za-z0-9/_.~%=&?#-]*$`, no `//`, no `..`, ≤ 300), checked in TS, DB, and again before navigation.

## Seeded types (disabled, no writer yet)

- `attendance.leave_request_pending` — ceiling owner/master (`isAttendanceAdminRole`).
- `inventory.pos_deduction_pending` — ceiling owner/master/manager/leader (inventory-deduction review routes).

## 01-B (Web Push) reuse

Reuse notification `id` (push tag / dedupe), `recipients` (delivery targets, re-check with the same display gate at
send time), `type_code` + `dedupe_key`, KO/VI title/body (lock-screen text must stay free of sensitive amounts),
and `href` (click target). 01-B adds: subscriptions per device, a `push_enabled` policy column, a delivery/attempt
table with its own unique key per (notification, subscription), VAPID, Service Worker, expiry handling, and
logout/deactivation revocation. Nothing in 01-A sends anything outside the app.
