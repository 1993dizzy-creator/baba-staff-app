// BABA-NOTIFICATION-01B routes + sender over real signed sessions and PGlite (01-A + 01-B migrations).
// The push service is mocked: every "send" is turned into the real web-push request (VAPID JWT,
// aes128gcm encryption, TTL/Topic/Urgency headers) and decrypted with the test device's private key,
// exactly as a browser would, but nothing leaves the process. Mock PASS != real-device delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { loadTs, authHarness } from './helpers/sales-auth-harness.mjs';
import { baseSql, testTypesSql, U, MIGRATION_FILE, PUSH_MIGRATION_FILE } from './helpers/notification-fixture.mjs';
import * as types from '../lib/notifications/types.ts';
import * as rules from '../lib/notifications/rules.ts';

const require = createRequire(import.meta.url);
const realWebpush = require('web-push');
const ece = require('http_ece');
const CAST = { p_payload: '::jsonb', p_policy: '::jsonb', p_evidence: '::jsonb', p_session_expires_at: '::timestamptz', p_claim_token: '::uuid' };

async function database({ push = true } = {}) {
  const db = new PGlite();
  await db.exec(baseSql); await db.exec(readFileSync(MIGRATION_FILE, 'utf8')); await db.exec(testTypesSql);
  if (push) await db.exec(readFileSync(PUSH_MIGRATION_FILE, 'utf8'));
  return db;
}
async function execRpc(db, name, args) {
  const entries = Object.entries(args);
  await db.exec('set role service_role');
  try {
    const sql = `select public.${name}(${entries.map(([k], i) => `${k} => $${i + 1}${CAST[k] ?? ''}`).join(',')}) r`;
    return (await db.query(sql, entries.map(([k, v]) => (CAST[k] === '::jsonb' && v != null ? JSON.stringify(v) : v ?? null)))).rows[0].r;
  } finally { await db.exec('reset role'); }
}
const rows = async (db, sql, args = []) => (await db.query(sql, args)).rows;

function device() {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const auth = randomBytes(16);
  const n = randomBytes(6).toString('hex');
  return { ecdh, authBytes: auth, json: { endpoint: `https://fcm.googleapis.com/fcm/send/dev-${n}:APA91b`, expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey('base64url'), auth: auth.toString('base64url') } } };
}

function harness(db) {
  const h = authHarness();
  const calls = []; const afterQueue = []; const sent = []; const logs = [];
  let claimDelayMs = 0;
  let mode = 'db'; let responder = () => ({ statusCode: 201, headers: {} });
  const supabaseServer = {
    rpc(name, args) {
      calls.push(name);
      const run = async () => {
        if (name === 'notification_push_claim_v1' && claimDelayMs) await new Promise(r => setTimeout(r, claimDelayMs));
        if (mode === 'missing' && (name.startsWith('notification_push') || name === 'notification_upsert_v1'))
          return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
        try { return { data: await execRpc(db, name, args), error: null }; }
        catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
      };
      return { abortSignal: () => run() };
    },
  };
  const devices = new Map();
  const webpush = {
    async sendNotification(subscription, body, options) {
      // The real library builds the request (throws on bad VAPID/keys/options) ...
      const details = realWebpush.generateRequestDetails(subscription, body, options);
      // ... and the "browser" decrypts it with its own private key.
      const dev = devices.get(subscription.endpoint);
      const plain = dev ? JSON.parse(ece.decrypt(details.body, { version: 'aes128gcm', privateKey: dev.ecdh, authSecret: dev.authBytes }).toString('utf8')) : null;
      sent.push({ endpoint: subscription.endpoint, headers: details.headers, plain, timeout: options.timeout });
      const result = await responder(subscription, sent.length);
      if (result instanceof Error) throw result;
      if (result.statusCode >= 200 && result.statusCode < 300) return { statusCode: result.statusCode, headers: result.headers ?? {}, body: '' };
      throw Object.assign(new Error('Received unexpected response code'), { name: 'WebPushError', statusCode: result.statusCode, headers: result.headers ?? {}, endpoint: subscription.endpoint, body: 'x' });
    },
  };
  // Browser cookie jar for the push device cookie (httpOnly, set by the push routes).
  const jar = { device: null, set: [] };
  let currentUser = null;
  const NextResponse = { json: (body, init) => Object.assign(Response.json(body, init), { cookies: { set(c) {
    jar.set.push(c.name); if (c.name === 'baba_push_device') jar.device = c.value; } } }) };
  const nextServer = { NextResponse, after: fn => { afterQueue.push(fn); } };
  const config = loadTs('lib/notifications/push/config.ts', { 'server-only': {} });
  const endpoint = loadTs('lib/notifications/push/endpoint.ts');
  const messages = loadTs('lib/notifications/push/messages.ts');
  const request = loadTs('lib/notifications/push/request.ts');
  const deviceMod = loadTs('lib/notifications/push/device.ts');
  const push = loadTs('lib/notifications/push/server.ts', {
    'server-only': {}, 'next/server': nextServer, 'web-push': webpush, '@/lib/supabase/server': { supabaseServer },
    './config.ts': config, './endpoint.ts': endpoint, './messages.ts': messages, './device.ts': deviceMod,
  });
  const server = loadTs('lib/notifications/server.ts', {
    'server-only': {}, 'next/server': { NextResponse }, '@/lib/auth/server-auth': h.auth, '@/lib/supabase/server': { supabaseServer },
    './types.ts': types, './push/server.ts': push,
  });
  const cookies = [];
  const sessionMod = {
    readServerSession: async () => h.tokens.verifyServerSessionToken(h.token()),
    clearServerSessionCookie: () => cookies.push('clear'),
    refreshServerSessionCookie: (_r, p) => { const next = h.tokens.refreshServerSessionPayload(p); if (next) cookies.push(['set', next.exp]); return next; },
  };
  const mocks = {
    '@/lib/notifications/server': server, '@/lib/notifications/types': types, '@/lib/notifications/rules': rules,
    '@/lib/auth/server-auth': h.auth, '@/lib/notifications/push/config': config, '@/lib/notifications/push/endpoint': endpoint,
    '@/lib/notifications/push/request': request, '@/lib/notifications/push/server': push, '@/lib/auth/server-session': sessionMod,
    '@/lib/notifications/push/device': deviceMod, 'next/server': { NextResponse },
  };
  const routes = {
    push: loadTs('app/api/notifications/push/route.ts', mocks),
    open: loadTs('app/api/notifications/push/open/route.ts', mocks),
    summary: loadTs('app/api/notifications/summary/route.ts', mocks),
    logout: loadTs('app/api/logout/route.ts', mocks),
    session: loadTs('app/api/session/route.ts', mocks),
  };
  const send = async (route, method, { query = '', body, headers = {}, raw } = {}) => {
    const init = { method, headers: { ...(jar.device ? { cookie: `baba_push_device=${jar.device}` } : {}), ...headers } };
    if (body !== undefined || raw !== undefined) {
      init.body = raw ?? JSON.stringify(body);
      init.headers = { 'content-type': 'application/json', origin: 'https://app.invalid', ...init.headers };
    }
    const response = await routes[route][method](new Request(`https://app.invalid/api/x${query}`, init));
    return { status: response.status, body: await response.json() };
  };
  const flushAfter = async () => { while (afterQueue.length) await afterQueue.shift()(); };
  return {
    h, calls, sent, server, push, send, afterQueue, flushAfter, cookies, logs, devices, jar,
    setMode(v) { mode = v; }, respond(fn) { responder = fn; }, claimDelay(ms) { claimDelayMs = ms; },
    // Every login is a new session with its own (past, valid) second, as in real use.
    login(id, role, extra = {}, now = Math.floor(Date.now() / 1000) - 3600 + (++loginSeq)) {
      h.setActor({ id, role, is_active: true, app_login_enabled: true, ...extra });
      h.setToken(h.tokens.createServerSessionToken(id, now));
      // As the login route does: this browser moves to its next signed push generation.
      const previous = jar.device ? deviceMod.readPushDevice(new Request('https://app.invalid/', { headers: { cookie: `baba_push_device=${jar.device}` } })) : null;
      jar.device = deviceMod.pushDeviceCookie(deviceMod.nextPushDevice(previous, { uid: id, iat: now })).value;
      currentUser = id;
    },
    logout() { h.setToken(undefined); },
    async register(dev, lang = 'ko', { expectUserId = currentUser ?? 1, cookie } = {}) {
      devices.set(dev.json.endpoint, dev);
      return send('push', 'POST', { body: { action: 'subscribe', subscription: dev.json, lang, expectUserId },
        ...(cookie !== undefined ? { headers: { cookie: cookie ? `baba_push_device=${cookie}` : '' } } : {}) });
    },
  };
}

let loginSeq = 0;
const ungate = db => db.query("update notification_private.push_runtime set recovery_started_at = '-infinity'");
const VAPID = realWebpush.generateVAPIDKeys(); // test-only, generated in memory, never stored
const ENV_KEYS = ['BABA_SESSION_SECRET', 'WEB_PUSH_ENABLED', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'];
async function withEnv(values, fn) {
  const old = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { BABA_SESSION_SECRET: 'offline-notification-session-secret-32-chars', ...values });
  try { await fn(); } finally { for (const k of ENV_KEYS) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}
const PUSH_ON = { WEB_PUSH_ENABLED: 'true', VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey, VAPID_SUBJECT: 'mailto:ops@example.invalid' };
async function enablePushPolicy(db, type = 'system.test_all', extra = {}) {
  const [{ revision }] = await rows(db, 'select revision from notification_private.policies where type_code=$1', [type]);
  const r = await execRpc(db, 'notification_policy_update_v1', { p_actor_user_id: U.owner, p_type_code: type, p_expected_revision: revision,
    p_policy: { enabled: true, inAppEnabled: true, pushEnabled: true, rules: { groups: [{}] }, ...extra } });
  assert.equal(r.status, 'ok');
}
function captureLogs(fn) {
  const lines = []; const orig = { error: console.error, info: console.info, warn: console.warn, log: console.log };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(JSON.stringify(a));
  return Promise.resolve().then(fn).finally(() => Object.assign(console, orig)).then(() => lines);
}

test('device routes: auth, CSRF/origin, JSON only, size, SSRF endpoint and key validation, no endpoint echo', () => withEnv(PUSH_ON, async () => {
  const db = await database();
  try {
    const a = harness(db);
    const dev = device();
    assert.equal((await a.send('push', 'GET')).status, 401);
    assert.equal((await a.register(dev)).status, 401, 'logged out');
    a.login(U.staffBar, 'staff');
    const status = await a.send('push', 'GET');
    assert.deepEqual(status.body, { ok: true, available: true, reason: null, publicKey: VAPID.publicKey, activeDevices: 0 });
    // Cross-site / missing origin / form posts are refused before auth or DB.
    const before = a.calls.length;
    for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: '' , 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' },
      { 'content-type': 'application/x-www-form-urlencoded' }]) {
      const r = await a.send('push', 'POST', { body: { action: 'subscribe', subscription: dev.json }, headers });
      assert.ok([400, 403].includes(r.status), JSON.stringify(headers));
    }
    assert.equal((await a.send('push', 'POST', { body: { action: 'sync', endpoint: dev.json.endpoint }, headers: { origin: '', 'sec-fetch-site': 'same-origin' } })).status, 200, 'same-origin fetch metadata accepted');
    assert.equal((await a.send('push', 'POST', { raw: JSON.stringify({ action: 'subscribe', subscription: dev.json, pad: 'x'.repeat(5000) }) })).status, 400);
    const bad = [
      { action: 'subscribe', subscription: { ...dev.json, endpoint: 'https://169.254.169.254/latest' } },
      { action: 'subscribe', subscription: { ...dev.json, endpoint: 'https://localhost/x' } },
      { action: 'subscribe', subscription: { ...dev.json, endpoint: 'http://fcm.googleapis.com/fcm/send/x' } },
      { action: 'subscribe', subscription: { ...dev.json, endpoint: 'https://fcm.googleapis.com.evil.com/x' } },
      { action: 'subscribe', subscription: { ...dev.json, keys: { p256dh: 'A'.repeat(87), auth: dev.json.keys.auth } } },
      { action: 'subscribe', subscription: { ...dev.json, keys: { ...dev.json.keys, auth: 'AAAA' } } },
      { action: 'subscribe', subscription: { ...dev.json, extra: 1 } },
      { action: 'subscribe', subscription: dev.json, lang: 'en' },
      { action: 'subscribe', subscription: dev.json, userId: U.owner },
      { action: 'unsubscribe', endpoint: 'https://evil.example/x' },
      { action: 'sync', endpoint: dev.json.endpoint, userId: 1 },
      { action: 'send', endpoint: dev.json.endpoint },
    ];
    for (const body of bad) assert.equal((await a.send('push', 'POST', { body })).status, 400, JSON.stringify(body).slice(0, 120));
    assert.equal(a.calls.length - before, 1, 'only the valid same-origin sync reached the DB');
    const ok = await a.register(dev);
    assert.deepEqual(ok, { status: 200, body: { ok: true, available: true } });
    assert.ok(!JSON.stringify(ok.body).includes('fcm'), 'endpoint never echoed');
    const [row] = await rows(db, 'select user_id::int u, session_iat::bigint iat, lang from notification_private.push_subscriptions');
    assert.equal(row.u, U.staffBar, 'owner is the session user, never a body field');
    assert.equal(Number(row.iat), a.h.tokens.verifyServerSessionToken(a.h.token()).iat, 'bound to the verified session');
    // Another user cannot unsubscribe it; the owner can.
    a.login(U.staffHall, 'staff');
    assert.equal((await a.send('push', 'POST', { body: { action: 'unsubscribe', endpoint: dev.json.endpoint } })).body.revoked, 0);
    a.login(U.staffBar, 'staff');
    assert.equal((await a.send('push', 'POST', { body: { action: 'unsubscribe', endpoint: dev.json.endpoint } })).body.revoked, 1);
    // Deactivated / login-disabled sessions are refused.
    a.login(U.staffBar, 'staff', { is_active: false });
    assert.equal((await a.register(dev)).status, 401);
  } finally { await db.close(); }
}));

test('compatibility: push DB missing, VAPID missing, global switch OFF; 01-A routes unaffected', async () => {
  const db = await database({ push: false });
  try {
    await withEnv({}, async () => {
      const a = harness(db);
      a.login(U.staffBar, 'staff');
      a.setMode('missing');
      assert.deepEqual((await a.send('push', 'GET')).body, { ok: true, available: false, reason: 'db_pending' });
      assert.deepEqual((await a.send('push', 'POST', { body: { action: 'sync', endpoint: device().json.endpoint } })).body, { ok: true, available: false, reason: 'db_pending' });
      a.setMode('db');
      // 01-A only DB: summary works, recovery is a no-op without config, writer still creates.
      assert.equal((await a.send('summary', 'GET')).body.available, true);
      assert.equal(a.afterQueue.length, 0, 'no push work scheduled while push is not configured');
      const w = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:compat', titleKo: '가', titleVi: 'a' });
      assert.equal(w.status, 'created');
      assert.equal(a.afterQueue.length, 0);
      // Logout / session work with no push DB at all.
      assert.equal((await a.send('logout', 'POST')).status, 200);
      a.login(U.staffBar, 'staff', {}, Math.floor(Date.now() / 1000) - 25 * 86400);
      const s = await a.send('session', 'GET');
      assert.equal(s.status, 200); assert.equal(a.cookies.filter(c => Array.isArray(c)).length, 1, 'session refresh unchanged');
      await a.flushAfter();
    });
  } finally { await db.close(); }
  const db2 = await database();
  try {
    for (const [env, reason] of [[{}, 'not_configured'], [{ ...PUSH_ON, WEB_PUSH_ENABLED: 'false' }, 'disabled'],
      [{ ...PUSH_ON, VAPID_PRIVATE_KEY: 'short' }, 'not_configured'], [{ ...PUSH_ON, VAPID_SUBJECT: 'ops' }, 'not_configured']]) {
      await withEnv(env, async () => {
        const a = harness(db2);
        a.login(U.staffBar, 'staff');
        const g = await a.send('push', 'GET');
        assert.deepEqual([g.body.available, g.body.reason, g.body.publicKey], [false, reason, null]);
        assert.deepEqual((await a.register(device())).body, { ok: true, available: false, reason });
        assert.deepEqual(await a.push.dispatchPushDeliveries({ notificationId: null }), { status: 'disabled', reason });
        assert.equal(a.sent.length, 0);
      });
    }
  } finally { await db2.close(); }
});

test('sender: event -> after() -> encrypted generic payload; TTL/Topic/Urgency; business result independent of push', () => withEnv(PUSH_ON, async () => {
  const db = await database();
  try {
    const a = harness(db);
    await enablePushPolicy(db);
    const ko = device(), vi = device(), other = device();
    a.login(U.staffBar, 'staff'); assert.equal((await a.register(ko, 'ko')).status, 200); assert.equal((await a.register(vi, 'vi')).status, 200);
    const other2 = harness(db); other2.login(U.staffHall, 'staff');
    assert.equal((await other2.register(other)).status, 200);
    a.devices.set(other.json.endpoint, other); // this test's push service decrypts for every device
    a.respond(() => ({ statusCode: 201 }));
    const sensitive = { titleKo: '홍길동 급여 12,345,000₫', titleVi: 'Lương Nguyen 12.345.000₫', bodyKo: '영수증 #R-778 고객 김철수', bodyVi: 'Hoa don #R-778' };
    const logs = await captureLogs(async () => {
      const r = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:1', severity: 'urgent', ...sensitive, href: '/admin/sales?tab=deductions' });
      assert.equal(r.status, 'created', 'business write returns before any push');
      assert.equal(a.sent.length, 0); assert.equal(a.afterQueue.length, 1);
      await a.flushAfter();
    });
    assert.equal(a.sent.length, 3);
    for (const s of a.sent) {
      assert.deepEqual(Object.keys(s.plain).sort(), ['badge', 'body', 'tag', 'title', 'url', 'v']);
      assert.match(s.plain.url, /^\/notifications\/open\?id=\d+$/); assert.match(s.plain.tag, /^baba-n-\d+$/);
      const text = JSON.stringify(s.plain);
      for (const word of ['홍길동', '12,345', '12.345', 'R-778', '김철수', 'Nguyen', '₫', 'deductions']) assert.ok(!text.includes(word), `lock screen leak: ${word}`);
      assert.ok(s.headers.TTL >= 3590 && s.headers.TTL <= 3600, String(s.headers.TTL)); assert.equal(s.headers.Urgency, 'high'); assert.match(s.headers.Topic, /^n\d+$/);
      assert.match(s.headers.Authorization, /^vapid t=/); assert.equal(s.headers['Content-Encoding'], 'aes128gcm');
      assert.equal(s.timeout, 10000);
    }
    const bodies = a.sent.map(s => s.plain.body);
    assert.ok(bodies.some(b => b.startsWith('새 업무 알림')) && bodies.some(b => b.startsWith('Có thông báo')), 'KO and VI per device');
    assert.equal(a.sent[0].plain.badge, 1, 'badge = existing unread count');
    const statuses = await rows(db, 'select status, attempt_count a, last_http_status h from notification_private.push_deliveries order by id');
    assert.ok(statuses.every(s => s.status === 'accepted' && s.a === 1 && s.h === 201));
    const leaked = logs.join('\n');
    for (const secret of [ko.json.endpoint, ko.json.keys.p256dh, ko.json.keys.auth, VAPID.privateKey, VAPID.publicKey, 'fcm.googleapis']) {
      assert.ok(!leaked.includes(secret), 'no endpoint/key/VAPID in logs');
    }
    // Re-observation: no new send. Push failure never turns the business write into a failure.
    await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:1', titleKo: 'x', titleVi: 'x' });
    await a.flushAfter(); assert.equal(a.sent.length, 3, 'open event re-observed: nothing sent');
    a.respond(() => new Error('socket hang up'));
    const failing = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:2', titleKo: 'x', titleVi: 'x' });
    assert.equal(failing.status, 'created');
    await a.flushAfter();
    // "none" leaves the rows to recovery.
    const later = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:3', titleKo: 'x', titleVi: 'x' }, { push: 'none' });
    assert.equal(a.afterQueue.length, 0);
    assert.equal((await rows(db, 'select count(*)::int n from notification_private.push_deliveries where notification_id=$1 and status=$2', [later.id, 'pending']))[0].n, 3);
  } finally { await db.close(); }
}));

test('sender outcomes: 404/410 revoke, 429 Retry-After, 5xx/timeout retry then recover, 401/403 stop, lost report, permission change', () => withEnv(PUSH_ON, async () => {
  const db = await database();
  try {
    const a = harness(db);
    await enablePushPolicy(db, 'system.test_all', { rules: { groups: [], userIds: [U.owner] } });
    a.login(U.owner, 'owner');
    const devs = Array.from({ length: 6 }, device);
    for (const d of devs) assert.equal((await a.register(d)).status, 200);
    const plan = new Map([[devs[0], { statusCode: 404 }], [devs[1], { statusCode: 410 }], [devs[2], { statusCode: 429, headers: { 'retry-after': '120' } }],
      [devs[3], { statusCode: 503 }], [devs[4], Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })], [devs[5], { statusCode: 403 }]]);
    a.respond(sub => plan.get(devs.find(d => d.json.endpoint === sub.endpoint)));
    const evt = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:x', titleKo: 'x', titleVi: 'x' });
    const summary = await a.push.dispatchPushDeliveries({ notificationId: evt.id });
    a.afterQueue.length = 0;
    assert.deepEqual([summary.claimed, summary.gone, summary.retry, summary.failed, summary.accepted], [6, 2, 3, 1, 0]);
    const state = async () => (await rows(db, `select s.endpoint, d.status, d.attempt_count a, d.last_error e, d.last_http_status h, s.status ss,
      round(extract(epoch from (d.next_attempt_at - now())))::int wait from notification_private.push_deliveries d
      join notification_private.push_subscriptions s on s.id=d.subscription_id where d.notification_id=$1 order by d.id`, [evt.id]));
    let s = await state();
    assert.deepEqual(s.map(x => [x.status, x.e, x.ss]), [
      ['failed', 'subscription_gone', 'revoked'], ['failed', 'subscription_gone', 'revoked'], ['pending', 'rate_limited', 'active'],
      ['pending', 'push_service_error', 'active'], ['pending', 'network_error', 'active'], ['failed', 'vapid_rejected', 'active']]);
    assert.ok(s[2].wait >= 118 && s[2].wait <= 120, 'Retry-After 120 s beats the 60 s backoff');
    assert.ok(s[3].wait >= 58 && s[3].wait <= 60);
    // Recovery entry point (bell count request): nothing due yet.
    assert.equal((await a.send('summary', 'GET')).status, 200);
    await a.flushAfter(); assert.equal(a.sent.length, 6);
    // Due now: recovery sends the 3 retries; they succeed.
    await db.query("update notification_private.push_deliveries set next_attempt_at = now() where status = 'pending'");
    a.respond(() => ({ statusCode: 201 }));
    assert.equal(a.push.schedulePushRecovery(Date.now() + 120000), true);
    await a.flushAfter();
    assert.equal(a.push.schedulePushRecovery(Date.now() + 130000), false, 'throttled per instance');
    s = await state();
    assert.deepEqual(s.map(x => [x.status, x.a]), [['failed', 1], ['failed', 1], ['accepted', 2], ['accepted', 2], ['accepted', 2], ['failed', 1]]);

    // Report lost after the push service accepted: re-claimed after the lease (duplicate risk, same Topic).
    const evt2 = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:y', titleKo: 'x', titleVi: 'x' }, { push: 'none' });
    const claimed = await execRpc(db, 'notification_push_claim_v1', { p_notification_id: evt2.id, p_limit: 10, p_lease_seconds: 120 });
    assert.equal(claimed.items.length, 4, 'devices 3-6 are still active (404/410 revoked two)');
    await db.query("update notification_private.push_deliveries set claimed_at = now() - interval '5 minutes' where status='sending'");
    const sentBefore = a.sent.length;
    await ungate(db); await a.push.dispatchPushDeliveries({ notificationId: null });
    const topics = new Set(a.sent.slice(sentBefore).map(x => x.headers.Topic));
    assert.deepEqual([a.sent.length - sentBefore, topics.size], [4, 1], 'resent once each with the same Topic');

    // Permission change between retries: never retried.
    a.respond(() => ({ statusCode: 500 }));
    const evt3 = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:z', titleKo: 'x', titleVi: 'x' });
    await a.flushAfter();
    await db.query("update public.users set app_login_enabled = false where id = $1", [U.owner]);
    await db.query("update notification_private.push_deliveries set next_attempt_at = now() where status = 'pending'");
    const n = a.sent.length;
    await ungate(db); await a.push.dispatchPushDeliveries({ notificationId: null });
    assert.equal(a.sent.length, n, 'login-disabled recipient: no retry sent');
    assert.ok((await rows(db, 'select last_error e from notification_private.push_deliveries where notification_id=$1', [evt3.id])).every(r => r.e === 'recipient_inactive'));
  } finally { await db.close(); }
}));

test('accounts on one device: logout revokes, B never gets A alerts, session refresh extends, click re-checks', () => withEnv(PUSH_ON, async () => {
  const db = await database();
  try {
    const a = harness(db);
    await enablePushPolicy(db);
    a.respond(() => ({ statusCode: 201 }));
    const shared = device();
    a.login(U.staffBar, 'staff');
    await a.register(shared);
    // Logout (server): A's device row is revoked before the reply.
    assert.equal((await a.send('logout', 'POST')).status, 200);
    assert.deepEqual((await rows(db, 'select status, revoked_reason r from notification_private.push_subscriptions')).map(r => [r.status, r.r]), [['revoked', 'logout']]);
    await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:after-logout', titleKo: 'x', titleVi: 'x' });
    await a.flushAfter();
    assert.equal(a.sent.length, 0, 'logged-out device receives nothing');
    // Offline logout (server never reached): B logs in on the same browser; sync revokes A's row.
    a.login(U.staffBar, 'staff'); await a.register(shared);
    a.login(U.staffHall, 'staff');
    assert.equal((await a.send('push', 'POST', { body: { action: 'sync', endpoint: shared.json.endpoint } })).body.device, 'foreign');
    await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:b', titleKo: 'x', titleVi: 'x' });
    await a.flushAfter();
    assert.equal(a.sent.length, 0, 'B (not opted in) and A (revoked) get nothing on that device');
    // Session refresh: the device row follows the new idle expiry.
    const old = Math.floor(Date.now() / 1000) - 25 * 86400;
    a.login(U.leaderBar, 'leader', {}, old);
    const dev = device(); await a.register(dev);
    const before = (await rows(db, "select round(extract(epoch from (expires_at - now()))/86400)::int d from notification_private.push_subscriptions where status='active'"))[0].d;
    assert.equal(before, 5);
    assert.equal((await a.send('session', 'GET')).status, 200);
    await a.flushAfter();
    const after = (await rows(db, "select round(extract(epoch from (expires_at - now()))/86400)::int d from notification_private.push_subscriptions where status='active'"))[0].d;
    assert.equal(after, 30);
    // Click: recipient only, internal path only, permission re-checked.
    const evt = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:click', titleKo: 'x', titleVi: 'x', href: '/admin/sales?tab=deductions' });
    await a.flushAfter();
    assert.deepEqual((await a.send('open', 'GET', { query: `?id=${evt.id}` })).body, { ok: true, available: true, href: '/admin/sales?tab=deductions' });
    a.login(U.staffKitchenInactive, 'staff', { is_active: false });
    assert.equal((await a.send('open', 'GET', { query: `?id=${evt.id}` })).status, 401);
    a.login(U.unknown, 'staff');
    assert.equal((await a.send('open', 'GET', { query: `?id=${evt.id}` })).status, 403);
    a.login(U.leaderBar, 'leader');
    for (const q of ['?id=abc', '?id=0', '?id=https://evil.example', '']) assert.equal((await a.send('open', 'GET', { query: q })).status, 400);
    const [{ n }] = await rows(db, 'select count(*) filter (where read_at is not null)::int n from notification_private.recipients');
    assert.equal(n, 0, 'push receipt and click lookup never mark read');
  } finally { await db.close(); }
}));

test('service worker: no fetch handler, generic fallback, tag dedupe, internal click target only, renewal post', async () => {
  const source = readFileSync('public/sw.js', 'utf8');
  const listeners = {}; const shown = []; const opened = []; const posted = []; const badges = [];
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting() {}, location: { origin: 'https://app.invalid' },
    navigator: { setAppBadge: async n => badges.push(n), clearAppBadge: async () => badges.push(0) },
    registration: { showNotification: async (title, options) => shown.push({ title, options }), pushManager: { subscribe: async () => ({ toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: {} }) }) } },
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async url => opened.push(url) },
  };
  const fetchMock = async (url, init) => { posted.push([url, JSON.parse(init.body), init.credentials]); return new Response('{}'); };
  vm.runInNewContext(source, { self, URL, fetch: fetchMock, JSON, Number, Math });
  assert.deepEqual(Object.keys(listeners).sort(), ['activate', 'install', 'notificationclick', 'push', 'pushsubscriptionchange']);
  assert.ok(!('fetch' in listeners) && !/caches\.|CacheStorage|addEventListener\(["']fetch/.test(source), 'nothing intercepted or cached');
  const run = async (type, event) => { let p; listeners[type]({ ...event, waitUntil: x => { p = x; } }); await p; };
  await run('push', { data: { json: () => ({ v: 1, title: 'BABA 알림', body: '새 업무 알림이 있습니다: 휴무 신청 대기', tag: 'baba-n-7', url: '/notifications/open?id=7', badge: 3 }) } });
  await run('push', { data: { json: () => { throw new Error('bad'); } } });
  await run('push', { data: { json: () => ({ v: 1, title: 'x', body: 'y', tag: '<script>', url: 'https://evil.example/' }) } });
  assert.deepEqual(shown.map(s => [s.title, s.options.tag, s.options.data.url, s.options.renotify]), [
    ['BABA 알림', 'baba-n-7', '/notifications/open?id=7', false],
    ['BABA', 'baba-notification', '/notifications', false],
    ['x', 'baba-notification', '/notifications', false]]);
  assert.deepEqual(badges, [3]);
  for (const url of ['/notifications/open?id=7', 'https://evil.example/', '//evil.example', 'javascript:alert(1)']) {
    await run('notificationclick', { notification: { close() {}, data: { url } } });
  }
  assert.deepEqual(opened, ['https://app.invalid/notifications/open?id=7', 'https://app.invalid/notifications', 'https://app.invalid/notifications', 'https://app.invalid/notifications']);
  await run('pushsubscriptionchange', { oldSubscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/old', options: { applicationServerKey: new Uint8Array(65) } } });
  assert.deepEqual(posted.map(p => [p[0], p[1].action, p[1].oldEndpoint, p[2]]), [['/api/notifications/push', 'subscribe', 'https://fcm.googleapis.com/fcm/send/old', 'same-origin']]);
});

test('static contracts: sw.js headers, worker registered only from the click path, logout cleanup, no cron', () => {
  const nextConfig = readFileSync('next.config.ts', 'utf8');
  assert.match(nextConfig, /source: "\/sw\.js"[\s\S]*no-cache, no-store, must-revalidate/);
  const client = readFileSync('lib/notifications/push-client.ts', 'utf8');
  assert.equal((client.match(/serviceWorker\.register\(/g) ?? []).length, 1);
  assert.equal((client.match(/requestPermission\(/g) ?? []).length, 1);
  const enable = client.slice(client.indexOf('export async function enablePushOnThisDevice'), client.indexOf('export async function disablePushOnThisDevice'));
  assert.ok(enable.includes('serviceWorker.register(') && enable.includes('requestPermission('), 'both only inside the click handler path');
  assert.ok(enable.indexOf('requestPermission(') < enable.indexOf('serviceWorker.register('), 'permission first, inside the gesture');
  for (const file of ['components/notifications/PushDeviceSync.tsx', 'app/(protected)/layout.tsx', 'components/notifications/NotificationBell.tsx']) {
    assert.ok(!/requestPermission|serviceWorker\.register/.test(readFileSync(file, 'utf8')), file);
  }
  const layout = readFileSync('app/(protected)/layout.tsx', 'utf8');
  assert.match(layout, /await fetch\("\/api\/logout", \{ method: "POST" \}\);[\s\S]*await cleanupPushOnLogout\(\)[\s\S]*localStorage\.removeItem\("baba_user"\)/);
  assert.match(layout, /baba_leave_pending_alert_shown/, 'leave popup kept');
  const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
  assert.ok(!vercel.crons.some(c => /notification|push/.test(c.path)), 'no new cron');
  assert.ok(!/console\.[a-z]+\([^)]*(endpoint|p256dh|privateKey|auth:)/.test(readFileSync('lib/notifications/push/server.ts', 'utf8')));
  assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).dependencies['web-push'], '3.6.7', 'pinned');
});

test('01B-FINAL sender bounds: lease covers send + report, small batches, no DB work while push is off', () => withEnv(PUSH_ON, async () => {
  const db = await database();
  try {
    const a = harness(db);
    const L = a.push.PUSH_LIMITS;
    assert.ok(L.leaseSeconds * 1000 >= 3 * (L.sendDeadlineMs + 5000), 'lease >= 3x (send bound + report timeout)');
    assert.ok(L.maxClaimAgeMs + L.sendDeadlineMs + 5000 < L.leaseSeconds * 1000, 'a sender never outlives its lease');
    assert.equal(L.batch, 5);
    await enablePushPolicy(db, 'system.test_all', { rules: { groups: [], userIds: [U.owner] } });
    a.login(U.owner, 'owner');
    for (let i = 0; i < 12; i++) assert.equal((await a.register(device())).status, 200);
    let inFlight = 0, peak = 0;
    a.respond(async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 20)); inFlight--; return { statusCode: 201 }; });
    const evt = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:batch', titleKo: 'x', titleVi: 'x' }, { push: 'none' });
    const before = a.calls.filter(c => c === 'notification_push_claim_v1').length;
    const s = await a.push.dispatchPushDeliveries({ notificationId: evt.id });
    assert.deepEqual([s.rounds, s.claimed, s.accepted, peak], [3, 10, 10, 5], 'rounds of 5 (10 active devices), at most 5 sends in flight');
    assert.equal(a.calls.filter(c => c === 'notification_push_claim_v1').length - before, 3);
  } finally { await db.close(); }
  // Push globally OFF: recovery and dispatch never reach the DB.
  const db2 = await database();
  try {
    await withEnv({ ...PUSH_ON, WEB_PUSH_ENABLED: 'false' }, async () => {
      const a = harness(db2);
      a.login(U.owner, 'owner');
      assert.equal(a.push.schedulePushRecovery(Date.now() + 10 ** 9), false);
      assert.equal((await a.send('summary', 'GET')).status, 200);
      await a.flushAfter();
      assert.ok(!a.calls.some(c => c.startsWith('notification_push_claim')), 'no claim while push is off');
    });
  } finally { await db2.close(); }
}));

test('01B-FINAL right before sending: stale claim released unsent, exhausted TTL never sent, hard send bound, permission lost between rounds', () => withEnv(PUSH_ON, async () => {
  const db = await database();
  try {
    const a = harness(db);
    await enablePushPolicy(db, 'system.test_all', { rules: { groups: [], userIds: [U.owner] } });
    a.login(U.owner, 'owner');
    for (let i = 0; i < 2; i++) await a.register(device());
    a.respond(() => ({ statusCode: 201 }));
    const state = async id => (await rows(db, 'select status, last_error e, attempt_count n from notification_private.push_deliveries where notification_id=$1 order by id', [id]));
    // Clock: claim answered at t=0, the sender looks at t=25 s (claim older than 20 s).
    const clock = later => { let n = 0; return () => (++n <= 3 ? 0 : later); };
    const e1 = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:stale', titleKo: 'x', titleVi: 'x' }, { push: 'none' });
    await a.push.dispatchPushDeliveries({ notificationId: e1.id, now: clock(25_000) });
    assert.equal(a.sent.length, 0, 'stale claim: nothing sent');
    assert.deepEqual((await state(e1.id)).map(r => [r.status, r.e]), [['pending', 'claim_too_old'], ['pending', 'claim_too_old']]);
    // TTL: 8 s left at claim, the sender looks 4 s later (< 5 s left): expired, not sent.
    const e2 = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:ttl', titleKo: 'x', titleVi: 'x' }, { push: 'none' });
    await db.query("update notification_private.push_deliveries set expires_at = now() + interval '8 seconds' where notification_id=$1", [e2.id]);
    await a.push.dispatchPushDeliveries({ notificationId: e2.id, now: clock(4_000) });
    assert.equal(a.sent.length, 0);
    assert.deepEqual((await state(e2.id)).map(r => [r.status, r.e]), [['expired', 'ttl_expired'], ['expired', 'ttl_expired']]);
    // Hard bound: a push service that never answers is cut off (bound shortened for the test).
    const limits = a.push.PUSH_LIMITS; const old = limits.sendDeadlineMs;
    limits.sendDeadlineMs = 300;
    try {
      a.respond(() => new Promise(() => {}));
      const e3 = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:hang', titleKo: 'x', titleVi: 'x' }, { push: 'none' });
      const t0 = Date.now();
      await a.push.dispatchPushDeliveries({ notificationId: e3.id });
      assert.ok(Date.now() - t0 < 3000);
      assert.deepEqual((await state(e3.id)).map(r => [r.status, r.e]), [['pending', 'send_timeout'], ['pending', 'send_timeout']]);
    } finally { limits.sendDeadlineMs = old; }
    // Permission lost while round 1 is sending: round 2 (claimed afterwards) is refused by the gate.
    for (let i = 0; i < 6; i++) await a.register(device());
    let flipped = false;
    a.respond(async () => {
      if (!flipped) { flipped = true; await db.query('update public.users set app_login_enabled=false where id=$1', [U.owner]); }
      return { statusCode: 201 };
    });
    const sentBefore = a.sent.length;
    const e4 = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:perm', titleKo: 'x', titleVi: 'x' }, { push: 'none' });
    const s = await a.push.dispatchPushDeliveries({ notificationId: e4.id });
    assert.equal(a.sent.length - sentBefore, 5, 'only the batch claimed before the change');
    assert.equal(s.skipped, 3);
    assert.deepEqual([...new Set((await state(e4.id)).filter(r => r.status === 'skipped').map(r => r.e))], ['recipient_inactive']);
  } finally { await db.close(); }
}));

test('01B-FINAL slow sender vs another instance recovery: no preventable duplicate; lost report is the inherent one', () => withEnv(PUSH_ON, async () => {
  const db = await database();
  try {
    const a = harness(db); const b = harness(db); // two server instances sharing the DB
    await enablePushPolicy(db, 'system.test_all', { rules: { groups: [], userIds: [U.owner] } });
    a.login(U.owner, 'owner');
    for (let i = 0; i < 3; i++) await a.register(device());
    let release; const hold = new Promise(r => { release = r; });
    a.respond(async () => { await hold; return { statusCode: 201 }; });
    b.respond(() => ({ statusCode: 201 }));
    const evt = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:slow', titleKo: 'x', titleVi: 'x' }, { push: 'none' });
    const slow = a.push.dispatchPushDeliveries({ notificationId: evt.id });
    await new Promise(r => setTimeout(r, 100));
    for (let i = 0; i < 5; i++) { await ungate(db); await b.push.dispatchPushDeliveries({ notificationId: null }); }
    assert.equal(b.sent.length, 0, 'live claims are never taken by another instance');
    release(); await slow;
    assert.equal(a.sent.length, 3);
    // Inherent case: accepted but the report was lost -> resent once after the lease, same Topic.
    const evt2 = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:lost', titleKo: 'x', titleVi: 'x' }, { push: 'none' });
    const lost = await execRpc(db, 'notification_push_claim_v1', { p_notification_id: evt2.id, p_limit: 5, p_lease_seconds: 90 });
    assert.equal(lost.items.length, 3);
    await db.query("update notification_private.push_deliveries set claimed_at = now() - interval '91 seconds' where status='sending'");
    await ungate(db); await b.push.dispatchPushDeliveries({ notificationId: null });
    assert.deepEqual([b.sent.length, new Set(b.sent.map(x => x.headers.Topic)).size], [3, 1]);
  } finally { await db.close(); }
}));

test('01B-FINAL-2 routes: signed device generation, in-flight requests after logout / account switch, consent, cookie init', () => withEnv(PUSH_ON, async () => {
  const db = await database();
  try {
    const a = harness(db);
    await enablePushPolicy(db);
    const now = Math.floor(Date.now() / 1000) - 100;
    a.login(U.owner, 'owner', {}, now);
    const d1 = device();
    assert.equal((await a.register(d1)).status, 200);
    const [row] = await rows(db, "select device_hash, device_generation::int g from notification_private.push_subscriptions where status='active'");
    assert.ok(!a.jar.device.includes(row.device_hash), 'only a hash of the device id is stored');
    assert.equal(row.g, 1);
    // Cookie integrity: missing, tampered or another account's cookie never reaches the DB.
    const calls = a.calls.length;
    const [payloadPart, sig] = a.jar.device.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payloadPart, 'base64url').toString()), u: U.master }), 'utf8').toString('base64url') + '.' + sig;
    for (const cookie of [null, a.jar.device.slice(0, -2) + 'xx', forged]) {
      const r = await a.register(device(), 'ko', { cookie });
      assert.deepEqual([r.status, r.body.code], [409, 'PUSH_DEVICE_INIT']);
    }
    assert.equal(a.calls.length, calls, 'refused before any RPC');
    // Consent: the click happened as another account than the session now in this browser.
    const r6 = await a.register(device(), 'ko', { expectUserId: U.master });
    assert.deepEqual([r6.status, r6.body.code], [409, 'PUSH_USER_CHANGED']);
    assert.equal((await a.send('push', 'POST', { body: { action: 'subscribe', subscription: device().json } })).status, 400, 'consent field required');
    // Same user, same second, another browser: its own identity, kept when browser 1 logs out.
    const b = harness(db);
    b.login(U.owner, 'owner', {}, now);
    const d2 = device();
    assert.equal((await b.register(d2)).status, 200);
    assert.equal((await b.send('push', 'POST', { body: { action: 'sync', endpoint: d2.json.endpoint, lang: 'vi' } })).body.device, 'registered');
    assert.equal((await rows(db, 'select lang from notification_private.push_subscriptions where endpoint=$1', [d2.json.endpoint]))[0].lang, 'vi');
    // (5) A registration issued before the logout (old cookie + still-signed old session) arrives after it.
    const inflight = a.jar.device;
    assert.equal((await a.send('logout', 'POST')).status, 200);
    const late = await a.register(device(), 'ko', { cookie: inflight });
    assert.deepEqual([late.status, late.body.code], [409, 'PUSH_SUPERSEDED'], 'refused by the raised floor');
    assert.deepEqual((await a.register(device())).body.code, 'PUSH_DEVICE_INIT', 'logged-out cookie belongs to no session');
    assert.deepEqual((await rows(db, "select endpoint from notification_private.push_subscriptions where status='active'")).map(r => r.endpoint), [d2.json.endpoint]);

    // (1)(6) Same-second account switch on ONE browser; A's request issued before the switch arrives late.
    const c = harness(db); const second = Math.floor(Date.now() / 1000) - 50;
    c.login(U.leaderBar, 'leader', {}, second);
    const aToken = c.h.token(); const aCookie = c.jar.device; const shared = device();
    assert.equal((await c.register(shared)).status, 200);
    c.login(U.leaderHall, 'leader', {}, second); // B logs in during the same second
    assert.equal((await c.register(shared)).status, 200);
    c.h.setActor({ id: U.leaderBar, role: 'leader', is_active: true, app_login_enabled: true }); c.h.setToken(aToken);
    const stale = await c.register(shared, 'ko', { cookie: aCookie, expectUserId: U.leaderBar });
    assert.deepEqual([stale.status, stale.body.code], [409, 'PUSH_SUPERSEDED'], 'A does not take it back (no last-request-wins)');
    const staleSync = await c.send('push', 'POST', { body: { action: 'sync', endpoint: shared.json.endpoint }, headers: { cookie: `baba_push_device=${aCookie}` } });
    assert.equal(staleSync.body.device, 'superseded');
    const staleOff = await c.send('push', 'POST', { body: { action: 'unsubscribe', endpoint: shared.json.endpoint }, headers: { cookie: `baba_push_device=${aCookie}` } });
    assert.deepEqual([staleOff.status, staleOff.body.code], [409, 'PUSH_SUPERSEDED']);
    assert.deepEqual((await rows(db, "select user_id::int u from notification_private.push_subscriptions where endpoint=$1 and status='active'", [shared.json.endpoint])).map(r => r.u), [U.leaderHall]);

    // /api/session issues a cookie only when missing or not this session's (no DB call either way).
    const s = harness(db);
    s.login(U.staffBar, 'staff');
    s.jar.device = null; s.jar.set.length = 0;
    const before = s.calls.length;
    assert.equal((await s.send('session', 'GET')).status, 200);
    assert.ok(s.jar.set.includes('baba_push_device') && s.jar.device, 'issued for a session without one');
    s.jar.set.length = 0;
    assert.equal((await s.send('session', 'GET')).status, 200);
    assert.ok(!s.jar.set.includes('baba_push_device'), 'matching cookie: nothing issued');
    assert.equal(s.calls.length, before, 'session check: no push DB call');
    assert.equal((await s.register(device())).status, 200, 'works after the session check');
  } finally { await db.close(); }
}));

test('01B-FINAL-2 sender timing: claim age measured from the claim request; the dispatch budget is a hard total bound', () => withEnv(PUSH_ON, async () => {
  const db = await database();
  try {
    const a = harness(db);
    const L = a.push.PUSH_LIMITS;
    assert.ok(L.roundWorstMs >= 5000 + L.sendDeadlineMs + 5000 && L.roundWorstMs <= L.dispatchBudgetMs);
    await enablePushPolicy(db, 'system.test_all', { rules: { groups: [], userIds: [U.owner] } });
    a.login(U.owner, 'owner');
    for (let i = 0; i < 10; i++) await a.register(device());
    // A slow claim RPC: the claim age already includes it (measured before the request).
    const oldAge = L.maxClaimAgeMs; L.maxClaimAgeMs = 150; a.claimDelay(300);
    try {
      const e1 = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:slow-claim', titleKo: 'x', titleVi: 'x' }, { push: 'none' });
      await a.push.dispatchPushDeliveries({ notificationId: e1.id });
      assert.equal(a.sent.length, 0, 'claim older than allowed once the slow claim answered: nothing sent');
    } finally { L.maxClaimAgeMs = oldAge; a.claimDelay(0); }
    // Budget: after round 1 the clock says 9 s; 9 + 22 > 30 -> no second round, the rest waits.
    let clock = 0; a.respond(() => { clock = 9_000; return { statusCode: 201 }; });
    const e2 = await a.server.upsertNotification({ typeCode: 'system.test_all', dedupeKey: 'evt:budget', titleKo: 'x', titleVi: 'x' }, { push: 'none' });
    const s = await a.push.dispatchPushDeliveries({ notificationId: e2.id, now: () => clock });
    assert.deepEqual([s.rounds, s.accepted], [1, 5]);
    clock = 0; a.respond(() => ({ statusCode: 201 }));
    const s2 = await a.push.dispatchPushDeliveries({ notificationId: e2.id, now: () => clock });
    assert.equal(s2.accepted, 5, 'the rest is sent by the next dispatch');
  } finally { await db.close(); }
}));
