import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function load(path,deps){
 const m={exports:{}};
 const c=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});assert.deepEqual(c.diagnostics,[]);
 new Function('require','module','exports',c.outputText)(name=>{assert.ok(name in deps,name);return deps[name];},m,m.exports);return m.exports;
}
const modulePath='lib/sales/inventory-shadow.ts',routePath='app/api/admin/sales/inventory-shadow/route.ts';
test('CUKCUK capture cannot promote a caller revision or completeness claim past P1-2D',async()=>{
 let captured;const at='2026-10-12T12:00:00Z';
 const mod=load(modulePath,{'server-only':{},'node:crypto':{randomUUID:()=> 'synthetic'},
  '@/lib/sales/inventory-shadow-observation-server':{receiptObservationPolicy:async()=>({disposition:'raw_only',reasons:['legacy_reprocess_baseline_requires_reconciliation'],automaticConfirmation:false})},
  '@/lib/supabase/server':{supabaseServer:{rpc:async(name,args)=>{
   if(name==='pos_shadow_read_receipt')return {data:{snapshotKey:'same',updatedAt:at,snapshot:{source:'cukcuk'}},error:null};
   if(name==='pos_ingest_shadow_evidence')return {data:{sourceComplete:false,sourceSequence:null,blockingReason:'source_order_uncertain'},error:null};
   if(name==='pos_shadow_capture_version'){captured=args;return {data:{result:'needs_review'},error:null};}assert.fail(name);
  }}},'@/lib/sales/inventory-deduction-preview':{buildInventoryDeductionPreview:async()=>({receipts:[{receiptId:10,previewedReceiptUpdatedAt:at,lines:[]}]})},
 });
 const result=await mod.captureInventoryShadow({receiptId:10,observationKey:'obs',sourceSequence:999,sourceComplete:true,proof:'caller claim',timeBasis:'physical_event'},'owner');
 assert.equal(result.result,'needs_review');assert.equal(captured.p_source_sequence,null);assert.equal(captured.p_evidence.blockingReason,'source_order_uncertain');
 assert.equal(captured.p_evidence.observationPolicy.disposition,'raw_only');
});

test('pilot capture: non-CUKCUK caller completeness and sequence claims are also held',async()=>{
 let captured;const at='2026-10-12T12:00:00Z';
 const mod=load(modulePath,{'server-only':{},'node:crypto':{randomUUID:()=> 'synthetic'},
  '@/lib/sales/inventory-shadow-observation-server':{receiptObservationPolicy:async()=>({disposition:'signed_candidate',sourceComplete:false,writerCoverageComplete:false})},
  '@/lib/supabase/server':{supabaseServer:{rpc:async(name,args)=>{
   if(name==='pos_shadow_read_receipt')return {data:{snapshotKey:'same',updatedAt:at,snapshot:{source:'unverified-external'}},error:null};
   assert.equal(name,'pos_shadow_capture_version');captured=args;return {data:{result:'needs_review'},error:null};
  }}},'@/lib/sales/inventory-deduction-preview':{buildInventoryDeductionPreview:async()=>({receipts:[{receiptId:10,previewedReceiptUpdatedAt:at,lines:[]}]})},
 });
 await mod.captureInventoryShadow({receiptId:10,observationKey:'pilot',sourceSequence:999,sourceComplete:true,proof:'caller claim',timeBasis:'physical_event'},'owner');
 assert.equal(captured.p_source_sequence,null);assert.equal(captured.p_evidence.blockingReason,'source_snapshot_incomplete');
 assert.equal(captured.p_evidence.observationPolicy.writerCoverageComplete,false);
});
test('shadow endpoint defaults disabled, requires owner/master, rejects live mode and invalid evidence',async()=>{
 let enabled=false,authorized=true,calls=0;
 const route=load(routePath,{
  'next/server':{NextResponse:{json:(r,o)=>Response.json(r,o)}},
  '@/lib/auth/server-auth':{requireRole:async roles=>{assert.deepEqual(roles,['owner','master']);return authorized?{ok:true,actor:{username:'owner'}}:{ok:false,code:'FORBIDDEN',status:403};}},
  '@/lib/sales/inventory-shadow':{isInventoryShadowEnabled:()=>enabled,shadowSqlState:e=>e.code,inventoryShadowAction:async()=>{calls++;return {mode:'shadow',operatingInventoryWritten:false};}},
 });
 const call=body=>route.POST(new Request('http://localhost/api/admin/sales/inventory-shadow',{method:'POST',body:JSON.stringify(body)}));
 assert.equal((await call({action:'run'})).status,409);assert.equal(calls,0);
 enabled=true;authorized=false;assert.equal((await call({action:'run'})).status,403);authorized=true;
 for(const body of [{action:'run',mode:'live'},{action:'run',limit:100},{action:'movement',logId:1,kind:'physical_return'},
  {action:'capture',receiptId:10,sourceSequence:-1,observationKey:'x'},null])assert.equal((await call(body)).status,400);
 assert.equal(calls,0);assert.equal((await call({action:'run',limit:2})).status,200);assert.equal(calls,1);
});
test('worker failure is fenced and retried through dedicated RPC; never invokes legacy stock writer',async()=>{
 let claims=0;const names=[];
 const mod=load(modulePath,{
  'server-only':{},'node:crypto':{randomUUID:()=> 'worker'},
  '@/lib/sales/inventory-deduction-preview':{},
  '@/lib/supabase/server':{supabaseServer:{rpc:async(name,args)=>{
   names.push(name);
   if(name==='pos_shadow_claim')return {data:claims++?{result:'empty'}:{result:'leased',jobId:1,token:'synthetic'},error:null};
   if(name==='pos_shadow_settle')return {data:null,error:{code:'55P03',details:'SECRET DATABASE DETAIL'}};
   assert.equal(name,'pos_shadow_fail');assert.equal(args.p_sqlstate,'55P03');return {data:{result:'retry_wait'},error:null};
  }}},
 });
 const r=await mod.runInventoryShadow('owner',10);assert.equal(r.results[0].recovery.result,'retry_wait');
 assert.deepEqual(names,['pos_shadow_claim','pos_shadow_settle','pos_shadow_fail','pos_shadow_claim']);
 assert.doesNotMatch(JSON.stringify(r),/SECRET/);assert.equal(r.operatingInventoryWritten,false);
 const previous=process.env.POS_INVENTORY_SHADOW_MODE;
 try{delete process.env.POS_INVENTORY_SHADOW_MODE;assert.equal(mod.isInventoryShadowEnabled(),false);
  process.env.POS_INVENTORY_SHADOW_MODE='live';assert.equal(mod.isInventoryShadowEnabled(),false);
  process.env.POS_INVENTORY_SHADOW_MODE='shadow';assert.equal(mod.isInventoryShadowEnabled(),true);
 }finally{if(previous===undefined)delete process.env.POS_INVENTORY_SHADOW_MODE;else process.env.POS_INVENTORY_SHADOW_MODE=previous;}
});
