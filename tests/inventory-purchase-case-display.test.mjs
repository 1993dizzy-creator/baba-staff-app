import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {purchaseRepairError} from '../lib/inventory/purchase-repair-contract.ts';
const testModule = {exports:{}};
new Function('require','module','exports',ts.transpileModule(readFileSync('lib/inventory/purchase-case-display.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(()=>({purchaseRepairError}),testModule,testModule.exports);
const {purchaseCaseDisplay,purchaseCaseReasonCounts}=testModule.exports;
const base={inventoryLogId:13085,businessDate:'2026-10-12',quantity:2.2,effectiveQuantity:2.2,quantityDelta:0,price:38000,unit:'Kg',supplier:'Chợ',newSupplier:'Chợ',oldAmount:70400,newAmount:83600,delta:13200,safe:true,code:'READY'};
const issue=c=>({code:'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED',resolution:{candidates:[c],recommended:false}});
test('melon uses recorded preview; hides unchanged quantity',()=>{
 const d=purchaseCaseDisplay(issue(base),false);assert.deepEqual(d.lines,['금액: 70,400₫ → 83,600₫ (+13,200₫)']);assert.equal(d.reason,'금액 변경 확인 필요');
});
test('tonic and tomatoes retain zero-difference supplier confirmations',()=>{
 for(const [supplier,newSupplier,amount] of [['Dabaco','Ok Mart',480000],['Trung Đông','Chợ',50000]]){
  const d=purchaseCaseDisplay(issue({...base,supplier,newSupplier,oldAmount:amount,newAmount:amount,delta:0,safe:false,code:'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED'}),false);
  assert.deepEqual(d.lines,[`거래처: ${supplier} → ${newSupplier}`]);assert.equal(d.reason,'거래처 변경 확인 필요');
 }
});
test('compound changes preserve three fields in two rows, with separate reason counts',()=>{
 const input=issue({...base,quantityDelta:-0.2,newAmount:60000,delta:-10400,newSupplier:'Ok Mart'}),before=JSON.stringify(input);
 for(const vi of [false,true]){const d=purchaseCaseDisplay(input,vi);assert.equal(d.lines.length,2);assert.equal(d.changes.length,3);assert.ok(d.lines.join(' ').includes('2.2 → 2Kg (-0.2)'));assert.ok(d.lines.join(' ').includes('-10,400₫'));assert.ok(d.lines.join(' ').includes('Chợ → Ok Mart'));}
 assert.equal(purchaseCaseReasonCounts([input],false),'금액 변경 1건 · 수량 변경 1건 · 거래처 변경 1건');assert.equal(JSON.stringify(input),before);
});
test('missing, ambiguous and incomplete previews never estimate amounts',()=>{
 for(const candidates of [[],[base,{...base,inventoryLogId:1}],[{...base,oldAmount:null,newAmount:null,delta:null}]]){const d=purchaseCaseDisplay({code:'MONTH_CLOSED',resolution:{candidates,recommended:false}},false);assert.deepEqual(d.lines,[]);assert.ok(d.explanation);}
});
test('zero-change review retains a reason and omits unchanged fields',()=>{
 const d=purchaseCaseDisplay(issue({...base,newAmount:70400,delta:0}),false);assert.deepEqual(d.lines,[]);assert.equal(d.reason,'변경 이력·장부 상태 확인 필요');assert.ok(d.explanation.includes('장부 상태 확인'));
});
test('same supplier label with changed partner identity remains visible',()=>{
 const d=purchaseCaseDisplay(issue({...base,newAmount:70400,delta:0,supplierChange:{valid:true,requiresConfirmation:true,beforeSupplier:'Chợ',afterSupplier:'Chợ',beforePartnerId:'10',afterPartnerId:'15'}}),true);assert.deepEqual(d.lines,['Nhà cung cấp: Chợ (#10) → Chợ (#15)']);
});

test('quantity-only increase hides unchanged money and supplier',()=>{
 const d=purchaseCaseDisplay(issue({...base,quantityDelta:0.3,newAmount:70400,delta:0}),false);assert.deepEqual(d.lines,['수량: 2.2 → 2.5Kg (+0.3)']);assert.equal(d.reason,'수량 변경 확인 필요');
});
