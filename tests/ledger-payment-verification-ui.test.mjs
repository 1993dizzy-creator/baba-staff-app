import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const path = 'app/(protected)/admin/ledger/payables/PaymentVerificationSection.tsx';
const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const mod = { exports: {} };
new Function('require', 'module', 'exports', code)(name => ({
  react: React,
  'react/jsx-runtime': jsxRuntime,
  '@/lib/common/business-time': { getBusinessDate: () => '2026-09-21' },
  '@/lib/styles/ui': { ui: { card: {}, input: {}, button: {} } },
})[name], mod, mod.exports);

function fixture(vi) {
  return renderToStaticMarkup(React.createElement(mod.exports.default, {
    vi, accounts: [], onPaid: async () => {},
    verification: { totalPending: 1_900_000, pendingCount: 1, items: [{
      payableId: 8, partyId: 10, businessDate: '2026-08-29', itemName: '켄트 담배', itemNameVi: 'Thuốc Kent', supplierName: 'Chợ',
      quantity: 50, unitPrice: 38_000, amount: 1_900_000, paidAmount: 0, remainingAmount: 1_900_000,
      appPaymentStatus: 'unconfirmed', paymentDate: null,
    }] },
  }));
}

test('Korean verification card exposes receipt and payment facts without internal ID', () => {
  const html = fixture(false);
  for (const label of ['기타 · 결제 미확인', '켄트 담배', '공급처', '수량', '단가', '입고금액', 'APP상 결제상태', '결제 미확인']) assert.match(html, new RegExp(label));
  assert.match(html, /1\.900\.000 ₫/);
  assert.doesNotMatch(html, /payableId|#8/);
});

test('Vietnamese verification card uses local text and item name', () => {
  const html = fixture(true);
  for (const label of ['Khác · Chưa xác minh thanh toán', 'Thuốc Kent', 'Nhà cung cấp', 'Số lượng', 'Đơn giá', 'Giá trị nhập', 'Trạng thái trong ứng dụng']) assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, /payableId|#8/);
});
