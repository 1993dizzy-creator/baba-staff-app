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

// @ts-expect-error Node strip-types uses explicit TypeScript extensions.
import {buildMonthlyEffectivePurchases} from '../lib/inventory/monthly-effective-purchases.ts';
// @ts-expect-error Node strip-types uses explicit TypeScript extensions.
import {analyzeDailyEffectivePurchases} from '../lib/inventory/daily-effective-purchases.ts';

// Orange receipt #100: 3 kg + linked receipt edits to 3.57 kg; the last edit sets billed 303,000.
const orangeLogs=(billedOnRoot=false)=>{
 const base={item_id:1,item_name:'Orange',item_name_vi:'Cam',part:'kitchen',category:'Fruit',category_vi:'Fruit',unit:'kg',code:'OR',new_supplier:'Chợ',reason:'purchase',business_date:'2026-10-27'};
 const root={...base,id:100,change_quantity:billedOnRoot?3.57:3,new_purchase_price:85000,correction_of_inventory_log_id:null,
  billed_amount:billedOnRoot?303000:null,billed_amount_mode:billedOnRoot?'manual':null};
 const corrections=billedOnRoot?[]:[
  {...base,id:101,change_quantity:0.5,new_purchase_price:85000,correction_of_inventory_log_id:100,billed_amount:null,billed_amount_mode:'auto'},
  {...base,id:102,change_quantity:0.07,new_purchase_price:85000,correction_of_inventory_log_id:100,billed_amount:303000,billed_amount_mode:'manual'},
  {...base,id:103,change_quantity:0,new_purchase_price:85000,correction_of_inventory_log_id:100,billed_amount:303000,billed_amount_mode:'manual'}];
 return {root,corrections};
};

test('daily 일자별재고: one effective row per receipt carries the billed amount once, never the correction history',()=>{
 for(const billedOnRoot of [false,true]){
  const {root,corrections}=orangeLogs(billedOnRoot),other={...root,id:110,change_quantity:2,new_purchase_price:20000,billed_amount:null,billed_amount_mode:null};
  const {purchases}=analyzeDailyEffectivePurchases([root,other],corrections);
  assert.equal(purchases.length,2,'repeated edits are folded into the receipt');
  const orange=purchases.find((row:{id:number})=>row.id===100)!;
  assert.equal(orange.change_quantity,3.57);assert.equal(orange.billed_amount_mode,'manual');assert.equal(Number(orange.billed_amount),303000);
  const auto=purchases.find((row:{id:number})=>row.id===110)!;assert.equal(auto.billed_amount_mode,null,'legacy receipt stays automatic');
 }
 // Restored auto: the latest explicit mode wins and no amount is carried.
 const {root,corrections}=orangeLogs();
 const restored=analyzeDailyEffectivePurchases([root],[...corrections,{...corrections[0],id:104,change_quantity:0,billed_amount:null,billed_amount_mode:'auto'}]).purchases[0];
 assert.equal(restored.billed_amount_mode,'auto');assert.equal(restored.billed_amount,null);
});

test('monthly 월간현황: manual billed replaces quantity x price once per receipt; auto keeps the calculation',()=>{
 const {root,corrections}=orangeLogs();
 const other={...root,id:110,change_quantity:2,new_purchase_price:20000,billed_amount:null,billed_amount_mode:null};
 const purchases=buildMonthlyEffectivePurchases([root,other,...corrections],corrections);
 assert.equal(purchases.length,2);
 const orange=purchases.find((row:{rootLogId:number})=>row.rootLogId===100)!;
 assert.equal(orange.effectiveQuantity,3.57);assert.equal(orange.billedAmount,303000);
 assert.equal(calculatePurchaseAmount(orange.effectiveQuantity,Number(orange.new_purchase_price)),303450,'original calculated amount');
 assert.equal(purchases.find((row:{rootLogId:number})=>row.rootLogId===110)!.billedAmount,null);
 // Manual billed on the original receipt itself (registration / quick save).
 const registered=orangeLogs(true);assert.equal(buildMonthlyEffectivePurchases([registered.root],[])[0].billedAmount,303000);
});

test('screens and monthly route use the effective billed amount for receipt totals only',()=>{
 const page=readFileSync('app/(protected)/inventory/snapshots/page.tsx','utf8');
 assert.match(page,/total_purchase_price: manualReceiptAmount\(log\) \?\?/);
 assert.match(page,/renderLogCard\(entry\.final, footer, highlighted, entry\.cancelled \|\| entry\.invalid \? null : billed\.billed\)/);
 const monthly=readFileSync('app/api/inventory/monthly/route.ts','utf8');
 assert.match(monthly,/const purchaseAmount = log\.billedAmount \?\? calculateInventoryPurchaseAmount/);
 assert.match(monthly,/purchase\.billedAmount\n/);
 assert.equal(monthly.match(/billed_amount_mode/g)?.length,2,'both purchase selects read the billed state');
 // Snapshot batch estimates (stock delta x item price) are a different metric and stay unchanged.
 assert.doesNotMatch(readFileSync('app/api/inventory/snapshot/route.ts','utf8'),/billed/);
});
