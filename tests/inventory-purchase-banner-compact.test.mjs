import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {purchaseRepairError} from '../lib/inventory/purchase-repair-contract.ts';

// Compact '장부 확인 필요' banner: one-line meta, 12px item name, header reason line only when useful.
function load(path,deps){
 const target={exports:{}};
 const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new Function('require','module','exports',code)(name=>{assert.ok(name in deps,'unexpected '+name);return deps[name];},target,target.exports);
 return target.exports;
}
const display=load('lib/inventory/purchase-case-display.ts',{'./purchase-repair-contract':{purchaseRepairError}});
const css=new Proxy({},{get:(_,key)=>String(key)});
const Summary=load('components/ledger/InventoryPurchaseCaseSummary.tsx',{
 react:React,'react/jsx-runtime':jsxRuntime,'./InventoryPurchaseCaseSummary.module.css':{default:css},
 '@/lib/inventory/purchase-case-display':display,'./InventoryPurchaseCaseDetails':{default:()=>React.createElement('details',{'data-testid':'purchase-case-details'})},
}).default;
const supplierOnly={safe:false,code:'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED',inventoryLogId:12581,businessDate:'2026-10-20',quantity:3,effectiveQuantity:3,quantityDelta:0,unit:'Kg',price:100000,
 supplier:'Ok Mart',newSupplier:'K-Market',oldAmount:300000,newAmount:300000,delta:0,
 supplierChange:{valid:true,requiresConfirmation:true,beforeSupplier:'Ok Mart',afterSupplier:'K-Market',beforePartnerId:'1',afterPartnerId:'2',confirmationFingerprint:'a'.repeat(64)}};
const issue=(candidate,extra={})=>({inventoryLogId:19101,rootInventoryLogId:12581,code:'PURCHASE_CORRECTION_REFERENCE_REQUIRED',itemName:'QA 버터',itemNameVi:'QA Bơ',
 supplier:'Ok Mart',businessDate:'2026-10-20',quantityDelta:0,amountDelta:0,originalQuantity:3,resolution:{candidates:[candidate],recommended:false},...extra});

test('supplier-only row reads "10/20 · Ok Mart → K-Market" on one meta line, no separate supplier/reason blocks',()=>{
 for(const vi of [false,true]){
  const html=renderToStaticMarkup(React.createElement(Summary,{issue:issue(supplierOnly),vi}));
  assert.match(html,/<div class="heading"><strong>QA (버터|Bơ)<\/strong><span class="badge">/);
  assert.match(html,/<time dateTime="2026-10-20">10\/20<\/time> · <span class="changeValue" data-testid="purchase-case-supplier-change">Ok Mart → <strong class="changedSupplier">K-Market<\/strong><\/span>/);
  assert.equal((html.match(/K-Market/g)||[]).length,1,'the new supplier is not repeated');
  assert.doesNotMatch(html,/class="supplier"|class="reason"|class="changes"/);
  assert.match(html,/data-testid="purchase-case-details"/,'details stay folded below');
 }
});
test('amount and quantity changes follow on the same meta line with the delta emphasised',()=>{
 const html=renderToStaticMarkup(React.createElement(Summary,{issue:issue({...supplierOnly,newAmount:330000,delta:30000,quantityDelta:0.3}),vi:false}));
 assert.match(html,/Ok Mart → <strong class="changedSupplier">K-Market<\/strong><\/span> · <span class="changeValue">금액: 300,000₫ → 330,000₫<strong class="amountDelta"> \(\+30,000₫\)<\/strong><\/span> · <span class="changeValue">수량: 3 → 3.3Kg \(\+0.3\)/);
 assert.match(html,/복합 변경 확인 필요/);
});
test('no supplier change shows the current supplier; missing preview keeps the explanation',()=>{
 const amountOnly={...supplierOnly,code:'READY',safe:true,newSupplier:'Ok Mart',supplierChange:undefined,newAmount:330000,delta:30000};
 assert.match(renderToStaticMarkup(React.createElement(Summary,{issue:issue(amountOnly),vi:false})),/10\/20<\/time> · <span>Ok Mart<\/span> · <span class="changeValue">금액/);
 const missing=renderToStaticMarkup(React.createElement(Summary,{issue:issue(supplierOnly,{resolution:{candidates:[],recommended:false}}),vi:true}));
 assert.match(missing,/Chưa đủ dữ liệu xác định chênh lệch/);
});
test('header reason line: none for one item; overlap note only when one item has several reasons',()=>{
 const single=issue(supplierOnly);
 const amount=issue({...supplierOnly,code:'READY',safe:true,newSupplier:'Ok Mart',supplierChange:undefined,newAmount:330000,delta:30000});
 const compound=issue({...supplierOnly,newAmount:330000,delta:30000});
 for(const vi of [false,true])assert.equal(display.purchaseCaseReasonSummary([single],vi),null);
 assert.equal(display.purchaseCaseReasonSummary([single,amount],false),'사유별: 금액 변경 1건 · 거래처 변경 1건');
 assert.equal(display.purchaseCaseReasonSummary([single,amount],true),'Theo lý do: Đổi số tiền 1 mục · Đổi nhà cung cấp 1 mục');
 assert.equal(display.purchaseCaseReasonSummary([single,compound],false),'사유별(중복 포함): 금액 변경 1건 · 거래처 변경 2건');
 const page=readFileSync('app/(protected)/admin/ledger/entries/page.tsx','utf8');
 assert.doesNotMatch(page,/"사유별\(중복 포함\): "/);assert.match(page,/purchaseCaseReasonSummary\(data\.inventoryProjectionIssues, vi\)/);
});
test('compact styles: 12px item name, tight rows, wrapping quick action, no fixed widths',()=>{
 const summary=readFileSync('components/ledger/InventoryPurchaseCaseSummary.module.css','utf8');
 assert.match(summary,/\.heading strong\{min-width:0;font-size:12px;/);assert.doesNotMatch(summary,/font-size:14px/);
 assert.match(summary,/\.meta\{margin-top:2px;font-size:11px;line-height:1\.45/);
 const resolution=readFileSync('components/ledger/InventoryProjectionResolution.module.css','utf8');
 assert.match(resolution,/\.quick \{ order: 2; flex: 1 0 100%;/);assert.match(resolution,/\.quickButton \{[^}]*white-space: normal; overflow-wrap: anywhere;/);
 const entries=readFileSync('app/(protected)/admin/ledger/entries/entries.module.css','utf8');
 assert.match(entries,/\.projectionWarningRow\{display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px 8px;padding:6px 0;/);
});
