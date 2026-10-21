import assert from 'node:assert/strict';import test from 'node:test';
import {loadTs} from './helpers/pos-resolution-auth-harness.mjs';
test('all save paths skip protected receipts independently of is_modified and preserve POS observation',async()=>{
 for(const modified of [false,true]){
  const mutations=[];const rpcs=[];const receipt={id:10,source:'cukcuk',ref_id:'ref-10',business_date:'2026-10-17',ref_date:'2026-10-17T10:00:00Z',created_at:'2026-10-17T10:00:00Z',payment_status:3,is_canceled:false,is_modified:modified,raw_json:{original:true}};
  const db={from(table){const rows=table==='pos_sales_receipts'?[receipt]:table==='pos_sales_receipt_admin_resolutions'?[{receipt_id:10}]:[];const q={select(){return q},eq(){return q},in(){return q},or(){return q},order(){return q},limit(){return q},returns(){return q},range(){return q},insert(v){mutations.push([table,'insert',v]);return q},update(v){mutations.push([table,'update',v]);return q},delete(){mutations.push([table,'delete']);return q},then(resolve){return Promise.resolve({data:rows,error:null}).then(resolve)}};return q},rpc:async(name,args)=>{rpcs.push({name,args});return {data:{},error:null}}};
  const sync=loadTs('lib/pos/cukcuk/sales-receipt-sync.ts',{'@/lib/supabase/server':{supabaseServer:db},'@/lib/sales/admin-resolution-server':{resolutionSchemaReady:()=>true,protectedResolutionRefs:async refs=>new Set(refs)},'@/lib/sales/pending-resolution-policy':loadTs('lib/sales/pending-resolution-policy.ts'),'@/lib/pos/cukcuk/sales-receipt-sync-compare':{stripVolatilePosSyncFields:v=>v}});
  const result=await sync.saveReceipts([{...receipt,payment_status:1,raw_json:{PaymentStatus:1},synced_at:'2026-10-21T07:00:00Z'}]);assert.equal(result.receiptIdMap.get('ref-10'),10);assert.equal(result.updatedCount,0);assert.deepEqual(result.autoEligibleReceiptIds,[]);
  await sync.saveLines([{source:'cukcuk',receipt_id:10,receipt_ref_id:'ref-10',ref_detail_id:'new-pos-line',payment_status:1,quantity:99}]);
  await sync.savePayments([{receipt_id:10,receipt_ref_id:'ref-10',amount:999}],['ref-10']);await sync.markReceiptsInventoryDeductionEligible([10],'2026-10-21T07:00:00Z',[10]);
  assert.deepEqual(mutations,[]);assert.equal(rpcs.length,1);assert.equal(rpcs[0].name,'sales_observe_resolved_receipts_v1');assert.equal(rpcs[0].args.p_observations[0].raw.detail.PaymentStatus,1);
 }
});
test('bounded POS retry isolates API failure and finalizes each lease without source mutations',async()=>{
 const previous=process.env.POS_PENDING_RECHECK_ENABLED;process.env.POS_PENDING_RECHECK_ENABLED='true';try{
  const finished=[];const observed=[];
  const server={rpc:async(name,args)=>{
   if(name==='sales_claim_pending_rechecks_v1')return {data:[1,2,3].map(id=>({receiptId:id,refId:String(id),leaseId:'fixture-'+id})),error:null};
   if(name==='sales_finish_pending_recheck_v1'){finished.push(args);return {data:true,error:null}}
   if(name==='sales_observe_resolved_receipts_v1'){observed.push(args);return {data:{},error:null}}
   throw Error('Unexpected RPC');
  }};
  const module=loadTs('lib/sales/pending-pos-recheck.ts',{'server-only':{},'@/lib/supabase/server':{supabaseServer:server},'@/lib/sales/admin-resolution-server':{resolutionSchemaReady:()=>true},'@/lib/pos/cukcuk/auth':{loginCukcuk:async()=>({accessToken:'fixture',companyCode:'fixture'})},'@/lib/pos/cukcuk/sales-receipt-sync':{fetchSaInvoiceDetail:async({refId})=>{if(refId==='2')throw Error('POS offline');return {RefID:refId,PaymentStatus:1}},getInvoiceRefId:v=>v.RefID,getPaymentStatus:v=>v.PaymentStatus,getNumber:()=>100}});
  const result=await module.runPendingPosRechecks();assert.equal(result.checked,2);assert.equal(result.failed,1);assert.equal(finished.length,3);assert.equal(finished[1].p_error,'pos_lookup_failed');assert.equal(observed.length,2);assert.ok(observed.every(o=>o.p_observations[0].detailStatus===1));
 }finally{if(previous===undefined)delete process.env.POS_PENDING_RECHECK_ENABLED;else process.env.POS_PENDING_RECHECK_ENABLED=previous}
});
