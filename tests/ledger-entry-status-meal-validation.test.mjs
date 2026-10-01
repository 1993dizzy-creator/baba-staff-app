import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const read = path => readFileSync(path, 'utf8');
function loadCode(source, deps = {}) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require', 'module', 'exports', code)(name => name in deps ? deps[name] : require(name), testModule, testModule.exports);
  return testModule.exports;
}
const { entryStatusReason } = loadCode(read('lib/ledger/entry-status-reason.ts'));
const { buildLedgerEntries } = require('../lib/ledger/entries.ts');
for (const supplier of ['Minh Thắm', 'khác']) {
  test(`pending inventory uses actual supplier ${supplier} in both languages`, () => {
    const [entry] = buildLedgerEntries([], [{ id: 71, business_date: '2026-09-30', proposed_amount: 100, source_snapshot: { supplier, item_name: 'Item' }, proposed_party_id: null }], new Map());
    assert.equal(entry.title, supplier);
    assert.equal(entry.status, 'pending');
    assert.equal(entryStatusReason(entry, 'ko'), `거래처 확인 필요 · 입고 거래처 '${supplier}'이(가) 거래처와 연결되지 않았습니다. 실제 거래처와 결제방식을 확인해주세요.`);
    assert.equal(entryStatusReason(entry, 'vi'), `Cần xác nhận nhà cung cấp · Nhà cung cấp nhập hàng '${supplier}' chưa được liên kết với đối tác. Vui lòng xác nhận nhà cung cấp thực tế và phương thức thanh toán.`);
    if (supplier !== 'khác') {
      assert.ok(!entryStatusReason(entry, 'ko').includes('khác'));
      assert.ok(!entryStatusReason(entry, 'vi').includes('khác'));
    }
  });
}
const page = read('app/(protected)/admin/ledger/entries/page.tsx');
const ast = ts.createSourceFile('page.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
  let found;
  function visit(node) { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); }
  visit(ast);
  assert.ok(found);
  return found;
}
const editor = find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'MealAdjustmentEditor');
const element = find(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'MealAdjustmentEditor');
const handler = element.attributes.properties.find(node => node.name?.getText(ast) === 'onSave').initializer.expression;
const deps = {
  react: React,
  'react/jsx-runtime': require('react/jsx-runtime'),
  '@/components/bar/keeping/KeepingUi': { BarField: ({ label, children }) => React.createElement('label', null, label, children({ id: label })), keepingInputStyle: {}, primaryButtonStyle: {} },
  '@/lib/ledger/manual-entry-amount': {},
  './entries.module.css': { default: new Proxy({}, { get: (_, key) => String(key) }) },
};
const { LedgerEditShell } = loadCode(read('app/(protected)/admin/ledger/entries/ManualDisplayEditor.tsx'), deps);
function compileHandler(bindings) {
  const code = ts.transpileModule('const save = ' + handler.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), code + ';return save;')(...Object.values(bindings));
}
for (const lang of ['ko', 'vi']) {
  for (const date of ['2026-09-29', '2026-09-30']) {
    test(`meal reason validation on save is inline and blocks requests: ${lang} ${date}`, async () => {
      const draft = { finalAmount: '330000', reason: '   ' };
      let error = '';
      const requests = [];
      const closed = [];
      const refreshed = [];
      const save = compileHandler({ mealDraft: draft, entry: { transactionId: 91, businessDate: date }, vi: lang === 'vi',
        setMealError: value => { error = value; }, setMealNotice() {}, setEditSaving() {}, setMealDraft: value => closed.push(value),
        onConfirmedEdited: async id => refreshed.push(id),
        fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({}) }; },
      });
      // Bind the real editor to the real shared shell, then click its rendered save button.
      const code = ts.transpileModule(editor.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
      const renderEditor = new Function('exports', 'require', 'LedgerEditShell', 'BarField', 'formatLedgerDecimalAmount', 'sanitizeLedgerDecimalAmount', 'keepingInputStyle', 'styles', code + ';return MealAdjustmentEditor;')(
        {}, require, LedgerEditShell, deps['@/components/bar/keeping/KeepingUi'].BarField, value => value, value => value, {}, {},
      );
      const props = { lang, draft, setDraft() {}, saving: false, error, onSave: save };
      const shell = renderEditor(props);
      const tree = shell.type(shell.props);
      const button = React.Children.toArray(tree.props.children).find(child => child.type === 'button');
      assert.equal(button.props.disabled, false);
      button.props.onClick();
      assert.equal(error, lang === 'vi' ? 'Vui lòng nhập lý do chỉnh sửa.' : '수정 사유를 입력해주세요.');
      assert.equal(requests.length, 0);
      const html = renderToStaticMarkup(renderEditor({ ...props, error }));
      assert.ok(html.includes('role="alert"'));
      assert.ok(html.includes(error));
      draft.reason = 'Additional employee';
      await save();
      assert.deepEqual(requests, [{ url: '/api/admin/ledger/transactions/91/meal-adjust', body: { finalAmount: '330000', reason: 'Additional employee' } }]);
      assert.equal(error, '');
      assert.deepEqual(closed, [null]);
      assert.deepEqual(refreshed, [91]);
    });
  }
}
