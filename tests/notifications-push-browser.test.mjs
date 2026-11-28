// BABA-NOTIFICATION-01B UI in a real browser: isolated Next production build of the real protected
// layout, notification center (+ device push panel), click landing page, store settings tab and the
// real notification/push/logout/session routes, with real signed sessions and PGlite (01-A + 01-B).
// No repository .env is read and no external host is reachable. The browser's PushManager is
// replaced by a deterministic stub (headless Chrome cannot reach a real push service offline), so
// this proves UI states, permission flow, server registration, badge, click landing and logout
// cleanup; it does NOT prove real-device delivery.
// Test binaries: npm.cmd --cache .local/npm-cache install --prefix .local/browser-qa --no-audit --no-fund playwright@1.65.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { createServerSessionToken } from '../lib/auth/session-token.ts';
import { notificationText, notificationSettingsText } from '../lib/text/notifications.ts';
import { baseSql, testTypesSql, U, payload, MIGRATION_FILE, PUSH_MIGRATION_FILE } from './helpers/notification-fixture.mjs';

const require = createRequire(import.meta.url);
const CAST = { p_payload: '::jsonb', p_policy: '::jsonb', p_evidence: '::jsonb', p_session_expires_at: '::timestamptz', p_claim_token: '::uuid' };

test('push UI in a real browser: device panel states KO/VI, enable/disable, settings channel, click landing, badge, logout', { timeout: 300000 }, async t => {
  const root = process.cwd(); const work = path.resolve('.local/notification-01b'); const preview = path.join(work, 'preview');
  const shots = path.join(work, 'screens'); mkdirSync(shots, { recursive: true }); mkdirSync(path.join(work, 'tmp'), { recursive: true });
  const put = (file, text) => { const target = path.join(preview, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text); };
  put('package.json', JSON.stringify({ name: 'baba-push-offline-check', private: true, version: '1.0.0' }));
  put('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['dom', 'esnext'], strict: true, noEmit: true, skipLibCheck: true,
    esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', jsx: 'react-jsx', resolveJsonModule: true, allowImportingTsExtensions: true,
    baseUrl: root, paths: { '@/*': ['./*'] }, plugins: [{ name: 'next' }] }, include: ['**/*.ts', '**/*.tsx', '.next/types/**/*.ts'], exclude: ['node_modules'] }));
  // Same headers() as the real next.config.ts (sw.js revalidation).
  const realHeaders = readFileSync('next.config.ts', 'utf8').match(/async headers\(\) \{[\s\S]*?\n  \},\n/)[0];
  put('next.config.mjs', `export default { devIndicators:false, experimental:{externalDir:true}, ${realHeaders} };`);
  put('postcss.config.mjs', readFileSync('postcss.config.mjs', 'utf8'));
  put('public/sw.js', readFileSync('public/sw.js', 'utf8'));
  put('app/layout.tsx', `import {LanguageProvider} from '@/lib/language-context';import '@/app/globals.css';
    export default function Layout({children}:{children:React.ReactNode}){return <html><body><LanguageProvider>{children}</LanguageProvider></body></html>}`);
  put('app/(protected)/layout.tsx', `export {default} from '@/app/(protected)/layout';`);
  put('app/(protected)/notifications/page.tsx', `export {default} from '@/app/(protected)/notifications/page';`);
  put('app/(protected)/notifications/open/page.tsx', `export {default} from '@/app/(protected)/notifications/open/page';`);
  put('app/(protected)/admin/layout.tsx', `export {default} from '@/app/(protected)/admin/layout';`);
  put('app/(protected)/admin/settings/store/page.tsx', `export {default} from '@/app/(protected)/admin/settings/store/page';`);
  put('app/(protected)/work/page.tsx', `export default function Work(){return <main style={{padding:16}}><h1>Business page</h1></main>}`);
  put('app/login/page.tsx', 'export default function Login(){return <main>Offline login boundary</main>}');
  for (const route of ['notifications/route.ts', 'notifications/summary/route.ts', 'notifications/read/route.ts', 'notifications/push/route.ts',
    'notifications/push/open/route.ts', 'admin/notification-settings/route.ts', 'admin/store-settings/route.ts', 'logout/route.ts', 'session/route.ts']) {
    put('app/api/' + route, readFileSync('app/api/' + route, 'utf8'));
  }
  if (!existsSync(path.join(preview, 'node_modules'))) symlinkSync(path.join(root, 'node_modules'), path.join(preview, 'node_modules'), 'junction');

  const db = new PGlite();
  await db.exec(baseSql); await db.exec(readFileSync(MIGRATION_FILE, 'utf8')); await db.exec(testTypesSql); await db.exec(readFileSync(PUSH_MIGRATION_FILE, 'utf8'));
  const exec = async (fn, args) => {
    const entries = Object.entries(args);
    await db.exec('set role service_role');
    try {
      const sql = `select public.${fn}(${entries.map(([k], i) => `${k} => $${i + 1}${CAST[k] ?? ''}`).join(',')}) data`;
      return (await db.query(sql, entries.map(([k, v]) => (CAST[k] === '::jsonb' && v != null ? JSON.stringify(v) : v)))).rows[0].data;
    } finally { await db.exec('reset role'); }
  };
  const [{ revision }] = (await db.query("select revision from notification_private.policies where type_code='system.test_all'")).rows;
  assert.equal((await exec('notification_policy_update_v1', { p_actor_user_id: U.owner, p_type_code: 'system.test_all', p_expected_revision: revision,
    p_policy: { enabled: true, inAppEnabled: true, pushEnabled: true, rules: { groups: [], userIds: [U.owner, U.leaderBar] } } })).status, 'ok');
  const seeded = await exec('notification_upsert_v1', { p_type_code: 'system.test_all', p_dedupe_key: 'ui:1', p_payload: payload({ href: '/work' }) });
  await exec('notification_upsert_v1', { p_type_code: 'system.test_all', p_dedupe_key: 'ui:2', p_payload: payload({ href: '/work' }) });

  let queue = Promise.resolve();
  const transport = http.createServer((req, res) => {
    queue = queue.then(async () => {
      res.setHeader('Content-Type', 'application/json');
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/rest/v1/users') {
          const id = Number(url.searchParams.get('id')?.replace('eq.', ''));
          res.end(JSON.stringify((await db.query('select * from public.users where id=$1', [id])).rows)); return;
        }
        const fn = url.pathname.replace('/rest/v1/rpc/', '');
        let text = ''; for await (const chunk of req) text += chunk;
        if (fn === 'store_business_date_for_timestamp_v1') { res.end(JSON.stringify('2026-11-28')); return; }
        if (fn === 'store_get_settings_overview_v1') { res.end(JSON.stringify({ businessDate: '2026-11-28', latestRevision: 0, current: null, scheduled: null })); return; }
        if (!/^notification_[a-z_]+_v1$/.test(fn)) { res.statusCode = 404; res.end('{}'); return; }
        res.end(JSON.stringify(await exec(fn, JSON.parse(text || '{}'))));
      } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ code: e.code ?? 'XX000', message: 'offline fixture error' })); }
    }).catch(() => { res.statusCode = 500; res.end('{}'); });
  });
  await new Promise(resolve => transport.listen(0, '127.0.0.1', resolve)); const transportPort = transport.address().port;
  const secret = 'offline-notification-browser-session-secret-32'; const oldSecret = process.env.BABA_SESSION_SECRET;
  process.env.BABA_SESSION_SECRET = secret;
  const vapid = require('web-push').generateVAPIDKeys(); // in-memory test keys only
  const baseEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
    TEMP: path.join(work, 'tmp'), TMP: path.join(work, 'tmp'), NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${transportPort}`, SUPABASE_SERVICE_ROLE_KEY: 'offline-synthetic-key',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'offline-synthetic-key', BABA_SESSION_SECRET: secret };
  const pushEnv = { ...baseEnv, WEB_PUSH_ENABLED: 'true', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:ops@example.invalid' };
  const next = path.resolve('node_modules/next/dist/bin/next'); const buildLog = path.join(work, 'preview-build.log');
  let server, browser; let origin; let fixedPort = null;
  const start = async env => {
    if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
    // Restarts keep the same port (same origin => the browser keeps its storage and worker).
    if (fixedPort === null) {
      const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); fixedPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
    }
    const port = fixedPort;
    const serverLog = openSync(path.join(work, 'preview-server.log'), 'a');
    server = spawn(process.execPath, [next, 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: preview, env, windowsHide: true, stdio: ['ignore', serverLog, serverLog] });
    closeSync(serverLog);
    origin = `http://127.0.0.1:${port}`;
    for (let n = 0; n < 200; n++) { try { if ((await fetch(origin + '/login')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
  };
  try {
    const descriptor = openSync(buildLog, 'w');
    const build = spawnSync(process.execPath, [next, 'build', '--webpack'], { cwd: preview, env: baseEnv, windowsHide: true, stdio: ['ignore', descriptor, descriptor], timeout: 240000 });
    closeSync(descriptor);
    assert.equal(build.status, 0, readFileSync(buildLog, 'utf8').slice(-6000));
    t.diagnostic('isolated push UI Next production build PASS');
    const { chromium } = await import(pathToFileURL(path.resolve('.local/browser-qa/node_modules/playwright/index.mjs')).href);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const errors = [];
    const NAMES = { [U.owner]: ['Owner A', 'owner'], [U.leaderBar]: ['Leader Bar', 'leader'], [U.staffBar]: ['Staff Bar', 'staff'] };
    const keys = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: e.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') }; };

    // stub: 'none' | 'granted' | 'denied' | 'unsupported'; ua: optional user agent (iPhone).
    async function open(userId, { lang = 'ko', width = 390, target = '/notifications', stub = 'none', ua } = {}) {
      const context = await browser.newContext({ viewport: { width, height: 860 }, locale: lang === 'ko' ? 'ko-KR' : 'vi-VN', ...(ua ? { userAgent: ua } : {}) });
      await context.addCookies([{ name: 'baba_session', value: createServerSessionToken(userId), url: origin }]);
      const [name, role] = NAMES[userId];
      const sub = { endpoint: `https://fcm.googleapis.com/fcm/send/ui-${userId}-${randomBytes(4).toString('hex')}`, expirationTime: null, keys: keys() };
      await context.addInitScript(({ user, stub, sub }) => {
        if (!sessionStorage.getItem('seeded')) { localStorage.setItem('baba_user', JSON.stringify(user)); sessionStorage.setItem('seeded', '1'); }
        window.__push = { badge: [], unsubscribed: 0, requested: 0 };
        navigator.setAppBadge = async n => { window.__push.badge.push(n ?? 'dot'); };
        navigator.clearAppBadge = async () => { window.__push.badge.push(0); };
        if (stub === 'unsupported') { delete window.PushManager; return; }
        if (stub === 'none') return;
        let permission = 'default'; let current = localStorage.getItem('__sub') ? JSON.parse(localStorage.getItem('__sub')) : null;
        Object.defineProperty(Notification, 'permission', { get: () => permission });
        Notification.requestPermission = async () => {
          window.__push.requested++;
          // 'granted-wait': the prompt stays open until the test answers it.
          if (stub === 'granted-wait') await new Promise(resolve => { window.__releasePermission = resolve; });
          permission = stub === 'granted-wait' ? 'granted' : stub;
          return permission;
        };
        const make = json => ({ endpoint: json.endpoint, options: { applicationServerKey: null }, toJSON: () => json,
          unsubscribe: async () => { window.__push.unsubscribed++; current = null; localStorage.removeItem('__sub'); return true; } });
        PushManager.prototype.getSubscription = async function () { return current ? make(current) : null; };
        PushManager.prototype.subscribe = async function () { current = sub; localStorage.setItem('__sub', JSON.stringify(sub)); return make(sub); };
      }, { user: { id: userId, name, role, language: lang }, stub, sub });
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
      await page.route('**/*', route => { const u = new URL(route.request().url()); return u.hostname !== '127.0.0.1' && u.protocol !== 'data:' ? route.abort() : route.continue(); });
      await page.goto(origin + target);
      return { page, context, sub };
    }
    const panel = page => page.getByTestId('push-device-panel');
    const waitState = async (page, state) => { await page.locator(`[data-testid="push-device-panel"][data-state="${state}"]`).waitFor({ timeout: 15000 }); };
    const fits = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), label + ' horizontal overflow');
    const active = async userId => (await db.query("select count(*)::int n from notification_private.push_subscriptions where user_id=$1 and status='active'", [userId])).rows[0].n;

    await t.test('push not configured (no VAPID, switch off): panel says not ready; 01-A center unchanged', async () => {
      await start(baseEnv);
      for (const lang of ['ko', 'vi']) {
        const { page, context } = await open(U.owner, { lang, stub: 'granted' });
        await waitState(page, 'unavailable');
        await panel(page).getByText(notificationText[lang].push.hint.unavailable).waitFor();
        assert.equal(await panel(page).getByRole('button').count(), 0, 'no turn-on button');
        assert.equal(await page.evaluate(() => window.__push.requested), 0, 'never asks permission on load');
        await page.getByText(lang === 'ko' ? '테스트 알림' : 'Thông báo thử').first().waitFor();
        await fits(page, `unavailable ${lang}`);
        await page.screenshot({ path: path.join(shots, `push-unavailable-${lang}-390.png`) });
        await context.close();
      }
    });

    await start(pushEnv);
    await t.test('environment states: unsupported, iPhone browser tab (needs install), denied', async () => {
      let s = await open(U.owner, { stub: 'unsupported' });
      await waitState(s.page, 'unsupported'); await s.page.screenshot({ path: path.join(shots, 'push-unsupported-ko-390.png') }); await s.context.close();
      s = await open(U.owner, { lang: 'vi', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
      await waitState(s.page, 'needs_install');
      await panel(s.page).getByText(notificationText.vi.push.hint.needs_install).waitFor();
      await fits(s.page, 'needs install vi'); await s.page.screenshot({ path: path.join(shots, 'push-needs-install-vi-390.png') }); await s.context.close();
      s = await open(U.owner, { stub: 'denied' });
      await waitState(s.page, 'off');
      assert.equal(await s.page.evaluate(() => window.__push.requested), 0);
      await panel(s.page).getByRole('button', { name: notificationText.ko.push.turnOn }).click();
      await waitState(s.page, 'denied');
      assert.equal(await s.page.evaluate(() => window.__push.requested), 1, 'permission asked only from the click');
      assert.equal(await active(U.owner), 0);
      await s.page.screenshot({ path: path.join(shots, 'push-denied-ko-390.png') }); await s.context.close();
    });

    await t.test('enable -> registered for the session user, badge mirrors unread, disable, re-enable, logout cleans up', async () => {
      const s = await open(U.owner, { stub: 'granted' });
      await waitState(s.page, 'off');
      await s.page.screenshot({ path: path.join(shots, 'push-off-ko-390.png') });
      await panel(s.page).getByRole('button', { name: notificationText.ko.push.turnOn }).click();
      await waitState(s.page, 'on');
      assert.equal(await active(U.owner), 1);
      const reg = await s.page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/'))?.scope);
      assert.equal(reg, origin + '/', 'worker registered at scope / after the click');
      const sw = await fetch(origin + '/sw.js');
      assert.match(sw.headers.get('cache-control') ?? '', /no-cache/); assert.match(sw.headers.get('content-type') ?? '', /javascript/);
      await fits(s.page, 'on ko'); await s.page.screenshot({ path: path.join(shots, 'push-on-ko-390.png') });
      await s.page.waitForFunction(() => window.__push.badge.includes(2));
      // Reload: sync keeps it on (no prompt).
      await s.page.reload(); await waitState(s.page, 'on');
      await panel(s.page).getByRole('button', { name: notificationText.ko.push.turnOff }).click();
      await waitState(s.page, 'off');
      assert.equal(await active(U.owner), 0);
      await panel(s.page).getByRole('button', { name: notificationText.ko.push.turnOn }).click();
      await waitState(s.page, 'on');
      assert.equal(await active(U.owner), 1);
      // Logout from the header menu: server revoke + local unsubscribe + badge cleared.
      const before = await s.page.evaluate(() => window.__push.unsubscribed);
      await s.page.locator('header svg circle').locator('..').locator('..').click();
      await s.page.getByRole('button', { name: '로그아웃' }).click();
      await s.page.waitForURL('**/login');
      assert.equal(await active(U.owner), 0, 'server rows revoked at logout');
      const after = await s.page.evaluate(() => ({ unsub: window.__push.unsubscribed, badge: window.__push.badge }));
      assert.equal(after.unsub, before + 1); assert.equal(after.badge.at(-1), 0);
      await s.context.close();
    });

    await t.test('account switch on one browser: the next user never inherits the subscription', async () => {
      const s = await open(U.leaderBar, { stub: 'granted', lang: 'vi' });
      await waitState(s.page, 'off');
      await panel(s.page).getByRole('button', { name: notificationText.vi.push.turnOn }).click();
      await waitState(s.page, 'on');
      await fits(s.page, 'on vi'); await s.page.screenshot({ path: path.join(shots, 'push-on-vi-390.png') });
      assert.equal(await active(U.leaderBar), 1);
      // Offline-style switch: no logout request; a different user simply appears on the device.
      await s.context.addCookies([{ name: 'baba_session', value: createServerSessionToken(U.owner), url: origin }]);
      await s.page.evaluate(() => { localStorage.setItem('baba_user', JSON.stringify({ id: 1, name: 'Owner A', role: 'owner', language: 'ko' })); window.dispatchEvent(new Event('baba_user_updated')); });
      await s.page.reload();
      await waitState(s.page, 'off');
      assert.equal(await active(U.leaderBar), 0, "previous user's device row revoked by sync");
      assert.equal(await active(U.owner), 0, 'new user not auto-registered');
      assert.equal(await s.page.evaluate(() => localStorage.getItem('__sub')), null, 'browser subscription dropped');
      await s.context.close();
    });

    await t.test('push click landing: server re-check then internal business page; others land on the center', async () => {
      let s = await open(U.owner, { target: `/notifications/open?id=${seeded.id}` });
      await s.page.waitForURL('**/work'); await s.page.getByRole('heading', { name: 'Business page' }).waitFor(); await s.context.close();
      s = await open(U.staffBar, { target: `/notifications/open?id=${seeded.id}` });
      await s.page.waitForURL(url => url.pathname === '/notifications'); await s.context.close();
      s = await open(U.owner, { target: '/notifications/open?id=https://evil.example' });
      await s.page.waitForURL(url => url.pathname === '/notifications' && url.origin === origin); await s.context.close();
    });

    await t.test('store settings: push channel per type, saved with revision, OFF by default, KO/VI', async () => {
      for (const lang of ['ko', 'vi']) {
        const copy = notificationSettingsText[lang];
        const { page, context } = await open(U.owner, { lang, target: '/admin/settings/store' });
        const tabs = page.locator('nav button');
        await tabs.first().waitFor();
        assert.equal(await tabs.count(), 4, 'still 4 tabs');
        await page.locator('nav button', { hasText: copy.tab }).click();
        const pos = page.getByTestId('notification-type-inventory.pos_deduction_pending');
        await pos.waitFor();
        await pos.getByTestId('notification-details-toggle').click();
        const push = pos.getByRole('checkbox', { name: copy.push });
        await push.waitFor();
        assert.equal(await push.isChecked(), lang === 'vi', 'OFF by default (VI run sees the KO save)');
        await pos.getByText(copy.pushNote).waitFor();
        await fits(page, `settings ${lang}`);
        await page.screenshot({ path: path.join(shots, `settings-push-${lang}-390.png`), fullPage: true });
        if (lang === 'ko') {
          await push.check();
          await pos.getByText(copy.unsaved, { exact: true }).waitFor();
          await pos.getByRole('button', { name: copy.save, exact: true }).click();
          await pos.getByText(copy.saved).waitFor();
          const [p] = (await db.query("select push_enabled, revision from notification_private.policies where type_code='inventory.pos_deduction_pending'")).rows;
          assert.deepEqual([p.push_enabled, p.revision], [true, 2]);
        }
        await context.close();
      }
    });
    await t.test('01B-FINAL-2 consent: another account logs in while the permission prompt is open -> nothing registered', async () => {
      const s = await open(U.owner, { stub: 'granted-wait' });
      await waitState(s.page, 'off');
      const posts = [];
      s.page.on('response', async r => { if (r.request().method() === 'POST' && r.url().endsWith('/api/notifications/push')) posts.push([r.status(), (await r.json().catch(() => ({}))).code]); });
      await panel(s.page).getByRole('button', { name: notificationText.ko.push.turnOn }).click();
      await s.page.waitForFunction(() => window.__push.requested === 1);
      // The next account's login lands in this browser (cookies) before the page itself knows.
      await s.context.addCookies([{ name: 'baba_session', value: createServerSessionToken(U.leaderBar), url: origin }]);
      await s.page.evaluate(() => window.__releasePermission());
      await s.page.waitForTimeout(1500);
      assert.ok(posts.some(([status, code]) => status === 409 && code === 'PUSH_USER_CHANGED'), JSON.stringify(posts));
      assert.equal(await active(U.owner), 0); assert.equal(await active(U.leaderBar), 0);
      assert.notEqual(await panel(s.page).getAttribute('data-state'), 'on');
      await s.context.close();
    });

    await t.test('01B-FINAL: reloads reuse the last sync, language follows the app, service OFF shows "paused" (not "on")', async () => {
      const s = await open(U.owner, { stub: 'granted' });
      await waitState(s.page, 'off');
      await panel(s.page).getByRole('button', { name: notificationText.ko.push.turnOn }).click();
      await waitState(s.page, 'on');
      const syncBodies = [];
      s.page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/api/notifications/push') && (r.postData() ?? '').includes('"sync"')) syncBodies.push(JSON.parse(r.postData())); });
      for (let i = 0; i < 3; i++) { await s.page.reload(); await waitState(s.page, 'on'); }
      assert.equal(syncBodies.length, 1, 'three reloads, one sync (cross-tab reuse window)');
      // Routine profile refresh events do not re-sync.
      await s.page.evaluate(() => { for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('baba_user_updated')); });
      await s.page.waitForTimeout(500);
      assert.equal(syncBodies.length, 1);
      // App language -> device push language.
      await s.page.locator('header span', { hasText: '🇰🇷' }).click();
      await s.page.waitForFunction(() => document.body.innerText.includes('Thông báo đẩy trên thiết bị này'));
      await s.page.waitForTimeout(800);
      assert.equal(syncBodies.at(-1)?.lang, 'vi');
      const lang = (await db.query("select lang from notification_private.push_subscriptions where user_id=$1 and status='active'", [U.owner])).rows.map(r => r.lang);
      assert.deepEqual(lang, ['vi']);
      // Global switch OFF while this device is registered: "paused", never "on"; turning off still works.
      await start({ ...pushEnv, WEB_PUSH_ENABLED: 'false' });
      await s.page.reload();
      await waitState(s.page, 'paused');
      await panel(s.page).getByText(notificationText.vi.push.hint.paused).waitFor();
      await fits(s.page, 'paused vi'); await s.page.screenshot({ path: path.join(shots, 'push-paused-vi-390.png') });
      await panel(s.page).getByRole('button', { name: notificationText.vi.push.turnOff }).click();
      await waitState(s.page, 'unavailable');
      assert.equal(await active(U.owner), 0);
      await s.context.close();
      await start(pushEnv);
    });
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser?.close().catch(() => {});
    if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
    await new Promise(resolve => transport.close(resolve));
    await db.close();
    if (oldSecret === undefined) delete process.env.BABA_SESSION_SECRET; else process.env.BABA_SESSION_SECRET = oldSecret;
  }
});
