import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(path, dependencies = {}) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => { assert.ok(name in dependencies, `Unexpected import ${name}`); return dependencies[name]; }, testModule, testModule.exports);
  return testModule.exports;
}
const cardSettlements = load('lib/ledger/card-settlements.ts');
const { buildCardFeeMonthState } = load('lib/ledger/card-fee-closures.ts', { './card-settlements': cardSettlements });
const { calculateMonthCloseOperatingSummary } = require('../lib/ledger/month-close-operating.ts');
const { calculateMonthCloseCardSnapshot } = require('../lib/ledger/month-close-card.ts');

const sale = (id, date, amount) => ({ id, business_date: date, amount });
const line = (reconciliationId, saleId, amount, status, depositDate) => ({ reconciliation_id: reconciliationId, pos_card_transaction_id: saleId, allocated_gross_amount: amount, reconciliation: { status, deposit_date: depositDate } });
const rec = (id, status, depositDate, deposit, gross, difference = 0) => ({ id, status, deposit_date: depositDate, deposit_amount: deposit, matched_gross_amount: gross, difference_amount: difference });
const closure = (id, month, amount, status = 'confirmed') => ({ id, fee_month: `${month}-01`, fee_amount: amount, status, expense_transaction_id: amount ? id * 10 : null, confirmed_at: '2026-09-05T00:00:00Z', confirmed_by: 1, cancelled_at: null, cancel_reason: null, memo: null });
const feeLines = rows => cardSettlements.cardFeeRowsAsAllocationLines(rows);
const state = (overrides) => buildCardFeeMonthState({ month: '2026-08', currentMonth: '2026-09', closedMonths: new Set(), sales: [], lines: [], reconciliations: [], closures: [], ...overrides });

test('outstanding counts next-month deposits and historical matched lines; the matched fee stays separate', () => {
  const sales = [sale(1, '2026-08-10', 10_000_000), sale(2, '2026-08-20', 5_000_000)];
  const reconciliations = [rec(1, 'matched', '2026-08-25', 9_800_000, 10_000_000, 200_000), rec(2, 'auto_allocated', '2026-09-03', 4_700_000, 4_700_000), rec(3, 'cancelled', '2026-09-04', 300_000, 300_000)];
  const lines = [line(1, 1, 10_000_000, 'matched', '2026-08-25'), line(2, 2, 4_700_000, 'auto_allocated', '2026-09-03'), line(3, 2, 300_000, 'cancelled', '2026-09-04')];
  const result = state({ sales, lines, reconciliations });
  assert.equal(result.monthCardGross, 15_000_000);
  assert.equal(result.currentOutstanding, 300_000, 'September deposit reduces August; cancelled deposit does not');
  assert.equal(result.historicalConfirmedFee, 200_000, 'matched difference attributed to its sale month');
  assert.equal(result.projectedTotalFee, 500_000);
  assert.deepEqual([result.canConfirm, result.blockerReason, result.closure, result.finalConfirmedFee], [true, null, null, null]);
});

test('active fee lines remove outstanding and define the final fee; cancelled closures do not', () => {
  const sales = [sale(1, '2026-08-10', 1000)];
  const deposit = [line(1, 1, 700, 'auto_allocated', '2026-08-20')];
  const reconciliations = [rec(1, 'auto_allocated', '2026-08-20', 700, 700)];
  const active = state({ sales, reconciliations, lines: [...deposit, ...feeLines([{ id: 1, closure_id: 9, pos_card_transaction_id: 1, allocated_fee_amount: 300, closure: { status: 'confirmed', fee_month: '2026-08-01' } }])], closures: [closure(9, '2026-08', 300)] });
  assert.deepEqual([active.currentOutstanding, active.monthEndFee, active.finalConfirmedFee, active.canConfirm, active.canCancel, active.blockerReason], [0, 300, 300, false, true, null]);
  const cancelledRows = [{ id: 1, closure_id: 8, pos_card_transaction_id: 1, allocated_fee_amount: 300, closure: { status: 'cancelled', fee_month: '2026-08-01' } }];
  const cancelled = state({ sales, reconciliations, lines: [...deposit, ...feeLines(cancelledRows)], closures: [closure(8, '2026-08', 300, 'cancelled')] });
  assert.deepEqual([cancelled.currentOutstanding, cancelled.closure, cancelled.canConfirm], [300, null, true]);
  assert.equal(feeLines(cancelledRows).length, 0);
  assert.deepEqual(feeLines([{ id: 1, closure_id: 9, pos_card_transaction_id: 1, allocated_fee_amount: '300.5', closure: { status: 'confirmed', fee_month: '2026-02-01' } }]),
    [{ reconciliation_id: -9, pos_card_transaction_id: 1, allocated_gross_amount: '300.5', reconciliation: { status: 'card_fee', deposit_date: '2026-02-28' } }]);
});

test('month state blockers mirror the confirm RPC order', () => {
  const sales = [sale(1, '2026-07-10', 500), sale(2, '2026-08-10', 1000)];
  assert.equal(state({ sales, month: '2026-09' }).blockerReason, 'current_month');
  assert.equal(state({ sales, month: '2026-10' }).blockerReason, 'future_month');
  assert.equal(state({ sales, closedMonths: new Set(['2026-08']) }).blockerReason, 'month_closed');
  assert.equal(state({ sales, reconciliations: [rec(5, 'unmatched', '2026-08-20', 100, 0)] }).blockerReason, 'legacy_unallocated_deposits');
  assert.equal(state({ sales, reconciliations: [rec(5, 'unmatched', '2026-07-31', 100, 0)] }).blockerReason, 'earlier_month_unconfirmed', 'a legacy deposit before the month cannot pay it');
  const earlier = state({ sales });
  assert.deepEqual([earlier.blockerReason, earlier.earlierUnconfirmedMonth, earlier.canConfirm], ['earlier_month_unconfirmed', '2026-07', false]);
  assert.equal(state({ sales, closedMonths: new Set(['2026-07']) }).blockerReason, null, 'closed earlier months never block');
  assert.equal(state({ sales, closures: [closure(3, '2026-07', 500)] }).blockerReason, null);
  const empty = state({ sales: [sale(1, '2026-07-10', 500)], closedMonths: new Set(['2026-07']) });
  assert.deepEqual([empty.hasCardSales, empty.blockerReason, empty.canConfirm], [false, 'no_card_sales', false]);
  const closed = state({ sales, closedMonths: new Set(['2026-07', '2026-08']), closures: [closure(4, '2026-08', 0)] });
  assert.deepEqual([closed.canCancel, closed.finalConfirmedFee, closed.blockerReason], [false, 0, null]);
});

test('operating summary counts historical attributed fee 200 plus month-end fee 300 exactly once', () => {
  const tx = (source_type, amount, sign = 1) => ({ type: 'expense_recognition', source_type, source_key: null, amount, economic_effect_sign: sign, category: { name: '카드 정산 차액' } });
  // August sale gross was matched by a September deposit: its 200 difference is recognized in September.
  const matchedLines = [{ reconciliationId: 1, businessDate: '2026-08-10', allocatedGrossAmount: 10_000, matchedGrossAmount: 10_000, differenceAmount: 200 }];
  const august = calculateMonthCloseOperatingSummary('2026-08', [tx('card_fee_month_close', 300)], matchedLines);
  assert.equal(august.expense.byCategory['카드 정산 차액'], 300);
  assert.equal(august.expense.byCategory['카드 정산 차액 · 매출월 귀속'], 200);
  assert.equal(august.expense.total, 500);
  assert.equal(august.expense.depositMonthRecognizedDifference, 0, 'the month-end fee is not treated as a deposit-month difference');
  const september = calculateMonthCloseOperatingSummary('2026-09', [tx('card_settlement_difference', 200)], matchedLines);
  assert.equal(september.expense.total, 0, 'the historical difference moves to its sale month, never counted twice');
  const cancelled = calculateMonthCloseOperatingSummary('2026-08', [tx('card_fee_month_close', 300), tx('card_fee_month_close_reversal', 300, -1)], matchedLines);
  assert.equal(cancelled.expense.total, 200, 'a cancelled month-end fee nets to zero');
});

test('month-end card snapshot settles fee lines in their fee month only', () => {
  const sales = [{ id: 1, amount: 1000 }];
  const lines = [
    { pos_card_transaction_id: 1, allocated_gross_amount: 700, reconciliation: { status: 'auto_allocated', deposit_date: '2026-08-20' } },
    ...feeLines([{ id: 1, closure_id: 9, pos_card_transaction_id: 1, allocated_fee_amount: 300, closure: { status: 'confirmed', fee_month: '2026-08-01' } }]),
  ];
  const cards = [{ id: 1, status: 'auto_allocated', deposit_amount: 700, matched_gross_amount: 700, difference_amount: 0 }];
  assert.equal(calculateMonthCloseCardSnapshot(cards, lines, sales, '2026-09-01').unsettledGross, 0, 'the August fee (dated 08-31) settles August at month end');
  assert.equal(calculateMonthCloseCardSnapshot(cards, lines, sales, '2026-08-31').unsettledGross, 300, 'not before the fee date');
  assert.equal(calculateMonthCloseCardSnapshot(cards, lines, sales, '2026-09-01').settlementDifference, 0, 'fee lines are not matched differences');
});

function feeApi({ rpcResult = { status: 'confirmed', feeAmount: 0 }, denied = false } = {}) {
  const calls = [];
  const route = load('app/api/admin/ledger/card-fees/route.ts', {
    '@/lib/ledger/card-fee-closures': { buildCardFeeMonthState: () => ({ month: '2026-08' }) },
    '@/lib/ledger/card-settlement-data': { loadCardAllocationLines: async () => [], loadCardRows: async () => [], loadCardSales: async () => [] },
    '@/lib/ledger/card-settlements': {},
    '@/lib/ledger/server': { requireLedgerActor: async () => denied ? { response: Response.json({ ok: false }, { status: 403 }) } : { actor: { id: 7 } }, ledgerJson: (body, status = 200) => Response.json(body, { status }) },
    '@/lib/supabase/server': { supabaseServer: { rpc: async (name, args) => { calls.push({ name, args }); return { data: rpcResult, error: null }; } } },
  });
  const cancel = load('app/api/admin/ledger/card-fees/[id]/cancel/route.ts', {
    '@/lib/ledger/server': { requireLedgerActor: async () => ({ actor: { id: 7 } }), ledgerJson: (body, status = 200) => Response.json(body, { status }) },
    '@/lib/supabase/server': { supabaseServer: { rpc: async (name, args) => { calls.push({ name, args }); return { data: rpcResult, error: null }; } } },
  });
  const post = body => route.POST(new Request('http://local/api/admin/ledger/card-fees', { method: 'POST', body: JSON.stringify(body) }));
  const cancelPost = (id, body) => cancel.POST(new Request('http://local', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { calls, route, post, cancelPost };
}

test('card fee POST sends only month and memo to the confirm RPC and maps its statuses', async () => {
  const ok = feeApi({ rpcResult: { status: 'confirmed', feeAmount: 300 } });
  const response = await ok.post({ month: '2026-08', memo: 'bank checked' });
  assert.equal(response.status, 201);
  assert.deepEqual(ok.calls, [{ name: 'ledger_confirm_card_fee_month_v1', args: { p_month: '2026-08-01', p_memo: 'bank checked', p_actor_user_id: 7 } }]);
  for (const body of [{ month: '2026-08', feeAmount: 300 }, { month: '2026-8' }, { memo: 'x' }, { month: '2026-08', memo: 5 }]) {
    const state = feeApi();
    assert.equal((await state.post(body)).status, 400, JSON.stringify(body));
    assert.equal(state.calls.length, 0);
  }
  for (const [status, http] of [['forbidden', 403], ['current_month', 409], ['month_closed', 409], ['already_confirmed', 409], ['legacy_unallocated_deposits', 409], ['earlier_month_unconfirmed', 409], ['insufficient_card_pending', 409], ['no_card_sales', 409], ['invalid_month', 400]]) {
    const result = await feeApi({ rpcResult: { status } }).post({ month: '2026-08' });
    assert.equal(result.status, http, status);
    assert.equal((await result.json()).code, status.toUpperCase());
  }
  assert.equal((await feeApi({ denied: true }).post({ month: '2026-08' })).status, 403);
  assert.equal((await feeApi().route.GET(new Request('http://local/api/admin/ledger/card-fees?month=2026-13'))).status, 400);
});

test('card fee cancel requires a reason and forwards only the canonical RPC arguments', async () => {
  const state = feeApi({ rpcResult: { status: 'cancelled' } });
  for (const [id, body] of [['1', {}], ['1', { reason: '  ' }], ['1', { reason: 'x', extra: 1 }], ['0', { reason: 'x' }]]) assert.equal((await state.cancelPost(id, body)).status, 400);
  assert.equal(state.calls.length, 0);
  assert.equal((await state.cancelPost('41', { reason: '  late deposit ' })).status, 200);
  assert.deepEqual(state.calls, [{ name: 'ledger_cancel_card_fee_month_v1', args: { p_closure_id: 41, p_reason: 'late deposit', p_actor_user_id: 7 } }]);
  for (const [status, http] of [['forbidden', 403], ['not_found', 404], ['month_closed', 409], ['already_cancelled', 409], ['reason_required', 400]]) {
    assert.equal((await feeApi({ rpcResult: { status } }).cancelPost('41', { reason: 'x' })).status, http, status);
  }
});
