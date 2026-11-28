// BABA-NOTIFICATION-01B push migration on an isolated PGlite database (01-A + 01-B, synthetic staff,
// no production credentials). Covers privileges, policy compatibility (pushEnabled omitted keeps
// the value, audit), device registration/ownership/sync/session lifecycle, SSRF endpoint checks,
// atomic enqueue (no back-fill, no re-send on observation, recurrence), the send-time gate, the
// claim/report state machine (lease, stale token, backoff, Retry-After, gone, TTL, attempts) and the
// click re-check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { baseSql, testTypesSql, U, payload, MIGRATION_FILE, PUSH_MIGRATION_FILE } from './helpers/notification-fixture.mjs';
import { readFileSync } from 'node:fs';

const base = readFileSync(MIGRATION_FILE, 'utf8');
const push = readFileSync(PUSH_MIGRATION_FILE, 'utf8');
export const KEY = 'B' + 'A'.repeat(86); // 87 chars base64url (shape only; DB checks the shape)
export const AUTH = 'C'.repeat(22);
const ep = (n, host = 'fcm.googleapis.com') => `https://${host}/fcm/send/device-${n}:APA91b_test`;

async function fixture() {
  const db = new PGlite();
  await db.exec(baseSql); await db.exec(base); await db.exec(testTypesSql); await db.exec(push);
  return db;
}
const rows = async (db, sql, args = []) => (await db.query(sql, args)).rows;
async function asRole(db, role, sql, args = []) {
  await db.exec(`set role ${role}`);
  try { return (await db.query(sql, args)).rows; } finally { await db.exec('reset role'); }
}
const call = async (db, fn, args) => (await asRole(db, 'service_role',
  `select public.${fn}(${args.map((a, i) => `$${i + 1}${a?.cast ?? ''}`).join(',')}) r`,
  args.map(a => (a?.cast ? a.v : a))))[0].r;
const j = v => ({ v: v === null ? null : JSON.stringify(v), cast: '::jsonb' });
const ts = v => ({ v, cast: '::timestamptz' });
const uuid = v => ({ v, cast: '::uuid' });
const inDays = d => new Date(Date.now() + d * 86400000).toISOString();
const IAT = 1_790_000_000;

export const DEV = 'D'.repeat(43); // push device cookie hash (shape only)
const subscribe = (db, user, endpoint, { iat = IAT, exp = inDays(30), lang = 'ko', old = null, p256dh = KEY, auth = AUTH, device = DEV } = {}) =>
  call(db, 'notification_push_subscribe_v1', [user, iat, ts(exp), endpoint, p256dh, auth, lang, old, device]);
const sync = (db, user, iat, exp, endpoint, lang = 'ko', device = DEV) =>
  call(db, 'notification_push_sync_v1', [user, iat, ts(exp), endpoint, lang, device]);
const ungate = db => db.query("update notification_private.push_runtime set recovery_started_at = '-infinity'");
const upsert = (db, type, key, extra) => call(db, 'notification_upsert_v1', [type, key, j(payload(extra))]);
// Recovery claims (id null) pass a DB-wide 60 s gate; tests reopen it unless they test the gate itself.
const claim = async (db, id = null, limit = 20, lease = 120, { gate = false } = {}) => {
  if (id === null && !gate) await ungate(db);
  return call(db, 'notification_push_claim_v1', [id, limit, lease]);
};
const report = (db, item, outcome, http = null, retryAfter = null, code = null) =>
  call(db, 'notification_push_report_v1', [item.deliveryId, uuid(item.claimToken), outcome, http, retryAfter, code]);
async function setPolicy(db, type, policy) {
  const [{ revision }] = await rows(db, 'select revision from notification_private.policies where type_code=$1', [type]);
  const r = await call(db, 'notification_policy_update_v1', [U.owner, type, revision, j({ enabled: true, inAppEnabled: true, rules: { groups: [{}] }, ...policy })]);
  assert.equal(r.status, 'ok', JSON.stringify(r));
}
const deliveries = (db, where = 'true') => rows(db, `select d.id, d.notification_id::int n, d.subscription_id::int s, d.user_id::int u, d.status,
  d.attempt_count a, d.last_error e, d.last_http_status h, d.next_attempt_at, d.expires_at from notification_private.push_deliveries d where ${where} order by d.id`);
const subStatus = async (db, endpoint) => (await rows(db,
  'select user_id::int u, status, revoked_reason r from notification_private.push_subscriptions where endpoint=$1 order by id', [endpoint]));
const due = db => db.query("update notification_private.push_deliveries set next_attempt_at = now() - interval '1 second' where status='pending'");

test('privileges: new tables closed, new RPCs service_role only, definer functions pin search_path', async () => {
  const db = await fixture();
  try {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const table of ['push_subscriptions', 'push_deliveries', 'push_session_revocations', 'push_runtime', 'policies']) {
        await assert.rejects(asRole(db, role, `select * from notification_private.${table}`), /permission denied/);
      }
    }
    const rpcs = ['notification_push_subscribe_v1(1,1,now(),null,null,null,null,null,null)', 'notification_push_unsubscribe_v1(1,null)',
      'notification_push_sync_v1(1,1,now(),null,null,null)', 'notification_push_session_revoke_v1(1,1,null)', 'notification_push_session_touch_v1(1,1,now())',
      'notification_push_open_v1(1,1)', 'notification_push_status_v1(1)', 'notification_push_claim_v1(null,1,60)',
      "notification_push_report_v1(1,'00000000-0000-0000-0000-000000000000',null,null,null,null)"];
    for (const role of ['anon', 'authenticated']) {
      for (const fn of rpcs) await assert.rejects(asRole(db, role, `select public.${fn}`), /permission denied/, `${role} ${fn}`);
    }
    for (const fn of rpcs) await asRole(db, 'service_role', `select public.${fn}`);
    const rls = await rows(db, `select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where nspname='notification_private' and relkind='r' order by relname`);
    assert.equal(rls.length, 9); assert.ok(rls.every(r => r.relrowsecurity));
    const definers = await rows(db, `select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (nspname='notification_private' or proname like 'notification\\_%') and prosecdef`);
    assert.ok(definers.length >= 20);
    for (const f of definers) assert.ok((f.proconfig ?? []).some(c => /^search_path=pg_catalog/.test(c)), f.proname);
    const publicExec = await rows(db, `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where nspname='notification_private' and has_function_privilege('service_role', p.oid, 'execute')`);
    assert.deepEqual(publicExec, [], 'private helpers not executable by API roles');
    assert.equal((await rows(db, "select count(*)::int n from pg_publication_tables where schemaname='notification_private'"))[0].n, 0);
  } finally { await db.close(); }
});

test('policy compatibility: push default OFF, 01-A update without pushEnabled keeps it, audit records it', async () => {
  const db = await fixture();
  try {
    const list = await call(db, 'notification_policy_list_v1', [U.owner]);
    assert.ok(list.types.every(t => t.pushEnabled === false), 'every type push OFF by default');
    const type = 'inventory.pos_deduction_pending';
    const on = await call(db, 'notification_policy_update_v1', [U.owner, type, 1, j({ enabled: true, inAppEnabled: true, pushEnabled: true, rules: { groups: [] } })]);
    assert.equal(on.status, 'ok');
    // An 01-A client (no pushEnabled key) keeps the stored push value.
    const old = await call(db, 'notification_policy_update_v1', [U.owner, type, 2, j({ enabled: true, inAppEnabled: false, rules: { groups: [] } })]);
    assert.equal(old.status, 'ok');
    const [p] = await rows(db, 'select enabled, in_app_enabled, push_enabled, revision from notification_private.policies where type_code=$1', [type]);
    assert.deepEqual(p, { enabled: true, in_app_enabled: false, push_enabled: true, revision: 3 });
    for (const bad of [{ pushEnabled: 'true' }, { pushEnabled: null }, { push: true }]) {
      assert.equal((await call(db, 'notification_policy_update_v1', [U.owner, type, 3, j({ enabled: true, inAppEnabled: true, rules: { groups: [] }, ...bad })])).status, 'invalid_input');
    }
    assert.equal((await call(db, 'notification_policy_update_v1', [U.managerHall, type, 3, j({ enabled: true, inAppEnabled: true, pushEnabled: false, rules: { groups: [] } })])).status, 'forbidden');
    const audit = await rows(db, 'select revision, before_policy b, after_policy a from notification_private.policy_audit where type_code=$1 order by id', [type]);
    assert.deepEqual(audit.map(x => [x.revision, x.b.pushEnabled, x.a.pushEnabled]), [[2, false, true], [3, true, true]]);
    const listed = (await call(db, 'notification_policy_list_v1', [U.owner])).types.find(t => t.code === type);
    assert.equal(listed.pushEnabled, true);
    await assert.rejects(db.query('delete from notification_private.policy_audit'), /append-only/);
  } finally { await db.close(); }
});

test('device registration: multi-device, endpoint ownership transfer, renewal, unsubscribe, sync, limit, validation', async () => {
  const db = await fixture();
  try {
    assert.equal((await subscribe(db, U.staffBar, ep(1))).status, 'ok');
    assert.equal((await subscribe(db, U.staffBar, ep(2), { lang: 'vi' })).status, 'ok');
    assert.equal((await call(db, 'notification_push_status_v1', [U.staffBar])).activeDevices, 2, 'two devices of one staff member');
    // Same endpoint registered again by the same user: one active row.
    await subscribe(db, U.staffBar, ep(1));
    assert.deepEqual((await subStatus(db, ep(1))).map(r => [r.status, r.r]), [['revoked', 'replaced'], ['active', null]]);
    // Account switch on device 1: B takes the endpoint, A's row is revoked (no send to A's device).
    await subscribe(db, U.staffHall, ep(1), { iat: IAT + 1 });
    assert.deepEqual((await subStatus(db, ep(1))).map(r => [r.u, r.status, r.r]),
      [[8, 'revoked', 'replaced'], [8, 'revoked', 'owner_changed'], [9, 'active', null]]);
    // Unsubscribe / renew cannot touch another user's row.
    assert.equal((await call(db, 'notification_push_unsubscribe_v1', [U.staffBar, ep(1)])).revoked, 0);
    assert.equal((await subscribe(db, U.staffBar, ep(3), { old: ep(1) })).status, 'not_found');
    assert.equal((await subStatus(db, ep(3))).length, 0);
    // Own renewal (pushsubscriptionchange): old revoked as renewed, language kept when omitted.
    assert.equal((await subscribe(db, U.staffBar, ep(4), { old: ep(2), lang: null })).status, 'ok');
    assert.deepEqual((await subStatus(db, ep(2))).map(r => r.r), ['renewed']);
    assert.equal((await rows(db, 'select lang from notification_private.push_subscriptions where endpoint=$1 and status=$2', [ep(4), 'active']))[0].lang, 'vi');
    assert.equal((await call(db, 'notification_push_unsubscribe_v1', [U.staffBar, ep(4)])).revoked, 1);
    // Sync: foreign row revoked; own row re-bound to the current session; unknown endpoint.
    assert.equal((await sync(db, U.staffBar, IAT + 5, inDays(30), ep(1))).device, 'foreign');
    assert.deepEqual((await subStatus(db, ep(1))).at(-1).r, 'owner_changed');
    await subscribe(db, U.leaderBar, ep(5));
    const resync = await sync(db, U.leaderBar, IAT + 9, inDays(20), ep(5));
    assert.equal(resync.device, 'registered');
    assert.equal((await rows(db, 'select session_iat::int s from notification_private.push_subscriptions where endpoint=$1 and status=$2', [ep(5), 'active']))[0].s, IAT + 9);
    assert.equal((await sync(db, U.leaderBar, IAT, inDays(20), ep(99))).device, 'not_registered');
    // Inactive / login-disabled accounts cannot register or sync.
    for (const user of [U.staffKitchenInactive, U.staffHallNoLogin, U.unknown]) {
      assert.equal((await subscribe(db, user, ep(50 + user))).status, 'forbidden');
      assert.equal((await sync(db, user, IAT, inDays(1), ep(1))).status, 'forbidden');
    }
    // At most 10 active devices per user: the oldest are retired.
    for (let i = 0; i < 12; i++) await subscribe(db, U.owner, ep(100 + i));
    assert.equal((await call(db, 'notification_push_status_v1', [U.owner])).activeDevices, 10);
    assert.deepEqual((await subStatus(db, ep(100))).map(r => r.r), ['device_limit']);
    // Session-bound expiry must be a real future session expiry.
    for (const exp of [inDays(-1), inDays(200)]) assert.equal((await subscribe(db, U.owner, ep(200), { exp })).status, 'invalid_input');
    assert.equal((await subscribe(db, U.owner, ep(200), { lang: 'en' })).status, 'invalid_input');
    assert.equal((await subscribe(db, U.owner, ep(200), { old: ep(200) })).status, 'invalid_input');
  } finally { await db.close(); }
});

test('SSRF: only HTTPS endpoints on standard push services; keys shape enforced', async () => {
  const db = await fixture();
  try {
    const good = ['https://fcm.googleapis.com/fcm/send/abc:DEF-1_2', 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABc',
      'https://web.push.apple.com/QGx7Yz', 'https://wns2-sg2p.notify.windows.com/w/?token=BQYAAAB%3d', 'https://api.push.apple.com/3/device/x'];
    for (const url of good) assert.equal((await subscribe(db, U.owner, url)).status, 'ok', url);
    const bad = ['http://fcm.googleapis.com/fcm/send/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.1/x', 'https://evil.example.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://fcm.googleapis.com:8443/x',
      'https://user@fcm.googleapis.com/x', 'https://evil.com@fcm.googleapis.com/x', 'https://fcm.googleapis.com/../admin', 'https://fcm.googleapis.com/a b',
      'https://xn--evil.notify.windows.com.attacker.net/x', 'https://fcm.googleapis.com/' + 'a'.repeat(1100), 'javascript:alert(1)', ''];
    for (const url of bad) assert.equal((await subscribe(db, U.owner, url)).status, 'invalid_input', url);
    for (const [p256dh, auth] of [['short', AUTH], [KEY, 'x'], [KEY + '!', AUTH], [KEY, AUTH + '/']]) {
      assert.equal((await subscribe(db, U.owner, ep(7), { p256dh, auth })).status, 'invalid_input');
    }
  } finally { await db.close(); }
});

test('enqueue: atomic with the event, push ON only, no back-fill, observation never re-sends, recurrence does', async () => {
  const db = await fixture();
  try {
    const type = 'system.test_all';
    await subscribe(db, U.staffBar, ep(1)); await subscribe(db, U.staffBar, ep(2)); await subscribe(db, U.staffHall, ep(3));
    // Push OFF (default): event created, nothing queued.
    const off = await upsert(db, type, 'evt:off');
    assert.equal(off.status, 'created');
    assert.equal((await deliveries(db)).length, 0);
    await setPolicy(db, type, { pushEnabled: true });
    assert.equal((await deliveries(db)).length, 0, 'switching push on never back-fills an older event');
    const first = await upsert(db, type, 'evt:1');
    const queued = await deliveries(db, `notification_id=${first.id}`);
    assert.deepEqual(queued.map(d => [d.u, d.status, d.a]), [[8, 'pending', 0], [8, 'pending', 0], [9, 'pending', 0]], 'one row per device of each recipient');
    const [row] = await rows(db, "select extract(epoch from (d.expires_at - n.first_observed_at))::int ttl from notification_private.push_deliveries d join notification_private.notifications n on n.id=d.notification_id limit 1");
    assert.equal(row.ttl, 3600, 'TTL 1 hour from creation');
    for (let i = 0; i < 4; i++) assert.equal((await upsert(db, type, 'evt:1')).status, 'observed');
    assert.equal((await deliveries(db)).length, 3, 'repeat observation of the open event never enqueues again');
    // A device registered later never receives the older event.
    await subscribe(db, U.leaderBar, ep(4));
    assert.equal((await deliveries(db, `notification_id=${first.id}`)).length, 3);
    // Duplicate rows impossible.
    await assert.rejects(db.query('insert into notification_private.push_deliveries (notification_id, subscription_id, user_id, expires_at) select notification_id, subscription_id, user_id, expires_at from notification_private.push_deliveries limit 1'), /duplicate key/);
    // Resolve then recur: a new occurrence enqueues normally (including the new device).
    await call(db, 'notification_resolve_v1', [first.id, type, 'evt:1', 'business_resolved', j(null)]);
    const recur = await upsert(db, type, 'evt:1');
    assert.equal(recur.status, 'created');
    assert.equal((await deliveries(db, `notification_id=${recur.id}`)).length, 4);
    // In-app OFF does not stop push; push OFF stops it regardless of in-app.
    await setPolicy(db, type, { inAppEnabled: false, pushEnabled: true });
    assert.equal((await deliveries(db, `notification_id=${(await upsert(db, type, 'evt:inapp-off')).id}`)).length, 4);
    await setPolicy(db, type, { inAppEnabled: true, pushEnabled: false });
    assert.equal((await deliveries(db, `notification_id=${(await upsert(db, type, 'evt:push-off')).id}`)).length, 0);
    // Rules + ceiling apply to push exactly like recipients (manager type: staff never queued).
    await setPolicy(db, 'sales.test_manager', { pushEnabled: true });
    await subscribe(db, U.managerHall, ep(5));
    const mgr = await upsert(db, 'sales.test_manager', 'evt:m');
    assert.deepEqual((await deliveries(db, `notification_id=${mgr.id}`)).map(d => d.u), [4]);
    // Transaction failure: the event and its deliveries roll back together.
    await setPolicy(db, type, { pushEnabled: true });
    const before = (await deliveries(db)).length;
    await db.exec('begin');
    await db.exec('set local role service_role');
    await db.query(`select public.notification_upsert_v1('system.test_all', 'evt:rollback', $1::jsonb)`, [JSON.stringify(payload())]);
    await db.exec('rollback');
    assert.equal((await deliveries(db)).length, before);
    assert.equal((await rows(db, "select count(*)::int n from notification_private.notifications where dedupe_key='evt:rollback'"))[0].n, 0);
  } finally { await db.close(); }
});

test('send-time gate: resolved, deactivated, login off, role/part change, push off, logout, expiry, owner change', async () => {
  const db = await fixture();
  try {
    const type = 'system.test_all';
    await setPolicy(db, type, { pushEnabled: true, rules: { groups: [{ parts: ['bar'] }, { parts: ['hall'] }] } });
    await subscribe(db, U.leaderBar, ep(1)); await subscribe(db, U.staffBar, ep(2)); await subscribe(db, U.staffHall, ep(3), { iat: IAT + 1 });
    await subscribe(db, U.managerHall, ep(4)); await subscribe(db, U.leaderHall, ep(5));
    const a = await upsert(db, type, 'evt:a');
    assert.equal((await deliveries(db)).length, 5);
    // Changes after enqueue, before sending:
    await db.query('update public.users set is_active=false where id=$1', [U.leaderBar]);
    await db.query('update public.users set app_login_enabled=false where id=$1', [U.staffBar]);
    await call(db, 'notification_push_session_revoke_v1', [U.staffHall, IAT + 1, null]); // logout of that session
    await db.query("update public.users set part='kitchen' where id=$1", [U.managerHall]);
    const c = await claim(db, a.id);
    assert.deepEqual(c.items.map(i => i.notificationId), [a.id]);
    assert.equal(c.items.length, 1, 'only leader hall still qualifies');
    assert.equal(c.skipped, 4);
    const reasons = Object.fromEntries((await deliveries(db)).map(d => [d.u, [d.status, d.e]]));
    assert.deepEqual(reasons, {
      [U.leaderBar]: ['skipped', 'recipient_inactive'], [U.staffBar]: ['skipped', 'recipient_inactive'],
      [U.staffHall]: ['skipped', 'subscription_inactive'], [U.managerHall]: ['skipped', 'not_allowed'], [U.leaderHall]: ['sending', null],
    });
    // Resolved, push switched off, role ceiling, subscription expiry, owner change, TTL.
    const b = await upsert(db, type, 'evt:b');
    await call(db, 'notification_resolve_v1', [b.id, type, 'evt:b', 'business_resolved', j(null)]);
    assert.deepEqual((await claim(db, b.id)).items, []);
    assert.ok((await deliveries(db, `notification_id=${b.id}`)).every(d => d.status === 'skipped' && d.e === 'resolved'));
    const cEvt = await upsert(db, type, 'evt:c');
    await setPolicy(db, type, { pushEnabled: false, rules: { groups: [{ parts: ['hall'] }] } });
    assert.deepEqual((await claim(db, cEvt.id)).items, []);
    assert.ok((await deliveries(db, `notification_id=${cEvt.id}`)).every(d => d.e === 'not_allowed'), 'push turned off after enqueue');
    await setPolicy(db, type, { pushEnabled: true, inAppEnabled: false, rules: { groups: [{ parts: ['hall'] }] } });
    const d = await upsert(db, type, 'evt:d');
    await db.query("update public.users set role='staff' where id=$1", [U.leaderHall]);
    await setPolicy(db, 'sales.test_manager', { pushEnabled: true });
    await subscribe(db, U.managerHall, ep(6)); await db.query("update public.users set part='hall' where id=$1", [U.managerHall]);
    const m = await upsert(db, 'sales.test_manager', 'evt:m');
    await db.query("update public.users set role='staff' where id=$1", [U.managerHall]);
    assert.deepEqual((await claim(db, m.id)).items, [], 'role below the type ceiling');
    assert.equal((await deliveries(db, `notification_id=${m.id}`))[0].e, 'not_allowed');
    const inAppOff = await claim(db, d.id);
    assert.ok(inAppOff.items.length >= 1, 'in-app OFF is not a push condition');
    // Subscription expiry: revoked as expired at claim time.
    await db.query("update public.users set role='leader' where id=$1", [U.leaderHall]);
    const e = await upsert(db, type, 'evt:e');
    await db.query("update notification_private.push_subscriptions set expires_at = now() - interval '1 second' where endpoint=$1 and status='active'", [ep(5)]);
    await claim(db, e.id);
    assert.deepEqual((await subStatus(db, ep(5))).at(-1).r, 'expired');
    // TTL passed.
    const f = await upsert(db, type, 'evt:f');
    await db.query(`update notification_private.push_deliveries set expires_at = now() - interval '1 second' where notification_id=${f.id}`);
    await claim(db, f.id);
    assert.ok((await deliveries(db, `notification_id=${f.id}`)).every(x => x.status === 'expired' && x.e === 'ttl_expired'));
    // Owner change on the device after enqueue: the old owner's delivery is skipped.
    await subscribe(db, U.staffHall, ep(7));
    const g = await upsert(db, type, 'evt:g');
    await subscribe(db, U.leaderHall, ep(7), { iat: IAT + 2 });
    await claim(db, g.id);
    const gd = await deliveries(db, `notification_id=${g.id} and user_id=${U.staffHall}`);
    assert.deepEqual(gd.map(x => x.e), ['subscription_inactive']);
  } finally { await db.close(); }
});

test('claim/report: single claim, lease recovery, stale token, backoff + Retry-After, 3 attempts, gone, permanent, TTL', async () => {
  const db = await fixture();
  try {
    const type = 'system.test_all';
    await setPolicy(db, type, { pushEnabled: true, rules: { groups: [], userIds: [U.owner] } });
    for (let i = 1; i <= 4; i++) await subscribe(db, U.owner, ep(i));
    const evt = await upsert(db, type, 'evt:1');
    const first = await claim(db, evt.id);
    assert.equal(first.items.length, 4);
    const item = first.items[0];
    assert.deepEqual(Object.keys(item).sort(), ['attempt', 'auth', 'claimToken', 'deliveryId', 'endpoint', 'lang', 'leaseSeconds', 'notificationId', 'p256dh', 'severity', 'ttlSeconds', 'typeCode', 'unreadCount'].sort());
    assert.equal(item.attempt, 1); assert.ok(item.ttlSeconds > 3500 && item.ttlSeconds <= 3600); assert.equal(item.unreadCount, 1);
    assert.deepEqual((await claim(db, evt.id)).items, [], 'claimed rows are not claimed twice');
    assert.deepEqual((await claim(db)).items, [], 'recovery does not steal a live claim');
    const [i1, i2, i3, i4] = first.items;
    // accepted
    assert.equal((await report(db, i1, 'accepted', 201)).delivery, 'accepted');
    assert.equal((await report(db, i1, 'accepted', 201)).status, 'stale', 'a second report is stale');
    // gone -> subscription revoked
    assert.equal((await report(db, i2, 'gone', 410, null, 'subscription_gone')).delivery, 'failed');
    assert.deepEqual((await subStatus(db, ep(2))).map(r => r.r), ['gone']);
    // permanent (401/403/config) -> no retry
    assert.equal((await report(db, i3, 'failed', 403, null, 'vapid_rejected')).delivery, 'failed');
    // retry: 1 min, then max(5 min, Retry-After), then exhausted after 3 attempts
    const r1 = await report(db, i4, 'retry', 503, null, 'push_service_error');
    assert.equal(r1.delivery, 'pending');
    const [{ wait1 }] = await rows(db, `select round(extract(epoch from (next_attempt_at - now())))::int wait1 from notification_private.push_deliveries where id=${i4.deliveryId}`);
    assert.ok(wait1 >= 58 && wait1 <= 60, String(wait1));
    assert.deepEqual((await claim(db)).items, [], 'not due before the backoff');
    await due(db);
    const second = (await claim(db)).items;
    assert.deepEqual([second.length, second[0].attempt], [1, 2]);
    await report(db, second[0], 'retry', 429, 900, 'rate_limited');
    const [{ wait2 }] = await rows(db, `select round(extract(epoch from (next_attempt_at - now())))::int wait2 from notification_private.push_deliveries where id=${i4.deliveryId}`);
    assert.ok(wait2 >= 898 && wait2 <= 900, 'Retry-After longer than the 5 min backoff is honoured');
    await due(db);
    const third = (await claim(db)).items;
    assert.equal(third[0].attempt, 3);
    assert.equal((await report(db, third[0], 'retry', 500)).delivery, 'failed');
    const final = await deliveries(db);
    assert.deepEqual(final.map(d => [d.status, d.a, d.e, d.h]), [
      ['accepted', 1, null, 201], ['failed', 1, 'subscription_gone', 410], ['failed', 1, 'vapid_rejected', 403], ['failed', 3, 'retry_exhausted', 500]]);
    await due(db);
    assert.deepEqual((await claim(db)).items, [], 'finished rows never re-claimed');

    // Lease recovery: the sender died after the push service accepted (no report). After the lease
    // the row is re-claimed with a new token (possible duplicate, same topic/tag); the old token is stale.
    const evt2 = await upsert(db, type, 'evt:2');
    const lost = (await claim(db, evt2.id)).items[0];
    await db.query(`update notification_private.push_deliveries set claimed_at = now() - interval '10 minutes' where id=${lost.deliveryId}`);
    const again = (await claim(db)).items.find(x => x.deliveryId === lost.deliveryId);
    assert.ok(again && again.claimToken !== lost.claimToken && again.attempt === 2);
    assert.equal((await report(db, lost, 'accepted', 201)).status, 'stale', 'the lost claim can no longer write');
    assert.equal((await report(db, again, 'accepted', 201)).delivery, 'accepted');
    // After 3 claims without any report the result is unknown -> failed, never claimed a 4th time.
    const evt3 = await upsert(db, type, 'evt:3');
    const pending = (await claim(db, evt3.id)).items[0];
    for (let n = 0; n < 3; n++) {
      await db.query(`update notification_private.push_deliveries set claimed_at = now() - interval '10 minutes' where id=${pending.deliveryId}`);
      await claim(db);
    }
    const [unknown] = await deliveries(db, `id=${pending.deliveryId}`);
    assert.deepEqual([unknown.status, unknown.a, unknown.e], ['failed', 3, 'result_unknown']);
    // A retry that would land after the TTL expires instead of waiting.
    const evt4 = await upsert(db, type, 'evt:4');
    const late = (await claim(db, evt4.id)).items[0];
    await db.query(`update notification_private.push_deliveries set expires_at = now() + interval '30 seconds' where id=${late.deliveryId}`);
    await report(db, late, 'retry', null, null, 'network_error');
    const [exp] = await deliveries(db, `id=${late.deliveryId}`);
    assert.deepEqual([exp.status, exp.e], ['expired', 'ttl_expired']);
    // Input validation.
    assert.equal((await call(db, 'notification_push_claim_v1', [null, 0, 120])).status, 'invalid_input');
    assert.equal((await call(db, 'notification_push_claim_v1', [null, 10, 30])).status, 'invalid_input', 'lease below 60 s');
    assert.equal((await call(db, 'notification_push_claim_v1', [null, 21, 120])).status, 'invalid_input', 'batch above 20');
    assert.equal((await report(db, late, 'delivered')).status, 'invalid_input');
    assert.equal((await report(db, late, 'failed', null, null, 'Bad Code')).status, 'invalid_input');
  } finally { await db.close(); }
});

test('click re-check: recipient + a currently allowed channel; returns the internal path only', async () => {
  const db = await fixture();
  try {
    const type = 'sales.test_manager';
    await setPolicy(db, type, { pushEnabled: true, inAppEnabled: false });
    const evt = await upsert(db, type, 'evt:1', { href: '/admin/sales?tab=deductions' });
    const open = await call(db, 'notification_push_open_v1', [U.managerHall, evt.id]);
    assert.deepEqual(open, { status: 'ok', href: '/admin/sales?tab=deductions' }, 'push-only channel can open');
    assert.equal((await call(db, 'notification_push_open_v1', [U.staffBar, evt.id])).status, 'not_found', 'not a recipient');
    await setPolicy(db, type, { pushEnabled: false, inAppEnabled: false });
    assert.equal((await call(db, 'notification_push_open_v1', [U.managerHall, evt.id])).status, 'not_found', 'no channel allowed now');
    await setPolicy(db, type, { pushEnabled: false, inAppEnabled: true });
    assert.equal((await call(db, 'notification_push_open_v1', [U.managerHall, evt.id])).status, 'ok');
    await db.query("update public.users set role='staff' where id=$1", [U.managerHall]);
    assert.equal((await call(db, 'notification_push_open_v1', [U.managerHall, evt.id])).status, 'not_found', 'permission lost');
    await db.query('update public.users set is_active=false where id=$1', [U.managerHall]);
    assert.equal((await call(db, 'notification_push_open_v1', [U.managerHall, evt.id])).status, 'forbidden');
    // Push receipt / click never changes read or business state.
    const [r] = await rows(db, 'select count(*) filter (where read_at is not null)::int n from notification_private.recipients');
    assert.equal(r.n, 0);
  } finally { await db.close(); }
});

test('session lifecycle: logout revokes that session only; refresh extends that session only', async () => {
  const db = await fixture();
  try {
    await subscribe(db, U.owner, ep(1), { iat: IAT, exp: inDays(3) });
    await subscribe(db, U.owner, ep(2), { iat: IAT + 100, exp: inDays(3) });
    const touched = await call(db, 'notification_push_session_touch_v1', [U.owner, IAT, ts(inDays(30))]);
    assert.equal(touched.updated, 1);
    assert.equal((await call(db, 'notification_push_session_touch_v1', [U.owner, IAT, ts(inDays(10))])).updated, 0, 'never shortens');
    assert.equal((await call(db, 'notification_push_session_touch_v1', [U.owner, IAT, ts(inDays(400))])).status, 'invalid_input');
    const exps = await rows(db, "select endpoint, round(extract(epoch from (expires_at - now()))/86400)::int d from notification_private.push_subscriptions order by id");
    assert.deepEqual(exps.map(e => e.d), [30, 3]);
    assert.equal((await call(db, 'notification_push_session_revoke_v1', [U.owner, IAT, null])).revoked, 1);
    assert.deepEqual((await subStatus(db, ep(1))).map(r => r.r), ['logout']);
    assert.deepEqual((await subStatus(db, ep(2))).map(r => r.status), ['active'], 'other device of the same user untouched');
    assert.equal((await call(db, 'notification_push_session_revoke_v1', [U.owner, null, null])).status, 'invalid_input');
  } finally { await db.close(); }
});

test('01B-FINAL logout/registration races: revocation markers, per-device scope, newer session wins, failed replacement keeps rows', async () => {
  const db = await fixture();
  const D1 = 'a'.repeat(43), D2 = 'b'.repeat(43);
  try {
    // Logout of device D1 (session IAT) then a late registration from D1: refused, nothing active.
    assert.equal((await call(db, 'notification_push_session_revoke_v1', [U.owner, IAT, D1])).status, 'ok');
    assert.equal((await subscribe(db, U.owner, ep(1), { device: D1 })).status, 'session_revoked');
    assert.equal((await sync(db, U.owner, IAT, inDays(30), ep(1), 'ko', D1)).status, 'session_revoked');
    assert.equal((await call(db, 'notification_push_status_v1', [U.owner])).activeDevices, 0);
    // Same user, same session second, another device D2: unaffected by D1's logout.
    assert.equal((await subscribe(db, U.owner, ep(2), { device: D2 })).status, 'ok');
    // Logout without a device cookie: the whole session (every device) is revoked and blocked.
    assert.equal((await call(db, 'notification_push_session_revoke_v1', [U.owner, IAT, null])).revoked, 1);
    assert.equal((await subscribe(db, U.owner, ep(3), { device: D2 })).status, 'session_revoked');
    // A new login (new session) registers normally.
    assert.equal((await subscribe(db, U.owner, ep(3), { iat: IAT + 60, device: D2 })).status, 'ok');

    // Account switch A (older session) -> B (newer session) on one endpoint; A's late requests change nothing.
    await subscribe(db, U.staffBar, ep(10), { iat: IAT + 100 });
    assert.equal((await subscribe(db, U.staffHall, ep(10), { iat: IAT + 200 })).status, 'ok');
    assert.equal((await subscribe(db, U.staffBar, ep(10), { iat: IAT + 100 })).status, 'superseded', 'late A subscribe');
    assert.equal((await sync(db, U.staffBar, IAT + 100, inDays(30), ep(10))).device, 'superseded', 'late A sync');
    assert.deepEqual((await subStatus(db, ep(10))).filter(r => r.status === 'active').map(r => r.u), [U.staffHall], 'B kept');
    // Same second, different accounts: the requester (the browser's current account) takes over -- a
    // late request can at worst stop pushes, never deliver one account's alerts to another.
    await subscribe(db, U.leaderBar, ep(11), { iat: IAT + 300 });
    assert.equal((await subscribe(db, U.leaderHall, ep(11), { iat: IAT + 300 })).status, 'ok');
    assert.deepEqual((await subStatus(db, ep(11))).map(r => [r.u, r.status, r.r]), [[U.leaderBar, 'revoked', 'owner_changed'], [U.leaderHall, 'active', null]]);
    assert.equal((await sync(db, U.leaderBar, IAT + 300, inDays(30), ep(11))).device, 'foreign', 'same-second sync of the other account also takes over');

    // Failed replacement (invalid new keys) keeps the existing registration and the renewal source.
    await subscribe(db, U.managerHall, ep(20));
    assert.equal((await subscribe(db, U.managerHall, ep(20), { p256dh: 'bad' })).status, 'invalid_input');
    assert.equal((await subscribe(db, U.managerHall, ep(21), { old: ep(20), auth: 'x' })).status, 'invalid_input');
    assert.deepEqual((await subStatus(db, ep(20))).map(r => r.status), ['active'], 'nothing revoked by the failed attempts');
    assert.equal((await subStatus(db, ep(21))).length, 0);
    assert.equal((await subscribe(db, U.managerHall, ep(20), { device: 'short' })).status, 'invalid_input');
  } finally { await db.close(); }
});

test('01B-FINAL sync writes only on change; language follows the app', async () => {
  const db = await fixture();
  try {
    await subscribe(db, U.owner, ep(1), { exp: inDays(20), lang: 'ko' });
    const stamp = async () => (await rows(db, "select updated_at, lang, xmin::text x from notification_private.push_subscriptions where status='active'"))[0];
    const exp = (await rows(db, "select expires_at from notification_private.push_subscriptions where status='active'"))[0].expires_at.toISOString();
    const before = await stamp();
    for (let i = 0; i < 3; i++) assert.equal((await sync(db, U.owner, IAT, exp, ep(1), 'ko')).device, 'registered');
    assert.deepEqual(await stamp(), before, 'identical sync = no row write');
    assert.equal((await sync(db, U.owner, IAT, exp, ep(1), 'vi')).device, 'registered');
    const after = await stamp();
    assert.equal(after.lang, 'vi'); assert.notEqual(after.x, before.x, 'language change written');
    assert.equal((await sync(db, U.owner, IAT, exp, ep(1), null)).device, 'registered');
    assert.equal((await stamp()).x, after.x, 'no language given = keep');
  } finally { await db.close(); }
});

test('01B-FINAL recovery gate + small batches: idle queue costs no write, one scan per 60 s, batch cap, TTL margin', async () => {
  const db = await fixture();
  try {
    const runtime = async () => (await rows(db, 'select recovery_started_at::text t, xmin::text x from notification_private.push_runtime'))[0];
    const idle = await runtime();
    for (let i = 0; i < 5; i++) {
      const r = await call(db, 'notification_push_claim_v1', [null, 5, 90]);
      assert.deepEqual([r.items.length, r.idle], [0, true]);
    }
    assert.deepEqual(await runtime(), idle, 'empty queue: no gate write');
    const type = 'system.test_all';
    await setPolicy(db, type, { pushEnabled: true, rules: { groups: [], userIds: [U.owner] } });
    for (let i = 1; i <= 8; i++) await subscribe(db, U.owner, ep(i));
    const evt = await upsert(db, type, 'evt:gate');
    const first = await call(db, 'notification_push_claim_v1', [null, 5, 90]);
    assert.equal(first.items.length, 5, 'batch cap honoured');
    assert.notEqual((await runtime()).t, idle.t, 'gate taken');
    const second = await call(db, 'notification_push_claim_v1', [null, 5, 90]);
    assert.deepEqual([second.items.length, second.throttled], [0, true], 'another instance within 60 s is throttled');
    // Event dispatch is not gated (just-in-time rounds of the same event).
    assert.equal((await claim(db, evt.id, 5, 90)).items.length, 3);
    // TTL margin: less than 5 s left = expired at claim, never handed to the sender.
    const evt2 = await upsert(db, type, 'evt:ttl');
    await db.query(`update notification_private.push_deliveries set expires_at = now() + interval '3 seconds' where notification_id=${evt2.id}`);
    const c = await claim(db, evt2.id, 20, 90);
    assert.equal(c.items.length, 0);
    assert.ok((await deliveries(db, `notification_id=${evt2.id}`)).every(d => d.status === 'expired' && d.e === 'ttl_expired'));
    // Sender-side TTL check reports "expired" (no send).
    const evt3 = await upsert(db, type, 'evt:report-expired');
    const one = (await claim(db, evt3.id, 1, 90)).items[0];
    assert.equal((await report(db, one, 'expired', null, null, 'ttl_expired')).delivery, 'expired');
    // Per-user unread count computed once per batch and identical across that user's devices.
    const evt4 = await upsert(db, type, 'evt:badge');
    const batch = (await claim(db, evt4.id, 5, 90)).items;
    assert.equal(new Set(batch.map(i => i.unreadCount)).size, 1);
  } finally { await db.close(); }
});
