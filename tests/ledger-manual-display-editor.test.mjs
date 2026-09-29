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
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ lang = "ko", closed = false, response = { ok: true, body: { status: "updated" } } } = {}) {
  const values = [];
  const calls = [];
  const events = { refreshed: [], closed: 0, saving: [] };
  let cursor = 0;
  const react = {
    ...React,
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
  };
  const testModule = { exports: {} };
  new Function("require", "module", "exports", "fetch", code)(
    name => deps[name], testModule, testModule.exports,
    async (url, options) => {
      calls.push({ url, options });
      return { ok: response.ok, async json() { return response.body; } };
    },
  );
  const props = {
    lang, transactionId: 81, originalTitle: "기존 제목", originalMemo: "기존 메모", closed,
    onSavingChange(value) { events.saving.push(value); },
    async onConfirmedEdited(id) { events.refreshed.push(id); },
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
    cursor = 0;
    const found = { buttons: [], inputs: [], textareas: [] };
    const tree = expand(testModule.exports.default(props), found);
    return { ...found, html: renderToStaticMarkup(tree) };
  }
  const click = (view, label) => {
    const button = view.buttons.find(item => item.props.children === label);
    assert.ok(button, "Button missing: " + label);
    assert.equal(button.props.disabled, false, "Button disabled: " + label);
    button.props.onClick();
  };
  return { render, click, calls, events };
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

