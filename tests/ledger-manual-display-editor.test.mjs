import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync("app/(protected)/admin/ledger/entries/ManualDisplayEditor.tsx", "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const amountModule = { exports: {} };
new Function("require", "module", "exports", ts.transpileModule(
  readFileSync("lib/ledger/manual-entry-amount.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText)(require, amountModule, amountModule.exports);
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ lang = "ko", closed = false, amountEditable = false, originalAmount = 100, response = { ok: true, body: { status: "updated" } }, refresh } = {}) {
  const values = [];
  const calls = [];
  const events = { refreshed: [], closed: 0, saving: [] };
  let cursor = 0, refCursor = 0;
  const refs = [], cleanups = [];
  let effectsMounted = false;
  const react = {
    ...React,
    useRef(value) { const slot = refCursor++; return refs[slot] ??= { current: value }; },
    useEffect(callback) { if (!effectsMounted) cleanups.push(callback()); },
    useState(initial) {
      const slot = cursor++;
      if (!(slot in values)) values[slot] = initial;
      return [values[slot], next => {
        values[slot] = typeof next === "function" ? next(values[slot]) : next;
      }];
    },
  };
  const deps = {
    react,
    "react/jsx-runtime": require("react/jsx-runtime"),
    "@/components/bar/keeping/KeepingUi": {
      BarField: ({ children, label }) => React.createElement("label", null, label, children({ id: label })),
      keepingInputStyle: {},
      primaryButtonStyle: {},
    },
    "./entries.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
    "@/lib/ledger/manual-entry-amount": amountModule.exports,
  };
  const testModule = { exports: {} };
  new Function("require", "module", "exports", "fetch", code)(
    name => deps[name], testModule, testModule.exports,
    async (url, options) => {
      calls.push({ url, options });
      const result = await response;
      return { ok: result.ok, async json() { return result.body; } };
    },
  );
  const props = {
    lang, transactionId: 81, originalAmount, amountEditable, originalTitle: "기존 제목", originalMemo: "기존 메모", closed,
    onSavingChange(value) { events.saving.push(value); },
    async onConfirmedEdited(id, message, financial) { events.refreshed.push(id); events.financial = financial; if (refresh) await refresh(); },
    onClose() { events.closed++; },
  };
  function expand(node, found) {
    if (Array.isArray(node)) return node.map((item, index) => {
      const child = expand(item, found);
      return React.isValidElement(child) && child.key == null ? React.cloneElement(child, { key: index }) : child;
    });
    if (node == null || typeof node !== "object") return node;
    if (typeof node.type === "function") return expand(node.type(node.props), found);
    const children = expand(node.props?.children, found);
    const element = { ...node, props: { ...node.props, children } };
    if (node.type === "button") found.buttons.push(element);
    if (node.type === "input") found.inputs.push(element);
    if (node.type === "textarea") found.textareas.push(element);
    return element;
  }
  function render() {
    cursor = 0; refCursor = 0;
    const found = { buttons: [], inputs: [], textareas: [] };
    const tree = expand(testModule.exports.default(props), found);
    effectsMounted = true;
    return { ...found, html: renderToStaticMarkup(tree) };
  }
  const click = (view, label) => {
    const button = view.buttons.find(item => item.props.children === label);
    assert.ok(button, "Button missing: " + label);
    assert.equal(button.props.disabled, false, "Button disabled: " + label);
    button.props.onClick();
  };
  return { render, click, calls, events, unmount() { cleanups.forEach(cleanup => cleanup?.()); } };
}

test("blank reason keeps save clickable and shows a validation message without calling API", () => {
  const ui = fixture();
  const initial = ui.render();
  ui.click(initial, "수정 저장");
  assert.match(ui.render().html, /수정 사유를 입력해주세요/);
  assert.equal(ui.calls.length, 0);
});

test("blank title and unchanged content show their own validation messages", () => {
  const ui = fixture();
  let view = ui.render();
  view.inputs[0].props.onChange({ target: { value: "" } });
  ui.click(ui.render(), "수정 저장");
  assert.match(ui.render().html, /표시 제목을 입력해주세요/);
  view = ui.render();
  view.inputs[0].props.onChange({ target: { value: "기존 제목" } });
  view = ui.render();
  view.inputs[1].props.onChange({ target: { value: "확인 사유" } });
  ui.click(ui.render(), "수정 저장");
  assert.match(ui.render().html, /변경된 내용이 없습니다/);
  assert.equal(ui.calls.length, 0);
});

test("valid save posts immediately once, closes editor and refreshes", async () => {
  const ui = fixture();
  let view = ui.render();
  view.inputs[0].props.onChange({ target: { value: "변경 제목" } });
  view = ui.render();
  view.textareas[0].props.onChange({ target: { value: "" } });
  view = ui.render();
  view.inputs[1].props.onChange({ target: { value: "오타 수정" } });
  ui.click(ui.render(), "수정 저장");
  assert.equal(ui.calls.length, 1, "POST starts on the save click");
  await flush();
  assert.equal(ui.calls[0].url, "/api/admin/ledger/transactions/81/display");
  assert.deepEqual(JSON.parse(ui.calls[0].options.body), { title: "변경 제목", memo: "", reason: "오타 수정" });
  assert.equal(ui.events.closed, 1);
  assert.deepEqual(ui.events.refreshed, [81]);
});
test("API failure preserves entered draft and shows error in editor", async () => {
  const ui = fixture({ response: { ok: false, body: { code: "EDIT_FAILED" } } });
  let view = ui.render();
  view.inputs[0].props.onChange({ target: { value: "새 제목" } });
  view = ui.render();
  view.textareas[0].props.onChange({ target: { value: "새 메모" } });
  view = ui.render();
  view.inputs[1].props.onChange({ target: { value: "수정 사유" } });
  ui.click(ui.render(), "수정 저장");
  await flush();
  view = ui.render();
  assert.match(view.html, /EDIT_FAILED/);
  assert.equal(view.inputs[0].props.value, "새 제목");
  assert.equal(view.textareas[0].props.value, "새 메모");
  assert.equal(view.inputs[1].props.value, "수정 사유");
  assert.equal(ui.events.closed, 0);
  assert.deepEqual(ui.events.refreshed, []);
  assert.equal(ui.calls.length, 1);
});

test("closed month disables save and Vietnamese validation is localized", () => {
  const closed = fixture({ closed: true });
  const button = closed.render().buttons.find(item => item.props.children === "수정 저장");
  assert.equal(button?.props.disabled, true);
  assert.equal(closed.calls.length, 0);
  const vi = fixture({ lang: "vi" });
  vi.click(vi.render(), "Lưu sửa đổi");
  assert.match(vi.render().html, /Vui lòng nhập lý do chỉnh sửa/);
  assert.equal(vi.calls.length, 0);
});


test("generic manual editor shows amount and posts title, amount, memo and reason", async () => {
  const ui = fixture({ amountEditable: true });
  let view = ui.render();
  assert.match(view.html, /금액/);
  assert.equal(view.inputs.length, 3);
  view.inputs[1].props.onChange({ target: { value: "150" } });
  view = ui.render();
  view.inputs[2].props.onChange({ target: { value: "Correction" } });
  ui.click(ui.render(), "수정 저장");
  await flush();
  assert.equal(ui.calls[0].url, "/api/admin/ledger/transactions/81/manual-edit");
  assert.deepEqual(Object.keys(JSON.parse(ui.calls[0].options.body)), ["title", "amount", "memo", "reason"]);
  assert.equal(JSON.parse(ui.calls[0].options.body).amount, 150);
});

test("manual payable editor hides amount and keeps display-only API", async () => {
  const ui = fixture({ amountEditable: false });
  let view = ui.render();
  assert.doesNotMatch(view.html, /<label>금액/);
  assert.equal(view.inputs.length, 2);
  view.inputs[0].props.onChange({ target: { value: "Changed title" } });
  view = ui.render();
  view.inputs[1].props.onChange({ target: { value: "Correction" } });
  ui.click(ui.render(), "수정 저장");
  await flush();
  assert.equal(ui.calls[0].url, "/api/admin/ledger/transactions/81/display");
  assert.deepEqual(Object.keys(JSON.parse(ui.calls[0].options.body)), ["title", "memo", "reason"]);
});

test("manual amount displays grouping while typing and saves an unformatted number", async () => {
  const initial = fixture({ amountEditable: true, originalAmount: 3000000 });
  assert.equal(initial.render().inputs[1].props.value, "3,000,000");

  const ui = fixture({ amountEditable: true });
  let view = ui.render();
  view.inputs[1].props.onChange({ target: { value: "3x000,000원" } });
  view = ui.render();
  assert.equal(view.inputs[1].props.value, "3,000,000");
  view.inputs[2].props.onChange({ target: { value: "Correction" } });
  ui.click(ui.render(), "수정 저장");
  await flush();
  assert.equal(ui.calls[0].url, "/api/admin/ledger/transactions/81/manual-edit");
  assert.equal(JSON.parse(ui.calls[0].options.body).amount, 3000000);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fillDraft(ui, amountEditable = false) {
  let view = ui.render();
  view.inputs[0].props.onChange({ target: { value: "Changed" } });
  view = ui.render();
  view.inputs[amountEditable ? 2 : 1].props.onChange({ target: { value: "Correction" } });
  return ui.render();
}

test("manual same-render double click posts once, shows loading and waits for refresh before closing editor", async () => {
  const response = deferred(), refresh = deferred();
  const ui = fixture({ response: response.promise, refresh: () => refresh.promise });
  const view = fillDraft(ui), button = view.buttons.find(item => item.props.children === "수정 저장");
  button.props.onClick(); button.props.onClick();
  assert.equal(ui.calls.length, 1);
  const saving = ui.render();
  assert.match(saving.html, /저장 중…/);
  assert.ok(saving.buttons.find(item => item.props.children === "저장 중…").props.disabled);
  assert.ok(saving.inputs.every(item => item.props.disabled));
  response.resolve({ ok: true, body: { result: { status: "updated" } } }); await flush();
  assert.equal(ui.events.closed, 0);
  assert.match(ui.render().html, /저장 중…/);
  assert.equal(ui.events.financial, false);
  refresh.resolve(); await flush();
  assert.equal(ui.events.closed, 1);
  assert.deepEqual(ui.events.saving, [true, false]);
});

test("manual unmount after month/selection change cannot refresh or close a replacement detail", async () => {
  const response = deferred(), ui = fixture({ response: response.promise });
  ui.click(fillDraft(ui), "수정 저장"); ui.unmount();
  response.resolve({ ok: true, body: { result: { status: "updated" } } }); await flush();
  assert.deepEqual(ui.events.refreshed, []);
  assert.equal(ui.events.closed, 0);
  assert.deepEqual(ui.events.saving, [true]);
});

test("manual committed save with refresh failure preserves inputs and distinguishes refresh from save failure in KO/VI", async () => {
  for (const lang of ["ko", "vi"]) {
    const ui = fixture({ lang, refresh: async () => { throw Error("LEDGER_REFRESH_FAILED"); } });
    ui.click(fillDraft(ui), lang === "ko" ? "수정 저장" : "Lưu sửa đổi"); await flush();
    const view = ui.render();
    assert.ok(view.html.includes(lang === "ko" ? "저장했지만 화면을 갱신하지 못했습니다" : "Đã lưu nhưng không thể tải lại màn hình"));
    assert.equal(view.inputs[0].props.value, "Changed");
    assert.equal(ui.events.closed, 0);
  }
});
