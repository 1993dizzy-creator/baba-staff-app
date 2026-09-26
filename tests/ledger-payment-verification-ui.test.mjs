import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { createRequire } from 'node:module';

const displayGroups = createRequire(import.meta.url)('../lib/ledger/payable-display-groups.ts');

// 결제 미확인 is the display-only "기타" row at the end of 장부작성 > 미납금 현황 plus its sheet.
const path = 'app/(protected)/admin/ledger/entries/PaymentVerificationSection.tsx';
const source = readFileSync(path, 'utf8');
const compact = source.replace(/\s+/g, '');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
// createPortal is mocked to render inline; the portal target only needs to exist.
globalThis.document ??= { body: {} };
const classNames = new Proxy({}, { get: (_target, key) => String(key) });
const Sheet = ({ children, footer, title }) => React.createElement('section', { role: 'dialog', 'aria-label': title }, children, footer);
const Field = ({ children, label }) => React.createElement('label', null, label, typeof children === 'function' ? children({ id: 'field' }) : children);

// useState seeded by call order: 0 open, 1 selected item.
function load(states) {
  let index = 0;
  const react = { ...React, useState(initial) { const slot = index++; const value = Object.hasOwn(states, slot) ? states[slot] : typeof initial === 'function' ? initial() : initial; return [value, () => {}]; } };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => ({
    react, 'react/jsx-runtime': jsxRuntime,
    'react-dom': { createPortal: node => node },
    '@/lib/common/business-time': { getBusinessDate: () => '2026-09-25' },
    '@/components/bar/keeping/KeepingUi': { BarField: Field, BarSheet: Sheet, keepingInputStyle: {}, primaryButtonStyle: {}, secondaryButtonStyle: {} },
    './entries.module.css': { __esModule: true, default: classNames },
    '@/lib/ledger/payable-display-groups': displayGroups,
  })[name], mod, mod.exports);
  return { component: mod.exports.default, reset: () => { index = 0; } };
}

const items = [
  { payableId: 8, partyId: 10, businessDate: '2026-09-25', itemName: 'Jonut 코코넛 워터', itemNameVi: 'Nước dừa Jonut', supplierName: 'Chợ', quantity: 2, unitPrice: 11_000, amount: 22_000, paidAmount: 0, remainingAmount: 22_000, appPaymentStatus: 'unconfirmed', paymentDate: null },
  { payableId: 9, partyId: 20, businessDate: '2026-09-20', itemName: '보드카', itemNameVi: null, supplierName: 'Wow Spirit', quantity: null, unitPrice: null, amount: 1_500_000, paidAmount: 500_000, remainingAmount: 1_000_000, appPaymentStatus: 'unconfirmed', paymentDate: '2026-09-21' },
];
const group = { items, count: 2, amount: 1_022_000 };

function render({ states = {}, vi = false, canPay = true, group: groupProp = group } = {}) {
  const { component } = load(states);
  return renderToStaticMarkup(React.createElement(component, { group: groupProp, vi, canPay, accounts: [{ id: 1, display_name: '현금' }], onPaid: async () => {} }));
}

test('old /payables component file is gone; entries owns the 기타 verification group', () => {
  assert.equal(existsSync('app/(protected)/admin/ledger/payables/PaymentVerificationSection.tsx'), false);
});

test('기타 row reuses the party-row markup: type badge, name, 결제 미확인 badge, hint, amount, count and chevron', () => {
  const html = render();
  assert.match(html, /^<button type="button"><span class="payablePartyMain"><span class="partnerTypeBadge">기타<\/span><span class="payablePartyName">기타 <em class="verificationBadge">결제 미확인<\/em><\/span><small class="payablePartyPeriod">월말 미납 제외 · 실제 지급 확인 필요<\/small><\/span><strong class="verificationAmount" aria-label="확인 필요"><span class="verificationAmountLabel">확인 필요<\/span> 1\.022\.000 ₫<\/strong><small>2건<\/small><i aria-hidden="true">›<\/i><\/button>$/);
  assert.doesNotMatch(html, /월 외상|월 지급/, 'no synthetic 당월 외상/지급 line');
  assert.doesNotMatch(html, /role="dialog"/, 'sheet closed until the row is tapped');
});

test('Vietnamese row and sheet text', () => {
  assert.match(render({ vi: true }), /Khác <em class="verificationBadge">Chưa xác minh<\/em>.*Không tính vào công nợ cuối tháng · Cần xác nhận thanh toán.*Cần kiểm tra<\/span> 1\.022\.000 ₫/);
  const sheet = render({ vi: true, states: { 0: true } });
  for (const label of ['Khác · Chưa xác minh thanh toán', 'Số tiền này không được tính vào công nợ cuối tháng', 'Nước dừa Jonut', 'Số lượng', 'Đơn giá', 'Giá trị nhập', 'Đã ghi nhận', 'Ghi nhận thanh toán thực tế']) assert.match(sheet, new RegExp(label));
});

test('opened sheet lists each item with its real supplier, date, item, qty/price, amounts and status', () => {
  const html = render({ states: { 0: true } });
  assert.match(html, /role="dialog" aria-label="기타 · 결제 미확인"/);
  assert.match(html, /09\/25 · <b>Chợ<\/b>/);
  assert.match(html, /09\/20 · <b>Wow Spirit<\/b>/);
  for (const label of ['Jonut 코코넛 워터', '수량 2', '단가 11\\.000 ₫', '입고금액 22\\.000 ₫', '기록된 지급 500\\.000 ₫', '1\\.000\\.000 ₫', '결제 미확인', '실제 결제 기록']) assert.match(html, new RegExp(label));
  assert.equal((html.match(/실제 결제 기록/g) ?? []).length, 2, 'one manual record button per item');
  assert.doesNotMatch(html, /payableId|#8/);
});

test('no group-wide payment: no partial, oldest-first or selected-date bulk pay for 기타', () => {
  const html = render({ states: { 0: true } });
  assert.doesNotMatch(html, /부분 지급|선택 일자|일괄/);
  assert.doesNotMatch(source, /planPartialPayablePayment|buildOldestFirstAllocations|selectedDates/);
});

test('recording is per item, manual, via the existing pay API with one explicit allocation', () => {
  const html = render({ states: { 0: true, 1: items[1] } });
  for (const label of ['지급액', '지급 계정', '지급일', '메모', '결제 확정', '목록으로', 'Wow Spirit', '실제 지급을 확인한 건만 한 건씩 기록하세요']) assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, /Jonut/, 'form shows only the selected item');
  assert.match(compact, /fetch\("\/api\/admin\/ledger\/payables\/pay",/);
  assert.match(compact, /partyId:selected\.partyId,fundAccountId:Number\(accountId\)/);
  assert.match(compact, /allocations:\[\{payableId:selected\.payableId,allocatedAmount:amountValue\}\]/);
  assert.match(compact, /amountValue>0&&amountValue<=selected\.remainingAmount/);
  assert.match(compact, /disabled=\{busy\|\|!amountValid\|\|!accountId\}/);
  assert.match(compact, /setSelected\(null\);awaitonPaid\(\);/, 'after paying, the parent reload refreshes the group');
  assert.doesNotMatch(source, /useEffect/, 'nothing is paid automatically');
});

test('past months are read-only: items visible, no record buttons', () => {
  const html = render({ states: { 0: true }, canPay: false });
  assert.match(html, /Jonut 코코넛 워터/);
  assert.doesNotMatch(html, /실제 결제 기록/);
  assert.match(html, /조회만 가능합니다/);
});

test('sheet uses the shared full compact BarSheet style and is portaled out of the row list', () => {
  assert.match(compact, /createPortal\(<BarSheetkind="full"compacttopAlignedcomfortableTopfillAvailablecontainedBody/);
  assert.match(compact, /<\/BarSheet>,document\.body\)/);
});

test('기타 amount is shown as a warning (not confirmed outstanding) and the sheet says it is excluded from 월말 미납', () => {
  const css = readFileSync('app/(protected)/admin/ledger/entries/entries.module.css', 'utf8');
  // Beats the neutral ".payableParties button>strong" rule, so the amount is orange, not black.
  assert.match(css, /\.payableParties button>strong\.verificationAmount\{color:#b7791f\}/);
  assert.match(css, /\.verificationNotice\{[^}]*color:#9a5b10;/);
  const html = render({ states: { 0: true } });
  assert.match(html, /role="dialog" aria-label="기타 · 결제 미확인"><div class="payableSheetBody"><p class="verificationNotice" role="note">이 금액은 월말 미납에 포함되지 않습니다\. 실제 지급 여부를 확인한 뒤 기록하세요\.<\/p>/);
});

// Multi-party fixture: Chợ appears first, then Wow Spirit, then Chợ again (older date).
const mixed = [
  { ...items[0], payableId: 31, partyId: 10, supplierName: 'Chợ', businessDate: '2026-09-25', itemName: 'Jonut 코코넛 워터', remainingAmount: 22_000 },
  { ...items[1], payableId: 32, partyId: 20, supplierName: 'Wow Spirit', businessDate: '2026-09-20', itemName: '보드카', remainingAmount: 1_000_000 },
  { ...items[0], payableId: 33, partyId: 10, supplierName: 'Chợ', businessDate: '2026-09-02', itemName: 'Vinamilk 알로에 요거트', remainingAmount: 14_000 },
  { ...items[0], payableId: 34, partyId: 10, supplierName: 'Chợ', businessDate: '2026-09-25', itemName: '같은 날 두번째', remainingAmount: 5_000 },
];
const mixedGroup = { items: mixed, count: 4, amount: 1_041_000 };

test('groups by real partyId in first-appearance order with count and Σ remaining; items oldest → newest', () => {
  const groups = displayGroups.groupVerificationItemsByParty(mixed);
  assert.deepEqual(groups.map((row) => [row.partyId, row.name, row.count, row.amount]), [[10, 'Chợ', 3, 41_000], [20, 'Wow Spirit', 1, 1_000_000]]);
  assert.deepEqual(groups[0].items.map((item) => item.payableId), [33, 31, 34], 'date ascending, same-date keeps incoming order');
  assert.equal(groups.reduce((sum, row) => sum + row.count, 0), mixedGroup.count);
  assert.equal(groups.reduce((sum, row) => sum + row.amount, 0), mixedGroup.amount);
  assert.ok(mixed.every((item) => groups.some((row) => row.partyId === item.partyId && row.items.includes(item))), 'partyId untouched');
});

test('sheet renders one compact header per party followed by that party\'s items', () => {
  const html = render({ states: { 0: true }, group: mixedGroup });
  assert.match(html, /<section class="verificationGroup" aria-label="Chợ"><div class="verificationGroupHeader"><strong>Chợ<\/strong><span>3건 · 41\.000 ₫<\/span><\/div>/);
  assert.match(html, /<section class="verificationGroup" aria-label="Wow Spirit"><div class="verificationGroupHeader"><strong>Wow Spirit<\/strong><span>1건 · 1\.000\.000 ₫<\/span><\/div>/);
  assert.ok(html.indexOf('aria-label="Chợ"') < html.indexOf('aria-label="Wow Spirit"'), 'first-appearance group order');
  const cho = html.slice(html.indexOf('aria-label="Chợ"'), html.indexOf('aria-label="Wow Spirit"'));
  assert.ok(cho.indexOf('Vinamilk') < cho.indexOf('Jonut') && cho.indexOf('Jonut') < cho.indexOf('같은 날 두번째'));
  assert.doesNotMatch(cho, /보드카/);
  assert.equal((html.match(/실제 결제 기록/g) ?? []).length, 4, 'per-item record button kept');
  assert.equal((html.match(/class="verificationGroupHeader"/g) ?? []).length, 2);
  assert.match(render({ states: { 0: true }, group: mixedGroup, vi: true }), /<strong>Chợ<\/strong><span>3 khoản · 41\.000 ₫<\/span>/);
});

test('after a reload the paid item disappears, its group shrinks, and an emptied group is removed', () => {
  const afterPaying = mixed.filter((item) => item.payableId !== 32 && item.payableId !== 31);
  const html = render({ states: { 0: true }, group: { items: afterPaying, count: 2, amount: 19_000 } });
  assert.doesNotMatch(html, /Wow Spirit|보드카|Jonut/);
  assert.match(html, /<strong>Chợ<\/strong><span>2건 · 19\.000 ₫<\/span>/);
  // Groups are derived from props on every render (no cached group state).
  assert.match(source, /const partyGroups = groupVerificationItemsByParty\(group\.items\);/);
});
