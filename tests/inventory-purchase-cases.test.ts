import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node strip-types uses explicit TypeScript extensions.
import {buildPurchaseCases,type PurchaseCaseLog,type PurchaseCaseIssue,type PurchaseCaseCandidate} from '../lib/inventory/purchase-cases.ts';
// These IDs and relationships are the user-provided 10/11 scenario. Quantities,
// prices, timestamps and actor names below are synthetic, not production facts.
const log=(id:number,item:number,name:string,minute:number,delta:number,root:number|null=null,reason='purchase'):PurchaseCaseLog=>({id,item_id:item,item_name:name,item_name_vi:name==='토닉워터'?'Tonic':'Ginger ale',business_date:'2026-10-11',created_at:`2026-10-11T03:${String(minute).padStart(2,'0')}:00Z`,change_quantity:delta,new_purchase_price:20000,new_supplier:'QA supplier',purchase_supplier_partner_id:10,correction_of_inventory_log_id:root,reason,unit:'can',actor_name:'QA actor',source:'edit_form'});
export const scenario=[log(12971,309,'토닉워터',1,10),log(12982,309,'토닉워터',10,-2,null,'stock_check'),log(13000,309,'토닉워터',20,-10,12971),log(13001,309,'토닉워터',21,12),log(12972,566,'진저에일',2,10),log(12998,566,'진저에일',18,-10,12972),log(12983,477,'진저에일',11,2,null,'stock_check'),log(13002,477,'진저에일',22,8)];
const issue=(row:PurchaseCaseLog):PurchaseCaseIssue=>({inventoryLogId:row.id,status:'review_required',code:'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED',itemName:row.item_name!,businessDate:row.business_date,quantityDelta:row.change_quantity,amountDelta:row.change_quantity*20000,originalQuantity:null,createdAt:row.created_at});
const make=(logs=scenario)=>buildPurchaseCases({logs,issues:logs.filter(row=>row.reason==='purchase').map(issue)});
const booked=(id:number,ids:number[],quantity:number,status='confirmed'):PurchaseCaseCandidate=>({id,source_key:`inventory-log:${id}`,status,dismissal_reason:status==='dismissed'?'Inventory purchase fully cancelled':null,resolved_transaction_id:status==='dismissed'?null:id,proposed_amount:quantity*20000,source_snapshot:{change_quantity:quantity,purchase_price:20000,purchase_amount:quantity*20000,supplier:'QA supplier',purchase_supplier_partner_id:10,inventory_correction_log_ids:ids}});

test('10/11 cases group explicit cancellations once, keep independent receipts and same-name item IDs separate',()=>{
 const before=JSON.stringify(scenario),cases=make();assert.equal(cases.length,4);assert.deepEqual(cases.map(row=>row.rootInventoryLogId).sort(),[12971,12972,13001,13002]);
 const tonic=cases.find(row=>row.rootInventoryLogId===12971)!;assert.equal(tonic.quantityDelta,-10);assert.equal(tonic.effectiveQuantity,0);assert.deepEqual(tonic.relatedLogIds,[12971,13000]);assert.deepEqual(tonic.timeline.map(row=>row.logId),[12971,12982,13000]);assert.equal(tonic.inventoryLogId,13000);
 const o6=cases.find(row=>row.rootInventoryLogId===13002)!;assert.deepEqual(o6.timeline.map(row=>row.logId),[12983,13002]);assert.equal(o6.effectiveQuantity,8);assert.equal(JSON.stringify(scenario),before);
});
test('already handled 10/11 cancellations disappear without replaying a mutation or changing inactive #566',()=>{
 const input={logs:scenario,issues:scenario.filter(row=>row.reason==='purchase').map(issue),candidates:[booked(12971,[13000],0,'dismissed'),booked(12972,[12998],0,'dismissed')]};
 const before=JSON.stringify(input),cases=buildPurchaseCases(input);assert.deepEqual(cases.map(row=>row.rootInventoryLogId),[13001,13002]);assert.equal(JSON.stringify(input),before);
});
test('a matching rebook removes stale root/child warnings; source drift or a manual amount edit stays visible',()=>{
 const logs=[log(10,309,'토닉워터',1,10),log(20,309,'토닉워터',2,-1,10)];
 const candidates=[booked(10,[20],9)];const transactions=[{id:10,amount:180000,status:'confirmed'}];const input={logs,issues:logs.map(issue),candidates,transactions};
 assert.deepEqual(buildPurchaseCases(input),[]);
 assert.equal(buildPurchaseCases({...input,transactions:[{id:10,amount:179000,status:'confirmed'}]}).length,1);
 assert.equal(buildPurchaseCases({...input,logs:[...logs,log(30,309,'토닉워터',3,-1,10)],issues:[...input.issues,issue(log(30,309,'토닉워터',3,-1,10))]}).length,1);
 assert.equal(buildPurchaseCases({...input,candidates:[{...candidates[0],source_snapshot:{...candidates[0].source_snapshot,supplier:'Other'}}]}).length,1);
});
test('equal amount does not conceal an uncovered zero-quantity correction',()=>{
 const logs=[log(10,309,'토닉워터',1,10),log(20,309,'토닉워터',2,0,10)];
 assert.equal(buildPurchaseCases({logs,issues:logs.map(issue),candidates:[booked(10,[],10)],transactions:[{id:10,amount:200000,status:'confirmed'}]}).length,1);
});
test('unknown or mismatched explicit root stays separate and is never inferred from an equal name',()=>{
 const logs=[log(10,566,'진저에일',1,10),log(20,477,'진저에일',2,-1,10),log(30,477,'진저에일',3,-1)];
 const cases=make(logs);assert.equal(cases.length,3);assert.equal(cases.find(row=>row.inventoryLogId===20)!.rootInventoryLogId,null);assert.equal(cases.find(row=>row.inventoryLogId===30)!.rootInventoryLogId,null);
});
test('history merges inventory, stock checks and ledger audit events in chronological order with actors',()=>{
 const cases=buildPurchaseCases({logs:scenario,issues:[issue(scenario[2])],actors:new Map([[1,'QA reviewer']]),audits:[{id:5,entity_type:'inventory_log',entity_id:13000,action:'inventory_source_projected',created_at:'2026-10-11T03:20:01Z',actor_user_id:1,after_snapshot:{amount:0,transactionId:40}}]});
 assert.deepEqual(cases[0].timeline.map(row=>row.kind),['purchase','stock_check','correction','ledger']);assert.equal(cases[0].timeline.at(-1)!.actor,'QA reviewer');assert.equal(cases[0].timeline.at(-1)!.amount,0);assert.equal(cases[0].timeline.at(-1)!.transactionId,40);
});