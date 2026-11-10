import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs, nextMock } from './helpers/sales-auth-harness.mjs';
import { buildDailyPaymentSales, compareDailyCloseSnapshot, fetchAllExactPages } from '../lib/sales/daily-sales-summary.ts';
import { buildPaymentSummary } from '../lib/sales/payment-summary.ts';

const reader = loadTs('lib/sales/open-orders-read-server.ts');
const sha = 'ce603ce55d3f73d7dcf6e872dbcddb3c6428d9cc';

test('READ diagnostics expose presence and the actual trimmed true decision, never raw values or credentials', () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1', 'true', ' true ', 'PRIVATE_TOKEN']) {
    const env = { VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: sha,
      SUPABASE_SERVICE_ROLE_KEY: 'PRIVATE_CREDENTIAL', POS_OPEN_ORDERS_READ_ENABLED: value };
    const diagnostic = reader.getOpenOrdersReadDiagnostic(env);
    assert.deepEqual(diagnostic, { readFlagPresent: value !== undefined, readFlagEnabled: value?.trim() === 'true',
      deploymentSha: sha, deploymentEnvironment: 'production' });
    assert.equal(diagnostic.readFlagEnabled, reader.openOrdersReadEnabled(env));
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE|SUPABASE|POS_OPEN_ORDERS_READ_ENABLED/);
  }
});

test('deployment identifiers are bounded to a valid SHA and known environment; unknown runtime stays explicit', () => {
  assert.deepEqual(reader.getOpenOrdersReadDiagnostic({}), { readFlagPresent: false, readFlagEnabled: false,
    deploymentSha: null, deploymentEnvironment: 'unknown' });
  for (const environment of ['production', 'preview', 'development']) {
    assert.equal(reader.getOpenOrdersReadDiagnostic({ VERCEL_ENV: environment }).deploymentEnvironment, environment);
  }
  const invalid = reader.getOpenOrdersReadDiagnostic({ VERCEL_ENV: 'PRIVATE_ENV', VERCEL_GIT_COMMIT_SHA: 'PRIVATE_TOKEN' });
  assert.equal(invalid.deploymentSha, null);
  assert.equal(invalid.deploymentEnvironment, 'unknown');
  assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE/);
});

function apiHarness(auth, fail = false) {
  let diagnosticCalls = 0, queries = 0;
  const expected = reader.getOpenOrdersReadDiagnostic({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: sha });
  const route = loadTs('app/api/admin/sales/today/route.ts', {
    'next/server': nextMock,
    '@/lib/auth/server-auth': { requireRole: async roles => { assert.deepEqual(roles, ['owner','master','manager']); return auth; } },
    '@/lib/sales/open-orders-read-server': {
      getOpenOrdersReadDiagnostic: () => { diagnosticCalls++; return expected; },
      loadOpenOrderKpi: async () => ({ status: 'not_enabled', open: null, provisional: null }),
    },
    '@/lib/sales/admin-sales-business-time': { resolveAdminSalesBusinessDate: async () => ({ businessDate: '2026-11-10' }) },
    '@/lib/sales/pos-pending-payment': { findOldestPendingCloseHoldDate: async () => null },
    '@/lib/sales/daily-sales-summary': { buildDailyPaymentSales, compareDailyCloseSnapshot, fetchAllExactPages },
    '@/lib/sales/payment-summary': { buildPaymentSummary },
    '@/lib/sales/tax-saving': { calculateModifiedReceiptTaxSaving: () => 0 },
    '@/lib/supabase/server': { supabaseServer: { from() {
      queries++;
      const query = { select() { return query; }, eq() { return query; }, order() { return query; }, limit() { return query; },
        maybeSingle: async () => ({ data: null, error: null }),
        range: async () => ({ data: [], count: 0, error: fail ? { message: 'fixture database unavailable' } : null }) };
      return query;
    } } },
  });
  return { route, expected, counts: () => ({ diagnosticCalls, queries }) };
}
const request = () => new Request('http://local/api/admin/sales/today?businessDate=2026-11-10');

test('401/403 responses never compute or include deployment diagnostics and never read sales data', async () => {
  for (const status of [401, 403]) {
    const h = apiHarness({ ok: false, status, code: status === 401 ? 'RELOGIN_REQUIRED' : 'FORBIDDEN' });
    const response = await h.route.GET(request());
    assert.equal(response.status, status);
    assert.equal((await response.json()).openOrdersReadDiagnostic, undefined);
    assert.deepEqual(h.counts(), { diagnosticCalls: 0, queries: 0 });
  }
});

test('authenticated daily API includes a no-store READ diagnostic without adding a DB query', async () => {
  const h = apiHarness({ ok: true });
  const response = await h.route.GET(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.openOrdersReadDiagnostic, h.expected);
  assert.equal(body.openOrders.status, 'not_enabled');
  assert.equal(body.openOrders.open, null);
  assert.equal(body.summary.totalSales, 0);
  assert.deepEqual(h.counts(), { diagnosticCalls: 1, queries: 4 }); // Existing closure + three paid sources.
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
});

test('authenticated source failure still includes safe READ diagnostics for incident diagnosis', async () => {
  const h = apiHarness({ ok: true }, true);
  const log = console.error;
  console.error = () => {};
  let response;
  try { response = await h.route.GET(request()); } finally { console.error = log; }
  assert.equal(response.status, 500);
  assert.deepEqual((await response.json()).openOrdersReadDiagnostic, h.expected);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
});
