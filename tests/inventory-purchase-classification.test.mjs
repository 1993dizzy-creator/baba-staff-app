import assert from 'node:assert/strict';
import test from 'node:test';
import {analyzeDailyEffectivePurchases} from '../lib/inventory/daily-effective-purchases.ts';
import {inventoryReasonChangeIssue,inventoryPurchaseErrorMessage} from '../lib/inventory/reasons.ts';
const root={id:1,item_id:314,reason:'purchase',change_quantity:1.36,correction_of_inventory_log_id:null,new_supplier:'QA',new_purchase_price:30000};
const correction=(id,qty,overrides={})=>({...root,id,change_quantity:qty,correction_of_inventory_log_id:1,...overrides});
test('51 unlinked negative audit rows cannot offset a valid receipt or mutate historical data',()=>{
 const logs=[root,...Array.from({length:51},(_,i)=>({...root,id:100+i,change_quantity:-4.52}))],before=JSON.stringify(logs);
 const result=analyzeDailyEffectivePurchases(logs,[]);assert.equal(result.purchases.filter(r=>Number(r.change_quantity)>0).length,1);assert.equal(result.purchases.find(r=>r.id===1).change_quantity,1.36);assert.equal(result.diagnostics.length,51);assert.ok(result.diagnostics.every(r=>r.code==='unlinked_nonpositive_purchase'));assert.equal(JSON.stringify(logs),before);
});
test('explicit linked partial corrections are applied once and ordered independently of response order',()=>{
 const c=[correction(3,-0.06,{new_supplier:'latest'}),correction(2,-0.04,{new_supplier:'earlier'}),correction(3,-0.06,{new_supplier:'latest'})];
 const result=analyzeDailyEffectivePurchases([root],c);assert.equal(result.purchases[0].change_quantity,1.26);assert.equal(result.purchases[0].new_supplier,'latest');assert.deepEqual(result.diagnostics,[]);
});
test('full cancellation remains excluded while its source and processing evidence remain accessible',()=>{
 const result=analyzeDailyEffectivePurchases([root],[correction(2,-1.36)]);assert.deepEqual(result.purchases,[]);assert.equal(result.diagnostics[0].code,'fully_cancelled');assert.deepEqual(result.diagnostics[0].logIds,[1,2]);assert.equal(result.diagnostics[0].log.change_quantity,1.36);
});
test('overcorrection, wrong item and invalid correction quantities fail closed for effective receipt totals',()=>{
 for(const c of [correction(2,-2),correction(2,-0.1,{item_id:999}),correction(2,null),correction(2,'invalid')]){const result=analyzeDailyEffectivePurchases([root],[c]);assert.deepEqual(result.purchases,[]);assert.equal(result.diagnostics[0].code,'invalid_correction_family');}
});
test('cross-date linked corrections remain visible without counting a separate new purchase',()=>{
 const c=correction(2,-0.1);const result=analyzeDailyEffectivePurchases([c],[]);assert.deepEqual(result.purchases,[]);assert.equal(result.diagnostics[0].code,'linked_correction');assert.equal(result.diagnostics[0].rootLogId,1);
});
test('classification guard protects financial boundaries while preserving unrelated labels and linked negative receipts',()=>{
 assert.equal(inventoryReasonChangeIssue({...root,change_quantity:-4.52,reason:'stock_check'},'purchase'),'inventory_nonpositive_purchase_classification');
 assert.equal(inventoryReasonChangeIssue(root,'stock_check'),'inventory_purchase_reclassification_requires_review');
 assert.equal(inventoryReasonChangeIssue({...root,reason:'stock_check'},'purchase'),'inventory_purchase_reclassification_requires_review');
 assert.equal(inventoryReasonChangeIssue(correction(2,-0.1),'purchase'),null);
 assert.equal(inventoryReasonChangeIssue(correction(2,-0.1),'other'),'inventory_purchase_correction_log_protected');
 assert.equal(inventoryReasonChangeIssue({...root,reason:'stock_check'},'other'),null);
 for(const lang of ['ko','vi'])for(const code of ['inventory_nonpositive_purchase_classification','inventory_purchase_reclassification_requires_review','purchase_correction_later_stock_check','purchase_correction_exceeds_purchase'])assert.ok(inventoryPurchaseErrorMessage(code,lang));
});

test('multiple receipt alert uses the exact confirmed count and required KO/VI wording',()=>{
 const info={candidateCount:3,candidateCountExact:true,blockReason:'multiple_candidates'};
 assert.equal(inventoryPurchaseErrorMessage('purchase_correction_ambiguous','ko',info),'오늘 이 품목의 정정 가능한 입고 기록이 3건 있습니다. 어느 입고를 정정해야 할지 자동으로 확인할 수 없어 저장하지 않았습니다. 관리자에게 문의해 주세요.');
 assert.equal(inventoryPurchaseErrorMessage('purchase_correction_ambiguous','vi',info),'Hôm nay có 3 phiếu nhập phù hợp với mặt hàng này. Hệ thống không thể xác định phiếu cần điều chỉnh nên chưa lưu. Vui lòng liên hệ quản lý.');
 for(const details of [{candidateCount:3},{candidateCount:3,candidateCountExact:false},{candidateCount:1,candidateCountExact:true},{candidateCount:-1,candidateCountExact:true},{candidateCount:1.5,candidateCountExact:true},{candidateCount:NaN,candidateCountExact:true}])for(const lang of ['ko','vi'])assert.doesNotMatch(inventoryPurchaseErrorMessage('purchase_correction_ambiguous',lang,details),/3건|3 phiếu|NaN|-1|1\.5/);
});
test('major guard messages use server codes/details and never infer a paid or closed reason',()=>{
 for(const lang of ['ko','vi']){
  const payment=inventoryPurchaseErrorMessage('purchase_correction_review_required',lang,{blockReason:'payment_completed'}),closed=inventoryPurchaseErrorMessage('purchase_correction_review_required',lang,{blockReason:'month_closed'});
  assert.notEqual(payment,closed);assert.match(payment,lang==='ko'?/지급 완료/:/đã được thanh toán/);assert.match(closed,lang==='ko'?/마감/:/đã chốt/);
  for(const code of ['QUANTITY_CONFLICT','quantity_conflict','INVENTORY_CONFLICT','inventory_conflict','purchase_correction_root_not_found','purchase_correction_exceeds_purchase','purchase_correction_later_stock_check','invalid_purchase_reference'])assert.ok(inventoryPurchaseErrorMessage(code,lang));
  assert.equal(inventoryPurchaseErrorMessage('purchase_correction_review_required',lang,{blockReason:'unknown'}),inventoryPurchaseErrorMessage('purchase_correction_review_required',lang));
  assert.equal(inventoryPurchaseErrorMessage('purchase_correction_root_not_found',lang,{blockReason:'payment_completed'}),inventoryPurchaseErrorMessage('purchase_correction_root_not_found',lang));
  assert.equal(inventoryPurchaseErrorMessage('unknown',lang,{blockReason:'payment_completed'}),null);
 }
});
