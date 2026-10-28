import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as recurring from '../lib/ledger/recurring-expenses.ts';

const require = createRequire(import.meta.url);
const rent = { id: 1, name: '매장 임대료', category_id: 3, amount: '50000000.000', recognition_day: 1, effective_from: '2026-08-01', effective_to: null, is_active: true, source_key_prefix: 'store-rent', memo: null };

test('month status: one item per active plan; recognized / cancelled / missing; closure state', () => {
  const months = recurring.monthRange('2026-08', '2026-10');
  assert.deepEqual(months, ['2026-08', '2026-09', '2026-10']);
  const rows = recurring.buildRecurringMonthStatuses(
    [rent, { ...rent, id: 2, is_active: false, source_key_prefix: 'old' }],
    [{ id: 91, source_key: 'recurring:1:2026-10', status: 'confirmed', amount: '50000000', recognition_month: '2026-10-01' },
     { id: 92, source_key: 'recurring:1:2026-09', status: 'cancelled', amount: '50000000', recognition_month: '2026-09-01' }],
    [{ month: '2026-08-01', status: 'closed' }, { month: '2026-09-01', status: 'reopened' }],
    months,
  );
  assert.deepEqual(rows.map(row => [row.month, row.closure, row.missingCount, row.items.map(item => item.status).join()]), [
    ['2026-08', 'closed', 1, 'missing'], ['2026-09', 'reopened', 0, 'cancelled'], ['2026-10', 'open', 0, 'recognized'],
  ]);
  assert.equal(rows[2].items[0].transactionId, 91);
  assert.equal(rows[0].items[0].amount, 50000000);
  // Before the plan starts (and outside its end) nothing applies.
  assert.deepEqual(recurring.buildRecurringMonthStatuses([{ ...rent, effective_to: '2026-08-31' }], [], [], ['2026-07', '2026-09']).map(row => row.items.length), [0, 0]);
  assert.equal(recurring.monthRange('2024-01', '2026-10').length, recurring.MAX_STATUS_MONTHS);
  assert.deepEqual(recurring.monthRange('2026-11', '2026-10'), []);
});

test('plan input validation and the same-category guard against double rent', () => {
  const body = { name: '매장 임대료', categoryId: 3, amount: 50000000, recognitionDay: 1, effectiveFrom: '2026-08', sourceKeyPrefix: 'store-rent', memo: ' ' };
  assert.deepEqual(recurring.parseCreatePlanBody(body), { ok: true, value: { ...body, memo: null } });
  for (const [patch, code] of [[{ name: ' ' }, 'INVALID_NAME'], [{ categoryId: 0 }, 'INVALID_CATEGORY'], [{ amount: 0 }, 'INVALID_AMOUNT'], [{ amount: 1.0001 }, 'INVALID_AMOUNT'],
    [{ recognitionDay: 32 }, 'INVALID_RECOGNITION_DAY'], [{ effectiveFrom: '2026-08-01' }, 'INVALID_EFFECTIVE_FROM'], [{ sourceKeyPrefix: 'Store Rent' }, 'INVALID_SOURCE_KEY_PREFIX']]) {
    assert.deepEqual(recurring.parseCreatePlanBody({ ...body, ...patch }), { ok: false, code }, code);
  }
  assert.equal(recurring.conflictingCategoryPlan([rent], { categoryId: 3, sourceKeyPrefix: 'rent-2', effectiveFrom: '2026-10' })?.id, 1);
  // A new version of the same plan (same prefix) is the RPC's own versioning, not a duplicate.
  assert.equal(recurring.conflictingCategoryPlan([rent], { categoryId: 3, sourceKeyPrefix: 'store-rent', effectiveFrom: '2027-07' }), null);
  assert.equal(recurring.conflictingCategoryPlan([rent], { categoryId: 4, sourceKeyPrefix: 'other', effectiveFrom: '2026-10' }), null);
  assert.equal(recurring.conflictingCategoryPlan([{ ...rent, effective_to: '2026-09-30' }], { categoryId: 3, sourceKeyPrefix: 'rent-2', effectiveFrom: '2026-10' }), null);
});

// Route with a read-only Supabase double: RPC calls are recorded, never executed.
function routeApi({ rpcResult = { status: 'ok', createdCount: 1 }, plans = [rent], today = '2026-10-27' } = {}) {
  const calls = [];
  const db = {
    from(table) {
      const filters = [];
      const query = {
        select() { return query; }, order() { return query; },
        eq(key, value) { filters.push([key, value]); return query; }, in() { return query; },
        then(resolve) {
          const data = table === 'ledger_recurring_expense_plans' ? plans.filter(plan => filters.every(([key, value]) => plan[key] === value))
            : table === 'ledger_categories' ? [{ id: 3, name: '임대료', parent_id: 18 }] : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
    async rpc(name, args) { calls.push([name, args]); return { data: rpcResult, error: null }; },
  };
  const code = ts.transpileModule(readFileSync('app/api/admin/ledger/recurring-expenses/route.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const deps = {
    '@/lib/common/business-time': { getBusinessDate: () => today },
    '@/lib/ledger/recurring-expenses': require('../lib/ledger/recurring-expenses.ts'),
    '@/lib/ledger/server': { requireLedgerActor: async () => ({ actor: { id: 7 }, response: null }), ledgerJson: (body, status = 200) => Response.json(body, { status }) },
    '@/lib/supabase/server': { supabaseServer: db },
  };
  const routeModule = { exports: {} };
  new Function('require', 'module', 'exports', 'console', code)(name => { assert.ok(name in deps, name); return deps[name]; }, routeModule, routeModule.exports, { error() {} });
  const post = async body => { const response = await routeModule.exports.POST(new Request('http://local/api', { method: 'POST', body: JSON.stringify(body) })); return { status: response.status, body: await response.json() }; };
  const get = async (query = '') => { const response = await routeModule.exports.GET(new Request('http://local/api' + query)); return { status: response.status, body: await response.json() }; };
  return { calls, post, get };
}

test('sync: open month calls v2 once; closed month is reported by the RPC; future/invalid months never reach the RPC', async () => {
  const open = routeApi();
  assert.deepEqual(await open.post({ action: 'sync', month: '2026-10' }), { status: 200, body: { ok: true, month: '2026-10', result: { status: 'ok', createdCount: 1 } } });
  assert.deepEqual(open.calls, [['ledger_sync_recurring_expenses_v2', { p_month: '2026-10-01', p_actor_user_id: 7 }]]);

  const closed = routeApi({ rpcResult: { status: 'ok', createdCount: 0, unchangedCount: 1, closedMonth: true } });
  const closedResult = await closed.post({ action: 'sync', month: '2026-08' });
  assert.equal(closedResult.status, 409);
  assert.equal(closedResult.body.code, 'MONTH_CLOSED');

  const guarded = routeApi();
  assert.equal((await guarded.post({ action: 'sync', month: '2026-11' })).body.code, 'FUTURE_MONTH');
  assert.equal((await guarded.post({ action: 'sync', month: '2026-8' })).status, 400);
  assert.equal((await guarded.post({ action: 'sync', month: '2026-10', extra: 1 })).status, 400);
  assert.equal((await guarded.post({ action: 'delete' })).body.code, 'INVALID_ACTION');
  assert.deepEqual(guarded.calls, []);
  assert.equal((await routeApi({ rpcResult: { status: 'forbidden' } }).post({ action: 'sync', month: '2026-10' })).status, 403);
});

test('create_plan: validated, blocked when the category already has an active plan, otherwise the version RPC only', async () => {
  const body = { action: 'create_plan', name: '매장 임대료 (현 계약)', categoryId: 3, amount: 50000000, recognitionDay: 1, effectiveFrom: '2026-08', sourceKeyPrefix: 'store-rent', memo: '선납금·준비금과 별개' };
  const blocked = routeApi();
  const conflict = await blocked.post({ ...body, sourceKeyPrefix: 'rent-copy' });
  assert.deepEqual([conflict.status, conflict.body.code, conflict.body.planId], [409, 'CATEGORY_PLAN_EXISTS', 1]);
  assert.deepEqual(blocked.calls, []);

  const fresh = routeApi({ plans: [], rpcResult: { status: 'created', recurringPlanId: 5 } });
  assert.equal((await fresh.post(body)).status, 201);
  assert.deepEqual(fresh.calls, [['ledger_create_recurring_plan_version_v1', {
    p_name: '매장 임대료 (현 계약)', p_category_id: 3, p_amount: 50000000, p_recognition_day: 1, p_effective_from: '2026-08-01',
    p_party_id: null, p_source_key_prefix: 'store-rent', p_memo: '선납금·준비금과 별개', p_actor_user_id: 7,
  }]]);
  assert.equal((await fresh.post({ ...body, unknown: true })).body.code, 'INVALID_BODY');
  assert.equal((await fresh.post({ ...body, effectiveFrom: '2028-01' })).body.code, 'INVALID_EFFECTIVE_FROM');
});

test('GET: read only, no RPC, statuses from the first active plan month through the current month', async () => {
  const api = routeApi();
  const { status, body } = await api.get();
  assert.equal(status, 200);
  assert.deepEqual(body.months.map(row => row.month), ['2026-08', '2026-09', '2026-10']);
  assert.ok(body.months.every(row => row.missingCount === 1));
  assert.deepEqual(api.calls, []);
  assert.equal((await api.get('?through=2026-11')).status, 400);
});

test('UI: settings card loads only when opened; the close sheet offers sync on RECURRING_NOT_SYNCED', () => {
  const settings = readFileSync('app/(protected)/admin/ledger/settings/page.tsx', 'utf8');
  const panel = readFileSync('app/(protected)/admin/ledger/settings/RecurringExpensePanel.tsx', 'utf8');
  const sheet = readFileSync('app/(protected)/admin/ledger/entries/MonthCloseSheet.tsx', 'utf8');
  // 2026-10-28 A plan: the card is not mounted in 기본설정 any more (rent lives in 임대료·준비금);
  // the component, the recurring route and the close-sheet sync below stay.
  assert.doesNotMatch(settings, /<RecurringExpensePanel/);
  // The 기본설정 tab keeps exactly its two reads; the card fetches on first open.
  assert.doesNotMatch(settings, /recurring-expenses/);
  assert.match(panel, /if \(next && !data && !loading\) void load\(\);/);
  assert.match(panel, /window\.confirm\(copy\.confirmSync/);
  assert.match(panel, /window\.confirm\(copy\.confirmCreate/);
  assert.match(sheet, /blockers\.some\(issue => issue\.code === "RECURRING_NOT_SYNCED"\)/);
  assert.match(sheet, /body: JSON\.stringify\(\{ action: "sync", month \}\)/);
  const keys = lang => [...panel.slice(panel.indexOf(`  ${lang}: {`), panel.indexOf('\n  },', panel.indexOf(`  ${lang}: {`))).matchAll(/^ {4}(\w+):/gm)].map(match => match[1]);
  assert.deepEqual(keys('vi'), keys('ko'));
});
