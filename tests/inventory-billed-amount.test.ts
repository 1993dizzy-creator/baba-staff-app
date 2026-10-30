import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
// @ts-expect-error Node strip-types uses explicit TypeScript extensions.
import {AUTO_BILLED_AMOUNT,billedAmountRequest,calculatePurchaseAmount,editBilledAmountDraft,effectiveBilledAmount,manualBilledDraft,parseBilledAmountRequest,resolveBilledAmount} from '../lib/inventory/billed-amount.ts';
// @ts-expect-error Node strip-types uses explicit TypeScript extensions.
import {buildPurchaseCases,type PurchaseCaseLog} from '../lib/inventory/purchase-cases.ts';

test('orange: 3.57 x 85,000 = 303,450; manual 303,000 shows -450 and is sent as manual',()=>{
 const calculated=calculatePurchaseAmount(3.57,85000);assert.equal(calculated,303450);
 const auto=resolveBilledAmount(AUTO_BILLED_AMOUNT,calculated);
 assert.deepEqual({billed:auto.billed,difference:auto.difference,valid:auto.valid},{billed:303450,difference:0,valid:true});
 const manual=editBilledAmountDraft('303,000');assert.deepEqual(manual,{mode:'manual',manualText:'303,000'});
 const r=resolveBilledAmount(manual,calculated);assert.equal(r.billed,303000);assert.equal(r.difference,-450);assert.equal(r.valid,true);
 assert.deepEqual(billedAmountRequest(manual),{mode:'manual',amount:303000});
});

test('auto follows quantity/price; manual is kept through changes until 자동계산 복원',()=>{
 let draft=AUTO_BILLED_AMOUNT;
 assert.equal(resolveBilledAmount(draft,calculatePurchaseAmount(2,85000)).billed,170000);
 assert.equal(resolveBilledAmount(draft,calculatePurchaseAmount(3,85000)).billed,255000);
 draft=editBilledAmountDraft('250000');
 for(const quantity of [3,4,0.5])assert.equal(resolveBilledAmount(draft,calculatePurchaseAmount(quantity,85000)).billed,250000);
 // Typing the calculated value itself is still manual.
 const same=editBilledAmountDraft('255,000');assert.equal(same.mode,'manual');assert.deepEqual(billedAmountRequest(same),{mode:'manual',amount:255000});
 assert.deepEqual(billedAmountRequest(AUTO_BILLED_AMOUNT),{mode:'auto'});
 assert.deepEqual(manualBilledDraft('303000.000'),{mode:'manual',manualText:'303,000'});assert.deepEqual(manualBilledDraft(null),AUTO_BILLED_AMOUNT);
});

test('decimal quantity uses the projector rounding; manual needs a positive amount and a calculated amount',()=>{
 assert.equal(calculatePurchaseAmount(0.333,3001),999.333);assert.equal(calculatePurchaseAmount(0,85000),0);
 assert.equal(calculatePurchaseAmount(1,0),null);assert.equal(calculatePurchaseAmount(null,85000),null);assert.equal(calculatePurchaseAmount(-1,85000),null);
 assert.equal(resolveBilledAmount(editBilledAmountDraft(''),303450).valid,false);
 assert.equal(resolveBilledAmount(editBilledAmountDraft('0'),303450).valid,false);
 assert.equal(resolveBilledAmount(editBilledAmountDraft('5'),null).valid,false);
 assert.equal(resolveBilledAmount(editBilledAmountDraft('5'),0).valid,false);
 assert.equal(billedAmountRequest(editBilledAmountDraft('')),null);
});

test('server parse: undefined for older clients, strict manual/auto shapes',()=>{
 assert.equal(parseBilledAmountRequest(undefined),undefined);assert.equal(parseBilledAmountRequest(null),undefined);
 assert.deepEqual(parseBilledAmountRequest({mode:'auto'}),{mode:'auto'});
 assert.deepEqual(parseBilledAmountRequest({mode:'manual',amount:303000}),{mode:'manual',amount:303000});
 assert.deepEqual(parseBilledAmountRequest({mode:'manual',amount:999.333}),{mode:'manual',amount:999.333});
 for(const value of [{mode:'auto',amount:1},{mode:'manual'},{mode:'manual',amount:0},{mode:'manual',amount:-5},{mode:'manual',amount:'303000'},
  {mode:'manual',amount:1.0001},{mode:'manual',amount:1e13},{mode:'manual',amount:Number.NaN},{mode:'x'},[],'auto'])
  assert.equal(parseBilledAmountRequest(value),'invalid',JSON.stringify(value));
});

test('family effective amount: latest explicit mode wins; legacy logs are automatic',()=>{
 assert.deepEqual(effectiveBilledAmount([{id:1}],3.57,85000),{mode:'auto',calculated:303450,billed:303450,difference:0});
 assert.deepEqual(effectiveBilledAmount([{id:1},{id:2,billed_amount_mode:'manual',billed_amount:'303000.000'}],3.57,85000),
  {mode:'manual',calculated:303450,billed:303000,difference:-450});
 assert.equal(effectiveBilledAmount([{id:1},{id:3,billed_amount_mode:'auto'},{id:2,billed_amount_mode:'manual',billed_amount:1}],3.57,85000).mode,'auto');
 assert.equal(effectiveBilledAmount([{id:1,billed_amount_mode:'manual',billed_amount:5},{id:2}],0,85000).billed,0);
});

test('repair case completion compares the booked amount with the effective billed amount',()=>{
 const log=(id:number,delta:number,root:number|null,extra:Partial<PurchaseCaseLog>={}):PurchaseCaseLog=>({id,item_id:1,item_name:'Orange',business_date:'2026-10-27',
  created_at:`2026-10-27T03:0${id-100}:00Z`,change_quantity:delta,new_purchase_price:85000,new_supplier:'Chợ',correction_of_inventory_log_id:root,reason:'purchase',unit:'kg',...extra});
 const logs=[log(100,3,null),log(101,0.57,100,{billed_amount_mode:'manual',billed_amount:303000})];
 const snapshot=(amount:number)=>({change_quantity:3.57,purchase_price:85000,purchase_amount:amount,supplier:'Chợ',inventory_correction_log_ids:[101]});
 const issues=[{inventoryLogId:101,status:'review_required',code:'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED',itemName:'Orange',businessDate:'2026-10-27',quantityDelta:0.57,amountDelta:0,originalQuantity:null}];
 const cases=(amount:number)=>buildPurchaseCases({issues,logs,candidates:[{id:100,source_key:'inventory-log:100',status:'confirmed',resolved_transaction_id:9,proposed_amount:amount,source_snapshot:snapshot(amount)}],
  transactions:[{id:9,amount,status:'confirmed'}]});
 assert.equal(cases(303000).length,0,'booked at the billed amount = complete');
 assert.equal(cases(303450).length,1,'booked at quantity x price while billed is manual = still open');
});

test('API and screens send the billed amount on every receipt path; corrections never carry manual',()=>{
 const route=readFileSync('app/api/inventory/items/route.ts','utf8');
 assert.equal(route.match(/parseBilledAmountRequest\(body\.purchaseBilledAmount\)/g)?.length,2,'POST and PATCH');
 assert.match(route,/billedAmountColumns\(billedRequest\)/);
 assert.match(route,/A billed amount belongs to a new receipt/);
 assert.match(route,/purchase_billed_amount_edit_required/);
 assert.match(route,/saved\.ledgerSync \?\?/);
 for(const file of ['components/inventory/InventoryPageContent.tsx','components/inventory/InventoryItemEditor.tsx','app/(protected)/inventory/snapshots/page.tsx']){
  const source=readFileSync(file,'utf8');assert.match(source,/<BilledAmountField/,file);assert.match(source,/purchaseBilledAmount/,file);
 }
 // Quick save multiplies the stock increase, never the final stock.
 const page=readFileSync('components/inventory/InventoryPageContent.tsx','utf8');
 assert.match(page,/calculatePurchaseAmount\(roundDecimal\(nextQty - currentQty\), nextPurchasePrice\)/);
 assert.match(page,/calculatePurchaseAmount\(changeQty, parsePrice\(quickPurchasePrice\)\)/);
});
