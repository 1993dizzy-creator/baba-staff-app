// BABA-TABLE-FINAL (2026-11-25 20:25-20:28): every central collection succeeded, but three board
// reads hit PostgREST timeouts and the whole board turned unknown. The board now holds its last
// good view (display only) inside the 10-minute collection validity, and the server records which
// read stage failed. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { heldTableOverview, overviewReadFailed, OVERVIEW_HOLD_MAX_SNAPSHOT_AGE_MS, unavailableTableOverview } from '../lib/sales/table-detail-refresh.ts';
import { logTablesReadFailure, tablesReadBudget, tablesReadErrorCode, tablesReadTimedOut, TABLES_READ_LOG } from '../lib/sales/table-read-diagnostics.ts';
import { overview, order, now, businessDate } from './helpers/table-overview-fixture.mjs';

const MIN = 60_000;
// Last good board: snapshot 1 minute old when served; A1 occupied, B1 has an unverifiable order (unknown).
const good = () => overview({ now: new Date(now.getTime() + MIN), orders: [order('live', 'A1'), order('odd', 'B1', { lines: null, status: 7 })] });
const readFailed = (day = businessDate) => overview({ readFailed: true, businessDate: day, now: new Date(now.getTime() + 2 * MIN),
  sync: { businessDate: day, lastSuccessAt: now.toISOString(), lastAttemptAt: now.toISOString(), lastErrorCode: 'read_failed' } });
const t0 = 1_000_000;
const tile = (o, name) => o.tables.find(t => t.name === name);

test('RED: the previous board turned every table unknown on a single failed refresh', () => {
  const last = good();
  assert.equal(tile(last, 'A1').state, 'occupied');
  assert.ok(unavailableTableOverview(last).tables.every(t => t.state === 'unknown'));
});

test('transient /api/tables failure: the last good board is held unchanged with its last good time, then recovers', () => {
  const last = good();
  const held = heldTableOverview({ overview: last, receivedAt: t0 }, t0 + MIN);
  assert.equal(held.overview, last); // same facts: no green/blue invented, no state changed
  assert.equal(held.delayed.lastSuccessAt, last.serverNow);
  assert.equal(held.delayed.expiresInMs, OVERVIEW_HOLD_MAX_SNAPSHOT_AGE_MS - 2 * MIN);
  assert.equal(tile(held.overview, 'B1').state, tile(last, 'B1').state); // a real per-table unknown is not hidden
  // Recovery: a successful response clears the failure; the board is that response (page: setFailure(null)).
  assert.equal(heldTableOverview(null, t0, null).overview, null);
});

test('HTTP 200 server read failure is treated as a failed refresh, never as current facts', () => {
  const last = good(), failedRead = readFailed();
  assert.equal(overviewReadFailed(failedRead), true);
  assert.ok(failedRead.tables.every(t => t.state === 'unknown'));
  const held = heldTableOverview({ overview: last, receivedAt: t0 }, t0 + MIN, failedRead);
  assert.equal(held.overview, last);
  assert.ok(held.delayed);
  // Real collection results are not failures: stale/failed collection or partial unknown are shown as they are.
  assert.equal(overviewReadFailed(last), false);
  assert.equal(overviewReadFailed(overview({ sync: { businessDate, lastSuccessAt: now.toISOString(), lastAttemptAt: now.toISOString(), lastErrorCode: 'provider_timeout' } })), false);
});

test('consecutive failures: held only inside the 10-minute collection validity, then every table unknown', () => {
  const last = good(); // snapshot already 1 minute old when served
  const justInside = heldTableOverview({ overview: last, receivedAt: t0 }, t0 + 9 * MIN - 1);
  assert.equal(justInside.overview, last);
  const expired = heldTableOverview({ overview: last, receivedAt: t0 }, t0 + 9 * MIN);
  assert.equal(expired.delayed, null);
  assert.ok(expired.overview.tables.every(t => t.state === 'unknown'));
  assert.equal(expired.overview.collection.health, 'read_failed');
  // A clock moved backwards, an unhealthy or already failed last view: never held.
  assert.equal(heldTableOverview({ overview: last, receivedAt: t0 }, t0 - 1).delayed, null);
  const waiting = overview({ sync: null, orders: [] });
  assert.notEqual(waiting.snapshotStatus, 'ok');
  assert.equal(heldTableOverview({ overview: waiting, receivedAt: t0 }, t0 + 1000).delayed, null);
  assert.equal(heldTableOverview({ overview: readFailed(), receivedAt: t0 }, t0 + 1000).delayed, null);
});

test('business date change and no previous good data keep the existing protection', () => {
  const last = good(), next = readFailed('2026-11-14');
  const changed = heldTableOverview({ overview: last, receivedAt: t0 }, t0 + MIN, next);
  assert.deepEqual([changed.overview, changed.delayed], [next, null]);
  const first = readFailed();
  assert.deepEqual(heldTableOverview(null, t0, first), { overview: first, delayed: null });
  assert.deepEqual(heldTableOverview(null, t0, null), { overview: null, delayed: null });
});

test('diagnostics: stage, sanitized code and elapsed time only; timeouts are recognized', () => {
  assert.equal(tablesReadErrorCode({ code: '57014', message: 'canceling statement due to statement timeout' }), '57014');
  assert.equal(tablesReadErrorCode({ code: 'PGRST003', message: 'Timed out acquiring connection' }), 'PGRST003');
  assert.equal(tablesReadErrorCode(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), 'timeout');
  assert.equal(tablesReadErrorCode({ message: 'AbortError: signal timed out', code: '' }), 'timeout');
  assert.equal(tablesReadErrorCode(new Error('SNAPSHOT_INVALID')), 'SNAPSHOT_INVALID');
  assert.equal(tablesReadErrorCode(new Error('row customer=Nguyen token=abc')), 'error');
  assert.equal(tablesReadErrorCode(null), 'error');
  for (const code of ['57014', 'PGRST003', 'timeout']) assert.equal(tablesReadTimedOut(code), true);
  assert.equal(tablesReadTimedOut('42501'), false);
  const lines = [];
  const code = logTablesReadFailure('auto_context', { code: '57014', message: 'secret detail', details: 'order 05155463', hint: 'x' }, Date.now() - 8000, (...a) => lines.push(a));
  assert.equal(code, '57014');
  assert.equal(lines[0][0], TABLES_READ_LOG);
  const entry = JSON.parse(lines[0][1]);
  assert.deepEqual(Object.keys(entry), ['stage', 'code', 'ms']);
  assert.ok(entry.ms >= 8000 && entry.stage === 'auto_context');
  assert.doesNotMatch(lines[0][1], /secret|order|05155463/);
});

test('request budget: 12 s total ends well before the 20 s board limit; no stage starts without time left', () => {
  const start = Date.now();
  const budget = tablesReadBudget(undefined, start);
  assert.ok(budget.remaining() <= 12_000 && budget.remaining() > 11_000);
  assert.equal(budget.allows(), true);
  const spent = tablesReadBudget(12_000, start - 11_500);
  assert.equal(spent.allows(), false); // < 1 s left: no fallback read is started
  assert.ok(spent.signal() instanceof AbortSignal);
});
