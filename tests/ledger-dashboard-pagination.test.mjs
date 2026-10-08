import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const compile = path => ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const routeCode = compile('app/api/admin/ledger/route.ts');
const cardCode = compile('lib/ledger/card-settlement-data.ts');
const { buildProvisionalOperatingProfit } = require('../lib/ledger/provisional-operating-profit.ts');

function queryKind(table, columns, filters) {
  const is = (key, value) => filters.some(([op, name, expected]) => op === 'eq' && name === key && expected === value);
  if (table === 'ledger_transactions') {
    if (columns === 'type,amount,economic_effect_sign,category_id') return is('type', 'expense_recognition') ? 'recognition' : 'profit';
    if (columns.startsWith('id,amount,economic_effect_sign')) return 'paidRoots';
    if (columns.startsWith('correction_of_id,amount')) return 'paidCorrections';
  }
  if (table === 'ledger_card_reconciliation_lines' && columns.includes('sale:')) return 'priorCardDeposits';
  if (table === 'ledger_movements') return is('transaction.type', 'opening') ? 'opening' : 'movements';
  if (table === 'ledger_reserve_plans') return 'reservePlans';
  if (table === 'ledger_reserve_entries') return 'reserveEntries';
  return table;
}

// Read-only Supabase double. The default cap, inclusive ranges, filters and
// multi-column ordering are enforced; shuffled input cannot accidentally pass.
function api(tables, failKind) {
  const calls = [];
  const db = {
    from(table) {
      const filters = [], orders = [];
      let columns = '', from = 0, to = 999;
      const value = (row, key) => key.split('.').reduce((item, part) => item?.[part], row);
      const matches = row => filters.every(([op, key, expected]) => {
        const actual = value(row, key);
        switch (op) {
          case 'eq': return actual === expected;
          case 'neq': return actual !== expected;
          case 'gte': return actual >= expected;
          case 'lt': return actual < expected;
          case 'lte': return actual <= expected;
          case 'in': return expected.includes(actual);
          case 'not': return actual != null;
          case 'like': return new RegExp('^' + expected.split('%').join('.*') + '$').test(actual ?? '');
          default: throw Error('Unexpected filter ' + op);
        }
      });
      function execute(single = false) {
        const kind = queryKind(table, columns, filters);
        const call = { table, columns, kind, filters: [...filters], orders: [...orders], from, to };
        calls.push(call);
        if (kind === failKind && from >= 1000) return { data: null, error: { code: 'PAGE_FAILED', kind } };
        const rows = (tables[table] ?? []).filter(matches).sort((a, b) => {
          for (const [key, ascending] of orders) {
            const left = value(a, key), right = value(b, key);
            if (left !== right) return (left < right ? -1 : 1) * (ascending ? 1 : -1);
          }
          return 0;
        }).slice(from, Math.min(to + 1, from + 1000));
        call.ids = rows.map(row => row.id);
        return { data: single ? rows[0] ?? null : rows, error: null };
      }
      const query = {
        select(selection) { columns = selection; return query; },
        order(key, options = {}) { orders.push([key, options.ascending !== false]); return query; },
        range(start, end) { from = start; to = end; return query; },
        maybeSingle: async () => execute(true),
        then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); },
      };
      for (const op of ['eq', 'neq', 'gte', 'lt', 'lte', 'in', 'not', 'like']) {
        query[op] = (key, expected) => { filters.push([op, key, expected]); return query; };
      }
      return query;
    },
    rpc() { throw Error('RPC forbidden in this read-only test'); },
  };
  const cardModule = { exports: {} };
  const cardFunctions = require('../lib/ledger/card-settlements.ts');
  new Function('require', 'module', 'exports', cardCode)(name => {
    if (name === '@/lib/supabase/server') return { supabaseServer: db };
    if (name === '@/lib/ledger/card-settlements') return cardFunctions;
    throw Error('Unexpected card dependency ' + name);
  }, cardModule, cardModule.exports);
  const dependencies = {
    '@/lib/supabase/server': { supabaseServer: db },
    '@/lib/ledger/server': { requireLedgerActor: async () => ({ actor: { id: 7, role: 'owner' } }), ledgerJson: (body, status = 200) => Response.json(body, { status }) },
    '@/lib/ledger/inventory-display': { withInventoryDisplay: async rows => rows, loadInventoryProjectionIssues: async () => [] },
    '@/lib/ledger/entries': { buildLedgerEntries: () => [], buildReserveLedgerEntries: () => [] },
    '@/lib/ledger/card-settlement-data': cardModule.exports,
    '@/lib/ledger/card-settlements': cardFunctions,
    '@/lib/common/business-time': {
      getBusinessDate: () => '2026-10-08',
      getBusinessMonthEndBoundary(month) {
        const date = new Date(month + '-01T00:00:00Z'); date.setUTCMonth(date.getUTCMonth() + 1);
        const businessDateExclusive = date.toISOString().slice(0, 10);
        return { businessDateExclusive, cutoffAt: businessDateExclusive + 'T03:00:00+07:00' };
      },
    },
  };
  for (const name of ['reserve-balances', 'fund-account-view', 'dashboard-cash-report', 'manual-entry-policy', 'payables', 'summary', 'cash-outflow']) {
    dependencies['@/lib/ledger/' + name] = require('../lib/ledger/' + name + '.ts');
  }
  dependencies['@/lib/partners/emoji'] = require('../lib/partners/emoji.ts');
  const routeModule = { exports: {} };
  new Function('require', 'module', 'exports', 'console', routeCode)(name => {
    assert.ok(name in dependencies, 'Unexpected dependency ' + name);
    return dependencies[name];
  }, routeModule, routeModule.exports, { error() {} });
  return {
    calls,
    get: (month = '2026-09', scope = '') => routeModule.exports.GET(new Request('http://local/api/admin/ledger?month=' + month + scope)),
  };
}

const transaction = (id, type = 'sales', amount = 1, extra = {}) => ({
  id, type, amount, economic_effect_sign: 1, status: 'confirmed', recognition_month: '2026-09-01',
  business_date: '2026-09-10', occurred_at: '2026-09-10T12:00:00+07:00', source_type: 'manual',
  source_key: 'fixture:' + id, category_id: 1, category: { id: 1, name: 'Fixture', kind: 'expense' },
  movements: [], payable: null, ...extra,
});
const account = { id: 1, code: 'store_cash', type: 'cash', display_name: 'Cash', is_business_fund: true, sort_order: 1 };
const snapshot = { funds: { accounts: [{ id: 1, code: 'store_cash', balance: 338845642 }] }, reserve: { plans: [] } };
const tablesFor = rows => ({
  ledger_transactions: rows,
  ledger_fund_accounts: [account],
  ledger_month_closures: [{ id: 1, month: '2026-09-01', status: 'closed', revision: 2, summary_snapshot: snapshot }],
});
const splitTotal = (count, total, firstId) => Array.from({ length: count }, (_, index) => transaction(firstId + index, 'sales', Math.floor(total / count) + (index < total % count ? 1 : 0)));
function assertPages(state, kind, count) {
  const calls = state.calls.filter(call => call.kind === kind);
  const pages = Math.floor(count / 1000) + 1;
  assert.equal(calls.length, pages, kind);
  for (const [index, call] of calls.entries()) {
    assert.deepEqual([call.from, call.to], [index * 1000, index * 1000 + 999]);
    assert.deepEqual(call.orders, [['id', true]]);
  }
  const ids = calls.flatMap(call => call.ids);
  assert.equal(ids.length, count);
  assert.equal(new Set(ids).size, count);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
}

test('September 1017 rows include the last 17 sales and preserve the closed snapshot and payroll formula', async () => {
  const ballantine = transaction(2, 'income', 5200000, { source_key: 'manual:ballantine-21:2026-09-10' });
  const rows = [transaction(1, 'expense', 406979586), ballantine, transaction(3, 'income', 619069),
    ...splitTotal(997, 606785280, 4), ...splitTotal(17, 84379920, 1001)];
  assert.equal(rows.slice(0, 1000).filter(row => ['sales', 'income'].includes(row.type)).reduce((sum, row) => sum + row.amount, 0), 612604349);
  assert.equal(rows.slice(1000).reduce((sum, row) => sum + row.amount, 0), 84379920);
  // Recognition month, not business date, controls profit membership.
  rows[3].business_date = '2026-08-31';
  const excluded = [transaction(2001, 'sales', 900000000, { status: 'draft' }),
    transaction(2002, 'sales', 900000000, { recognition_month: '2026-08-01' }),
    transaction(2003, 'sales', 900000000, { recognition_month: '2026-10-01' }), transaction(2004, 'transfer', 900000000)];
  const tables = tablesFor([...excluded, ...rows].reverse());
  tables.ledger_movements = [{ id: 1, fund_account_id: 1, amount: 338845642, transaction: { status: 'confirmed', type: 'opening', business_date: '2026-10-01', occurred_at: '2026-10-01T03:00:00+07:00' } }];
  const before = JSON.stringify(tables);
  const state = api(tables), response = await state.get(), body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.summary.salesIncome, 691165200); assert.equal(body.summary.otherIncome, 5819069);
  assert.equal(body.summary.income, 696984269); assert.equal(body.summary.expense, 406979586);
  assert.equal(body.summary.operatingProfit, 290004683); assert.equal(body.profitTransactions.length, 1017);
  const provisional = buildProvisionalOperatingProfit({ isCurrentMonth: false, summary: body.summary,
    payroll: { status: 'predicted', amount: 176449615, adjustment: 176449615 }, currentCard: null, previousCard: null });
  assert.equal(provisional.operatingProfit, 113555068);
  assert.equal(body.fundsView.mode, 'closed_snapshot'); assert.equal(body.accounts[0].balance, 338845642);
  const october = await (await state.get('2026-10', '&scope=accounts')).json();
  assert.equal(october.accounts[0].openingBalance, 338845642);
  assertPages(state, 'profit', 1017);
  assert.equal(tables.ledger_month_closures[0].revision, 2);
  assert.equal(JSON.stringify(tables), before);
  assert.equal(ballantine.amount, 5200000);
});

for (const count of [0, 944, 1000, 1001, 2000, 2017]) {
  test('profit pagination includes exactly ' + count + ' shuffled rows without gaps or duplicates', async () => {
    const state = api(tablesFor(Array.from({ length: count }, (_, index) => transaction(index + 1, 'sales', index + 1)).reverse()));
    const response = await state.get(), body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.summary.income, count * (count + 1) / 2);
    assert.equal(body.profitTransactions.length, count); assertPages(state, 'profit', count);
  });
}

test('negative sales, income, expense and expense_recognition signs retain their existing economics', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => transaction(i + 1, 'sales', 10));
  rows.push(transaction(1001, 'sales', 300, { economic_effect_sign: -1 }), transaction(1002, 'income', 500),
    transaction(1003, 'income', 50, { economic_effect_sign: -1 }), transaction(1004, 'expense', 1000),
    transaction(1005, 'expense', 250, { economic_effect_sign: -1, source_type: 'ledger_correction', correction_of_id: 1004 }),
    transaction(1006, 'expense_recognition', 30, { economic_effect_sign: -1 }));
  const body = await (await api(tablesFor(rows.reverse())).get()).json();
  assert.equal(body.summary.salesIncome, 9700); assert.equal(body.summary.otherIncome, 450);
  assert.equal(body.summary.expense, 720); assert.equal(body.summary.operatingProfit, 9430);
  assert.equal(body.summary.paidExpense, 750);
});

test('expense_recognition beyond 1000 rows is complete and retains negative signs', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => transaction(i + 1, 'expense_recognition', 5, { economic_effect_sign: i === 1000 ? -1 : 1 }));
  const state = api(tablesFor(rows.reverse())), body = await (await state.get()).json();
  assert.equal(body.summary.expense, 4995); assert.equal(body.profitTransactions.length, 1001);
  assertPages(state, 'recognition', 1001);
});

test('paid expense roots and corrections both paginate; later-month corrections stay date-independent', async () => {
  const roots = Array.from({ length: 1001 }, (_, i) => transaction(i + 1, 'expense', 100));
  const corrections = roots.map(row => transaction(row.id + 5000, 'expense', 1, { source_type: 'ledger_correction', correction_of_id: row.id, economic_effect_sign: -1, recognition_month: '2026-10-01', business_date: '2026-10-10' }));
  const state = api(tablesFor([...roots, ...corrections].reverse())), body = await (await state.get()).json();
  assert.equal(body.summary.expense, 100100); assert.equal(body.summary.paidExpense, 99099);
  assertPages(state, 'paidRoots', 1001); assertPages(state, 'paidCorrections', 1001);
  for (const call of state.calls.filter(call => call.kind === 'paidCorrections')) assert.ok(!call.filters.some(([, key]) => key === 'recognition_month' || key === 'business_date'));
});

function aggregateTables() {
  const month = { recognition_month: '2026-10-01', business_date: '2026-10-05' };
  const roots = Array.from({ length: 1001 }, (_, i) => transaction(i + 3000, 'expense', 100, month));
  const tables = tablesFor([...Array.from({ length: 1001 }, (_, i) => transaction(i + 1, 'sales', 1, month)),
    ...Array.from({ length: 1001 }, (_, i) => transaction(i + 1500, 'expense_recognition', 1, month)), ...roots,
    ...roots.map(row => transaction(row.id + 5000, 'expense', 1, { ...month, source_type: 'ledger_correction', correction_of_id: row.id, economic_effect_sign: -1, recognition_month: '2026-11-01' }))].reverse());
  const movement = (id, type, amount) => ({ id, fund_account_id: 1, amount, transaction: { status: 'confirmed', type, business_date: '2026-10-01', occurred_at: '2026-10-01T03:00:00+07:00' } });
  tables.ledger_movements = [...Array.from({ length: 1001 }, (_, i) => movement(i + 1, 'income', 1)), ...Array.from({ length: 1001 }, (_, i) => movement(i + 2000, 'opening', 2))].reverse();
  tables.ledger_reserve_plans = Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, name: 'Reserve ' + i, is_active: true, fund_account_id: 1 })).reverse();
  tables.ledger_reserve_entries = Array.from({ length: 1001 }, (_, i) => ({ id: i + 1, reserve_plan_id: 1001, entry_type: i === 1000 ? 'release' : 'allocate', amount: 1, occurred_at: '2026-09-20T12:00:00+07:00' })).reverse();
  return tables;
}

test('movement, opening, reserve plan and reserve entry pagination preserves full/accounts scope parity', async () => {
  const state = api(aggregateTables()), body = await (await state.get('2026-10')).json();
  assert.equal(body.accounts[0].balance, 3003); assert.equal(body.accounts[0].openingBalance, 2002);
  assert.equal(body.accounts[0].reserveTotal, 999); assert.equal(body.accounts[0].availableBalance, 2004);
  for (const [kind, count] of [['movements', 2002], ['opening', 1001], ['reservePlans', 1001], ['reserveEntries', 1001]]) assertPages(state, kind, count);
  const light = api(aggregateTables()), lightBody = await (await light.get('2026-10', '&scope=accounts')).json();
  assert.deepEqual(lightBody.accounts, body.accounts);
  assert.ok(!light.calls.some(call => call.table === 'ledger_transactions'));
});

for (const kind of ['profit', 'recognition', 'paidRoots', 'paidCorrections', 'movements', 'opening', 'reservePlans', 'reserveEntries']) {
  test('a later ' + kind + ' page error returns 500 with no partial summary', async () => {
    const state = api(aggregateTables(), kind), response = await state.get('2026-10'), body = await response.json();
    assert.equal(response.status, 500); assert.deepEqual(body, { ok: false, code: 'LEDGER_LOAD_FAILED' });
    assert.ok(state.calls.some(call => call.kind === kind && call.from === 1000));
  });
}


function receiptTables({ priorDate = '2026-08-20', cancelled = false, count = 1 } = {}) {
  const current = transaction(2, 'sales', 181045460, { source_type: 'pos_sales_daily_payment', source_key: 'pos:2026-09-10:card' });
  const prior = transaction(5, 'sales', 90000000, { recognition_month: '2026-08-01', business_date: priorDate, source_type: 'pos_sales_daily_payment', source_key: 'pos:' + priorDate + ':card' });
  const tables = tablesFor([transaction(1, 'sales', 510119740), current, transaction(3, 'income', 5819069), transaction(4, 'expense', 406979586), prior]);
  const reconciliation = (id, amount, status = 'auto_allocated') => ({ id, deposit_date: '2026-09-12', deposit_amount: amount, matched_gross_amount: amount, difference_amount: 0, status });
  const now = reconciliation(1, 174118663), old = reconciliation(2, 27933560);
  const ignored = reconciliation(3, 999999, 'cancelled');
  tables.ledger_card_reconciliations = [now, old, ignored];
  const line = (id, sale, parent, amount) => ({ id, reconciliation_id: parent.id, pos_card_transaction_id: sale.id, allocated_gross_amount: amount, sale, reconciliation: parent });
  tables.ledger_card_reconciliation_lines = [line(1, current, now, 174118663), line(2, prior, old, 27933560), line(3, prior, ignored, 999999)];
  if (cancelled) old.status = 'cancelled';
  if (count > 1) tables.ledger_card_reconciliation_lines = [line(1, current, now, 174118663), ...Array.from({ length: count }, (_, i) => line(i + 10, prior, old, Math.floor(27933560 / count) + (i < 27933560 % count ? 1 : 0)))].reverse();
  return tables;
}

test('September receipt bridge uses actual previous allocations and leaves every existing summary and snapshot unchanged', async () => {
  const tables = receiptTables(), before = JSON.stringify(tables), state = api(tables);
  const response = await state.get(), body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.salesReceiptExplanation, { posSales: 691165200, priorMonthCardDeposits: 27933560, monthEndUnsettledCardSales: 6926797, actualSalesReceipts: 712171963, allocationDifference: 0 });
  assert.equal(body.summary.cardGrossSales, 181045460); assert.equal(body.summary.monthlySettledGross, 174118663);
  assert.equal(body.summary.actualCardDeposits, 202052223); assert.equal(body.summary.receivedIncome, 717991032);
  assert.equal(body.summary.otherIncome, 5819069); assert.equal(body.summary.income, 696984269);
  assert.equal(body.summary.expense, 406979586); assert.equal(body.summary.operatingProfit, 290004683);
  assert.equal(body.accounts[0].balance, 338845642); assert.equal(body.fundsView.mode, 'closed_snapshot');
  assert.equal(JSON.stringify(tables), before);
});

test('two or more months earlier sales use only the actual selected-month allocation, not the old outstanding balance', async () => {
  const body = await (await api(receiptTables({ priorDate: '2026-07-20' })).get()).json();
  assert.equal(body.salesReceiptExplanation.priorMonthCardDeposits, 27933560);
  assert.equal(body.salesReceiptExplanation.allocationDifference, 0);
});

test('cancelled prior settlement deposits and allocations are both excluded', async () => {
  const body = await (await api(receiptTables({ cancelled: true })).get()).json();
  assert.equal(body.salesReceiptExplanation.priorMonthCardDeposits, 0);
  assert.equal(body.salesReceiptExplanation.actualSalesReceipts, 684238403);
  assert.equal(body.salesReceiptExplanation.allocationDifference, 0);
});

for (const count of [1000, 1001, 2017]) {
  test('prior-month allocation paging includes ' + count + ' shuffled lines without duplicates', async () => {
    const state = api(receiptTables({ count })), body = await (await state.get()).json();
    assert.equal(body.salesReceiptExplanation.priorMonthCardDeposits, 27933560);
    assert.equal(body.salesReceiptExplanation.actualSalesReceipts, 712171963);
    assertPages(state, 'priorCardDeposits', count);
  });
}

test('a later allocation page failure returns no partial receipts or summary', async () => {
  const response = await api(receiptTables({ count: 1001 }), 'priorCardDeposits').get();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, code: 'LEDGER_LOAD_FAILED' });
});
