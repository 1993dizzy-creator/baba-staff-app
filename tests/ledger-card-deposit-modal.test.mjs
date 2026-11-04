import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// 장부 내역 추가 › 수입 › 💳 카드입금: 공통 CardDepositForm(입력·미리보기·저장)과 모달/카드정산 페이지 연결.
const require = createRequire(import.meta.url);
const h = React.createElement;
const formPath = 'app/(protected)/admin/ledger/card-settlements/CardDepositForm.tsx';
const entriesPath = 'app/(protected)/admin/ledger/entries/page.tsx';
const cardPath = 'app/(protected)/admin/ledger/card-settlements/page.tsx';

// Renders the real component with seeded useState slots; effects are captured, never run automatically.
function formFixture({ states = {}, lang = 'ko', sources = null, sourcesError = null, saving = false, fetcher = () => { throw new Error('Unexpected network request'); }, onCreated = () => {} } = {}) {
  let index = 0; const updates = [], calls = [], effects = [], elements = [];
  const react = { ...React,
    useState(initial) { const slot = index++; const value = Object.hasOwn(states, slot) ? states[slot] : typeof initial === 'function' ? initial() : initial; return [value, next => updates.push({ slot, value: next })]; },
    useEffect(callback) { effects.push(callback); }, useRef(initial) { return { current: initial }; } };
  const runtime = require('react/jsx-runtime');
  const tracked = { ...runtime, ...Object.fromEntries(['jsx', 'jsxs'].map(name => [name, (type, props, ...rest) => { elements.push({ type, props }); return runtime[name](type, props, ...rest); }])) };
  const deps = {
    react, 'react/jsx-runtime': tracked,
    '@/components/bar/keeping/KeepingUi': { BarField: ({ children, label }) => h('label', null, label, children({ id: 'field' })), keepingInputStyle: {} },
    '@/lib/ledger/card-fee-policy': require('../lib/ledger/card-fee-policy.ts'),
    '@/lib/ledger/manual-entry-amount': require('../lib/ledger/manual-entry-amount.ts'),
    '@/lib/ledger/manual-transaction-form': require('../lib/ledger/manual-transaction-form.ts'),
    './card-settlements.module.css': { default: new Proxy({}, { get: (_, key) => String(key) }) },
  };
  const loaded = { exports: {} };
  const code = ts.transpileModule(readFileSync(formPath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require', 'module', 'exports', 'fetch', code)(name => { assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name]; }, loaded, loaded.exports, (url, options) => { calls.push({ url: String(url), options }); return fetcher(String(url), options); });
  const form = loaded.exports;
  const savingUpdates = [];
  let draft;
  // Hook order: 0 depositAt, 1 amount, 2 memo, 3 error.
  const Harness = () => {
    draft = form.useCardDepositDraft({ lang, sources, saving, setSaving: value => savingUpdates.push(value), onCreated });
    return h(form.CardDepositFields, { lang, draft, sources, sourcesError, disabled: saving });
  };
  const html = renderToStaticMarkup(h(Harness));
  return { html, draft, form, updates, calls, effects, elements, savingUpdates };
}
const sale = (id, date, outstanding, amount = outstanding) => ({ id, business_date: date, amount, allocatedGrossAmount: amount - outstanding, outstandingGrossAmount: outstanding });
const sources = (sales, autoFeeMonths = []) => ({ month: '2026-09', sales, autoFeeMonths });

test('card deposit fields format the amount and preview FIFO allocation of exactly the deposit', () => {
  const data = sources([sale(16, '2026-09-16', 900), sale(15, '2026-09-15', 14_606_200), sale(14, '2026-09-14', 6_245_400, 7_000_000)]);
  const state = formFixture({ sources: data, states: { 0: '2026-09-15T10:00', 1: '10000000' } });
  for (const label of ['📅 입금일시', '💵 실제 입금액', '💡 자동 정산 미리보기', '📝 메모']) assert.ok(state.html.includes(label), label);
  assert.doesNotMatch(state.html, /참조번호|Reference|입금계정|<select|수수료율|추천|<form/);
  const input = state.elements.find(element => element.type === 'input' && element.props.inputMode === 'numeric');
  assert.equal(input.props.value, '10,000,000'); assert.notEqual(input.props.type, 'number');
  input.props.onChange({ target: { value: '5,000,0001' } });
  assert.equal(state.updates.findLast(update => update.slot === 1).value, '50000001', 'the stored value stays digits only');
  const preview = state.html.slice(state.html.indexOf('💡 자동 정산 미리보기'), state.html.indexOf('📝 메모'));
  assert.match(preview, /<li><div><time dateTime="2026-09-14">매출일 09\/14<\/time><span>이번 정산 <strong>6\.245\.400 ₫<\/strong><\/span><\/div><div class="previewBalance">6\.245\.400 ₫ → 0 ₫<\/div><\/li>/);
  assert.match(preview, /<li><div><time dateTime="2026-09-15">매출일 09\/15<\/time><span>이번 정산 <strong>3\.754\.600 ₫<\/strong><\/span><\/div><div class="previewBalance">14\.606\.200 ₫ → 10\.851\.600 ₫<\/div><\/li>/);
  assert.match(preview, /총 정산 <strong>10\.000\.000 ₫<\/strong> = 실제 입금/);
  assert.doesNotMatch(preview, /09\/16|수수료/);
  assert.equal(state.draft.canSubmit, true);
});

test('card deposit fields block short, missing and review-required plans and hint before an amount', () => {
  const data = sources([sale(14, '2026-09-14', 6_245_400), sale(16, '2026-09-16', 9_000_000)]);
  const short = formFixture({ sources: data, states: { 0: '2026-09-15T10:00', 1: '6245401' } });
  assert.match(short.html, /role="alert" class="validation">미정산 카드매출 잔액이 실제 입금액보다 부족합니다\. \(정산 가능 미정산 6\.245\.400 ₫\)/);
  assert.equal(short.draft.canSubmit, false);
  const empty = formFixture({ sources: data, states: { 0: '2026-09-15T10:00' } });
  assert.match(empty.html, /실제 입금액을 입력하면 오래된 미정산 카드매출부터 자동 정산합니다\./);
  assert.match(empty.html, /정산 가능 미정산 6\.245\.400 ₫/);
  assert.equal(empty.draft.canSubmit, false);
  assert.match(formFixture({ sources: data, states: { 0: '2026-09-13T10:00', 1: '100' } }).html, /입금일 이전의 미정산 카드매출이 없습니다\./);
  // Closed-month fee check: a remaining rate below the auto-close minimum needs review, so nothing can be saved.
  const review = formFixture({ sources: sources([sale(1, '2026-08-20', 1_000)], [{ month: '2026-08', gross: 1_000_000, outstanding: 1_000 }]), states: { 0: '2026-09-05T10:00', 1: '500' } });
  assert.match(review.html, /카드 정산 데이터를 확인해주세요\./); assert.equal(review.draft.canSubmit, false);
  // Sources still loading or failed: no preview numbers and no save.
  const loading = formFixture({ states: { 0: '2026-09-15T10:00', 1: '100' } });
  assert.match(loading.html, /카드 정산 정보를 불러오는 중…/); assert.equal(loading.draft.canSubmit, false);
  assert.match(formFixture({ sourcesError: 'CARD_FEES_LOAD_FAILED' }).html, /role="alert" class="validation">카드 정산 정보를 불러오지 못했습니다\. CARD_FEES_LOAD_FAILED/);
});

test('deposits before 03:00 settle against the previous Vietnam business date like the RPC', () => {
  const data = sources([sale(14, '2026-09-14', 1_000), sale(15, '2026-09-15', 2_000)]);
  const early = formFixture({ sources: data, states: { 0: '2026-09-15T02:30', 1: '1500' } });
  assert.match(early.html, /03:00 이전이라 2026-09-14 영업일 입금으로 정산합니다\./);
  assert.match(early.html, /미정산 카드매출 잔액이 실제 입금액보다 부족합니다\. \(정산 가능 미정산 1\.000 ₫\)/);
  const at3 = formFixture({ sources: data, states: { 0: '2026-09-15T03:00', 1: '1500' } });
  assert.doesNotMatch(at3.html, /03:00 이전이라/); assert.equal(at3.draft.canSubmit, true);
  const { cardDepositBusinessDate } = early.form;
  assert.equal(cardDepositBusinessDate('2026-10-01T02:59'), '2026-09-30');
  assert.equal(cardDepositBusinessDate('2026-10-01T03:00'), '2026-10-01');
});

test('submit posts only the existing card settlement API and reports allocations; blocked plans never post', async () => {
  const data = sources([sale(1, '2026-09-10', 5_000_000)]);
  const created = [];
  const state = formFixture({ sources: data, states: { 0: '2026-09-14T12:30', 1: '982000', 2: 'Memo' }, onCreated: count => created.push(count),
    fetcher: async () => Response.json({ ok: true, result: { status: 'created', allocations: [{ transactionId: 1 }] } }, { status: 201 }) });
  await state.draft.submit();
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].url, '/api/admin/ledger/card-settlements'); assert.equal(state.calls[0].options.method, 'POST');
  // The amount is sent as the parsed number; the deposit time keeps its local wall clock (+07:00) for the RPC's 03:00 rule.
  assert.deepEqual(JSON.parse(state.calls[0].options.body), { depositAt: '2026-09-14T12:30:00+07:00', amount: 982000, memo: 'Memo' });
  assert.deepEqual(created, [1]); assert.deepEqual(state.savingUpdates, [true, false]);
  const blocked = formFixture({ sources: sources([]), states: { 0: '2026-09-14T12:30', 1: '982' }, fetcher: () => { throw new Error('must not post'); } });
  await blocked.draft.submit(); assert.equal(blocked.calls.length, 0);
  const failed = formFixture({ sources: data, states: { 0: '2026-09-14T12:30', 1: '982000' }, onCreated: () => { throw new Error('must not close'); },
    fetcher: async () => Response.json({ ok: false, code: 'INSUFFICIENT_CARD_PENDING' }, { status: 409 }) });
  await failed.draft.submit();
  assert.equal(failed.updates.findLast(update => update.slot === 3).value, '등록 실패: 미정산 카드매출 잔액이 실제 입금액보다 부족합니다.');
  const closed = formFixture({ sources: data, states: { 0: '2026-09-14T12:30', 1: '982000' }, fetcher: async () => Response.json({ ok: false, code: 'MONTH_CLOSED' }, { status: 409 }) });
  await closed.draft.submit();
  assert.equal(closed.updates.findLast(update => update.slot === 3).value, '등록 실패: MONTH_CLOSED');
});

test('sources load both card settlement reads for the ledger month only when enabled', async () => {
  const fetcher = async url => Response.json(url.includes('card-fees') ? { autoFeeMonths: [{ month: '2026-08', gross: 10, outstanding: 1 }] } : { month: '2026-09', sales: [sale(1, '2026-09-01', 1)] });
  let index = 0; const updates = [], effects = [], calls = [];
  const react = { ...React, useState(initial) { const slot = index++; return [initial, next => updates.push({ slot, value: next })]; }, useEffect(callback) { effects.push(callback); }, useRef(initial) { return { current: initial }; } };
  const deps = { react, 'react/jsx-runtime': require('react/jsx-runtime'), '@/components/bar/keeping/KeepingUi': {}, '@/lib/ledger/card-fee-policy': {}, '@/lib/ledger/manual-entry-amount': {}, '@/lib/ledger/manual-transaction-form': {}, './card-settlements.module.css': { default: {} } };
  const loaded = { exports: {} };
  const code = ts.transpileModule(readFileSync(formPath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require', 'module', 'exports', 'fetch', code)(name => deps[name], loaded, loaded.exports, (url, options) => { calls.push(String(url)); return fetcher(String(url), options); });
  loaded.exports.useCardDepositSources('2026-09', false);
  effects.pop()(); assert.equal(calls.length, 0, 'disabled: no request');
  loaded.exports.useCardDepositSources('2026-09', true);
  effects.pop()(); for (let tick = 0; tick < 20 && !updates.length; tick++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['/api/admin/ledger/card-settlements?month=2026-09', '/api/admin/ledger/card-fees?month=2026-09']);
  // Second hook call: its useState slots are 2 (sources) and 3 (error).
  assert.deepEqual(updates.find(update => update.slot === 3)?.value, null);
  assert.deepEqual(updates.find(update => update.slot === 2)?.value, { month: '2026-09', sales: [sale(1, '2026-09-01', 1)], autoFeeMonths: [{ month: '2026-08', gross: 10, outstanding: 1 }] });
});

test('card deposit fields render Vietnamese throughout', () => {
  const data = sources([sale(1, '2026-08-01', 1000)]);
  const form = formFixture({ lang: 'vi', sources: data, states: { 0: '2026-08-20T10:00', 1: '600' } }).html;
  for (const label of ['Thời điểm tiền về', 'Số tiền thực nhận', 'Xem trước quyết toán tự động', 'Ghi chú']) assert.ok(form.includes(label), label);
  assert.match(form, /<time dateTime="2026-08-01">Ngày bán 08\/01<\/time><span>Lần này <strong>600 ₫<\/strong><\/span>/);
  assert.match(form, /Tổng quyết toán <strong>600 ₫<\/strong> = Tiền thực nhận/);
  assert.doesNotMatch(form, /[가-힣]/);
  assert.match(formFixture({ lang: 'vi', sources: data, states: { 0: '2026-08-20T01:00', 1: '600' } }).html, /Trước 03:00 nên quyết toán theo ngày kinh doanh 2026-08-19\./);
});

test('ledger entry sheet: income starts with a 5:5 card/general choice and card deposits never post as manual income', () => {
  const page = readFileSync(entriesPath, 'utf8');
  const sheet = page.slice(page.indexOf('function ManualEntrySheet('), page.indexOf('function entryDisplayEmoji('));
  // 기존 지출/수입/이체/잔액조정 탭 유지
  for (const tab of ['value: "expense"', 'value: "income"', 'value: "transfer"', 'value: "balance_adjustment"']) assert.ok(sheet.includes(tab), tab);
  assert.match(sheet, /\[\["card", `💳 \$\{vi \? "Tiền thẻ về" : "카드입금"\}`\], \["general", `💵 \$\{vi \? "Thu thông thường" : "일반수입"\}`\]\]/);
  assert.match(sheet, /if \(next === "income"\) setIncomeMode\(null\);/);
  assert.match(sheet, /\{cardDeposit \? \(\s*<CardDepositFields /);
  assert.match(sheet, /\) : incomeChooser \? null : \(\s*<div className=\{styles\.manualGrid\}>/);
  // 카드입금은 manual POST(/api/admin/ledger) 이전에 공통 카드정산 저장으로 분기한다.
  const submit = sheet.slice(sheet.indexOf('async function submit('));
  assert.ok(submit.indexOf('if (cardDeposit) { void cardDraft.submit(); return; }') > -1);
  assert.ok(submit.indexOf('if (cardDeposit) { void cardDraft.submit(); return; }') < submit.indexOf('"/api/admin/ledger"'));
  assert.match(sheet, /onCreated: count => onSaved\(cardDepositText\[lang\]\.created\(count\)\)/);
  assert.match(sheet, /disabled=\{saving \|\| incomeChooser \|\| \(cardDeposit && !cardDraft\.canSubmit\)\}/);
  // 저장 성공 → 모달 닫기 + load()(목록·잔액, 카드정산 요약 재조회 키 갱신) → 갱신 성공 시 자동 정산 N건 안내
  assert.match(page, /onSaved=\{async \(message\?: string\) => \{\s*setManualOpen\(false\);\s*const fresh = await load\(\);\s*if \(fresh && message\) setNotice\(message\);/);
  // 일반 수기 저장은 안내 메시지 없이 기존대로
  assert.match(sheet, /if \(!manualSheetMountedRef\.current\) return;\s*await onSaved\(\);/);
  assert.match(page, /bumpInvestmentsVersion\(\);/); assert.match(page, /const key = `\$\{requestedMonth\}:\$\{investmentsVersion\}`;\s*if \(cardSettlementLoadedKeyRef/);
  const css = readFileSync('app/(protected)/admin/ledger/entries/entries.module.css', 'utf8');
  assert.match(css, /\.incomeModeChooser\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css, /@media[^{]*\{[^}]*\.incomeModeChooser/);
  // 선택 전·후 같은 버튼 클래스: 최소 높이 60px, 선택 상태는 색만 바뀐다.
  assert.match(css, /\.incomeModeButton\{[^}]*min-height:60px;box-sizing:border-box;/);
  assert.doesNotMatch(css.match(/\.incomeModeButton\[aria-pressed="true"\]\{[^}]*\}/)[0], /height|padding|border-width|font-size/);
});

test('card deposit success notice reports the auto-settled sale count in Korean and Vietnamese', () => {
  const { cardDepositText } = formFixture().form;
  assert.equal(cardDepositText.ko.created(2), '카드 입금을 등록하고 카드매출 2건을 자동 정산했습니다.');
  assert.equal(cardDepositText.ko.created(0), '카드 입금을 등록했습니다.');
  assert.equal(cardDepositText.vi.created(3), 'Đã ghi nhận tiền thẻ và tự động quyết toán 3 doanh thu thẻ.');
  assert.equal(cardDepositText.vi.created(0), 'Đã ghi nhận tiền thẻ.');
});

test('card settlement page keeps history, cancellation and fees but has no second registration form', () => {
  const page = readFileSync(cardPath, 'utf8');
  assert.doesNotMatch(page, /card-deposit-form|planCardDepositWithFees|setCreateOpen|method: "POST", headers: \{ "Content-Type": "application\/json" \}, body: JSON\.stringify\(\{ depositAt/);
  assert.match(page, /<Link href=\{ledgerMonthHref\("\/admin\/ledger\/entries","",month\)\} className=\{styles\.registerLink\}>/);
  for (const kept of ['/api/admin/ledger/card-settlements/${inspectedDeposit.id}/cancel', '/api/admin/ledger/card-fees/${fee.closure.id}/cancel', '/api/admin/ledger/card-fees?month=', 'pos-drilldown']) assert.ok(page.includes(kept), kept);
  const entries = readFileSync(entriesPath, 'utf8');
  assert.match(entries, /카드 입금 등록은 장부 내역 추가 › 수입 › 카드입금에서 진행합니다\./);
});
