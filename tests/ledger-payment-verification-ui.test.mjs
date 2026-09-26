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

// useState seeded by call order: 0 open, 1 selected payment target, 2 amount, 3 accountId,
// 4 date, 5 memo, 6 busy, 7 error, 8 expanded date keys. Setter calls are recorded.
function load(states, updates = []) {
  let index = 0;
  const react = { ...React, useState(initial) {
    const slot = index++;
    const value = Object.hasOwn(states, slot) ? states[slot] : typeof initial === 'function' ? initial() : initial;
    return [value, (next) => updates.push([slot, typeof next === 'function' ? next(value) : next])];
  } };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => ({
    react, 'react/jsx-runtime': jsxRuntime,
    'react-dom': { createPortal: node => node },
    '@/lib/common/business-time': { getBusinessDate: () => '2026-09-25' },
    '@/components/bar/keeping/KeepingUi': { BarField: Field, BarSheet: Sheet, keepingInputStyle: {}, primaryButtonStyle: {}, secondaryButtonStyle: {} },
    './entries.module.css': { __esModule: true, default: classNames },
    '@/lib/ledger/payable-display-groups': displayGroups,
  })[name], mod, mod.exports);
  return { component: mod.exports.default };
}

const items = [
  { payableId: 8, partyId: 10, businessDate: '2026-09-25', itemName: 'Jonut 코코넛 워터', itemNameVi: 'Nước dừa Jonut', supplierName: 'Chợ', quantity: 2, unitPrice: 11_000, amount: 22_000, paidAmount: 0, remainingAmount: 22_000, appPaymentStatus: 'unconfirmed', paymentDate: null },
  { payableId: 9, partyId: 20, businessDate: '2026-09-20', itemName: '보드카', itemNameVi: null, supplierName: 'Wow Spirit', quantity: null, unitPrice: null, amount: 1_500_000, paidAmount: 500_000, remainingAmount: 1_000_000, appPaymentStatus: 'unconfirmed', paymentDate: '2026-09-21' },
];
const group = { items, count: 2, amount: 1_022_000 };
const props = (groupProp, vi, canPay) => ({ group: groupProp, vi, canPay, accounts: [{ id: 1, display_name: '현금' }], onPaid: async () => {} });

function render({ states = {}, vi = false, canPay = true, group: groupProp = group, expanded } = {}) {
  const { component } = load(expanded ? { ...states, 8: new Set(expanded) } : states);
  return renderToStaticMarkup(React.createElement(component, props(groupProp, vi, canPay)));
}

// Calls the component directly (hooks are mocked) so real onClick handlers can be invoked.
function tree({ states = {}, canPay = true, group: groupProp = group } = {}) {
  const updates = [];
  const { component } = load(states, updates);
  const root = component(props(groupProp, false, canPay));
  const buttons = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object' || !node.props) return;
    if (node.type === 'button') buttons.push(node);
    walk(node.props.children); walk(node.props.footer);
  };
  walk(root);
  const text = (node) => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : node == null || node === false ? '' : String(node);
  return { updates, buttons, button: (label, nth = 0) => buttons.filter((button) => text(button).includes(label))[nth] };
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
  const sheet = render({ vi: true, states: { 0: true }, expanded: ['10:2026-09-25'] });
  for (const label of ['Khác · Chưa xác minh thanh toán', 'Số tiền này không được tính vào công nợ cuối tháng', 'Nước dừa Jonut', 'Thanh toán riêng', '09/25 · 1 khoản · <b>22\\.000 ₫']) assert.match(sheet, new RegExp(label));
});

test('date groups start collapsed: header "› 날짜 · 건수 · 금액" always visible, items hidden', () => {
  const html = render({ states: { 0: true } });
  assert.match(html, /role="dialog" aria-label="기타 · 결제 미확인"/);
  assert.match(html, /<div role="group" class="verificationDate" aria-label="09\/25"><div class="verificationDateHeader"><button type="button" class="verificationDateToggle" aria-expanded="false"><i aria-hidden="true">›<\/i><span>09\/25 · 1건 · <b>22\.000 ₫<\/b><\/span><\/button><\/div><\/div>/);
  assert.match(html, /<span>09\/20 · 1건 · <b>1\.000\.000 ₫<\/b><\/span>/);
  assert.doesNotMatch(html, /verificationItem|Jonut|보드카|개별 결제/, 'no item rows until a date is opened');
  // Reuses the entries date-group chevron: "›" rotated by .dateChevronOpen.
  assert.match(readFileSync('app/(protected)/admin/ledger/entries/entries.module.css', 'utf8'), /\.dateChevronOpen\{transform:rotate\(90deg\)\}/);
});

test('an opened date shows compact rows: name · remaining · 개별 결제 (no status badge, no repeated info)', () => {
  const html = render({ states: { 0: true }, expanded: ['10:2026-09-25'] });
  assert.match(html, /aria-expanded="true"><i aria-hidden="true" class="dateChevronOpen">›<\/i><span>09\/25 · 1건/);
  // Single row: name | amount | 개별 결제 as direct siblings (no nested line wrapper).
  assert.match(html, /<article class="verificationItem"><strong class="verificationName">Jonut 코코넛 워터<\/strong><strong class="verificationItemAmount" aria-label="남은 금액">22\.000 ₫<\/strong><button type="button" class="itemAction">개별 결제<\/button><\/article>/);
  assert.equal((html.match(/개별 결제/g) ?? []).length, 1, 'only the opened date shows its item');
  assert.doesNotMatch(html, /보드카/, 'other dates stay collapsed');
  assert.doesNotMatch(html.slice(html.indexOf('class="verificationList"')), /결제 미확인|verificationStatus|실제 결제 기록/, 'status badge removed, old label gone');
  assert.equal((html.match(/>Chợ</g) ?? []).length, 1, 'supplier name only in its party header');
  assert.doesNotMatch(html, /수량|단가|입고금액|기록된 지급|1\.500\.000|500\.000 ₫|payableId|#8/);
});

test('tapping a date header toggles only that party+date key', () => {
  const closed = tree({ states: { 0: true }, group: mixedGroup });
  closed.button('09/25').props.onClick();
  assert.deepEqual(closed.updates, [[8, new Set(['10:2026-09-25'])]]);
  const opened = tree({ states: { 0: true, 8: new Set(['10:2026-09-25', '20:2026-09-20']) }, group: mixedGroup });
  opened.button('09/25').props.onClick();
  assert.deepEqual(opened.updates, [[8, new Set(['20:2026-09-20'])]], 'closing one date leaves the others');
});

test('no party-wide payment: never the oldest-first mode or ordinary 선택 일자/부분 지급 UI', () => {
  const html = render({ states: { 0: true } });
  assert.doesNotMatch(html, /부분 지급|선택 일자/);
  assert.doesNotMatch(source, /planPartialPayablePayment|buildOldestFirstAllocations|selectedDates/);
  // allocations are always explicit, so the RPC's p_allocations=null oldest-first path is unreachable.
  assert.match(compact, /allocations:payment\.allocations,/);
  assert.doesNotMatch(compact, /allocations:null|allocations:undefined/);
});

test('개별 결제 keeps the per-item form and single explicit allocation', async () => {
  const html = render({ states: { 0: true, 1: { bulk: false, partyId: 20, supplierName: 'Wow Spirit', businessDate: '2026-09-20', items: [items[1]] } } });
  for (const label of ['지급액', '지급 계정', '지급일', '메모', '결제 확정', '목록으로', 'Wow Spirit', '실제 지급을 확인한 건만 기록하세요']) assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, /Jonut|지급 배분/, 'form shows only the selected item');
  assert.match(compact, /fetch\("\/api\/admin\/ledger\/payables\/pay",/);
  assert.match(compact, /amountValue>0&&amountValue<=single\.remainingAmount/);
  assert.match(compact, /disabled=\{busy\|\|!canSubmit\|\|!accountId\}/);
  assert.match(compact, /setSelected\(null\);awaitonPaid\(\);/, 'after paying, the parent reload refreshes the group');
  assert.doesNotMatch(source, /useEffect/, 'nothing is paid automatically');

  // Tapping 개별 결제 selects just that item (and never touches the expanded dates).
  const list = tree({ states: { 0: true, 8: new Set(['20:2026-09-20']) } });
  list.button('개별 결제').props.onClick();
  assert.deepEqual(list.updates[0], [1, { bulk: false, partyId: 20, supplierName: 'Wow Spirit', businessDate: '2026-09-20', items: [items[1]] }]);
  assert.ok(!list.updates.some(([slot]) => slot === 8));

  // Confirm posts the unchanged single-item body (partial amount allowed up to remaining).
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true }; };
  const form = tree({ states: { 0: true, 1: { bulk: false, partyId: 20, supplierName: 'Wow Spirit', businessDate: '2026-09-20', items: [items[1]] }, 2: '400000', 3: '1', 4: '2026-09-25', 5: '' } });
  await form.button('결제 확정').props.onClick();
  assert.deepEqual(calls, [['/api/admin/ledger/payables/pay', { partyId: 20, fundAccountId: 1, occurredAt: '2026-09-25T12:00:00+07:00', amount: 400_000, allocations: [{ payableId: 9, allocatedAmount: 400_000 }], memo: null }]]);
});

test('past months are read-only: items visible when opened, no 개별/일괄 결제 buttons', () => {
  const keys = ['10:2026-09-02', '10:2026-09-25', '20:2026-09-20'];
  const html = render({ states: { 0: true }, canPay: false, group: mixedGroup, expanded: keys });
  assert.match(html, /Jonut 코코넛 워터/);
  assert.doesNotMatch(html, /개별 결제|일괄 결제|실제 결제 기록/);
  assert.match(html, /조회만 가능합니다/);
  assert.match(html, /<span>09\/25 · 2건 · <b>27\.000 ₫<\/b><\/span><\/button><\/div>/, 'no bulk button next to a 2-item date');
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
const allDates = ['10:2026-09-02', '10:2026-09-25', '20:2026-09-20'];

test('groups by real partyId in first-appearance order with count and Σ remaining; items oldest → newest', () => {
  const groups = displayGroups.groupVerificationItemsByParty(mixed);
  assert.deepEqual(groups.map((row) => [row.partyId, row.name, row.count, row.amount]), [[10, 'Chợ', 3, 41_000], [20, 'Wow Spirit', 1, 1_000_000]]);
  assert.deepEqual(groups[0].items.map((item) => item.payableId), [33, 31, 34], 'date ascending, same-date keeps incoming order');
  assert.equal(groups.reduce((sum, row) => sum + row.count, 0), mixedGroup.count);
  assert.equal(groups.reduce((sum, row) => sum + row.amount, 0), mixedGroup.amount);
  assert.ok(mixed.every((item) => groups.some((row) => row.partyId === item.partyId && row.items.includes(item))), 'partyId untouched');
});

test('sheet renders one compact header per party followed by that party\'s dates', () => {
  const html = render({ states: { 0: true }, group: mixedGroup, expanded: allDates });
  assert.match(html, /<section class="verificationGroup" aria-label="Chợ"><div class="verificationGroupHeader"><strong>Chợ<\/strong><span>3건 · 41\.000 ₫<\/span><\/div>/);
  assert.match(html, /<section class="verificationGroup" aria-label="Wow Spirit"><div class="verificationGroupHeader"><strong>Wow Spirit<\/strong><span>1건 · 1\.000\.000 ₫<\/span><\/div>/);
  assert.ok(html.indexOf('aria-label="Chợ"') < html.indexOf('aria-label="Wow Spirit"'), 'first-appearance group order');
  const cho = html.slice(html.indexOf('aria-label="Chợ"'), html.indexOf('aria-label="Wow Spirit"'));
  assert.ok(cho.indexOf('Vinamilk') < cho.indexOf('Jonut') && cho.indexOf('Jonut') < cho.indexOf('같은 날 두번째'));
  assert.doesNotMatch(cho, /보드카/);
  assert.equal((html.match(/개별 결제/g) ?? []).length, 4, 'per-item button kept');
  assert.equal((html.match(/class="verificationGroupHeader"/g) ?? []).length, 2);
  assert.match(render({ states: { 0: true }, group: mixedGroup, vi: true }), /<strong>Chợ<\/strong><span>3 khoản · 41\.000 ₫<\/span>/);
});

test('party → date → items: date blocks ascending; date Σ = its items, party Σ = its dates', () => {
  const groups = displayGroups.groupVerificationItemsByParty(mixed);
  assert.deepEqual(groups[0].dates.map((day) => [day.businessDate, day.count, day.amount, day.items.map((item) => item.payableId)]), [
    ['2026-09-02', 1, 14_000, [33]], ['2026-09-25', 2, 27_000, [31, 34]],
  ]);
  assert.deepEqual(groups[1].dates.map((day) => [day.businessDate, day.count, day.amount]), [['2026-09-20', 1, 1_000_000]]);
  for (const row of groups) {
    for (const day of row.dates) assert.equal(day.amount, day.items.reduce((sum, item) => sum + item.remainingAmount, 0));
    assert.equal(row.dates.reduce((sum, day) => sum + day.count, 0), row.count);
    assert.equal(row.dates.reduce((sum, day) => sum + day.amount, 0), row.amount);
    assert.deepEqual(row.dates.flatMap((day) => day.items), row.items, 'same items, same order');
  }
  const html = render({ states: { 0: true }, group: mixedGroup, expanded: allDates });
  const cho = html.slice(html.indexOf('aria-label="Chợ"'), html.indexOf('aria-label="Wow Spirit"'));
  assert.equal((cho.match(/class="verificationDateHeader"/g) ?? []).length, 2);
  assert.match(cho, /<span>09\/02 · 1건 · <b>14\.000 ₫<\/b><\/span>/);
  assert.match(cho, /<span>09\/25 · 2건 · <b>27\.000 ₫<\/b><\/span>/);
  assert.ok(cho.indexOf('09/02') < cho.indexOf('09/25'), 'dates ascending');
  const sameDay = cho.slice(cho.indexOf('aria-label="09/25"'));
  assert.ok(sameDay.indexOf('Jonut') < sameDay.indexOf('같은 날 두번째'));
  assert.equal((sameDay.match(/class="verificationItem"/g) ?? []).length, 2, 'both same-day items under one date header');
});

test('일괄 결제 only on dates with 2+ unresolved items, beside (not inside) the date toggle', () => {
  const html = render({ states: { 0: true }, group: mixedGroup });
  assert.equal((html.match(/일괄 결제/g) ?? []).length, 1);
  assert.match(html, /<span>09\/25 · 2건 · <b>27\.000 ₫<\/b><\/span><\/button><button type="button" class="itemAction verificationBulkAction">일괄 결제<\/button><\/div>/);
  assert.match(html, /<span>09\/02 · 1건 · <b>14\.000 ₫<\/b><\/span><\/button><\/div>/, '1-item date has no bulk button');
  assert.match(html, /<span>09\/20 · 1건 · <b>1\.000\.000 ₫<\/b><\/span><\/button><\/div>/);
  // A 2-item date where one item is already fully paid (remaining 0) is not bulk-payable.
  const onePaid = mixed.map((item) => item.payableId === 34 ? { ...item, remainingAmount: 0 } : item);
  assert.doesNotMatch(render({ states: { 0: true }, group: { items: onePaid, count: 4, amount: 1_036_000 } }), /일괄 결제/);
  // Tapping it opens the bulk form for that party+date and does not toggle the date.
  const list = tree({ states: { 0: true }, group: mixedGroup });
  list.button('일괄 결제').props.onClick();
  assert.equal(list.updates[0][0], 1);
  assert.deepEqual({ ...list.updates[0][1], items: list.updates[0][1].items.map((item) => item.payableId) }, { bulk: true, partyId: 10, supplierName: 'Chợ', businessDate: '2026-09-25', items: [31, 34] });
  assert.ok(!list.updates.some(([slot]) => slot === 8), 'expanded state untouched');
});

test('planVerificationDatePayment allocates exactly the date\'s unresolved payables in full', () => {
  const date = mixed.filter((item) => item.partyId === 10 && item.businessDate === '2026-09-25');
  assert.deepEqual(displayGroups.planVerificationDatePayment(date), { partyId: 10, amount: 27_000, allocations: [{ payableId: 31, allocatedAmount: 22_000 }, { payableId: 34, allocatedAmount: 5_000 }] });
  assert.deepEqual(displayGroups.planVerificationDatePayment([...date, { ...date[0], payableId: 35, remainingAmount: 0 }]).allocations.map((row) => row.payableId), [31, 34], 'paid items excluded');
  assert.equal(displayGroups.planVerificationDatePayment([{ ...date[0], remainingAmount: 0 }]), null);
  assert.equal(displayGroups.planVerificationDatePayment([]), null);
  assert.equal(displayGroups.planVerificationDatePayment([date[0], mixed[1]]), null, 'never mixes parties (the RPC takes one partyId)');
  assert.deepEqual(displayGroups.planVerificationDatePayment([{ ...date[0], remainingAmount: 0.1 }, { ...date[1], remainingAmount: 0.2 }]).amount, 0.3, 'exact Σ');
});

test('일괄 결제 form: fixed Σ remaining, allocation preview, account/date required, one payment via the existing API', async () => {
  const target = { bulk: true, partyId: 10, supplierName: 'Chợ', businessDate: '2026-09-25', items: [mixed[0], mixed[3]] };
  const html = render({ states: { 0: true, 1: target } });
  for (const label of ['09/25 · Chợ', '일괄 결제', '2건 · 남은 금액 전액 지급', '지급 배분', 'Jonut 코코넛 워터</em><b>22\\.000 ₫', '같은 날 두번째</em><b>5\\.000 ₫', '지급 합계</em><b>27\\.000 ₫', '지급 계정', '지급일', '메모', '결제 확정']) assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, /💰 지급액/, 'bulk amount is not editable');
  assert.doesNotMatch(html, /Vinamilk|보드카/);

  // Without an account the confirm button stays disabled and nothing is sent.
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true }; };
  const noAccount = tree({ states: { 0: true, 1: target, 3: '' } });
  assert.equal(noAccount.button('결제 확정').props.disabled, true);
  await noAccount.button('결제 확정').props.onClick();
  assert.equal(calls.length, 0);

  const form = tree({ states: { 0: true, 1: target, 3: '1', 4: '2026-09-26', 5: '시장 정산' } });
  assert.equal(form.button('결제 확정').props.disabled, false);
  await form.button('결제 확정').props.onClick();
  assert.deepEqual(calls, [['/api/admin/ledger/payables/pay', { partyId: 10, fundAccountId: 1, occurredAt: '2026-09-26T12:00:00+07:00', amount: 27_000, allocations: [{ payableId: 31, allocatedAmount: 22_000 }, { payableId: 34, allocatedAmount: 5_000 }], memo: '시장 정산' }]]);
  assert.ok(form.updates.some(([slot, value]) => slot === 1 && value === null), 'back to the list after paying');
});

test('item row is one line: name ellipsis | amount nowrap | button nowrap, thin divider kept', () => {
  const css = readFileSync('app/(protected)/admin/ledger/entries/entries.module.css', 'utf8');
  assert.match(css, /\.verificationItem\{display:grid;grid-template-columns:minmax\(0,1fr\) auto auto;align-items:center;gap:8px;padding:4px 9px;border-top:1px solid #eef0f2\}/);
  assert.match(css, /\.verificationName\{min-width:0;overflow:hidden;[^}]*text-overflow:ellipsis;white-space:nowrap\}/);
  assert.match(css, /\.verificationItemAmount\{[^}]*white-space:nowrap\}/);
  assert.match(css, /\.verificationItem \.itemAction,\.verificationDateHeader \.itemAction\{[^}]*min-height:28px;padding:3px 9px;[^}]*white-space:nowrap\}/);
  assert.doesNotMatch(css, /\.verificationTop/, 'no separate second line wrapper');
  assert.doesNotMatch(css, /\.verificationStatus\{|\.verificationActions\{/, 'removed status badge styles');
});

test('일괄 결제 uses the blue primary modifier (white text, hover/active darker, disabled dimmed); 개별 결제 stays outline', () => {
  const css = readFileSync('app/(protected)/admin/ledger/entries/entries.module.css', 'utf8');
  assert.match(css, /\.verificationDateHeader \.verificationBulkAction\{border-color:#2563eb;background:#2563eb;color:#fff\}/);
  assert.match(css, /\.verificationDateHeader \.verificationBulkAction:hover,\.verificationDateHeader \.verificationBulkAction:active\{border-color:#1d4ed8;background:#1d4ed8\}/);
  assert.match(css, /\.verificationDateHeader \.verificationBulkAction:disabled\{opacity:\.45\}/);
  assert.doesNotMatch(css.match(/\.verificationDateHeader \.verificationBulkAction\{[^}]*\}/)[0], /#b4493e|#b91c1c|red/, 'not a danger colour');
  const html = render({ states: { 0: true }, group: mixedGroup, expanded: allDates });
  assert.equal((html.match(/class="itemAction verificationBulkAction"/g) ?? []).length, 1);
  assert.equal((html.match(/class="itemAction">개별 결제/g) ?? []).length, 4);
  const readOnly = render({ states: { 0: true }, canPay: false, group: mixedGroup, expanded: allDates });
  assert.doesNotMatch(readOnly, /<button type="button" class="itemAction/, 'read-only: no 개별/일괄 결제 buttons');
  assert.match(readOnly, /<article class="verificationItem"><strong class="verificationName">Jonut 코코넛 워터<\/strong><strong class="verificationItemAmount" aria-label="남은 금액">22\.000 ₫<\/strong><\/article>/);
});

test('after a reload the paid item disappears, its group shrinks, and an emptied group is removed', () => {
  const afterPaying = mixed.filter((item) => item.payableId !== 32 && item.payableId !== 31);
  const html = render({ states: { 0: true }, group: { items: afterPaying, count: 2, amount: 19_000 }, expanded: allDates });
  assert.doesNotMatch(html, /Wow Spirit|보드카|Jonut|일괄 결제/);
  assert.match(html, /<strong>Chợ<\/strong><span>2건 · 19\.000 ₫<\/span>/);
  // Groups are derived from props on every render (no cached group state).
  assert.match(source, /const partyGroups = groupVerificationItemsByParty\(group\.items\);/);
});
