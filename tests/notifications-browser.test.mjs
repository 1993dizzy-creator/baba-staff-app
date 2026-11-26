// Isolated Next production build of the real protected header, notification center, store
// settings tab and notification routes + real signed sessions + PGlite (real migration).
// No repository .env is loaded and no external host is reachable from the browser.
// Test binaries: npm.cmd --cache .local/npm-cache install --prefix .local/browser-qa --no-audit --no-fund playwright@1.65.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { createServerSessionToken } from '../lib/auth/session-token.ts';
import { notificationText, notificationSettingsText } from '../lib/text/notifications.ts';
import { baseSql, migration, testTypesSql, U, payload } from './helpers/notification-fixture.mjs';

const JSONB = new Set(['p_policy', 'p_payload', 'p_evidence']);

test('notification UI in a real browser: header bell, center, settings tab, DB missing/failure, polling, user switch', { timeout: 300000 }, async t => {
  const root = process.cwd(); const work = path.resolve('.local/notification-01a'); const preview = path.join(work, 'preview');
  const shots = path.join(work, 'screens'); mkdirSync(shots, { recursive: true }); mkdirSync(path.join(work, 'tmp'), { recursive: true });
  const put = (file, text) => { const target = path.join(preview, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text); };
  put('package.json', JSON.stringify({ name: 'baba-notification-offline-check', private: true, version: '1.0.0' }));
  put('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['dom', 'esnext'], strict: true, noEmit: true, skipLibCheck: true,
    esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', jsx: 'react-jsx', resolveJsonModule: true, allowImportingTsExtensions: true,
    baseUrl: root, paths: { '@/*': ['./*'] }, plugins: [{ name: 'next' }] }, include: ['**/*.ts', '**/*.tsx', '.next/types/**/*.ts'], exclude: ['node_modules'] }));
  put('next.config.mjs', 'export default { devIndicators:false, experimental:{externalDir:true} };');
  put('postcss.config.mjs', readFileSync('postcss.config.mjs', 'utf8'));
  put('app/layout.tsx', `import {LanguageProvider} from '@/lib/language-context';import '@/app/globals.css';
    export default function Layout({children}:{children:React.ReactNode}){return <html><body><LanguageProvider>{children}</LanguageProvider></body></html>}`);
  // Real protected header + real pages (thin re-exports resolve to repository code).
  put('app/(protected)/layout.tsx', `export {default} from '@/app/(protected)/layout';`);
  put('app/(protected)/notifications/page.tsx', `export {default} from '@/app/(protected)/notifications/page';`);
  put('app/(protected)/admin/layout.tsx', `export {default} from '@/app/(protected)/admin/layout';`);
  put('app/(protected)/admin/settings/store/page.tsx', `export {default} from '@/app/(protected)/admin/settings/store/page';`);
  put('app/(protected)/work/page.tsx', `export default function Work(){return <main style={{padding:16}}><h1>Business page</h1><p>Existing work screen placeholder</p></main>}`);
  put('app/login/page.tsx', 'export default function Login(){return <main>Offline login boundary</main>}');
  for (const route of ['notifications/route.ts', 'notifications/summary/route.ts', 'notifications/read/route.ts',
    'admin/notification-settings/route.ts', 'admin/store-settings/route.ts']) put('app/api/' + route, readFileSync('app/api/' + route, 'utf8'));
  if (!existsSync(path.join(preview, 'node_modules'))) symlinkSync(path.join(root, 'node_modules'), path.join(preview, 'node_modules'), 'junction');

  const db = new PGlite();
  await db.exec(baseSql); await db.exec(migration); await db.exec(testTypesSql);
  const exec = async (fn, args) => {
    const entries = Object.entries(args);
    await db.exec('set role service_role');
    try {
      const sql = `select public.${fn}(${entries.map(([k], i) => `${k} => $${i + 1}${JSONB.has(k) ? '::jsonb' : ''}`).join(',')}) data`;
      return (await db.query(sql, entries.map(([k, v]) => (JSONB.has(k) && v != null ? JSON.stringify(v) : v)))).rows[0].data;
    } finally { await db.exec('reset role'); }
  };
  const policy = async (type, rules, extra = {}) => {
    const [{ revision }] = (await db.query('select revision from notification_private.policies where type_code=$1', [type])).rows;
    assert.equal((await exec('notification_policy_update_v1', { p_actor_user_id: U.owner, p_type_code: type, p_expected_revision: revision,
      p_policy: { enabled: true, inAppEnabled: true, rules, ...extra } })).status, 'ok');
  };
  const seed = (type, key, extra) => exec('notification_upsert_v1', { p_type_code: type, p_dedupe_key: key, p_payload: payload(extra) });
  // Owner: 34 system + 1 sales notifications with mixed severities/states; leader bar: 105; staff no part: 0.
  await policy('system.test_all', { groups: [], userIds: [U.owner] });
  for (let i = 0; i < 34; i++) {
    await seed('system.test_all', `own:${i}`, { severity: ['urgent', 'warning', 'normal'][i % 3], titleKo: `테스트 알림 ${i + 1}`, titleVi: `Thông báo thử ${i + 1}`,
      bodyKo: i === 33 ? '긴 본문 '.repeat(40) : `본문 ${i + 1}`, bodyVi: i === 33 ? 'Nội dung rất dài để kiểm tra xuống dòng '.repeat(8) : `Nội dung ${i + 1}`,
      href: i === 33 ? '/admin/settings/store' : '/work' });
  }
  await exec('notification_resolve_v1', { p_type_code: 'system.test_all', p_dedupe_key: 'own:30', p_reason: 'business_resolved', p_evidence: null });
  await seed('sales.test_manager', 'sales:1', { titleKo: '매출 확인 필요', titleVi: 'Cần kiểm tra doanh thu', href: '/work' });
  await policy('system.test_all', { groups: [], userIds: [U.leaderBar] });
  for (let i = 0; i < 105; i++) await seed('system.test_all', `bar:${i}`);
  // Display re-checks the CURRENT policy, so the final rule must still cover both audiences.
  await policy('system.test_all', { groups: [], userIds: [U.owner, U.leaderBar] });

  let mode = 'db'; const rpcLog = []; let queue = Promise.resolve();
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
        if (fn === 'store_business_date_for_timestamp_v1') { res.end(JSON.stringify('2026-11-26')); return; }
        if (fn === 'store_get_settings_overview_v1') { res.end(JSON.stringify({ businessDate: '2026-11-26', latestRevision: 0, current: null, scheduled: null })); return; }
        if (!/^notification_[a-z_]+_v1$/.test(fn)) { res.statusCode = 404; res.end('{}'); return; }
        rpcLog.push(fn);
        if (mode === 'missing') { res.statusCode = 404; res.end(JSON.stringify({ code: 'PGRST202', message: 'Could not find the function' })); return; }
        if (mode === 'error') { res.statusCode = 500; res.end(JSON.stringify({ code: '57014', message: 'canceling statement due to statement timeout' })); return; }
        res.end(JSON.stringify(await exec(fn, JSON.parse(text || '{}'))));
      } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ code: e.code ?? 'XX000', message: 'offline fixture error' })); }
    }).catch(() => { res.statusCode = 500; res.end('{}'); });
  });
  await new Promise(resolve => transport.listen(0, '127.0.0.1', resolve)); const transportPort = transport.address().port;
  const secret = 'offline-notification-browser-session-secret-32'; const oldSecret = process.env.BABA_SESSION_SECRET;
  process.env.BABA_SESSION_SECRET = secret;
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
    TEMP: path.join(work, 'tmp'), TMP: path.join(work, 'tmp'), NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${transportPort}`, SUPABASE_SERVICE_ROLE_KEY: 'offline-synthetic-key',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'offline-synthetic-key', BABA_SESSION_SECRET: secret };
  const next = path.resolve('node_modules/next/dist/bin/next'); const buildLog = path.join(work, 'preview-build.log');
  let server, browser; let descriptor;
  try {
    descriptor = openSync(buildLog, 'w');
    const build = spawnSync(process.execPath, [next, 'build', '--webpack'], { cwd: preview, env, windowsHide: true, stdio: ['ignore', descriptor, descriptor], timeout: 240000 });
    closeSync(descriptor); descriptor = undefined;
    assert.equal(build.status, 0, readFileSync(buildLog, 'utf8').slice(-6000));
    t.diagnostic('isolated notification Next production build PASS');
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const serverLog = openSync(path.join(work, 'preview-server.log'), 'w');
    server = spawn(process.execPath, [next, 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: preview, env, windowsHide: true, stdio: ['ignore', serverLog, serverLog] });
    closeSync(serverLog);
    const origin = `http://127.0.0.1:${port}`;
    for (let n = 0; n < 200; n++) { try { if ((await fetch(origin + '/login')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
    const { chromium } = await import(pathToFileURL(path.resolve('.local/browser-qa/node_modules/playwright/index.mjs')).href);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const errors = [];
    const NAMES = { [U.owner]: ['Owner A', 'owner'], [U.leaderBar]: ['Leader Bar', 'leader'], [U.staffNullPart]: ['Staff NoPart', 'staff'], [U.master]: ['Master B', 'master'] };
    async function open(userId, { lang = 'ko', width = 390, path: target = '/work', clock = false } = {}) {
      const context = await browser.newContext({ viewport: { width, height: 860 }, locale: lang === 'ko' ? 'ko-KR' : 'vi-VN' });
      await context.addCookies([{ name: 'baba_session', value: createServerSessionToken(userId), url: origin }]);
      const [name, role] = NAMES[userId];
      await context.addInitScript(user => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('baba_user', JSON.stringify(user)); sessionStorage.setItem('seeded', '1'); } },
        { id: userId, name, role, language: lang });
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
      await page.route('**/*', route => { const u = new URL(route.request().url()); return u.hostname !== '127.0.0.1' && u.protocol !== 'data:' ? route.abort() : route.continue(); });
      if (clock) await page.clock.install();
      await page.goto(origin + target);
      return { page, context };
    }
    const bell = (page, lang = 'ko') => page.locator(`a[href="/notifications"][aria-label^="${notificationText[lang].bellLabel}"]`);
    const fits = async (page, label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), label + ' horizontal overflow');
    const headerHeight = page => page.evaluate(() => document.querySelector('header').getBoundingClientRect().height);

    await t.test('header bell: badge per user (35 / 99+ / hidden), KO/VI, 320–1280 px, header height unchanged', async () => {
      for (const lang of ['ko', 'vi']) for (const width of [320, 390, 1280]) {
        const { page, context } = await open(U.owner, { lang, width });
        await page.getByTestId('notification-badge').waitFor();
        assert.equal(await page.getByTestId('notification-badge').textContent(), '35');
        assert.equal(await headerHeight(page), 54);
        await fits(page, `${lang}-${width}`);
        const flag = await page.getByText(lang === 'ko' ? '🇰🇷' : '🇻🇳').boundingBox();
        const b = await bell(page, lang).boundingBox();
        assert.ok(b.x > flag.x && b.y >= 0 && b.y + b.height <= 54, 'bell inside the header, right of the language toggle');
        await page.screenshot({ path: path.join(shots, `header-${lang}-${width}.png`), clip: { x: 0, y: 0, width, height: 120 } });
        await context.close();
      }
      const leader = await open(U.leaderBar);
      await leader.page.getByTestId('notification-badge').waitFor();
      assert.equal(await leader.page.getByTestId('notification-badge').textContent(), '99+');
      await leader.page.screenshot({ path: path.join(shots, 'header-ko-390-99plus.png'), clip: { x: 0, y: 0, width: 390, height: 120 } });
      await leader.context.close();
      const staff = await open(U.staffNullPart);
      await bell(staff.page).waitFor();
      assert.equal(await staff.page.getByTestId('notification-badge').count(), 0, 'no badge at 0 unread');
      await staff.context.close();
    });

    await t.test('center: filters, severity/domain/time, read one, mark all, load more, safe navigation (mobile + PC)', async () => {
      for (const [lang, width] of [['ko', 390], ['vi', 390], ['ko', 1280], ['vi', 1280]]) {
        const { page, context } = await open(U.owner, { lang, width, path: '/notifications' });
        const copy = notificationText[lang];
        await page.getByRole('heading', { name: copy.title, exact: true }).waitFor();
        await page.locator('li').first().waitFor();
        assert.equal(await page.locator('li').count(), 30, 'first page = 30');
        await fits(page, `center-${lang}-${width}`);
        await page.screenshot({ path: path.join(shots, `center-${lang}-${width}.png`), fullPage: false });
        await page.getByRole('button', { name: copy.loadMore, exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('li').length === 35);
        await page.getByRole('button', { name: copy.filters.resolved, exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('li').length === 1);
        await page.getByText(copy.status.resolved).first().waitFor();
        await page.screenshot({ path: path.join(shots, `center-${lang}-${width}-resolved.png`) });
        await context.close();
      }
      const { page, context } = await open(U.owner, { path: '/notifications' });
      const copy = notificationText.ko;
      await page.locator('li').first().waitFor();
      await page.getByRole('button', { name: copy.filters.unread, exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('li').length === 30);
      await page.locator('li').first().getByRole('button', { name: copy.markRead, exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="notification-badge"]')?.textContent === '34');
      // A notification arriving after the list was loaded is newer than anything shown.
      await seed('sales.test_manager', 'sales:late', { titleKo: '늦게 도착한 알림', titleVi: 'Thông báo đến sau', href: '/work' });
      await page.getByRole('button', { name: copy.markAllRead, exact: true }).click();
      // Everything up to the newest shown id is read (older pages included); the late one stays unread.
      await page.waitForFunction(() => document.querySelector('[data-testid="notification-badge"]')?.textContent === '1');
      const resolvedState = (await db.query("select count(*)::int n from notification_private.notifications where status='resolved'")).rows[0].n;
      assert.equal(resolvedState, 1, 'reading never resolves');
      await page.getByRole('button', { name: copy.filters.all, exact: true }).click();
      await page.getByText('테스트 알림 34', { exact: true }).waitFor();
      await page.locator('li', { hasText: '테스트 알림 34' }).getByRole('button', { name: copy.open, exact: true }).click();
      await page.waitForURL(origin + '/admin/settings/store');
      await context.close();
    });

    await t.test('settings tab: owner/master edit BAR leader rule with preview; leader never sees the tab', async () => {
      for (const [lang, width] of [['ko', 390], ['vi', 1280]]) {
        const { page, context } = await open(U.master, { lang, width, path: '/admin/settings/store' });
        const copy = notificationSettingsText[lang];
        await page.getByRole('button', { name: copy.tab, exact: true }).click();
        await page.getByText(copy.typeNames['inventory.pos_deduction_pending'], { exact: true }).waitFor();
        await fits(page, `settings-${lang}-${width}`);
        await page.screenshot({ path: path.join(shots, `settings-${lang}-${width}.png`), fullPage: true });
        await context.close();
      }
      const { page, context } = await open(U.owner, { path: '/admin/settings/store' });
      const copy = notificationSettingsText.ko;
      await page.getByRole('button', { name: copy.tab, exact: true }).click();
      const card = page.getByTestId('notification-type-inventory.pos_deduction_pending');
      await card.getByLabel(copy.enabled).check();
      await card.getByRole('button', { name: copy.removeGroup }).click();
      await card.getByRole('button', { name: `+ ${copy.addGroup}` }).click();
      const group = card.getByTestId('rule-group-0');
      await group.getByTestId('rule-roles').getByRole('button', { name: '리더', exact: true }).click();
      await group.getByTestId('rule-parts').getByRole('button', { name: 'Bar', exact: true }).click();
      await card.getByTestId('recipient-preview').getByText('Leader Bar', { exact: true }).waitFor();
      await card.getByRole('button', { name: copy.save, exact: true }).click();
      await page.getByText(copy.saved).waitFor();
      await page.screenshot({ path: path.join(shots, 'settings-ko-390-saved.png'), fullPage: true });
      const [saved] = (await db.query("select enabled, rules from notification_private.policies where type_code='inventory.pos_deduction_pending'")).rows;
      assert.equal(saved.enabled, true);
      assert.deepEqual(saved.rules, { groups: [{ roles: ['leader'], positions: [], parts: ['bar'] }], userIds: [] });
      await context.close();
      const leader = await open(U.leaderBar, { path: '/admin/settings/store' });
      await leader.page.getByRole('button', { name: '공휴일', exact: true }).waitFor();
      assert.equal(await leader.page.getByRole('button', { name: copy.tab, exact: true }).count(), 0);
      await leader.context.close();
    });

    await t.test('polling: 120 s while visible, stopped in background, refreshed on return', async () => {
      const { page, context } = await open(U.owner, { clock: true });
      await page.getByTestId('notification-badge').waitFor();
      const count = () => rpcLog.filter(fn => fn === 'notification_unread_count_v1').length;
      const start = count();
      await page.clock.runFor(121_000);
      await page.waitForFunction(() => true); await new Promise(r => setTimeout(r, 300));
      assert.equal(count(), start + 1, 'one poll after 120 s');
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.clock.runFor(480_000); await new Promise(r => setTimeout(r, 300));
      assert.equal(count(), start + 1, 'no polling in the background');
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
      await new Promise(r => setTimeout(r, 500));
      assert.ok(count() >= start + 2, 'refresh on return to the app');
      await context.close();
    });

    await t.test('logout and user switch never show the previous user count', async () => {
      const { page, context } = await open(U.owner);
      await page.getByTestId('notification-badge').waitFor();
      await page.locator('header svg circle').locator('xpath=ancestor::div[1]').click();
      await page.getByRole('button', { name: '로그아웃', exact: true }).click();
      await page.waitForURL(origin + '/login');
      await context.addCookies([{ name: 'baba_session', value: createServerSessionToken(U.staffNullPart), url: origin }]);
      await page.evaluate(() => localStorage.setItem('baba_user', JSON.stringify({ id: 12, name: 'Staff NoPart', role: 'staff', language: 'ko' })));
      await page.goto(origin + '/work');
      await bell(page).waitFor();
      assert.equal(await page.getByTestId('notification-badge').count(), 0, 'new user (0 unread) sees no stale badge');
      await context.close();
    });

    await t.test('DB not installed: bell hidden, pages render; DB failure: pages render, center shows error not "empty"', async () => {
      mode = 'missing';
      let s = await open(U.owner);
      await s.page.getByRole('heading', { name: 'Business page' }).waitFor();
      await new Promise(r => setTimeout(r, 800));
      assert.equal(await bell(s.page).count(), 0, 'bell hidden while not installed');
      assert.equal(await headerHeight(s.page), 54);
      await s.page.screenshot({ path: path.join(shots, 'db-missing-header-ko-390.png'), clip: { x: 0, y: 0, width: 390, height: 200 } });
      await s.page.goto(origin + '/notifications');
      await s.page.getByText(notificationText.ko.notInstalled).waitFor();
      await s.page.goto(origin + '/admin/settings/store');
      await s.page.getByRole('button', { name: notificationSettingsText.ko.tab, exact: true }).click();
      await s.page.getByText(notificationSettingsText.ko.notInstalled).waitFor();
      await s.context.close();
      mode = 'error';
      s = await open(U.owner);
      await s.page.getByRole('heading', { name: 'Business page' }).waitFor();
      await new Promise(r => setTimeout(r, 800));
      assert.equal(await s.page.getByTestId('notification-badge').count(), 0, 'no fake 0 / count on failure');
      await s.page.goto(origin + '/notifications');
      await s.page.getByText(notificationText.ko.error).waitFor();
      assert.equal(await s.page.getByText(notificationText.ko.empty).count(), 0);
      await s.page.screenshot({ path: path.join(shots, 'db-error-center-ko-390.png') });
      await s.context.close();
      mode = 'db';
    });
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    await browser?.close().catch(() => {});
    if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
    await new Promise(resolve => transport.close(resolve));
    await db.close();
    if (oldSecret === undefined) delete process.env.BABA_SESSION_SECRET; else process.env.BABA_SESSION_SECRET = oldSecret;
  }
});
