import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { entriesApi } from './helpers/ledger-entries-api-fixture.mjs';
import { entriesTables } from './helpers/ledger-entries-tables.mjs';
import { createEntriesDiagnostics, ENTRIES_QUERY_GROUPS, ENTRIES_SLOW_LOG_MS } from '../lib/ledger/entries-diagnostics.ts';

// The same route source with diagnostics never enabled is the behavioral baseline.
const source = readFileSync('app/api/admin/ledger/route.ts', 'utf8');
const ENABLE = '  if (entriesOnly) diagnostics = createEntriesDiagnostics();\n';
assert.equal(source.split(ENABLE).length, 2);
const disabledSource = source.replace(ENABLE, '');
const callShape = calls => calls.map(({ table, columns, filters, orders, from, to }) => ({ table, columns, filters, orders, from, to }));
const stageNames = header => header.split(', ').map(token => token.slice(0, token.indexOf(';'))).filter(name => !/^(bq_|diag_)/.test(name));
const tokens = header => Object.fromEntries(header.split(', ').filter(t => t.startsWith('bq_')).map(t => {
  const [, group, dur, pages] = t.match(/^bq_(\w+);dur=([\d.]+);desc="p(\d+)"$/);
  return [group, { end: Number(dur), pages: Number(pages) }];
}));

async function run(tables, query, options = {}) {
  const api = entriesApi(tables, options), response = await api.get('2026-10', query);
  return { status: response.status, body: await response.text(), header: response.headers.get('server-timing'), calls: callShape(api.calls) };
}

for (const extraSales of [0, 1001]) for (const scope of ['', 'dashboard', 'accounts', 'entries']) {
  test(`diagnostics leave ${scope || 'default'} responses and query sequence unchanged (${extraSales ? '1000+ rows' : 'base fixture'})`, async () => {
    const query = scope ? '&scope=' + scope : '';
    const enabled = await run(entriesTables(extraSales), query);
    const disabled = await run(entriesTables(extraSales), query, { source: disabledSource });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.status, disabled.status);
    assert.equal(enabled.body, disabled.body);
    assert.deepEqual(enabled.calls, disabled.calls);
    assert.deepEqual(stageNames(enabled.header), stageNames(disabled.header));
    if (scope === 'entries') assert.match(enabled.header, /bq_mtx;dur=.*diag_inst;desc="r\d+ g-?\d+", total;dur=/);
    else assert.doesNotMatch(enabled.header, /bq_|diag_/);
  });
}

// base_reads requests of the fixture call log, by diagnostic group.
function groupOf({ table, columns, filters }) {
  const has = (op, key, value) => filters.some(([o, k, v]) => o === op && k === key && (value === undefined || v === value));
  if (table === 'ledger_transactions') {
    if (columns.startsWith('id,operation_id')) return has('in', 'correction_of_id') ? 'mcor' : 'mtx';
    if (columns.startsWith('type,amount')) return 'prof';
    if (columns.startsWith('id,business_date,amount,source_key')) return 'card';
    if (columns.startsWith('id,amount,economic_effect_sign')) return 'pexp';
    if (columns.startsWith('correction_of_id')) return 'pcor';
  }
  if (table === 'ledger_card_reconciliations' || (table === 'ledger_card_reconciliation_lines' && columns.includes('sale:'))) return 'card';
  if (['ledger_reserve_plans', 'ledger_reserve_entries'].includes(table)) return 'fund';
  if (table === 'ledger_movements' && !columns.startsWith('id,')) return 'fund';
  if (['ledger_fund_accounts', 'ledger_categories', 'business_partners', 'business_partner_subtypes', 'business_partner_ledger_parties'].includes(table)) return 'ref';
  if (table === 'ledger_candidates' && (has('eq', 'status', 'pending') || has('eq', 'candidate_type', 'employee_meal'))) return 'cand';
  return null;
}

for (const extraSales of [0, 1001]) test(`entries groups: settle time and page count match the requests actually sent (${extraSales ? '1000+ rows' : 'base fixture'})`, async () => {
  const result = await run(entriesTables(extraSales), '&scope=entries');
  const groups = tokens(result.header);
  assert.deepEqual(Object.keys(groups), [...ENTRIES_QUERY_GROUPS]);
  const sent = Object.fromEntries(ENTRIES_QUERY_GROUPS.map(group => [group, 0]));
  for (const call of result.calls) { const group = groupOf(call); if (group) sent[group] += 1; }
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([group, timing]) => [group, timing.pages])), sent);
  assert.equal(sent.mtx, extraSales ? 2 : 1);
  // Meal corrections need the month pages first.
  assert.ok(groups.mcor.end >= groups.mtx.end);
});

test('a failed later month page fails closed exactly as before, with group timings attached', async () => {
  const options = { failKind: 'ledger_transactions' };
  const enabled = await run(entriesTables(1001), '&scope=entries', options);
  const disabled = await run(entriesTables(1001), '&scope=entries', { ...options, source: disabledSource });
  assert.equal(enabled.status, 500);
  assert.equal(enabled.body, disabled.body);
  assert.deepEqual(enabled.calls, disabled.calls);
  assert.match(enabled.header, /bq_ref;dur=.*diag_inst;desc=/);
});

test('group() settles exactly like the wrapped promise, including rejection', async () => {
  const diagnostics = createEntriesDiagnostics();
  diagnostics.startBaseReads();
  const value = { data: [{ id: 1 }], error: null };
  assert.equal(await diagnostics.group('ref', Promise.resolve(value)), value);
  const error = new Error('page failed');
  await assert.rejects(async () => await diagnostics.group('card', Promise.reject(error)), e => e === error);
  // Lazy: an unsubscribed query builder is never started by the wrapper.
  let started = 0;
  diagnostics.group('fund', { then(resolve) { started++; resolve({ data: [] }); } });
  assert.equal(started, 0);
  diagnostics.endBaseReads();
  assert.match(diagnostics.serverTiming().join(', '), /^bq_card;dur=\d+\.\d{2};desc="p0", bq_ref;dur=\d+\.\d{2};desc="p1", diag_elu;desc="\d\.\d{2}", diag_inst;desc="r\d+ g-?\d+"$/);
});

test('slow log: only at or above 3s, one line of fixed numeric fields with a UTC timestamp', () => {
  const lines = [], warn = console.warn;
  console.warn = (...args) => lines.push(args);
  try {
    const diagnostics = createEntriesDiagnostics();
    diagnostics.startBaseReads();
    diagnostics.monthPagesLoaded(2);
    diagnostics.monthCorrectionsLoaded(1);
    diagnostics.endBaseReads();
    const stages = [['auth', 41.5], ['base_reads', 2950.25]];
    assert.equal(diagnostics.logIfSlow('2026-10', stages, ENTRIES_SLOW_LOG_MS - 0.01), false);
    assert.equal(lines.length, 0);
    assert.equal(diagnostics.logIfSlow('2026-10', stages, ENTRIES_SLOW_LOG_MS), true);
  } finally { console.warn = warn; }
  assert.equal(lines.length, 1);
  const [prefix, json] = lines[0];
  assert.equal(prefix, '[ledger-entries-slow]');
  const record = JSON.parse(json);
  assert.deepEqual(Object.keys(record), ['v', 'at', 'month', 'totalMs', 'stages', 'groups', 'elu', 'instance']);
  assert.match(record.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(record.stages, { auth: 42, base_reads: 2950 });
  assert.deepEqual(Object.keys(record.groups), ['mtx', 'mcor']);
  assert.equal(record.groups.mtx[1], 2);
  // Only fixed names, digits and the month: no URL, query, identity or text values.
  assert.doesNotMatch(json, /https?:|\/|\?|@|select|ledger_|"[^"]*\s[^"]*"/);
  assert.ok(json.length < 400, `log line ${json.length} bytes`);
});

test('diagnostic cost and header size stay negligible', async () => {
  const runs = 2000, started = performance.now();
  for (let i = 0; i < runs; i++) {
    const diagnostics = createEntriesDiagnostics();
    diagnostics.startBaseReads();
    await Promise.all(ENTRIES_QUERY_GROUPS.flatMap(group => [1, 2, 3].map(() => diagnostics.group(group, Promise.resolve({ data: [] })))));
    diagnostics.endBaseReads();
    diagnostics.serverTiming();
  }
  const perRequestMs = (performance.now() - started) / runs;
  assert.ok(perRequestMs < 1, `per request ${perRequestMs.toFixed(3)}ms`);
  const enabled = await run(entriesTables(1001), '&scope=entries');
  const disabled = await run(entriesTables(1001), '&scope=entries', { source: disabledSource });
  const added = Buffer.byteLength(enabled.header) - Buffer.byteLength(disabled.header);
  assert.ok(added > 0 && added < 600, `added ${added} header bytes`);
  console.log(`diagnostics: ${perRequestMs.toFixed(3)}ms per request (27 groups), +${added} Server-Timing bytes`);
});
