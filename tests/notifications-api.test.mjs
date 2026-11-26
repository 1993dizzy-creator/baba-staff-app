// Notification API routes over a signed server session, with RPCs executed on PGlite (real
// migration). Covers auth (logged out / inactive / role), cross-user and id tampering, body
// validation, owner/master settings, DB-not-installed and DB-failure behavior, cache headers,
// and the absence of any browser route that creates or resolves notifications.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { loadTs, authHarness, nextMock } from './helpers/sales-auth-harness.mjs';
import { baseSql, migration, testTypesSql, U, payload } from './helpers/notification-fixture.mjs';
import * as types from '../lib/notifications/types.ts';
import * as rules from '../lib/notifications/rules.ts';

const ORDER = {
  notification_unread_count_v1: ['p_actor_user_id'],
  notification_list_v1: ['p_actor_user_id', 'p_filter', 'p_before_id', 'p_limit'],
  notification_mark_read_v1: ['p_actor_user_id', 'p_notification_id'],
  notification_mark_all_read_v1: ['p_actor_user_id', 'p_up_to_id'],
  notification_policy_list_v1: ['p_actor_user_id'],
  notification_policy_update_v1: ['p_actor_user_id', 'p_type_code', 'p_expected_revision', 'p_policy'],
  notification_upsert_v1: ['p_type_code', 'p_dedupe_key', 'p_payload'],
  notification_resolve_v1: ['p_type_code', 'p_dedupe_key', 'p_reason', 'p_evidence'],
};
const JSONB = new Set(['p_policy', 'p_payload', 'p_evidence']);

async function database() {
  const db = new PGlite();
  await db.exec(baseSql); await db.exec(migration); await db.exec(testTypesSql);
  return db;
}
async function execRpc(db, name, args) {
  const keys = ORDER[name];
  await db.exec('set role service_role');
  try {
    const sql = `select public.${name}(${keys.map((k, i) => `$${i + 1}${JSONB.has(k) ? '::jsonb' : ''}`).join(',')}) r`;
    return (await db.query(sql, keys.map(k => (JSONB.has(k) && args[k] != null ? JSON.stringify(args[k]) : args[k] ?? null)))).rows[0].r;
  } finally { await db.exec('reset role'); }
}

function harness(db) {
  const h = authHarness();
  const calls = [];
  let mode = 'db';
  const supabaseServer = {
    rpc(name, args) {
      calls.push(name);
      const run = async () => {
        if (mode === 'missing') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
        if (mode === 'error') return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
        if (mode === 'throw') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
        try { return { data: await execRpc(db, name, args), error: null }; }
        catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
      };
      return { abortSignal: () => run() };
    },
  };
  const server = loadTs('lib/notifications/server.ts', {
    'server-only': {}, 'next/server': nextMock, '@/lib/auth/server-auth': h.auth,
    '@/lib/supabase/server': { supabaseServer }, './types.ts': types,
  });
  const mocks = { '@/lib/notifications/server': server, '@/lib/notifications/types': types, '@/lib/notifications/rules': rules };
  const routes = {
    summary: loadTs('app/api/notifications/summary/route.ts', mocks),
    list: loadTs('app/api/notifications/route.ts', mocks),
    read: loadTs('app/api/notifications/read/route.ts', mocks),
    settings: loadTs('app/api/admin/notification-settings/route.ts', mocks),
  };
  const send = async (route, method, { query = '', body } = {}) => {
    const init = { method, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) };
    const response = await routes[route][method](new Request(`https://offline.invalid/api/x${query}`, init));
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return {
    h, calls, server, send, setMode(v) { mode = v; },
    login(id, role, extra = {}) { h.setActor({ id, role, is_active: true, app_login_enabled: true, ...extra }); h.sign(id); },
    logout() { h.setToken(undefined); },
  };
}
const withSecret = async fn => {
  const old = process.env.BABA_SESSION_SECRET;
  process.env.BABA_SESSION_SECRET = 'offline-notification-session-secret-32-chars';
  try { await fn(); } finally { if (old === undefined) delete process.env.BABA_SESSION_SECRET; else process.env.BABA_SESSION_SECRET = old; }
};
const seed = async (db, key, extra) => execRpc(db, 'notification_upsert_v1', { p_type_code: 'system.test_all', p_dedupe_key: key, p_payload: payload(extra) });

test('logged out, inactive and login-disabled sessions are refused by every route', () => withSecret(async () => {
  const db = await database();
  try {
    const a = harness(db);
    const all = [['summary', 'GET'], ['list', 'GET'], ['read', 'POST', { id: 1 }], ['settings', 'GET'], ['settings', 'PUT',
      { typeCode: 'system.test_all', expectedRevision: 1, enabled: true, inAppEnabled: true, rules: { groups: [] } }]];
    for (const [route, method, body] of all) assert.equal((await a.send(route, method, { body })).status, 401, `${route} ${method} logged out`);
    a.login(U.staffBar, 'staff', { is_active: false });
    for (const [route, method, body] of all) assert.equal((await a.send(route, method, { body })).status, 401, `${route} inactive`);
    a.login(U.staffBar, 'staff', { app_login_enabled: false });
    assert.equal((await a.send('summary', 'GET')).status, 401);
    assert.equal(a.calls.length, 0, 'no RPC reached without a valid actor');
  } finally { await db.close(); }
}));

test('own notifications only: summary, list, read, mark-all; other ids and extra fields are refused', () => withSecret(async () => {
  const db = await database();
  try {
    const a = harness(db);
    await execRpc(db, 'notification_policy_update_v1', { p_actor_user_id: U.owner, p_type_code: 'system.test_all', p_expected_revision: 1,
      p_policy: { enabled: true, inAppEnabled: true, rules: { groups: [{ roles: ['staff'], parts: ['bar'] }] } } });
    const mine = await seed(db, 'mine');
    await execRpc(db, 'notification_policy_update_v1', { p_actor_user_id: U.owner, p_type_code: 'system.test_all', p_expected_revision: 2,
      p_policy: { enabled: true, inAppEnabled: true, rules: { groups: [{ roles: ['staff'] }] } } });
    const shared = await seed(db, 'shared');
    await execRpc(db, 'notification_policy_update_v1', { p_actor_user_id: U.owner, p_type_code: 'system.test_all', p_expected_revision: 3,
      p_policy: { enabled: true, inAppEnabled: true, rules: { groups: [{ roles: ['staff'] }], userIds: [U.owner] } } });
    const ownerOnly = await execRpc(db, 'notification_upsert_v1', { p_type_code: 'sales.test_manager', p_dedupe_key: 'owner', p_payload: payload() });

    a.login(U.staffBar, 'staff');
    const summary = await a.send('summary', 'GET');
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.body, { ok: true, available: true, unreadCount: 2, capped: false });
    assert.equal(summary.headers.get('Cache-Control'), 'private, no-store, max-age=0');
    assert.equal(summary.headers.get('Vary'), 'Cookie');
    const list = await a.send('list', 'GET', { query: '?filter=unread&user_id=1&role=owner' });
    assert.deepEqual(list.body.items.map(i => i.id), [shared.id, mine.id], 'client-supplied identity params are ignored');
    assert.equal((await a.send('read', 'POST', { body: { id: ownerOnly.id } })).status, 404, 'manager type is outside staff access');
    assert.equal((await a.send('read', 'POST', { body: { id: 999999 } })).status, 404);
    for (const body of [{ id: mine.id, userId: U.owner }, { id: '1' }, { id: -1 }, { all: true }, { all: true, upToId: 5, userId: 1 }, [], 'x']) {
      assert.equal((await a.send('read', 'POST', { body })).status, 400, JSON.stringify(body));
    }
    const read = await a.send('read', 'POST', { body: { id: mine.id } });
    assert.equal(read.status, 200); assert.ok(read.body.item.readAt);
    assert.equal(read.body.item.status, 'open', 'reading does not resolve');
    assert.equal((await a.send('summary', 'GET')).body.unreadCount, 1);

    a.login(U.staffHall, 'staff');
    assert.equal((await a.send('read', 'POST', { body: { id: mine.id } })).status, 404, 'not a recipient of the bar-only event');
    assert.deepEqual((await a.send('summary', 'GET')).body.unreadCount, 1, 'staff hall: only the shared one');
    const all = await a.send('read', 'POST', { body: { all: true, upToId: shared.id } });
    assert.deepEqual([all.status, all.body.updated], [200, 1]);
    a.login(U.staffBar, 'staff');
    assert.equal((await a.send('summary', 'GET')).body.unreadCount, 1, "another user's mark-all never touches mine");
    assert.equal((await a.send('list', 'GET', { query: '?filter=bogus' })).status, 400);
    assert.equal((await a.send('list', 'GET', { query: '?before=0' })).status, 400);
    assert.equal((await a.send('list', 'GET', { query: '?before=abc' })).status, 400);
  } finally { await db.close(); }
}));

test('settings: owner/master only; validation; revision conflict; staff never reaches the RPC', () => withSecret(async () => {
  const db = await database();
  try {
    const a = harness(db);
    for (const [id, role] of [[U.managerHall, 'manager'], [U.leaderBar, 'leader'], [U.staffBar, 'staff']]) {
      a.login(id, role);
      assert.equal((await a.send('settings', 'GET')).status, 403, role);
      assert.equal((await a.send('settings', 'PUT', { body: { typeCode: 'system.test_all', expectedRevision: 1, enabled: true, inAppEnabled: true, rules: { groups: [] } } })).status, 403);
    }
    assert.equal(a.calls.length, 0);
    a.login(U.master, 'master');
    const got = await a.send('settings', 'GET');
    assert.equal(got.status, 200);
    assert.ok(got.body.types.some(t => t.code === 'attendance.leave_request_pending'));
    assert.ok(got.body.staff.every(s => ![U.staffKitchenInactive, U.staffHallNoLogin].includes(s.id)));
    const body = { typeCode: 'inventory.pos_deduction_pending', expectedRevision: 1, enabled: true, inAppEnabled: true,
      rules: { groups: [{ roles: ['leader'], parts: ['bar'] }, { roles: ['manager'] }], userIds: [U.owner] } };
    for (const bad of [{ ...body, pushEnabled: true }, { ...body, rules: { groups: [{ parts: ['garden'] }] } }, { ...body, expectedRevision: 0 },
      { ...body, typeCode: 'Bad Code' }, { ...body, rules: { groups: [], userIds: ['1'] } }, { ...body, enabled: 'true' }]) {
      assert.equal((await a.send('settings', 'PUT', { body: bad })).status, 400, JSON.stringify(bad));
    }
    const saved = await a.send('settings', 'PUT', { body });
    assert.deepEqual([saved.status, saved.body.revision], [200, 2]);
    a.login(U.owner, 'owner');
    const stale = await a.send('settings', 'PUT', { body });
    assert.deepEqual([stale.status, stale.body.code, stale.body.latestRevision], [409, 'VERSION_CONFLICT', 2]);
    // A forged role in the cached user does not matter: the DB re-derives it.
    a.login(U.managerHall, 'owner');
    await db.query("update public.users set role='manager' where id=$1", [U.managerHall]);
    const forged = await a.send('settings', 'GET');
    assert.equal(forged.status, 403, 'server reads role from users, RPC re-checks it');
  } finally { await db.close(); }
}));

test('DB not installed: feature reports unavailable instead of 0; failures are 503, never a zero count', () => withSecret(async () => {
  const db = await database();
  try {
    const a = harness(db);
    a.login(U.owner, 'owner');
    a.setMode('missing');
    assert.deepEqual((await a.send('summary', 'GET')).body, { ok: true, available: false });
    assert.deepEqual((await a.send('list', 'GET')).body, { ok: true, available: false });
    assert.deepEqual((await a.send('settings', 'GET')).body, { ok: true, available: false });
    const put = await a.send('settings', 'PUT', { body: { typeCode: 'system.test_all', expectedRevision: 1, enabled: true, inAppEnabled: true, rules: { groups: [] } } });
    assert.deepEqual([put.status, put.body.code], [503, 'NOTIFICATIONS_DB_PENDING']);
    assert.deepEqual(await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'k', titleKo: 'a', titleVi: 'b' }), { status: 'not_installed' });
    for (const mode of ['error', 'throw']) {
      a.setMode(mode);
      const failed = await a.send('summary', 'GET');
      assert.equal(failed.status, 503, mode);
      assert.equal(failed.body.ok, false);
      assert.ok(!('unreadCount' in failed.body), 'a failure is never reported as a count');
      assert.equal((await a.send('list', 'GET')).status, 503);
    }
  } finally { await db.close(); }
}));

test('server-internal writer validates before the DB; no browser route can create or resolve notifications', () => withSecret(async () => {
  const db = await database();
  try {
    const a = harness(db);
    const bad = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'k', titleKo: 'a', titleVi: 'b', href: 'https://evil.test' });
    assert.deepEqual(bad, { status: 'invalid_input' });
    assert.equal(a.calls.length, 0);
    const created = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'writer:1', titleKo: '알림', titleVi: 'TB', href: '/admin/sales' });
    assert.equal(created.status, 'created');
    assert.equal((await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'writer:1', titleKo: '알림', titleVi: 'TB' })).status, 'observed');
    assert.deepEqual(await a.server.resolveNotification({ typeCode: 'system.test_all', dedupeKey: 'writer:1', reason: 'business_resolved' }), { status: 'resolved', id: created.id });
    // No route file references the writer RPCs or helpers.
    const files = [];
    const walk = dir => { for (const name of readdirSync(dir)) { const p = path.join(dir, name); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
    walk('app');
    const offenders = files.filter(f => /\.(ts|tsx)$/.test(f) && /notification_upsert_v1|notification_resolve_v1|upsertNotification|resolveNotification/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, []);
  } finally { await db.close(); }
}));
