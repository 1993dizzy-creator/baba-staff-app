import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
  let found;
  function visit(node) {
    if (!found && predicate(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, "Expected page callback was not found");
  return found;
}
const loadArrow = find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === "load")
  .initializer.arguments[0];
const editedArrow = find(node => ts.isJsxAttribute(node) && node.name.getText(ast) === "onConfirmedEdited" &&
  node.initializer?.expression && ts.isArrowFunction(node.initializer.expression)).initializer.expression;
function editorSave(name) {
  const editor = find(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === name);
  return editor.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(ast) === "onSave")
    .initializer.expression;
}
function compile(node, bindings) {
  const code = ts.transpileModule("const run = " + node.getText(ast) + ";", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(bindings), code + "\nreturn run;")(...Object.values(bindings));
}
function fixture({ entries = [], selected = { transactionId: 81, items: [] }, fail = false } = {}) {
  const events = { loading: [], errors: [], selected: [], notice: [], data: [] };
  let current = selected;
  const month = "2026-09";
  const load = compile(loadArrow, {
    month, vi: false, loadRequestSequenceRef: { current: 0 },
    setLoading: value => events.loading.push(value),
    setError: value => events.errors.push(value),
    setData: value => events.data.push(value),
    setPayables() {}, setMonthCloseState() {}, setInvestments() {}, setInvestmentsError() {},
    async fetch(url) {
      const ledger = url.startsWith("/api/admin/ledger?month=");
      const body = ledger ? { month, entries, code: fail ? "LOAD_FAILED" : undefined }
        : url.includes("/investments?") ? { month, configured: true } : { month, state: "open" };
      return { ok: !(ledger && fail), async json() { return body; } };
    },
  });
  const edited = compile(editedArrow, {
    load, vi: false,
    setSelected(value) { current = value; events.selected.push(value); },
    setNotice: value => events.notice.push(value),
  });
  return { load, edited, events, selected: () => current };
}

test("normal loading remains visible; silent refresh never changes whole-page loading", async () => {
  const normal = fixture();
  await normal.load();
  assert.deepEqual(normal.events.loading, [true, false]);
  const silent = fixture();
  await silent.load(undefined, { silent: true });
  assert.deepEqual(silent.events.loading, []);
  assert.equal(silent.events.data.length, 1);
});

test("manual save refresh keeps the detail sheet and replaces its selected entry", async () => {
  const refreshed = { transactionId: 81, amount: 150, items: [] };
  const ui = fixture({ entries: [refreshed] });
  await ui.edited(81);
  assert.equal(ui.selected(), refreshed);
  assert.deepEqual(ui.events.loading, []);
  assert.match(source, /onClose=\{\(\) => setManualDisplayOpen\(false\)\}/);
});

test("Meal save closes only its editor and keeps the refreshed original detail", async () => {
  const refreshed = { transactionId: 91, amount: 150, items: [] };
  const ui = fixture({ entries: [refreshed], selected: { transactionId: 91, amount: 100, items: [] } });
  const drafts = [];
  const save = compile(editorSave("MealAdjustmentEditor"), {
    mealDraft: { finalAmount: "150", reason: "Correction" }, entry: { transactionId: 91 },
    vi: false, setEditSaving() {}, setMealError() {}, setMealDraft: value => drafts.push(value),
    onConfirmedEdited: ui.edited,
    async fetch() { return { ok: true, async json() { return { result: { status: "created" } }; } }; },
  });
  await save();
  assert.deepEqual(drafts, [null]);
  assert.equal(ui.selected(), refreshed);
  assert.deepEqual(ui.events.loading, []);
});

test("Inventory rebook keeps the detail using the replacement transaction ID", async () => {
  const refreshed = { transactionId: null, items: [{ transactionId: 201 }] };
  const ui = fixture({ entries: [refreshed], selected: { transactionId: null, items: [{ transactionId: 101 }] } });
  const drafts = [];
  const save = compile(editorSave("ConfirmedInventoryEditor"), {
    editDraft: { item: { transactionId: 101 }, paymentMode: "immediate", categoryId: "1",
      fundAccountId: "2", amount: "150", memo: "Memo", reason: "Correction" },
    vi: false, setEditSaving() {}, setEditError() {}, setEditDraft: value => drafts.push(value),
    onConfirmedEdited: ui.edited,
    async fetch() { return { ok: true, async json() { return { result: { transactionId: 201 } }; } }; },
  });
  await save();
  assert.deepEqual(drafts, [null]);
  assert.equal(ui.selected(), refreshed);
  assert.deepEqual(ui.events.loading, []);
});

test("refresh failure keeps the existing selected detail and never switches loading", async () => {
  const selected = { transactionId: 81, amount: 100, items: [] };
  const ui = fixture({ selected, fail: true });
  await ui.edited(81);
  assert.equal(ui.selected(), selected);
  assert.deepEqual(ui.events.selected, []);
  assert.deepEqual(ui.events.loading, []);
  assert.ok(ui.events.errors.some(Boolean));
});

test("missing or stale refreshed entry also retains the existing detail", async () => {
  const selected = { transactionId: 81, items: [] };
  const ui = fixture({ selected });
  await ui.edited(81);
  assert.equal(ui.selected(), selected);
  assert.deepEqual(ui.events.selected, []);
});
