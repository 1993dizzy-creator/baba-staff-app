// Opt-in real-browser QA (KO/VI x PC/mobile). Every /api/* request is served from the
// in-memory fixture below and any other origin is aborted: no database, POS or network.
// Run against a local `next start` with PLAYWRIGHT_MODULE_PATH and QA_UI_BASE_URL set.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { salesText } from '../lib/text/sales.ts';
import { salesCloseText } from '../lib/text/sales-close.ts';
import { commonText } from '../lib/text/common.ts';

const require = createRequire(import.meta.url), skip = !process.env.PLAYWRIGHT_MODULE_PATH || !process.env.QA_UI_BASE_URL;
const HELD = '2026-10-20', OTHER_HELD = '2026-10-19';
const minutesAgo = m => new Date(Date.now() - m * 60_000).toISOString();

function fixture() {
  const receipts = new Map([
    [8381, { id: 8381, refNo: '2601007063', tableName: 'A1', paymentStatus: 1, isCanceled: false, finalAmount: 955_000, refDate: minutesAgo(120) }],
    [8382, { id: 8382, refNo: '2601007064', tableName: 'A2', paymentStatus: 1, isCanceled: false, finalAmount: 789_000, refDate: minutesAgo(10) }],
    [8000, { id: 8000, refNo: '2601007000', tableName: 'B1', paymentStatus: 3, isCanceled: false, finalAmount: 500_000, refDate: minutesAgo(200) }],
  ]);
  const calls = { paymentStatus: [], refresh: 0 };
  const listItem = r => ({ id: r.id, refId: 'ref-' + r.id, refNo: r.refNo, refDate: r.refDate, statusChangedAt: null, tableName: r.tableName,
    paymentStatus: r.paymentStatus, isCanceled: r.isCanceled, totalAmount: r.finalAmount, finalAmount: r.finalAmount, isModified: r.isCanceled,
    reviewStatus: null, adminNote: null, lineCount: 1, optionLineCount: 0, payments: [] });
  const detail = r => ({ ok: true, hasOptionLines: false, payments: [], taxSummary: { totalTaxAmount: 0, taxByRate: [], taxSavingAmount: 0, amountDifferenceAmount: 0 },
    lines: [{ id: r.id * 10, refDetailId: 'd' + r.id, parentRefDetailId: null, itemName: 'Beer', unitName: 'ly', quantity: 1, unitPrice: r.finalAmount,
      amount: r.finalAmount, discountAmount: 0, finalAmount: r.finalAmount, taxRate: null, taxAmount: 0, isExcluded: false, refDetailType: 1 }],
    receipt: { ...listItem(r), businessDate: HELD, discountAmount: 0, vatAmount: 0, receiveAmount: null, returnAmount: null, customerName: null,
      modifiedAt: null, modifiedBy: null, modificationNote: null, originalAmountSummary: null, taxOverrideMode: null, calculatedVatAmount: null,
      calculatedFinalAmount: null, finalAmountOverride: null, revision: r.isCanceled ? 1 : 0 } });
  const pending = date => {
    const rows = date === HELD ? [...receipts.values()].filter(r => r.paymentStatus === 1 && !r.isCanceled) : [receipts.get(8382)];
    return { count: rows.length, totalAmount: rows.reduce((s, r) => s + r.finalAmount, 0),
      receipts: rows.map(r => ({ id: r.id, refNo: r.refNo, tableName: r.tableName, finalAmount: r.finalAmount, pendingSince: r.refDate, reviewDue: r.id === 8381 })) };
  };
  async function api(method, url, body) {
    const u = new URL(url), p = u.pathname, date = u.searchParams.get('businessDate') || HELD;
    if (p === '/api/session') return { authenticated: true, user: { id: 1, username: 'alice', name: 'Alice', role: 'owner' } };
    if (p === '/api/admin/sales/today') return { ok: true, businessDate: date, summary: { totalSales: 0, receiptCount: 0, paidReceiptCount: 0,
      canceledReceiptCount: 0, lineCount: 0, salesLineCount: 0, optionLineCount: 0, averageReceiptAmount: 0, deductionTargetLineCount: 0 },
      paymentSummary: { cashAmount: 0, transferAmount: 0, cardAmount: 0, otherAmount: 0, paymentTotalAmount: 0 },
      taxSummary: { totalTaxAmount: 0, taxSavingAmount: 0, amountDifferenceAmount: 0, taxByRate: [] }, hourlySales: [], topItems: [] };
    if (p === '/api/admin/sales/close-status') return { ok: true, businessDate: date, currentTotals: { total: 0, cash: 0, transfer: 0, card: 0, other: 0 },
      currentFingerprint: 'a'.repeat(64), sourceValid: true, latestClose: null, latestFinalCheck: null, drift: false, delta: null,
      canClose: pending(date).count === 0, canReclose: false, needsOwnerReview: false, monthClosed: false, finalCheckPending: false,
      closeEligibilityReason: pending(date).count ? 'pending_payment' : 'eligible', closeAt: null,
      finalSync: { runId: null, lastSyncedAt: null, cutoffAt: date + 'T03:00:00+07:00', eligible: false },
      ledgerProjection: { status: 'not_closed', total: 0 }, pendingPayments: pending(date), pendingHoldDates: [OTHER_HELD, HELD] };
    if (p === '/api/admin/sales/receipts') return { ok: true, businessDate: date, receipts: [...receipts.values()].map(listItem) };
    const m = p.match(/^\/api\/admin\/sales\/receipts\/(\d+)(\/[a-z-]+)?$/);
    if (m) {
      const r = receipts.get(Number(m[1]));
      if (!m[2]) return detail(r);
      if (m[2] === '/refresh-pos') { calls.refresh++; return { ok: true, paymentStatus: r.paymentStatus, isCanceled: r.isCanceled, editable: false, blockReason: 'pending' }; }
      if (m[2] === '/payment-status') {
        calls.paymentStatus.push(body);
        // The held day is already closed in this scenario: paid is refused, cancel is allowed.
        if (body.resolution === 'paid') return [409, { ok: false, code: 'receipt_business_day_closed' }];
        r.isCanceled = true; return { ok: true, result: { isCanceled: true } };
      }
    }
    return { ok: true, receipts: [], preview: { receipts: [] }, count: 0 };
  }
  return { api, calls };
}

test('pending payment KO/VI x PC/mobile: held date, close banner, badge, button switch, guarded status change', { skip, timeout: 240000 }, async () => {
  const playwright = require(process.env.PLAYWRIGHT_MODULE_PATH), base = process.env.QA_UI_BASE_URL;
  const browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.QA_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  await mkdir('.qa-review/pos-pending-payment/browser', { recursive: true });
  try {
    for (const lang of ['ko', 'vi']) for (const mobile of [false, true]) {
      const name = `${lang}-${mobile ? 'mobile' : 'pc'}`, close = salesCloseText[lang], edit = salesText[lang].receiptsEdit, list = salesText[lang].receipts;
      const context = await browser.newContext({ viewport: mobile ? { width: 360, height: 800 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, timezoneId: 'Asia/Ho_Chi_Minh' });
      await context.addInitScript(u => localStorage.setItem('baba_user', JSON.stringify(u)), { id: 1, username: 'alice', name: 'Alice', role: 'owner', language: lang });
      const page = await context.newPage(), f = fixture(), errors = [], offOrigin = [];
      page.setDefaultTimeout(10000);
      page.on('pageerror', e => errors.push(e.message));
      page.on('dialog', d => d.dismiss());
      await page.route('**/*', async route => {
        const req = route.request(), u = new URL(req.url());
        if (u.origin !== new URL(base).origin) { offOrigin.push(u.origin); return route.abort(); }
        if (!u.pathname.startsWith('/api/')) return route.continue();
        let out = await f.api(req.method(), req.url(), req.postData() ? JSON.parse(req.postData()) : null);
        const [status, body] = Array.isArray(out) ? out : [200, out];
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      });
      const noHorizontalScroll = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), name + ' horizontal scroll');

      // ④ Default date stays on the held day; existing close panel carries the hold details.
      await page.goto(base + '/admin/sales');
      await page.waitForURL(/businessDate=2026-10-20/);
      await page.getByText(close.pendingBlocked).waitFor();
      assert.equal(await page.locator('input[type=date]').inputValue(), HELD);
      assert.equal(await page.getByRole('button', { name: close.close, exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('link', { name: '2601007063' }).getAttribute('href'), `/admin/sales/receipts?businessDate=${HELD}&receiptId=8381`);
      await page.getByRole('button', { name: OTHER_HELD }).waitFor();
      await noHorizontalScroll();
      await page.screenshot({ path: `.qa-review/pos-pending-payment/browser/${name}-sales.png`, fullPage: true });

      // Shortcut opens the receipt; ② only the 30+ min pending receipt carries the badge.
      await page.getByRole('link', { name: '2601007063' }).click();
      await page.waitForURL(/\/admin\/sales\/receipts\?businessDate=2026-10-20&receiptId=8381/);
      const statusButton = page.getByRole('button', { name: edit.statusChangeTitle, exact: true });
      await statusButton.waitFor();
      assert.equal(await page.getByText(list.pendingReviewBadge, { exact: true }).count(), 1);
      await noHorizontalScroll();

      // ③ Button switch: POS re-check first, then the guarded form.
      await statusButton.click();
      await page.getByRole('button', { name: edit.statusChangeToPaid }).waitFor();
      assert.equal(f.calls.refresh, 1);
      const submit = page.getByRole('button', { name: edit.statusChangeSubmit });
      await submit.click();
      await page.getByText(edit.statusChangeInputRequired).waitFor();
      assert.equal(f.calls.paymentStatus.length, 0);
      await page.getByRole('button', { name: commonText[lang].transfer, exact: true }).click();
      await page.getByPlaceholder(edit.statusChangeEvidencePlaceholder).fill('Bank transfer #77 confirmed');
      await page.getByText(edit.statusChangeConfirm).click();
      await page.screenshot({ path: `.qa-review/pos-pending-payment/browser/${name}-form.png`, fullPage: true });
      await submit.dblclick();
      // ① closed-day protection message reaches the admin; double click sent one request.
      await page.getByText(edit.statusChangeClosedDay).waitFor().catch(async error => {
        await page.screenshot({ path: `.qa-review/pos-pending-payment/browser/${name}-failure.png`, fullPage: true });
        throw new Error(name + ' ' + JSON.stringify(f.calls) + ' ' + error.message);
      });
      assert.equal(f.calls.paymentStatus.length, 1);
      assert.equal(f.calls.paymentStatus[0].resolution, 'paid');
      await page.getByRole('button', { name: edit.statusChangeToCanceled }).click();
      await submit.click();
      // Resolved: badge cleared, original edit button restored.
      await page.getByRole('button', { name: edit.title, exact: true }).waitFor();
      assert.equal(await page.getByText(list.pendingReviewBadge, { exact: true }).count(), 0);
      assert.equal(f.calls.paymentStatus.length, 2);
      assert.equal(f.calls.paymentStatus[0].requestId, f.calls.paymentStatus[1].requestId);
      await page.screenshot({ path: `.qa-review/pos-pending-payment/browser/${name}-resolved.png`, fullPage: true });

      // Paid receipts keep the existing edit button and no badge.
      await page.getByText('2601007000').click();
      await page.getByRole('button', { name: edit.title, exact: true }).first().waitFor();
      assert.equal(await page.getByText(list.pendingReviewBadge, { exact: true }).count(), 0);

      // Other held day is reachable from the banner.
      await page.goto(base + '/admin/sales');
      await page.getByRole('button', { name: OTHER_HELD }).click();
      await page.waitForURL(/businessDate=2026-10-19/);
      assert.equal(await page.locator('input[type=date]').inputValue(), OTHER_HELD);

      assert.deepEqual(errors, [], name + ' page errors');
      assert.deepEqual(offOrigin.filter(o => !o.includes('fonts.g')), [], name + ' off-origin requests');
      await context.close();
    }
  } finally { await browser.close(); }
});
