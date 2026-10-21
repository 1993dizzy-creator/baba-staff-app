import assert from 'node:assert/strict';import test from 'node:test';import {loadTs} from './helpers/pos-resolution-auth-harness.mjs';
const unified=loadTs('lib/sales/inventory-deduction-unified-preview.ts');const core=loadTs('lib/sales/inventory-deduction-fingerprint-core.ts');const fingerprint=loadTs('lib/sales/inventory-deduction-fingerprint.ts',{'@/lib/sales/inventory-deduction-fingerprint-core':core});
function service({canceled=false,deductions=[],mapping='direct',status='ready',keg=false}={}){let saved;const state={state:{receipt:{ref_id:'ref',source:'cukcuk',payment_status:canceled?4:3,is_canceled:canceled,business_date:'2026-10-17'},lines:[{id:1,item_code:'ITEM',quantity:1,is_option:true,raw_json:{OptionID:'verified-option'},is_excluded:false,is_canceled:canceled}]},deductions,contextFingerprint:'db-context'};
 const rpc=async(name,args)=>name==='sales_get_admin_resolution_work_v2'?{data:state,error:null}:(saved=args,{data:{reviewId:'review',blockers:args.p_blockers,plan:args.p_plan},error:null});
 const module=loadTs('lib/sales/admin-resolution-work.ts',{'@/lib/supabase/server':{supabaseServer:{rpc}},'@/lib/sales/inventory-deduction-unified-preview':unified,'@/lib/sales/inventory-deduction-fingerprint':fingerprint,'@/lib/sales/inventory-deduction-preview':{buildInventoryDeductionPreview:async input=>{assert.equal(input.resolutionReview,true);return {inventoryTotals:[],receipts:[{receiptId:10,inventoryAffectingHash:'hash',amountHash:'amount',hashVersion:1,lines:[{receiptLineId:1,status,blocksReceipt:status==='missing_mapping',isKegTracked:keg,mappingType:mapping,deductions:mapping==='direct'?[{inventoryItemId:1,deductQuantity:1}]:[]}]}]};}}});return {module,getSaved:()=>saved};}
const applied=(id=1,patch={})=>({id,receipt_id:10,status:'applied',operation_type:'apply',receipt_line_id:1,inventory_item_id:1,mapping_id:1,recipe_id:null,deduct_quantity_total:1,...patch});
for(const [label,input,workflow,block] of [
 ['never deducted',{deductions:[]},'initial_apply',null],
 ['existing active deduction',{deductions:[applied()]},'reprocess_modified',null],
 ['already reversed before cancellation',{canceled:true,deductions:[applied(),applied(2,{operation_type:'revert',reversal_of_deduction_id:1})]},'no_stock_change',null],
 ['canceled with stock',{canceled:true,deductions:[applied()]},'rollback_canceled',null],
 ['duplicate active originals',{deductions:[applied(),applied(2)]},'reprocess_modified','duplicate_active_deductions'],
 ['legacy unlinked logs',{deductions:[applied(1,{receipt_id:null})]},'reprocess_modified','legacy_inventory_link_requires_review'],
 ['manual mapping',{mapping:'manual'},'initial_apply','special_mapping_requires_review'],
 ['keg mapping',{keg:true},'initial_apply','special_mapping_requires_review'],
 ['unmapped item',{mapping:null,status:'missing_mapping'},'initial_apply','missing_mapping'],
])test('phase2 preview service: '+label,async()=>{const h=service(input);const r=await h.module.previewResolutionInventory(10,1);assert.equal(r.plan.workflow,workflow);if(block)assert.ok(r.blockers.includes(block));else assert.deepEqual(r.blockers,[]);assert.equal(h.getSaved().p_actor_user_id,1);assert.equal(h.getSaved().p_context,'db-context');});
