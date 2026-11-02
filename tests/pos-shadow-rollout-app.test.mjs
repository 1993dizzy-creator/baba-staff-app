import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function load(p,deps={}){const m={exports:{}};new Function('require','module','exports',ts.transpileModule(readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>{assert.ok(n in deps,n);return deps[n];},m,m.exports);return m.exports;}
const policy=load('lib/sales/inventory-shadow-observation-policy.ts');
const d=(id,op='deduction',original=null)=>({id,operation_type:op,status:'applied',applied_at:'2026-10-12T00:00:00Z',inventory_log_id:id+100,reversal_of_deduction_id:original,batch_receipt_id:1});
test('history policy distinguishes candidate, reprocess raw-only, economic cancel and uncertain evidence',()=>{
 assert.equal(policy.classifyObservationHistory([d(1)],{}).disposition,'signed_candidate');
 const corrected=policy.classifyObservationHistory([d(1559),d(1660,'revert',1559)],{1:'reprocess_modified'});
 assert.equal(corrected.disposition,'raw_only');assert.equal(corrected.signedAdoptionAllowed,false);
 assert.ok(corrected.reasons.includes('legacy_reprocess_baseline_requires_reconciliation'));
 const canceled=policy.classifyObservationHistory([d(1),d(2,'revert',1)],{1:'rollback_canceled'});
 assert.ok(canceled.reasons.includes('economic_cancel_is_not_physical_return'));
 for(const rows of [[d(2,'revert',1)],[d(1),d(2,'revert',1),d(3,'revert',1)],[{...d(1),inventory_log_id:null}]])assert.equal(policy.classifyObservationHistory(rows,{1:'reprocess_modified'}).disposition,'uncertain');
 assert.equal(policy.classifyObservationHistory([],{},true).disposition,'uncertain');
 for(const result of [corrected,canceled,policy.classifyObservationHistory([], {})]){
  assert.equal(result.sourceComplete,false);assert.equal(result.writerCoverageComplete,false);assert.equal(result.automaticConfirmation,false);
 }
});
test('history reader is bounded, read-only and treats API row cap/failed workflow reads as uncertainty',async()=>{
 let rows=[d(1),d(2,'revert',1)],fail=false,calls=[];
 const server=load('lib/sales/inventory-shadow-observation-server.ts',{'server-only':{},'./inventory-shadow-observation-policy':policy,
  '@/lib/supabase/server':{supabaseServer:{from(table){calls.push(table);const q={select(){return q},eq(){return q},order(){return q},limit(){return q},in(){return q},then(resolve){return Promise.resolve(table==='pos_inventory_deductions'?{data:rows,error:null}:fail?{error:{code:'08006'}}:{data:[{id:1,workflow_type:'reprocess_modified'}]}).then(resolve)}};return q}}}});
 assert.equal((await server.receiptObservationPolicy(8111)).disposition,'raw_only');
 fail=true;assert.equal((await server.receiptObservationPolicy(8111)).disposition,'uncertain');
 rows=Array.from({length:1000},()=>d(1));assert.equal((await server.receiptObservationPolicy(8111)).disposition,'uncertain');
 assert.ok(calls.every(t=>['pos_inventory_deductions','pos_inventory_deduction_receipts'].includes(t)));
});
test('pilot API: disabled makes no history call; historical/uncertain receipts cannot enter signed baseline',async()=>{
 const previous=process.env.POS_INVENTORY_SHADOW_MODE;let calls=0,rpcs=0;
 const raw=policy.classifyObservationHistory([d(1559),d(1660,'revert',1559)],{1:'reprocess_modified'});
 const route=load('app/api/admin/sales/inventory-shadow/writers/route.ts',{
  'next/server':{NextResponse:{json:(b,o)=>Response.json(b,o)}},
  '@/lib/auth/server-auth':{requireRole:async()=>({ok:true,actor:{username:'owner'}})},
  '@/lib/supabase/server':{supabaseServer:{rpc:async()=>{rpcs++;throw Error('no signed write permitted')}}},
  '@/lib/sales/inventory-shadow-observation-server':{receiptObservationPolicy:async()=>{calls++;return raw}},
 });
 const call=b=>route.POST(new Request('http://localhost/writers',{method:'POST',body:JSON.stringify(b)}));
 try{
  delete process.env.POS_INVENTORY_SHADOW_MODE;assert.equal((await call({action:'observation_policy',receiptId:8111})).status,409);assert.equal(calls,0);
  process.env.POS_INVENTORY_SHADOW_MODE='shadow';const r=await call({action:'observation_policy',receiptId:8111});assert.equal(r.status,200);assert.equal((await r.json()).result.disposition,'raw_only');
  const denied=await call({action:'adopt_receipt',receiptId:8111,targets:[],expectedReceiptUpdatedAt:'2026-10-12T12:00:27Z',proof:'synthetic request for observation',requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
  assert.equal(denied.status,409);const b=await denied.json();assert.equal(b.code,'SIGNED_OBSERVATION_EXCLUDED');assert.equal(b.policy.automaticConfirmation,false);assert.equal(rpcs,0);
 }finally{if(previous===undefined)delete process.env.POS_INVENTORY_SHADOW_MODE;else process.env.POS_INVENTORY_SHADOW_MODE=previous;}
});
test('predeploy reprocessing: missing RPC holds without fallback writes; refresh/review policies are explicit and recover when installed',async()=>{
 const previous=process.env.POS_REPROCESS_P1_ENABLED;process.env.POS_REPROCESS_P1_ENABLED='enabled';
 try{
 let error={code:'PGRST202',message:'private schema details'},calls=0;
 const mod=load('lib/sales/inventory-deduction-reprocess.ts',{'server-only':{},
  '@/lib/sales/inventory-deduction-lock':{isInventoryDeductionBusy:e=>e.code==='55P03'},
  '@/lib/sales/inventory-deduction-unified-preview':{buildUnifiedInventoryDeductionPreview:async()=>({receipts:[{receiptId:10,operationType:'reprocess_modified',currentFingerprint:'fp',activeDeductionCount:1}]})},
  '@/lib/sales/inventory-deduction-preview':{buildInventoryDeductionPreview:async()=>({receipts:[{receiptId:10,lines:[],inventoryAffectingHash:'hash',amountHash:'amount',previewedReceiptUpdatedAt:'2026-10-12T00:00:00Z'}]})},
  '@/lib/supabase/server':{supabaseServer:{rpc:async(name)=>{assert.equal(name,'prepare_and_apply_sales_inventory_reprocess');calls++;return {data:error?null:{result:'already_processed'},error}}}},
 });
 for(const [code,result,retryable] of [['PGRST202','needs_check',false],['42883','needs_check',false],['42501','needs_check',false],['40001','stale_preview',true],['55P03','stale_preview',true],['08006','failed',false]]){
  error={code,message:'private schema details'};const r=await mod.prepareAndApplyReprocessInventoryDeduction({receiptId:10,actorUsername:'owner'});
  assert.equal(r.result,result);assert.equal(r.retryable,retryable);assert.equal(r.appliedDeductionCount,0);assert.equal(r.batchId,null);assert.doesNotMatch(JSON.stringify(r),/private schema/);
 }
 assert.equal(calls,6);error=null;assert.equal((await mod.prepareAndApplyReprocessInventoryDeduction({receiptId:10,actorUsername:'owner'})).result,'already_processed');
 }finally{if(previous===undefined)delete process.env.POS_REPROCESS_P1_ENABLED;else process.env.POS_REPROCESS_P1_ENABLED=previous;}
});

test('app-first reprocess gate: OFF never calls previews, new tables or the uninstalled RPC',async()=>{
 const previous=process.env.POS_REPROCESS_P1_ENABLED;
 const forbidden=()=>{assert.fail('DB access before P1 enable');};
 const mod=load('lib/sales/inventory-deduction-reprocess.ts',{'server-only':{},
  '@/lib/sales/inventory-deduction-lock':{},
  '@/lib/sales/inventory-deduction-unified-preview':{buildUnifiedInventoryDeductionPreview:forbidden},
  '@/lib/sales/inventory-deduction-preview':{buildInventoryDeductionPreview:forbidden},
  '@/lib/supabase/server':{supabaseServer:{rpc:forbidden,from:forbidden}},
 });
 try{
  for(const value of [undefined,'off','disabled']){
   if(value===undefined)delete process.env.POS_REPROCESS_P1_ENABLED;else process.env.POS_REPROCESS_P1_ENABLED=value;
   const r=await mod.prepareAndApplyReprocessInventoryDeduction({receiptId:8111,actorUsername:'owner'});
   assert.equal(r.result,'needs_check');assert.equal(r.failureReason,'pos_reprocess_migration_required');assert.equal(r.retryable,false);
  }
 }finally{if(previous===undefined)delete process.env.POS_REPROCESS_P1_ENABLED;else process.env.POS_REPROCESS_P1_ENABLED=previous;}
});
