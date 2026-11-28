// Isolated Next build of the real /admin/settings/store page (hours / attendance / holidays / notifications)
// with the real store-settings, audit, holidays, prepare-year and notification-settings routes, real signed
// sessions, a fixture PostgREST transport for the store tables/RPCs and PGlite + the real notification
// migration. No repository .env is loaded and no external host is reachable from the browser.
// BABA_BROWSER_DEV=1 runs against `next dev` (React reports style conflicts only in development).
// BABA_SHOT_TAG names the 4-tab screenshots (e.g. before/after); BABA_SHOTS_ONLY=1 stops after them.
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
import { notificationSettingsText } from '../lib/text/notifications.ts';
import { baseSql, migration, U } from './helpers/notification-fixture.mjs';

const JSONB = new Set(['p_policy', 'p_payload', 'p_evidence']);
const TABS = { ko: ['운영시간', '근태설정', '공휴일'], vi: ['Giờ mở cửa', 'Chấm công', 'Ngày lễ'] };
const WIDTHS = [320, 360, 390, 414, 1280];

// Store business date = Vietnam local date with the 03:00 cutoff (same rule as the app).
const businessDate = () => new Date(Date.now() + 7 * 3600e3 - 3 * 3600e3).toISOString().slice(0, 10);
const hoursOf = (friSat) => Array.from({ length: 7 }, (_, weekday) => ({
  weekday, isClosed: false, openTime: '16:00', closeTime: weekday === 5 || weekday === 6 ? friSat : '01:00',
}));
const version = (id, revision, effective, hours, policy) => ({
  id, timezone: 'Asia/Ho_Chi_Minh', businessDayCutoffTime: '03:00', effectiveFromBusinessDate: effective, revision,
  state: 'active', createdBy: 1, createdAt: '2026-10-30T09:00:00Z', cancelledBy: null, cancelledAt: null,
  attendancePolicy: policy, hours,
});
const holidayRow = (id, date, code, group, ko, vi, selected = false) => ({
  id, holiday_date: date, holiday_code: code, name_ko: ko, name_vi: vi, holiday_group: group,
  is_paid_holiday: true, is_employer_selected: false, calendar_year: Number(date.slice(0, 4)),
  store_holiday_operation_policies: selected ? [{ internal_pay_multiplier: 2 }] : [],
});

test('store settings UI in a real browser: 4 tabs, KO/VI 320–1280 px, collapsible editors, drafts kept, saves', { timeout: 600000 }, async t => {
  const root = process.cwd(); const work = path.resolve('.local/store-ui-refine'); const preview = path.join(work, 'preview');
  const shots = path.join(work, 'screens'); mkdirSync(shots, { recursive: true }); mkdirSync(path.join(work, 'tmp'), { recursive: true });
  const put = (file, text) => { const target = path.join(preview, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text); };
  put('package.json', JSON.stringify({ name: 'baba-store-settings-offline-check', private: true, version: '1.0.0' }));
  put('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['dom', 'esnext'], strict: true, noEmit: true, skipLibCheck: true,
    esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', jsx: 'react-jsx', resolveJsonModule: true, allowImportingTsExtensions: true,
    baseUrl: root, paths: { '@/*': ['./*'] }, plugins: [{ name: 'next' }] }, include: ['**/*.ts', '**/*.tsx', '.next/types/**/*.ts'], exclude: ['node_modules'] }));
  put('next.config.mjs', 'export default { devIndicators:false, experimental:{externalDir:true} };');
  put('postcss.config.mjs', readFileSync('postcss.config.mjs', 'utf8'));
  put('app/layout.tsx', `import {LanguageProvider} from '@/lib/language-context';import '@/app/globals.css';
    export default function Layout({children}:{children:React.ReactNode}){return <html><body><LanguageProvider>{children}</LanguageProvider></body></html>}`);
  put('app/(protected)/layout.tsx', `export {default} from '@/app/(protected)/layout';`);
  put('app/(protected)/admin/layout.tsx', `export {default} from '@/app/(protected)/admin/layout';`);
  put('app/(protected)/admin/settings/store/page.tsx', `export {default} from '@/app/(protected)/admin/settings/store/page';`);
  put('app/login/page.tsx', 'export default function Login(){return <main>Offline login boundary</main>}');
  for (const route of ['notifications/route.ts', 'notifications/summary/route.ts', 'admin/notification-settings/route.ts',
    'admin/store-settings/route.ts', 'admin/store-settings/audit/route.ts', 'admin/store-settings/holidays/route.ts',
    'admin/store-settings/holidays/prepare-year/route.ts']) put('app/api/' + route, readFileSync('app/api/' + route, 'utf8'));
  if (!existsSync(path.join(preview, 'node_modules'))) symlinkSync(path.join(root, 'node_modules'), path.join(preview, 'node_modules'), 'junction');

  const db = new PGlite();
  await db.exec(baseSql); await db.exec(migration);
  const exec = async (fn, args) => {
    const entries = Object.entries(args);
    await db.exec('set role service_role');
    try {
      const sql = `select public.${fn}(${entries.map(([k], i) => `${k} => $${i + 1}${JSONB.has(k) ? '::jsonb' : ''}`).join(',')}) data`;
      return (await db.query(sql, entries.map(([k, v]) => (JSONB.has(k) && v != null ? JSON.stringify(v) : v)))).rows[0].data;
    } finally { await db.exec('reset role'); }
  };

  // Store fixture state (stands in for store_setting_versions / store_holidays and their RPCs).
  const today = businessDate();
  const store = {
    latestRevision: 3, current: version(3, 3, '2026-11-01', hoursOf('02:00'), { lateGraceMinutes: 5, earlyLeaveGraceMinutes: 10, missingCheckoutGraceMinutes: 60 }),
    scheduled: null, audit: [{ id: 1, setting_version_id: 3, action: 'created', actor_user_id: 1, before_snapshot: null, after_snapshot: null, created_at: '2026-10-30T09:00:00Z' }],
    calendars: new Set([2026]), scheduleCalls: [],
    holidays: [
      holidayRow(1, '2026-01-01', 'NEW_YEAR', 'NEW_YEAR', '신정', 'Tết Dương lịch'),
      ...['16', '17', '18', '19', '20'].map((day, i) => holidayRow(2 + i, `2026-02-${day}`, `TET_${i + 1}`, 'TET', '음력설 연휴', 'Tết Nguyên Đán', i < 3)),
      holidayRow(7, '2026-04-26', 'HUNG_KINGS', 'HUNG_KINGS', '흥왕기념일', 'Giỗ Tổ Hùng Vương'),
      holidayRow(8, '2026-04-30', 'REUNIFICATION_DAY', 'REUNIFICATION_DAY', '남부해방 통일의 날', 'Ngày Giải phóng miền Nam, thống nhất đất nước'),
      holidayRow(9, '2026-05-01', 'LABOR_DAY', 'LABOR_DAY', '노동절', 'Ngày Quốc tế Lao động'),
      holidayRow(10, '2026-09-01', 'NATIONAL_DAY_ADJ', 'NATIONAL_DAY', '국경일 추가 휴일', 'Nghỉ lễ Quốc khánh'),
      holidayRow(11, '2026-09-02', 'NATIONAL_DAY', 'NATIONAL_DAY', '베트남 국경일', 'Quốc khánh Việt Nam', true),
    ],
  };
  const storeRpc = (fn, args) => {
    if (fn === 'store_business_date_for_timestamp_v1') return today;
    if (fn === 'store_get_settings_overview_v1') return { businessDate: today, latestRevision: store.latestRevision, current: store.current, scheduled: store.scheduled };
    if (fn === 'store_list_setting_audit_logs_v1') return [...store.audit].reverse();
    if (fn === 'store_schedule_settings_v1') {
      store.scheduleCalls.push(args);
      if (args.p_expected_revision !== store.latestRevision) return { status: 'version_conflict', latestRevision: store.latestRevision };
      if (store.scheduled) return { status: 'scheduled_exists' };
      store.latestRevision += 1;
      store.scheduled = version(10 + store.latestRevision, store.latestRevision, args.p_effective_from_business_date, args.p_hours, {
        lateGraceMinutes: args.p_late_grace_minutes, earlyLeaveGraceMinutes: args.p_early_leave_grace_minutes, missingCheckoutGraceMinutes: args.p_missing_checkout_grace_minutes });
      store.scheduled.businessDayCutoffTime = args.p_business_day_cutoff_time;
      store.audit.push({ id: store.audit.length + 1, setting_version_id: store.scheduled.id, action: 'created', actor_user_id: args.p_actor_user_id, before_snapshot: null, after_snapshot: null, created_at: new Date().toISOString() });
      return { status: 'ok', latestRevision: store.latestRevision };
    }
    if (fn === 'store_cancel_scheduled_settings_v1') {
      if (!store.scheduled || args.p_setting_version_id !== store.scheduled.id) return { status: 'not_found' };
      if (args.p_expected_revision !== store.latestRevision) return { status: 'version_conflict', latestRevision: store.latestRevision };
      store.audit.push({ id: store.audit.length + 1, setting_version_id: store.scheduled.id, action: 'cancelled', actor_user_id: args.p_actor_user_id, before_snapshot: null, after_snapshot: null, created_at: new Date().toISOString() });
      store.scheduled = null; store.latestRevision += 1;
      return { status: 'ok', latestRevision: store.latestRevision };
    }
    if (fn === 'store_toggle_holiday_operation_policy_v1') {
      const row = store.holidays.find(h => h.id === args.p_holiday_id);
      if (!row) return { status: 'not_found' };
      row.store_holiday_operation_policies = args.p_selected ? [{ internal_pay_multiplier: 2 }] : [];
      return { status: 'ok', holidayId: row.id, selected: args.p_selected, internalPayMultiplier: args.p_selected ? 2 : null };
    }
    if (fn === 'store_prepare_holiday_calendar_v1') {
      const year = args.p_year; if (store.calendars.has(year)) return { status: 'year_already_exists' };
      store.calendars.add(year); let id = 100 + store.holidays.length;
      store.holidays.push(holidayRow(id++, `${year}-01-01`, 'NEW_YEAR', 'NEW_YEAR', '신정', 'Tết Dương lịch'));
      for (const [i, date] of args.p_tet_dates.entries()) store.holidays.push(holidayRow(id++, date, `TET_${i + 1}`, 'TET', '음력설 연휴', 'Tết Nguyên Đán'));
      store.holidays.push(holidayRow(id++, args.p_hung_kings_date, 'HUNG_KINGS', 'HUNG_KINGS', '흥왕기념일', 'Giỗ Tổ Hùng Vương'));
      store.holidays.push(holidayRow(id++, args.p_national_day_adjacent_date, 'NATIONAL_DAY_ADJ', 'NATIONAL_DAY', '국경일 추가 휴일', 'Nghỉ lễ Quốc khánh'));
      store.holidays.push(holidayRow(id++, `${year}-09-02`, 'NATIONAL_DAY', 'NATIONAL_DAY', '베트남 국경일', 'Quốc khánh Việt Nam'));
      store.holidays.sort((a, b) => a.holiday_date.localeCompare(b.holiday_date));
      return { status: 'ok', year };
    }
    return undefined;
  };

  let queue = Promise.resolve(); const rpcLog = [];
  const inQueue = fn => { const run = queue.then(fn); queue = run.catch(() => {}); return run; };
  const transport = http.createServer((req, res) => {
    queue = queue.then(async () => {
      res.setHeader('Content-Type', 'application/json');
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const eq = key => url.searchParams.get(key)?.replace(/^eq\./, '');
        if (url.pathname === '/rest/v1/users') {
          const inList = url.searchParams.get('id')?.match(/^in\.\((.*)\)$/);
          const ids = inList ? inList[1].split(',').map(Number) : [Number(eq('id'))];
          res.end(JSON.stringify((await db.query('select * from public.users where id = any($1::bigint[])', [ids])).rows)); return;
        }
        if (url.pathname === '/rest/v1/store_holiday_calendars') {
          const year = Number(eq('year')); res.end(JSON.stringify(store.calendars.has(year) ? [{ year, country_code: 'VN' }] : [])); return;
        }
        if (url.pathname === '/rest/v1/store_holidays') {
          const year = Number(eq('calendar_year')); res.end(JSON.stringify(store.holidays.filter(h => h.calendar_year === year))); return;
        }
        const fn = url.pathname.replace('/rest/v1/rpc/', '');
        let text = ''; for await (const chunk of req) text += chunk;
        const args = JSON.parse(text || '{}'); rpcLog.push(fn);
        const storeResult = storeRpc(fn, args);
        if (storeResult !== undefined) { res.end(JSON.stringify(storeResult)); return; }
        if (!/^notification_[a-z_]+_v1$/.test(fn)) { res.statusCode = 404; res.end('{}'); return; }
        res.end(JSON.stringify(await exec(fn, args)));
      } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ code: e.code ?? 'XX000', message: 'offline fixture error' })); }
    }).catch(() => { res.statusCode = 500; res.end('{}'); });
  });
  await new Promise(resolve => transport.listen(0, '127.0.0.1', resolve)); const transportPort = transport.address().port;
  const secret = 'offline-store-settings-browser-session-secret'; const oldSecret = process.env.BABA_SESSION_SECRET;
  process.env.BABA_SESSION_SECRET = secret;
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
    TEMP: path.join(work, 'tmp'), TMP: path.join(work, 'tmp'), NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${transportPort}`, SUPABASE_SERVICE_ROLE_KEY: 'offline-synthetic-key',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'offline-synthetic-key', BABA_SESSION_SECRET: secret };
  const next = path.resolve('node_modules/next/dist/bin/next'); const buildLog = path.join(work, 'preview-build.log');
  const devMode = process.env.BABA_BROWSER_DEV === '1'; const shotTag = process.env.BABA_SHOT_TAG || 'after';
  let server, browser, descriptor;
  try {
    if (!devMode) {
      descriptor = openSync(buildLog, 'w');
      const build = spawnSync(process.execPath, [next, 'build', '--webpack'], { cwd: preview, env, windowsHide: true, stdio: ['ignore', descriptor, descriptor], timeout: 300000 });
      closeSync(descriptor); descriptor = undefined;
      assert.equal(build.status, 0, readFileSync(buildLog, 'utf8').slice(-6000));
      t.diagnostic('isolated store settings Next production build PASS');
    }
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const serverLog = openSync(path.join(work, 'preview-server.log'), 'w');
    server = spawn(process.execPath, [next, devMode ? 'dev' : 'start', ...(devMode ? ['--webpack'] : []), '--hostname', '127.0.0.1', '--port', String(port)],
      { cwd: preview, env, windowsHide: true, stdio: ['ignore', serverLog, serverLog] });
    closeSync(serverLog);
    const origin = `http://127.0.0.1:${port}`;
    for (let n = 0; n < (devMode ? 2400 : 200); n++) { try { if ((await fetch(origin + '/login')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 50)); }
    const { chromium } = await import(pathToFileURL(path.resolve('.local/browser-qa/node_modules/playwright/index.mjs')).href);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const errors = []; const consoleErrors = [];
    const NAMES = { [U.owner]: ['Owner A', 'owner'], [U.master]: ['Master B', 'master'], [U.leaderBar]: ['Leader Bar', 'leader'] };
    async function open(userId, { lang = 'ko', width = 390 } = {}) {
      const context = await browser.newContext({ viewport: { width, height: 860 }, locale: lang === 'ko' ? 'ko-KR' : 'vi-VN' });
      await context.addCookies([{ name: 'baba_session', value: createServerSessionToken(userId), url: origin }]);
      const [name, role] = NAMES[userId];
      await context.addInitScript(user => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('baba_user', JSON.stringify(user)); sessionStorage.setItem('seeded', '1'); } },
        { id: userId, name, role, language: lang });
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
      // Resource 404s are routes/assets the isolated preview does not copy (logo, /api/session, leave summary).
      page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) consoleErrors.push(m.text()); });
      await page.route('**/*', route => { const u = new URL(route.request().url()); return u.hostname !== '127.0.0.1' && u.protocol !== 'data:' ? route.abort() : route.continue(); });
      await page.goto(origin + '/admin/settings/store');
      await page.locator('nav button').first().waitFor();
      return { page, context };
    }
    const tabNames = lang => [...TABS[lang], notificationSettingsText[lang].tab];
    const gotoTab = async (page, lang, index) => {
      await page.locator('nav button', { hasText: tabNames(lang)[index] }).click();
      if (index === 2) await page.locator('main section').first().waitFor();
      if (index === 3) await page.getByText(notificationSettingsText[lang].typeNames['attendance.leave_request_pending'], { exact: true }).waitFor();
      await page.waitForTimeout(400);
    };

    await t.test(`4-tab mobile screenshots (${shotTag})`, async () => {
      for (const lang of ['ko', 'vi']) {
        const { page, context } = await open(U.master, { lang });
        for (const [index, key] of ['hours', 'attendance', 'holidays', 'notifications'].entries()) {
          await gotoTab(page, lang, index);
          await page.screenshot({ path: path.join(shots, `${shotTag}-${key}-${lang}-390.png`), fullPage: true });
        }
        await context.close();
      }
    });
    if (process.env.BABA_SHOTS_ONLY === '1') return;

    // Visible layout problems: page-level horizontal overflow, clipped button/label text, overlapping buttons.
    const layoutProblems = page => page.evaluate(() => {
      const problems = [];
      if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page overflow ${document.documentElement.scrollWidth} > ${innerWidth}`);
      const main = document.querySelector('main'); const mainRect = main.getBoundingClientRect();
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
      const buttons = [...main.querySelectorAll('button, label, input, select, [role=switch]')].filter(visible);
      for (const el of buttons) {
        const r = el.getBoundingClientRect();
        if (r.right > mainRect.right + 1 || r.left < mainRect.left - 1) problems.push(`outside main: ${el.tagName} "${el.textContent.trim().slice(0, 30)}"`);
        if (el.tagName === 'BUTTON' && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2)) problems.push(`clipped: "${el.textContent.trim().slice(0, 30)}"`);
      }
      const leaf = buttons.filter(el => el.tagName === 'BUTTON' || el.getAttribute('role') === 'switch');
      for (let i = 0; i < leaf.length; i++) for (let j = i + 1; j < leaf.length; j++) {
        if (leaf[i].contains(leaf[j]) || leaf[j].contains(leaf[i])) continue;
        const a = leaf[i].getBoundingClientRect(), b = leaf[j].getBoundingClientRect();
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 1 && h > 1) problems.push(`overlap: "${leaf[i].textContent.trim().slice(0, 20)}" / "${leaf[j].textContent.trim().slice(0, 20)}"`);
      }
      for (const el of main.querySelectorAll('h2, h3, strong, span, p, small')) {
        if (!visible(el)) continue;
        const cs = getComputedStyle(el);
        if ((cs.overflowX === 'hidden' || cs.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 1) problems.push(`truncated: "${el.textContent.trim().slice(0, 30)}"`);
      }
      return problems;
    });
    const expandAll = async page => {
      for (const toggle of await page.locator('main [aria-expanded="false"]').all()) if (await toggle.isVisible()) await toggle.click();
    };

    await t.test('KO/VI × 320/360/390/414/1280: 4 tabs (master) and 3 tabs (leader), collapsed and expanded, no overflow/clipping/overlap', async () => {
      for (const lang of ['ko', 'vi']) for (const width of WIDTHS) {
        const { page, context } = await open(U.master, { lang, width });
        assert.equal(await page.locator('nav button').count(), 4);
        for (const [index, key] of ['hours', 'attendance', 'holidays', 'notifications'].entries()) {
          await gotoTab(page, lang, index);
          assert.deepEqual(await layoutProblems(page), [], `${key}-${lang}-${width} collapsed`);
          if (width === 320 || width === 1280) await page.screenshot({ path: path.join(shots, `${key}-${lang}-${width}.png`), fullPage: true });
          await expandAll(page); await page.waitForTimeout(400);
          assert.deepEqual(await layoutProblems(page), [], `${key}-${lang}-${width} expanded`);
          if (width === 320) await page.screenshot({ path: path.join(shots, `${key}-${lang}-${width}-expanded.png`), fullPage: true });
        }
        await context.close();
        const leader = await open(U.leaderBar, { lang, width });
        assert.deepEqual(await leader.page.locator('nav button').allTextContents(), TABS[lang], 'leader keeps the 3 tabs');
        for (const index of [0, 1, 2]) {
          await gotoTab(leader.page, lang, index);
          assert.deepEqual(await layoutProblems(leader.page), [], `leader-${index}-${lang}-${width}`);
        }
        await leader.context.close();
      }
    });

    await t.test('hours: summary first, editor collapsed; input survives collapse and tab switch; schedule → confirm → cancel; history', async () => {
      const { page, context } = await open(U.owner);
      await page.getByText('16:00–02:00').first().waitFor();
      assert.equal(await page.locator('input[type="time"]').count(), 0, 'editor collapsed by default');
      await page.getByTestId('hours-edit-toggle').click();
      const friClose = page.getByLabel('금요일 요일별 운영시간').nth(1);
      await friClose.fill('03:00');
      await page.getByTestId('hours-edit-toggle').click();
      await page.getByTestId('hours-edit-toggle').click();
      assert.equal(await page.getByLabel('금요일 요일별 운영시간').nth(1).inputValue(), '03:00', 'kept across collapse');
      await gotoTab(page, 'ko', 1); await gotoTab(page, 'ko', 0);
      if (await page.getByTestId('hours-edit-toggle').getAttribute('aria-expanded') === 'false') await page.getByTestId('hours-edit-toggle').click();
      assert.equal(await page.getByLabel('금요일 요일별 운영시간').nth(1).inputValue(), '03:00', 'kept across tab switch');
      await page.getByRole('button', { name: '통합설정 예약', exact: true }).click();
      const dialog = page.getByRole('dialog'); await dialog.waitFor();
      await dialog.getByText('16:00~03:00').waitFor();
      await dialog.getByRole('button', { name: '예약하기', exact: true }).click();
      await page.getByRole('button', { name: '예약 취소', exact: true }).waitFor();
      const call = store.scheduleCalls.at(-1);
      assert.equal(call.p_hours[5].closeTime, '03:00');
      assert.deepEqual([call.p_late_grace_minutes, call.p_early_leave_grace_minutes, call.p_missing_checkout_grace_minutes], [5, 10, 60], 'unchanged attendance values are carried');
      assert.equal(call.p_expected_revision, 3);
      assert.equal(await page.getByTestId('hours-edit-toggle').count(), 0, 'no new schedule while one exists');
      await page.screenshot({ path: path.join(shots, 'hours-ko-390-scheduled.png'), fullPage: true });
      await page.getByRole('button', { name: '예약 취소', exact: true }).click();
      await page.getByTestId('hours-edit-toggle').waitFor();
      assert.equal(store.scheduled, null);
      await page.getByTestId('history-toggle').click();
      await page.getByTestId('history-list').getByText('#14').first().waitFor();
      await context.close();
    });

    await t.test('attendance: 3 criteria side by side, description and editor collapsible, invalid input blocked, schedule confirm shows values', async () => {
      const { page, context } = await open(U.owner);
      await gotoTab(page, 'ko', 1);
      const metrics = page.getByTestId('attendance-current');
      for (const value of ['5분', '10분', '60분']) await metrics.getByText(value, { exact: true }).waitFor();
      const tops = await metrics.locator('[data-metric]').evaluateAll(items => items.map(i => Math.round(i.getBoundingClientRect().top)));
      assert.equal(new Set(tops).size, 1, 'one row');
      await page.getByRole('button', { name: /기준 설명/ }).click();
      await page.getByText('예정 출근시간 + 설정값 이후 출근').waitFor();
      assert.equal(await page.locator('input[type="number"]').count(), 0, 'editor collapsed by default');
      await page.getByTestId('attendance-edit-toggle').click();
      const inputs = page.locator('input[type="number"]');
      await inputs.nth(0).fill('999');
      await page.getByRole('button', { name: '통합설정 예약', exact: true }).click();
      await page.getByText('입력값을 다시 확인해주세요.').waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
      await inputs.nth(0).fill('7');
      await page.getByRole('button', { name: '통합설정 예약', exact: true }).click();
      await page.getByRole('dialog').getByText('7분').waitFor();
      await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
      assert.equal(await page.getByRole('dialog').count(), 0);
      await context.close();
    });

    await t.test('holidays: slim year switcher, aligned rows with 200% marks, policy collapsible + immediate toggle, empty year, prepare', async () => {
      const { page, context } = await open(U.owner);
      await gotoTab(page, 'ko', 2);
      const list = page.getByTestId('holiday-list'); await list.waitFor();
      const rows = list.locator('li');
      assert.equal(await rows.count(), 11);
      const dateLefts = await rows.evaluateAll(items => items.map(li => Math.round(li.children[0].getBoundingClientRect().left)));
      assert.equal(new Set(dateLefts).size, 1, 'dates aligned');
      const badges = await rows.evaluateAll(items => items.map(li => li.querySelector('[data-premium]')?.textContent ?? ''));
      // Single-day holidays are 200% automatically; multi-day groups only for selected dates.
      assert.deepEqual(badges, ['200%', '200%', '200%', '200%', '', '', '200%', '200%', '200%', '', '200%']);
      assert.equal(await page.getByTestId('holiday-policy-body').count(), 0, 'policy collapsed by default');
      await page.getByTestId('holiday-policy-toggle').click();
      await page.getByTestId('holiday-policy-body').getByRole('button', { name: '02/19', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="holiday-list"] li')[4]?.querySelector('[data-premium]'));
      assert.deepEqual(store.holidays[4].store_holiday_operation_policies, [{ internal_pay_multiplier: 2 }]);
      await page.getByTestId('holiday-policy-body').getByRole('button', { name: '02/19', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="holiday-list"] li').length === 11 && !document.querySelectorAll('[data-testid="holiday-list"] li')[4].querySelector('[data-premium]'));
      await page.getByRole('button', { name: '다음 연도', exact: true }).click();
      await page.getByText('아직 2027년 공휴일이 준비되지 않았습니다.').waitFor();
      await page.screenshot({ path: path.join(shots, 'holidays-ko-390-empty-year.png'), fullPage: true });
      await page.locator('main').getByRole('button', { name: '2027년 공휴일 준비', exact: true }).last().click();
      const dialog = page.getByRole('dialog'); await dialog.waitFor();
      await dialog.locator('button').filter({ hasText: '1안' }).click();
      await dialog.getByRole('button', { name: '09/01 + 09/02', exact: true }).click();
      await dialog.getByRole('button', { name: '준비 완료', exact: true }).click();
      await page.getByTestId('holiday-list').waitFor();
      assert.ok(store.calendars.has(2027));
      assert.equal(await page.getByText('2027년 공휴일 설정이 아직 없습니다.', { exact: false }).count(), 0, 'reminder cleared');
      await context.close();
    });

    await t.test('notifications: compact cards, summary rows + checklists, people search, drafts kept, save lock, recipients match the DB', async () => {
      const copy = notificationSettingsText.ko;
      const { page, context } = await open(U.owner);
      await gotoTab(page, 'ko', 3);
      const leave = page.getByTestId('notification-type-attendance.leave_request_pending');
      const pos = page.getByTestId('notification-type-inventory.pos_deduction_pending');
      assert.equal(await page.getByText('attendance.leave_request_pending', { exact: true }).count(), 0, 'type code hidden');
      assert.equal(await page.getByTestId('rule-group-0').count(), 0, 'details collapsed by default');
      assert.equal(await page.getByText(copy.pushPending).count(), 0, 'Web Push note only inside details');
      // Icon / title / switch on one row, both cards aligned.
      const rows = await page.locator('[data-testid^="notification-type-"]').evaluateAll(cards => cards.map(card => {
        const icon = card.querySelector('[data-testid="notification-details-toggle"] > span').getBoundingClientRect();
        const sw = card.querySelector('[role="switch"]').getBoundingClientRect();
        return { iconLeft: Math.round(icon.left), switchRight: Math.round(sw.right), centerGap: Math.abs((icon.top + icon.bottom) / 2 - (sw.top + sw.bottom) / 2) };
      }));
      assert.equal(new Set(rows.map(r => r.iconLeft)).size, 1, 'icons aligned');
      assert.equal(new Set(rows.map(r => r.switchRight)).size, 1, 'switches aligned');
      for (const r of rows) assert.ok(r.centerGap <= 8, 'icon and switch on one row');
      // OFF state is told apart from the condition text.
      assert.equal(await pos.getAttribute('data-enabled'), 'false');
      await pos.getByText(copy.offNote, { exact: true }).waitFor();
      await pos.getByRole('switch', { name: copy.enabled }).click();
      await pos.getByText(copy.unsaved, { exact: true }).waitFor();
      assert.equal(await pos.getByText(copy.offNote, { exact: true }).count(), 0);

      await pos.getByTestId('notification-details-toggle').click();
      await pos.getByText(copy.pushPending).waitFor();
      await page.screenshot({ path: path.join(shots, 'notifications-ko-390-groups-summary.png'), fullPage: true });
      await pos.getByRole('button', { name: copy.removeGroup }).first().click();
      await pos.getByRole('button', { name: `+ ${copy.addGroup}` }).click();
      const group = pos.getByTestId('rule-group-0');
      const roles = group.getByTestId('rule-roles'); const parts = group.getByTestId('rule-parts');
      assert.equal(await roles.getByTestId('rule-roles-summary').textContent(), copy.any, 'empty group = 전체');
      assert.equal(await roles.getByRole('checkbox').count(), 0, 'checklist collapsed until its row is opened');
      // Role checklist: select / deselect / 전체.
      await roles.getByTestId('rule-roles-toggle').click();
      const roleBoxes = await roles.locator('label').evaluateAll(labels => labels.slice(1).map(l => Math.round(l.getBoundingClientRect().top)));
      assert.ok(roleBoxes[0] === roleBoxes[1], 'two columns');
      assert.equal(await roles.getByRole('checkbox', { name: copy.selectAll }).isChecked(), true);
      await roles.getByRole('checkbox', { name: '매니저', exact: true }).check();
      await roles.getByRole('checkbox', { name: '리더', exact: true }).check();
      assert.equal(await roles.getByRole('checkbox', { name: copy.selectAll }).isChecked(), false);
      assert.equal(await roles.getByTestId('rule-roles-summary').textContent(), '매니저, 리더');
      await page.screenshot({ path: path.join(shots, 'notifications-ko-390-roles-checklist.png'), fullPage: true });
      await roles.getByRole('checkbox', { name: copy.selectAll }).check();
      assert.equal(await roles.getByTestId('rule-roles-summary').textContent(), copy.any, '전체 clears the list');
      await roles.getByRole('checkbox', { name: '리더', exact: true }).check();
      await roles.getByRole('checkbox', { name: '매니저', exact: true }).check();
      await roles.getByRole('checkbox', { name: '매니저', exact: true }).uncheck();
      assert.equal(await roles.getByTestId('rule-roles-summary').textContent(), '리더');
      // Opening the part list closes the role list (one list at a time).
      await parts.getByTestId('rule-parts-toggle').click();
      assert.equal(await roles.getByRole('checkbox').count(), 0, 'only one checklist open');
      await parts.getByRole('checkbox', { name: 'Bar', exact: true }).check();
      await page.screenshot({ path: path.join(shots, 'notifications-ko-390-parts-checklist.png'), fullPage: true });
      // Second group (OR): manager × any part.
      await pos.getByRole('button', { name: `+ ${copy.addGroup}` }).click();
      const group2 = pos.getByTestId('rule-group-1');
      await group2.getByTestId('rule-roles-toggle').click();
      await group2.getByTestId('rule-roles').getByRole('checkbox', { name: '매니저', exact: true }).check();

      // People: collapsed summary, search filters the list only, selections kept.
      assert.equal(await pos.getByTestId('notification-people-list').count(), 0, 'people list collapsed by default');
      await pos.getByTestId('notification-people-toggle').click();
      const people = pos.getByTestId('notification-people-list');
      assert.equal(await people.getByRole('checkbox', { name: /Staff Bar/ }).isDisabled(), true, 'no business access → cannot be picked');
      await people.getByRole('checkbox', { name: /Leader Hall/ }).check();
      const search = pos.getByRole('searchbox', { name: copy.searchPlaceholder });
      await search.fill('kitchen');
      assert.equal(await people.getByRole('checkbox', { name: /Leader Hall/ }).count(), 0, 'filtered out of the list');
      await people.getByRole('checkbox', { name: /Leader Kitchen/ }).check();
      await page.screenshot({ path: path.join(shots, 'notifications-ko-390-people-search.png'), fullPage: true });
      await search.fill('zzz');
      await people.getByText(copy.noMatch).waitFor();
      await search.fill('');
      assert.equal(await people.getByRole('checkbox', { name: /Leader Hall/ }).isChecked(), true, 'search never unselects');
      assert.match(await pos.getByTestId('notification-people-summary').textContent(), /2명 선택/);

      // Draft kept across collapse, tab switch and another type's save.
      await pos.getByTestId('notification-details-toggle').click();
      assert.match(await pos.getByTestId('notification-summary').textContent(), /리더 · Bar \/ 매니저 \/ 개인 2명/);
      await pos.getByTestId('notification-details-toggle').click();
      await gotoTab(page, 'ko', 0); await gotoTab(page, 'ko', 3);
      await pos.getByText(copy.unsaved, { exact: true }).waitFor();
      await leave.getByTestId('notification-details-toggle').click();
      await leave.getByRole('button', { name: copy.save, exact: true }).click();
      await leave.getByText(copy.saved).waitFor();
      await pos.getByText(copy.unsaved, { exact: true }).waitFor();
      if (await pos.getByTestId('notification-details-toggle').getAttribute('aria-expanded') === 'false') await pos.getByTestId('notification-details-toggle').click();
      assert.equal(await pos.getByTestId('rule-group-0').getByTestId('rule-roles-summary').textContent(), '리더', 'kept after another save');
      await page.screenshot({ path: path.join(shots, 'notifications-ko-390-unsaved.png'), fullPage: true });

      // Save in flight: the card is frozen; a failed save keeps the draft.
      let release; const gate = new Promise(resolve => { release = resolve; });
      await page.route('**/api/admin/notification-settings', async route => {
        if (route.request().method() !== 'PUT') return route.continue();
        await gate; return route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' });
      });
      await pos.getByRole('button', { name: copy.save, exact: true }).click();
      await pos.getByRole('button', { name: copy.saving, exact: true }).waitFor();
      assert.equal(await pos.getByTestId('notification-body').evaluate(f => f.disabled), true, 'details frozen while saving');
      assert.equal(await pos.getByRole('switch', { name: copy.enabled }).isDisabled(), true, 'switch frozen while saving');
      assert.equal(await pos.getByRole('button', { name: copy.discard, exact: true }).isDisabled(), true, 'discard frozen while saving');
      await page.screenshot({ path: path.join(shots, 'notifications-ko-390-saving.png'), fullPage: true });
      release();
      await pos.getByText(copy.failed).waitFor();
      await page.unroute('**/api/admin/notification-settings');
      await pos.getByText(copy.unsaved, { exact: true }).waitFor();
      assert.equal(await pos.getByTestId('notification-body').evaluate(f => f.disabled), false);
      assert.match(await pos.getByTestId('notification-summary').textContent(), /리더 · Bar \/ 매니저 \/ 개인 2명/, 'draft kept after a failed save');

      const previewNames = (await pos.getByTestId('recipient-preview').textContent()).split(', ').sort();
      await pos.getByRole('button', { name: copy.save, exact: true }).click();
      await pos.getByText(copy.saved).waitFor();
      assert.equal(await pos.getByText(copy.unsaved, { exact: true }).count(), 0);
      await page.screenshot({ path: path.join(shots, 'notifications-ko-390-saved.png'), fullPage: true });
      const [saved] = (await inQueue(() => db.query("select enabled, rules from notification_private.policies where type_code='inventory.pos_deduction_pending'"))).rows;
      assert.equal(saved.enabled, true);
      assert.deepEqual(saved.rules, { groups: [{ roles: ['leader'], parts: ['bar'] }, { roles: ['manager'], parts: [] }], userIds: [U.leaderKitchen, U.leaderHall] });
      // The server-side recipient resolution for a new notification equals the preview shown before saving.
      const created = await inQueue(() => exec('notification_upsert_v1', { p_type_code: 'inventory.pos_deduction_pending', p_dedupe_key: 'ui-refine-2-check', p_payload: { titleKo: 'x', titleVi: 'x' } }));
      assert.equal(created.status, 'created');
      const dbNames = (await inQueue(() => db.query('select u.name from notification_private.recipients r join public.users u on u.id = r.user_id where r.notification_id = $1 order by u.name', [created.id]))).rows.map(r => r.name).sort();
      assert.deepEqual(dbNames, previewNames, 'DB recipients = UI preview');

      // Discard restores the saved state.
      await pos.getByRole('switch', { name: copy.enabled }).click();
      await pos.getByRole('button', { name: copy.discard, exact: true }).click();
      assert.equal(await pos.getByRole('switch', { name: copy.enabled }).getAttribute('aria-checked'), 'true');
      assert.equal(await page.getByTestId('notification-history-list').count(), 0, 'history collapsed by default');
      await page.getByTestId('notification-history-toggle').click();
      await page.getByTestId('notification-history-list').waitFor();
      // Repeated checkbox toggles keep the selected/unselected look without style warnings.
      await pos.getByTestId('rule-group-0').getByTestId('rule-parts-toggle').click();
      const hall = pos.getByTestId('rule-group-0').getByTestId('rule-parts').locator('label').filter({ hasText: 'Hall' });
      for (let n = 0; n < 6; n++) {
        await hall.click();
        assert.equal(await hall.evaluate(l => getComputedStyle(l).borderTopColor), n % 2 === 0 ? 'rgb(17, 24, 39)' : 'rgb(229, 231, 235)');
      }
      await context.close();
    });

    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(consoleErrors, [], 'no console errors');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    await browser?.close().catch(() => {});
    if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)); }
    await new Promise(resolve => transport.close(resolve));
    await db.close();
    if (oldSecret === undefined) delete process.env.BABA_SESSION_SECRET; else process.env.BABA_SESSION_SECRET = oldSecret;
  }
});
