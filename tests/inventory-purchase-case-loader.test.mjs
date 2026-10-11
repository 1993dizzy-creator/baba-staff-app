import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {buildPurchaseCases} from '../lib/inventory/purchase-cases.ts';
const code=ts.transpileModule(readFileSync('lib/ledger/purchase-case-loader.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const log=(id,delta,root=null,item=309)=>({id,item_id:item,item_name:item===309?'토닉워터':'진저에일',item_name_vi:item===309?'Tonic':'Ginger ale',business_date:'2026-10-11',created_at:`2026-10-11T03:${String(id%60).padStart(2,'0')}:00Z`,change_quantity:delta,new_purchase_price:20000,new_supplier:' QA supplier ',purchase_supplier_partner_id:10,unit:'can',reason:'purchase',source:'edit_form',actor_name:'QA actor',correction_of_inventory_log_id:root});
function setup({completed=false,missingSupplier=false,previewFailure=false,pages=false}={}){
 const root=log(12971,10),cancel=log(13000,-10,12971);if(missingSupplier){root.new_supplier=null;cancel.new_supplier=null;}
 const logs=[root,cancel,log(13001,12),log(12972,10,null,566),log(12998,-10,12972,566),log(13002,8,null,477)];
 const candidate={id:1,source_key:'inventory-log:12971',source_type:'inventory_purchase_log',status:completed?'dismissed':'confirmed',dismissal_reason:completed?'Inventory purchase fully cancelled':null,resolved_transaction_id:completed?null:10,proposed_amount:200000,source_snapshot:{change_quantity:completed?0:10,purchase_price:20000,purchase_amount:completed?0:200000,supplier:'QA supplier',purchase_supplier_partner_id:10,inventory_correction_log_ids:completed?[13000]:[]}};
 const data={inventory_logs:logs,ledger_candidates:[candidate],ledger_transactions:[{id:10,amount:200000,status:'confirmed'}],ledger_audit_logs:[],users:[]};
 const status=[{inventory_log_id:12971,status:'review_required',code:'PURCHASE_ORIGINAL_CANCELLED',source:root},{inventory_log_id:13000,status:'review_required',code:'PURCHASE_ORIGINAL_CANCELLED',source:[cancel]}];
 if(pages)for(let i=0;i<1000;i++)status.splice(1,0,{inventory_log_id:40000+i,status:'synced',code:'NOT_A_PURCHASE',source:{...root,id:40000+i,reason:'stock_check'}});
 const calls=[],previews=[];
 const db={from(table){const filters=[];let range=null,projection='';const query={select(cols){projection=cols;return query;},eq(k,v){filters.push(row=>row[k]===v);return query;},in(k,values){filters.push(row=>values.includes(row[k]));return query;},or(){return query;},gte(){return query;},lt(){return query;},order(){return query;},range(a,b){range=[a,b];return query;},then(resolve,reject){calls.push({table,range,projection});let rows=(table==='ledger_inventory_projection_status'?status:data[table]).filter(row=>filters.every(f=>f(row)));if(range)rows=rows.slice(range[0],range[1]+1);return Promise.resolve({data:rows,error:null}).then(resolve,reject);}};return query;}};
 const module={exports:{}};new Function('require','module','exports',code)(name=>{
 if(name==='server-only')return {};if(name==='@/lib/supabase/server')return {supabaseServer:db};if(name==='@/lib/inventory/purchase-cases')return {buildPurchaseCases};
 if(name==='@/lib/inventory/purchase-repair-contract')return {canReviewPurchaseCorrection:()=>true};
 if(name==='./inventory-repair')return {loadInventoryRepairPreview:async(id,actor)=>{previews.push({id,actor});if(previewFailure)throw Error('QA unavailable');return {candidates:[],recommended:false};}};
 throw Error('Unexpected dependency '+name);
 },module,module.exports);
 return {load:()=>module.exports.loadPurchaseCases('2026-10-01','2026-11-01',7),calls,previews};
}
test('loader groups one root and cancellation, uses source supplier and one actionable preview',async()=>{const s=setup(),rows=await s.load();assert.equal(rows.length,1);assert.equal(rows[0].rootInventoryLogId,12971);assert.equal(rows[0].supplier,'QA supplier');assert.equal(rows[0].quantityDelta,-10);assert.equal(rows[0].ledgerAmount,200000);assert.deepEqual(s.previews,[{id:13000,actor:7}]);});
test('missing suppliers remain unconfirmed and preview failure cannot hide a case',async()=>{const s=setup({missingSupplier:true,previewFailure:true}),rows=await s.load();assert.equal(rows.length,1);assert.equal(rows[0].supplier,null);assert.deepEqual(rows[0].resolution,{candidates:[],recommended:false});});
test('completed cancellation excludes stale root/cancellation statuses without preview or mutation',async()=>{const s=setup({completed:true});assert.deepEqual(await s.load(),[]);assert.deepEqual(s.previews,[]);assert.equal(s.calls.some(call=>['insert','update','rpc'].includes(call.table)),false);});
test('aggregation waits for all status pages and filters unrelated successful stock checks',async()=>{const s=setup({pages:true}),rows=await s.load();assert.equal(rows.length,1);assert.deepEqual(s.calls.filter(row=>row.table==='ledger_inventory_projection_status').map(row=>row.range),[[0,999],[1000,1999]]);assert.deepEqual(rows[0].relatedLogIds,[12971,13000]);});