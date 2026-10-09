import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { readEditedLedger } from '../lib/ledger/entry-save-refresh.ts';

const source = readFileSync('app/(protected)/admin/ledger/entries/page.tsx', 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
  let found;
  function visit(node) { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); }
  visit(ast); assert.ok(found); return found;
}
const loadArrow = find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'load').initializer.arguments[0];
const editedArrow = find(node => ts.isJsxAttribute(node) && node.name.getText(ast) === 'onConfirmedEdited' &&
  node.initializer?.expression && ts.isArrowFunction(node.initializer.expression)).initializer.expression;
function compile(node, bindings) {
  const code = ts.transpileModule('const run = ' + node.getText(ast) + ';', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(bindings), code + '\nreturn run;')(...Object.values(bindings));
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ entries = [], selected = { id: 'entry-81', transactionId: 81, items: [] }, fail = false, ledgerReplies = [] } = {}) {
  const events = { loading: [], errors: [], selected: [], notice: [], data: [], payables: [], detail: [], requests: [], invalidations: 0 };
  let current = selected;
  const month = '2026-10';
  const sequence = { current: 0 }, controller = { current: null };
  const view = { current: { month, selectionId: selected.id, version: 1 } };
  async function fetcher(url, options) {
    events.requests.push({ url, options });
    const ledger = url.startsWith('/api/admin/ledger?month=');
    const body = ledger ? await (ledgerReplies.length ? ledgerReplies.shift() : { month, entries })
      : url.includes('/investments?') ? { month, configured: true } : { month, state: 'open' };
    return { ok: !(ledger && fail), async json() { return body; } };
  }
  const bindings = {
    month, vi: false, selected, editViewRef: view, editRefreshControllerRef: controller, loadRequestSequenceRef: sequence,
    setLoading: value => events.loading.push(value), setError: value => events.errors.push(value),
    setData: value => events.data.push(value), setPayables: value => events.payables.push(value),
    setMonthCloseState() {}, setInvestmentSummary() {}, bumpInvestmentsVersion() { events.invalidations++; },
    setSelected(value) { current = typeof value === 'function' ? value(current) : value; events.selected.push(current); },
    setNotice: value => events.notice.push(value), setDetailMessage: value => events.detail.push(value),
    fetch: fetcher,
    readEditedLedger: (month, financial, signal) => readEditedLedger(month, financial, signal, fetcher),
  };
  return { load: compile(loadArrow, bindings), edited: compile(editedArrow, bindings), events, view, sequence, controller, selected: () => current };
}

test('normal and silent load keep original loading and abort policies', async () => {
  const normal = fixture(); await normal.load();
  assert.deepEqual(normal.events.loading, [true, false]);
  assert.equal(normal.events.requests.length, 4);
  const silent = fixture(); await silent.load(undefined, { silent: true });
  assert.deepEqual(silent.events.loading, []);
  assert.equal(silent.events.requests.length, 4);
});

test('display edit refreshes ledger only and keeps the selected detail, amounts and date inputs server-derived', async () => {
  const refreshed = { id: 'entry-81', transactionId: 81, amount: 150, memo: 'new', items: [] };
  const ui = fixture({ entries: [refreshed] });
  await ui.edited(81, undefined, false);
  assert.equal(ui.selected(), refreshed);
  assert.equal(ui.events.data[0].entries[0].amount, 150);
  assert.deepEqual(ui.events.requests.map(request => request.url), ['/api/admin/ledger?month=2026-10']);
  assert.equal(ui.events.payables.length, 0);
  assert.equal(ui.events.invalidations, 0);
  assert.equal(ui.events.notice.length, 1);
  assert.match(source, /key=\{`\$\{month\}:\$\{selected\.id\}`\}/);
});

test('financial edit refreshes ledger and payables, keeps server balances and invalidates expanded investment cache once', async () => {
  const ui = fixture({ entries: [{ id: 'entry-81', transactionId: 81, amount: 150, items: [] }] });
  await ui.edited(81);
  assert.equal(ui.events.requests.length, 2);
  assert.equal(ui.events.payables.length, 1);
  assert.equal(ui.events.invalidations, 1);
  assert.ok(ui.events.requests.every(request => request.options.cache === 'no-store'));
});

test('inventory replacement transaction refresh selects its group and keeps detail open', async () => {
  const refreshed = { id: 'supplier-group', transactionId: null, items: [{ transactionId: 201 }] };
  const ui = fixture({ entries: [refreshed], selected: { id: 'supplier-group', transactionId: null, items: [{ transactionId: 101 }] } });
  await ui.edited(201);
  assert.equal(ui.selected(), refreshed);
});

test('refresh failure retains selected detail and reports committed-save refresh failure without a success message', async () => {
  const selected = { id: 'entry-81', transactionId: 81, amount: 100, items: [] };
  const ui = fixture({ selected, fail: true });
  await assert.rejects(ui.edited(81), /LEDGER_REFRESH_FAILED/);
  assert.equal(ui.selected(), selected);
  assert.equal(ui.events.notice.length, 0);
  assert.equal(ui.events.data.length, 0);
});

test('a missing refreshed row retains the sheet instead of closing it', async () => {
  const ui = fixture(); await ui.edited(81);
  assert.equal(ui.selected().transactionId, 81);
  assert.equal(ui.events.selected.length, 0);
});

test('closing the detail during refresh never reopens it or paints a success', async () => {
  const pending = deferred(), ui = fixture({ ledgerReplies: [pending.promise] });
  const saving = ui.edited(81); await flush();
  ui.view.current = { month: '2026-10', selectionId: null, version: 2 };
  pending.resolve({ month: '2026-10', entries: [{ id: 'entry-81', transactionId: 81, items: [] }] });
  await saving;
  assert.equal(ui.events.selected.length, 0);
  assert.equal(ui.events.notice.length, 0);
  assert.equal(ui.events.data.length, 0);
});

test('month navigation before and during completion cannot overwrite another month, including returning to the same month', async () => {
  const pending = deferred(), ui = fixture({ ledgerReplies: [pending.promise] });
  const saving = ui.edited(81); await flush();
  ui.view.current = { month: '2026-09', selectionId: null, version: 2 };
  ui.view.current = { month: '2026-10', selectionId: 'entry-81', version: 3 };
  pending.resolve({ month: '2026-10', entries: [{ id: 'entry-81', transactionId: 81, items: [] }] });
  await saving;
  assert.equal(ui.events.data.length, 0);
  const moved = fixture(); moved.view.current.month = '2026-09';
  await moved.edited(81);
  assert.equal(moved.events.requests.length, 0);
});

test('reversed refresh responses keep the newest row and abort the previous refresh', async () => {
  const first = deferred();
  const newest = { id: 'entry-81', transactionId: 81, amount: 200, items: [] };
  const ui = fixture({ ledgerReplies: [first.promise, { month: '2026-10', entries: [newest] }] });
  const old = ui.edited(81); await flush();
  const oldSignal = ui.events.requests[0].options.signal;
  await ui.edited(81);
  first.resolve({ month: '2026-10', entries: [{ ...newest, amount: 100 }] }); await old;
  assert.equal(oldSignal.aborted, true);
  assert.equal(ui.selected().amount, 200);
  assert.equal(ui.events.data.length, 1);
});

test('wrong month API response never updates data or selected detail', async () => {
  const ui = fixture({ ledgerReplies: [{ month: '2026-09', entries: [] }] });
  await assert.rejects(ui.edited(81), /LEDGER_REFRESH_FAILED/);
  assert.equal(ui.events.data.length, 0);
});

function savingHandler(kind, { lang = 'ko', status = 'created', onEdited = async () => {}, response, failure } = {}) {
  const states = [], drafts = [], errors = [], notices = [], requests = [];
  const mounted = { current: true }, lock = { current: false };
  const node = find(node => ts.isFunctionDeclaration(node) && node.name?.text === (kind === 'meal' ? 'saveMealAdjustment' : 'saveConfirmedInventory'));
  const draft = kind === 'meal' ? { finalAmount: '150', reason: 'Correction' }
    : { item: { transactionId: 101 }, paymentMode: 'immediate', categoryId: '1', fundAccountId: '2', amount: '150', memo: 'Memo', reason: 'Correction' };
  const save = compile(node, {
    lang, vi: lang === 'vi', entry: { transactionId: 91 }, mealDraft: draft, editDraft: draft,
    editSaving: false, saving: false, closed: false, editInFlightRef: lock, detailMountedRef: mounted,
    setEditSaving: value => states.push(value), setMealError: value => errors.push(value), setEditError: value => errors.push(value),
    setMealDraft: value => drafts.push(value), setEditDraft: value => drafts.push(value), setMealNotice: value => notices.push(value),
    editRefreshFailureMessage: () => 'Saved; refresh failed', onConfirmedEdited: onEdited,
    async fetch(url, options) {
      requests.push({ url, options });
      if (response) return response;
      return { ok: !failure, async json() { return failure ? { code: failure } : { result: { status, transactionId: 201 } }; } };
    },
  });
  return { save, states, drafts, errors, notices, requests, mounted, draft };
}

for (const kind of ['inventory', 'meal']) {
  test(`${kind} same-render double click starts one POST, keeps spinner and draft until refresh finishes`, async () => {
    const refresh = deferred(), ui = savingHandler(kind, { onEdited: () => refresh.promise });
    const pending = ui.save(); await ui.save(); await flush();
    assert.equal(ui.requests.length, 1);
    assert.deepEqual(ui.states, [true]); assert.deepEqual(ui.drafts, []);
    refresh.resolve(); await pending;
    assert.deepEqual(ui.states, [true, false]); assert.deepEqual(ui.drafts, [null]);
  });
  test(`${kind} failed API retains draft and does not refresh`, async () => {
    let refreshed = 0;
    const ui = savingHandler(kind, { failure: 'EDIT_FAILED', onEdited: async () => { refreshed++; } });
    await ui.save();
    assert.equal(refreshed, 0); assert.deepEqual(ui.drafts, []);
    assert.ok(ui.errors.at(-1).includes('EDIT_FAILED'));
    assert.equal(ui.draft.reason, 'Correction'); assert.equal(ui.states.at(-1), false);
  });
  test(`${kind} unmounted detail drops completed POST callbacks`, async () => {
    const response = deferred(); let refreshed = 0;
    const ui = savingHandler(kind, { response: response.promise, onEdited: async () => { refreshed++; } });
    const pending = ui.save(); ui.mounted.current = false;
    response.resolve({ ok: true, json: async () => ({ result: { status: 'created', transactionId: 201 } }) });
    await pending;
    assert.equal(refreshed, 0); assert.deepEqual(ui.drafts, []);
  });
  test(`${kind} committed-save refresh failure leaves the draft and distinguishes refresh failure`, async () => {
    const ui = savingHandler(kind, { onEdited: async () => { throw Error('LEDGER_REFRESH_FAILED'); } });
    await ui.save(); assert.deepEqual(ui.drafts, []);
    assert.equal(ui.errors.at(-1), 'Saved; refresh failed'); assert.equal(ui.states.at(-1), false);
  });
}

for (const lang of ['ko', 'vi']) for (const status of ['unchanged', 'reviewed', 'created']) {
  test(`meal ${status} preserves localized success and waits for refresh (${lang})`, async () => {
    const refresh = deferred(); let message;
    const ui = savingHandler('meal', { lang, status, onEdited: (id, value) => { assert.equal(id, 91); message = value; return refresh.promise; } });
    const pending = ui.save(); await flush();
    assert.deepEqual(ui.states, [true]); assert.deepEqual(ui.notices, []);
    assert.ok(message.includes(lang === 'ko' ? '정정' : 'điều chỉnh'));
    refresh.resolve(); await pending;
    assert.deepEqual(ui.notices, [message]); assert.deepEqual(ui.drafts, [null]);
  });
}
