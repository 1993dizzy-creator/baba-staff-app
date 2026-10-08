import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildDashboardDetailEmoji } from '../lib/ledger/dashboard-detail-emoji.ts';
import { manualExpenseCategoryEmoji } from '../lib/ledger/manual-entry-policy.ts';

const categories = [
  { id: 1, name: '영업수입' }, { id: 2, name: '예금이자' },
  { id: 3, name: '매입비' }, { id: 4, name: '식자재 매입' },
  { id: 5, name: '주류 매입' }, { id: 6, name: '음료·BAR 재료' },
  { id: 7, name: '보험' }, { id: 8, name: '복리후생' },
  { id: 9, name: '식자재 매입 추가', emoji: null }, { id: 10, name: '설비·비품', emoji: '🎧' },
];
const emoji = buildDashboardDetailEmoji({ categories, partners: [{ ledgerPartyId: 11, emoji: '🍕' }, { ledgerPartyId: 12, emoji: '🥃' }],
  transactions: [{ id: 101, party_id: 11, category: { id: 1 } }, { id: 102, party_id: 12, category: { id: 1 } },
    { id: 103, category: { id: 2 } }, { id: 104, category: { id: 10 } }, { id: 105, party_id: 999, category: { id: 1 } }] });

test('configured detail and actually linked partner emoji take precedence over category defaults', () => {
  assert.equal(emoji({ id: 101, emoji: '⭐' }, 'income', 1), '⭐');
  assert.equal(emoji({ id: 101 }, 'income', 1), '🍕'); assert.equal(emoji({ id: 102 }, 'income', 1), '🥃');
  assert.equal(emoji({ id: 104 }, 'income', 1), '🎧');
});

test('expense details reuse the existing exact category mapping, including drink/BAR, insurance and benefits', () => {
  for (const id of [4, 5, 6, 7, 8]) assert.equal(emoji({ id }, 'expense', 3), manualExpenseCategoryEmoji(categories.find(c => c.id === id).name));
  assert.equal(emoji({ id: 10 }, 'expense', 3), '🎧');
});

test('known payroll and adjustment cause IDs have explicit icons', () => {
  assert.equal(emoji({ id: -201 }, 'expense', 3), '👥');
  assert.equal(emoji({ id: -204 }, 'expense', 3), '⚖️');
});

test('an income transaction ID cannot be mistaken for an expense category ID or the reverse', () => {
  const resolve = buildDashboardDetailEmoji({ categories: [{ id: 5, name: '주류 매입' }], transactions: [{ id: 5, party_id: 11 }], partners: [{ ledgerPartyId: 11, emoji: '🍕' }] });
  assert.equal(resolve({ id: 5 }, 'income', 1), '🍕'); assert.equal(resolve({ id: 5 }, 'expense', 5), '🍷');
});

test('unknown or incomplete classification uses safe direction defaults, never substring or memo guesses', () => {
  assert.equal(emoji({ id: 105 }, 'income', 1), '💰'); assert.equal(emoji({ id: 9 }, 'expense', 999), '📦');
  assert.equal(emoji({ id: 999 }, 'expense', 999), '📦'); assert.equal(emoji({ id: 103 }, 'income', 1), '🏦');
  const code = readFileSync('lib/ledger/dashboard-detail-emoji.ts', 'utf8');
  assert.ok(!code.includes('.includes(')); assert.ok(!code.includes('.memo'));
});

test('emoji resolution is read-only and does not change report amounts or source metadata', () => {
  const data = { categories, transactions: [{ id: 1, party_id: 11 }], partners: [{ ledgerPartyId: 11, emoji: '🍕' }] };
  const before = JSON.stringify(data); const resolve = buildDashboardDetailEmoji(data);
  resolve({ id: 1 }, 'income', 1); resolve({ id: 4 }, 'expense', 3);
  assert.equal(JSON.stringify(data), before);
});

test('all receipt and category detail rows share typography, amount alignment and a fixed hidden emoji column', () => {
  const css = readFileSync('app/(protected)/admin/ledger/ledger-dashboard.module.css', 'utf8');
  const row = readFileSync('components/ledger/DashboardDetailRow.tsx', 'utf8');
  assert.match(css, /\.detailRow\s*\{[^}]*grid-template-columns: 18px minmax\(0, 1fr\) auto;[^}]*line-height: 1.4;[^}]*font-size: 10px;[^}]*font-weight: 750;/);
  assert.match(css, /\.detailAmount\s*\{[^}]*text-align: right;[^}]*white-space: nowrap;/);
  assert.match(css, /\.receiptNote\s*\{[^}]*font-size: 9px;/);
  assert.match(row, /className=\{styles.detailEmoji\} aria-hidden="true"/);
  assert.ok(!css.includes('.receiptRows'));
  assert.ok(readFileSync('components/ledger/SalesReceiptDetails.tsx', 'utf8').includes('<DashboardDetailRow'));
  assert.ok(readFileSync('app/(protected)/admin/ledger/page.tsx', 'utf8').includes('<DashboardDetailRow key={detail.id}'));
});
