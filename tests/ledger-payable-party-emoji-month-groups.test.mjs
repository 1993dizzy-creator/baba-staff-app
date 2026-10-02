import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as runtime from 'react/jsx-runtime';
import ts from 'typescript';
import { countUnsettledPayables, groupPayableRows, groupPayableRowsByMonth, isPayableRowSettled, latestPayableMonth } from '../lib/ledger/payable-date-groups.ts';
import { chooseLedgerEntryEmoji, ledgerPartyEmoji } from '../lib/ledger/entry-display-emoji.ts';
import { effectivePartnerEmoji, partnerTypeEmoji } from '../lib/partners/emoji.ts';

const source = readFileSync('app/(protected)/admin/ledger/entries/page.tsx', 'utf8');
const css = readFileSync('app/(protected)/admin/ledger/entries/entries.module.css', 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  ts.forEachChild(node, visit);
})(ast);
const summary = source.slice(source.indexOf('aria-labelledby="payable-summary-title"'), source.indexOf('aria-labelledby="card-settlement-title"'));
const historical = functions.get('HistoricalPayablePartySheet');

// Renders the page's real PayableMonthGroups + PayableDateGroups. `toggled` seeds
// every useState Set (month toggles and expanded dates share keys by format).
function renderMonthGroups(rows, toggled = []) {
  const names = ['formatDate', 'payableItemLabel', 'PayableDateGroups', 'PayableMonthGroups'];
  const code = ts.transpileModule(names.map(name => functions.get(name)).join('\n'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const bindings = {
    useMemo: React.useMemo,
    useState: init => [new Set(toggled.length ? toggled : (typeof init === 'function' ? init() : init)), () => {}],
    styles: new Proxy({}, { get: (_, key) => String(key) }),
    money: amount => `${amount}₫`,
    groupPayableRows, groupPayableRowsByMonth, latestPayableMonth,
  };
  const Component = new Function('exports', 'require', ...Object.keys(bindings), `${code};return PayableMonthGroups`)({}, () => runtime, ...Object.values(bindings));
  return renderToStaticMarkup(React.createElement(Component, { rows, lang: 'ko' }));
}

const row = (id, date, outstandingAmount, settlementStatus = outstandingAmount > 0 ? 'unpaid' : 'paid') =>
  ({ id, party_id: 7, original_amount: 100, paidAmount: 100 - outstandingAmount, outstandingAmount, settlementStatus, expense: { business_date: date, source_snapshot: { item_name: `item-${id}` } } });
const history = [
  row(1, '2026-08-01', 0), row(2, '2026-08-01', 0), row(3, '2026-08-03', 0),
  row(4, '2026-07-15', 0), row(5, '2026-08-07', 40, 'partial'), row(6, '2026-06-30', 0), row(7, '2026-07-02', 0),
];

test('A/B: payable party rows show the ledger partner emoji instead of the text category badge', () => {
  const partyRow = summary.slice(summary.indexOf('payableDisplay.parties.map'), summary.indexOf('payableDisplay.other ? <PaymentVerificationSection'));
  assert.doesNotMatch(partyRow, /className=\{styles\.partnerTypeBadge\}/);
  assert.match(partyRow, /<span className=\{styles\.payablePartyEmoji\} role="img" aria-label=\{partnerTypeLabel\(party\.partnerType,lang\)\}>\{ledgerPartyEmoji\(partnerByLedgerParty\.get\(party\.partyId\)\?\.emoji,party\.partnerType\)\}<\/span><span className=\{styles\.payablePartyName\}>\{party\.partyName\}<\/span>/);
  // Same lookup the transaction list uses: partnerByLedgerParty -> partner.emoji -> chooseLedgerEntryEmoji.
  assert.match(source, /if \(partner\) return chooseLedgerEntryEmoji\(partner\.emoji, entryCategoryEmoji\(entry\)\);/);
  assert.match(functions.get('entryDisplayEmoji'), /partnersByParty\.get\(entry\.partyId\)/);
  // Name, amount, count and chevron stay.
  assert.match(partyRow, /money\(party\.closingOutstanding\)/);
  assert.match(partyRow, /\{party\.openCount\}\{vi \? " khoản" : "건"\}/);
  assert.match(partyRow, /<i aria-hidden>›<\/i>/);
  assert.match(css, /\.payablePartyMain>\.payablePartyEmoji\{/);
});

test('C: subtype emoji wins, otherwise the partner type emoji, otherwise the existing other fallback', () => {
  // partner.emoji is built server-side by effectivePartnerEmoji (subtype first).
  assert.equal(effectivePartnerEmoji('alcohol', { emoji: '🍺' }), '🍺');
  assert.equal(effectivePartnerEmoji('alcohol', { emoji: null }), '🍾');
  assert.match(readFileSync('app/api/admin/ledger/route.ts', 'utf8'), /emoji: effectivePartnerEmoji\(partner\.partner_type as PartnerType, partnerSubtype\)/);
  assert.equal(ledgerPartyEmoji('🍺', 'alcohol'), '🍺');
  assert.equal(ledgerPartyEmoji(effectivePartnerEmoji('food', { emoji: '🥩' }), 'food'), '🥩');
  assert.equal(ledgerPartyEmoji(undefined, 'food'), partnerTypeEmoji.food);
  assert.equal(ledgerPartyEmoji(undefined, null), partnerTypeEmoji.other);
  assert.equal(ledgerPartyEmoji(undefined, 'unknown'), partnerTypeEmoji.other);
  assert.equal(ledgerPartyEmoji('🍺', 'food'), chooseLedgerEntryEmoji('🍺', partnerTypeEmoji.food));
});

test('A/J: months run oldest → newest, grouped by YYYY-MM of their own business date, with nothing lost', () => {
  const groups = groupPayableRowsByMonth(history);
  assert.deepEqual(groups.map(group => [group.month, group.rows.map(item => item.id)]), [
    ['2026-06', [6]], ['2026-07', [4, 7]], ['2026-08', [1, 2, 3, 5]],
  ]);
  assert.deepEqual(groups.map(group => group.rows.length), [1, 2, 4]);
  const flat = groups.flatMap(group => group.rows);
  assert.equal(flat.length, history.length);
  assert.deepEqual(new Set(flat), new Set(history));
  const sum = rows => rows.reduce((total, item) => total + item.outstandingAmount, 0);
  assert.equal(sum(flat), sum(history));
  // Date groups inside the months equal the old flat date grouping.
  assert.deepEqual(groups.flatMap(group => groupPayableRows(group.rows, true)).sort((a, b) => a.businessDate.localeCompare(b.businessDate)),
    groupPayableRows(history, true));
  assert.deepEqual(groupPayableRowsByMonth([{ outstandingAmount: 1, expense: null }, row(9, '2026-09-01', 1)]).map(group => group.month), ['2026-09', '']);
});

test('B: dates inside a month keep the existing oldest → newest order', () => {
  const september = [row(30, '2026-09-30', 0), row(31, '2026-09-04', 0), row(32, '2026-09-03', 0), row(33, '2026-09-04', 0)];
  const html = renderMonthGroups([...history, ...september]);
  const order = ['9월 3일', '9월 4일', '9월 30일'].map(label => html.indexOf(`📅 ${label}<`));
  assert.ok(order.every(index => index > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.deepEqual(groupPayableRows(september, true).map(group => group.businessDate), ['2026-09-03', '2026-09-04', '2026-09-30']);
  // Month headers render oldest → newest too.
  const headers = ['2026년 6월', '2026년 7월', '2026년 8월', '2026년 9월'].map(label => html.indexOf(label));
  assert.deepEqual([...headers].sort((a, b) => a - b), headers);
});

test('C/D: only the newest returned month is open by default even though it renders last', () => {
  const html = renderMonthGroups(history);
  assert.match(html, /2026년 8월 · 4건/);
  assert.match(html, /2026년 7월 · 2건/);
  assert.match(html, /2026년 6월 · 1건/);
  assert.equal((html.match(/class="payableMonthHeader" aria-expanded="true"/g) ?? []).length, 1);
  assert.match(html, /class="payableMonthHeader" aria-expanded="true"><span class="payableMonthLabel"><span>2026년 8월 · 4건<\/span>/);
  assert.match(html, /class="payableMonthHeader" aria-expanded="false"><span class="payableMonthLabel"><span>2026년 6월 · 1건<\/span>/);
  assert.match(html, /8월 1일/);
  assert.doesNotMatch(html, /7월 15일|7월 2일|6월 30일/);
  // Newest month follows the data, not the selected month; undated rows never win.
  assert.match(renderMonthGroups([row(4, '2026-07-15', 0)]), /aria-expanded="true"><span class="payableMonthLabel"><span>2026년 7월 · 1건/);
  assert.equal(latestPayableMonth(groupPayableRowsByMonth([{ id: 9, outstandingAmount: 1, expense: null }, row(8, '2026-05-01', 0)])), '2026-05');
});

test('E/F/G/H/I: 미결제 N counts unique payables with a remaining balance, using the 결제완료 test', () => {
  // Same settled test as the date rows' 결제완료 badge.
  assert.match(readFileSync('lib/ledger/payable-date-groups.ts', 'utf8'), /settlementStatus: items\.every\(isPayableRowSettled\) \? "paid"/);
  assert.equal(isPayableRowSettled({ outstandingAmount: 0 }), true);
  assert.equal(isPayableRowSettled({ outstandingAmount: 1 }), false);
  const groups = groupPayableRowsByMonth([
    row(1, '2026-08-01', 0, 'paid'),                // G: fully paid → excluded
    row(2, '2026-08-02', 100, 'unpaid'),            // fully unpaid → counted
    row(3, '2026-08-03', 40, 'partial'),            // F: partially paid, remaining → counted
    row(3, '2026-08-03', 40, 'partial'),            // I: same payable id twice → counted once
    row(4, '2026-09-01', 0, 'paid'), row(5, '2026-09-02', 0, 'paid'),
  ]);
  assert.deepEqual(groups.map(group => [group.month, group.rows.length, group.unpaidCount]), [['2026-08', 4, 2], ['2026-09', 2, 0]]);
  assert.equal(countUnsettledPayables([row(7, '2026-08-07', 40, 'partial')]), 1);
  const html = renderMonthGroups(history);
  // E: one partially paid payable in August.
  assert.match(html, /<span>2026년 8월 · 4건<\/span><span class="pendingBadge">미결제 1<\/span><\/span><i aria-hidden="true">⌄<\/i>/);
  // H: no badge at all for fully settled months.
  assert.match(html, /<span>2026년 7월 · 2건<\/span><\/span><i aria-hidden="true">›<\/i>/);
  assert.equal((html.match(/미결제/g) ?? []).length, 1);
  assert.doesNotMatch(html, /미결제 0/);
  assert.match(css, /\.payableMonthLabel\{[^}]*white-space:nowrap/);
  assert.match(css, /\.payableMonthLabel>\.pendingBadge\{flex:0 0 auto/);
});

test('K: date accordion, 결제완료 badge, counts and items keep working inside a month', () => {
  const closedDates = renderMonthGroups(history);
  assert.match(closedDates, /📅 8월 1일<\/span><em class="payablePaidBadge">결제완료<\/em><\/span><small>2건<\/small>/);
  assert.match(closedDates, /📅 8월 7일<\/span><\/span><small>1건<\/small><strong>40₫<\/strong>/);
  assert.doesNotMatch(closedDates, /item-1/);
  // Toggling an older month opens it; expanding a date shows its items.
  const opened = renderMonthGroups(history, ['2026-07', '2026-08-01']);
  assert.match(opened, /📅 7월 2일/);
  assert.match(opened, /↳ item-1/);
  assert.match(opened, /↳ item-2/);
});

test('I/J: KPI and party totals keep their existing sources', () => {
  assert.match(summary, /<PayableMonthTotals summary=\{payables\?\.month===month\?payables\.summary:undefined\} vi=\{vi\} \/>/);
  assert.match(summary, /money\(payables\?\.totalOutstanding \?\? 0\)/);
  assert.match(historical, /<PayableMonthTotals summary=\{party\} vi=\{vi\}\/>/);
  assert.match(historical, /money\(party\.closingOutstanding\)/);
  assert.match(source, /rows=\{payables\.historyPayables\.filter\(row => Number\(row\.party_id\) === payableParty\.partyId\)\}/);
  // The historical sheet still has no payment path.
  assert.doesNotMatch(historical, /fetch|payables\/pay|onPaid|checkbox/);
});
