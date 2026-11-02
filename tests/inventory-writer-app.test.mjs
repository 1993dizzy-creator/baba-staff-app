import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import ts from 'typescript';
function load(file,deps){const m={exports:{}};const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});assert.deepEqual(code.diagnostics,[]);new Function('require','module','exports',code.outputText)(name=>{assert.ok(name in deps,name);return deps[name];},m,m.exports);return m.exports;}
const writer=load('lib/inventory/writer-rpc.ts',{'server-only':{},'node:crypto':{createHash}});
test('writer HTTP retries keep stable intent identity but preserve expected CAS and physical evidence',async()=>{
 const args={p_item_id:1,p_expected_item:{quantity:10,updated_at:'2026-10-11T00:00:00Z'},p_payload:{quantity:9,updated_at:'first'}};
 const id=writer.writerRequestId('save',args,{},1);assert.equal(writer.writerRequestId('save',{...args,p_payload:{quantity:9,updated_at:'second'}},{},1),id);
 assert.notEqual(writer.writerRequestId('save',{...args,p_expected_item:{...args.p_expected_item,updated_at:'2026-10-12T00:00:00Z'}},{},1),id);
 assert.notEqual(writer.writerRequestId('save',args,{effectiveAt:'2026-10-12T12:00:00Z',proof:'physical receipt'},1),id);
 const calls=[];const client={rpc:async(name,params)=>{calls.push({name,params});return calls.length===1?{error:{code:'08006'}}:{data:{status:'ok'},error:null};}};
 assert.equal((await writer.inventoryWriterRpc(client,'save',args,1)).data.status,'ok');assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
 assert.deepEqual(calls[0].params.p_event,{});assert.equal(calls[0].params.p_actor_user_id,1);
 const invalid=await writer.inventoryWriterRpc(client,'save',args,1,{requestId:'bad'});assert.equal(invalid.error.code,'22023');assert.equal(calls.length,2);
});
test('writer Shadow API is owner/master protected, default off, bounded and never accepts live mode',async()=>{
 const previous=process.env.POS_INVENTORY_SHADOW_MODE;let allowed=true,calls=[],fail=false;
 const route=load('app/api/admin/sales/inventory-shadow/writers/route.ts',{
  'next/server':{NextResponse:{json:(v,o)=>Response.json(v,o)}},
  '@/lib/auth/server-auth':{requireRole:async roles=>{assert.deepEqual(roles,['owner','master']);return allowed?{ok:true,actor:{username:'owner'}}:{ok:false,code:'FORBIDDEN',status:403};}},
  '@/lib/supabase/server':{supabaseServer:{rpc:async(name,args)=>{calls.push({name,args});return fail?{error:{code:'23514',details:'private SQL payload'}}:{data:{automaticConfirmation:false}};}}},
 });
 const call=b=>route.POST(new Request('http://localhost/writers',{method:'POST',body:JSON.stringify(b)}));
 try{
  delete process.env.POS_INVENTORY_SHADOW_MODE;assert.equal((await call({action:'inspect'})).status,409);assert.equal(calls.length,0);
  process.env.POS_INVENTORY_SHADOW_MODE='shadow';allowed=false;assert.equal((await call({action:'drain',limit:1})).status,403);allowed=true;
  for(const body of [{action:'drain',limit:101},{action:'compare',itemId:-1},{action:'inspect',mode:'live'},{action:'attest',eventId:'bad'}])assert.equal((await call(body)).status,400);
  assert.equal((await call({action:'drain',limit:10,actor:'forged'})).status,200);assert.equal(calls[0].args.p_actor,'owner');assert.equal(calls[0].name,'inventory_writer_shadow_drain');
  const requestId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for(const body of [
   {action:'signed_compare',itemId:1},
   {action:'define_epoch',itemId:1,startsAt:'2026-10-01T00:00:00Z',baseUnit:'ml',factors:{ml:{numerator:1,denominator:1}},expectedEpoch:null,proof:'verified item volume',requestId},
   {action:'revise_event',eventId:requestId,epochId:1,effectiveAt:'2026-10-12T00:00:00Z',unit:'bottle',expectedRevision:null,proof:'verified delivery slip',requestId},
   {action:'adopt_receipt',receiptId:10,expectedReceiptUpdatedAt:'2026-10-12T00:00:00Z',targets:[],proof:'verified opening baseline',requestId},
   {action:'observe_sale',receiptId:10,parentVersion:null,kind:'cancel',expectedReceiptUpdatedAt:'2026-10-12T00:00:00Z',targets:[],proof:'verified economic cancellation',requestId},
   {action:'reconcile_day',runId:requestId,requestId,external:{entries:[]}},
  ]){assert.equal((await call({...body,actor:'forged',sourceComplete:true})).status,200);assert.equal(calls.at(-1).args.p_actor,'owner');assert.equal(calls.at(-1).args.sourceComplete,undefined);}
  for(const body of [{action:'enable_handoff',receiptId:10,requestId},{action:'define_epoch',requestId:'invalid'},{action:'observe_sale',kind:'return'}, {action:'reconcile_day',requestId,runId:'invalid'},{action:'signed_compare',itemId:1,mode:'live'}])assert.equal((await call(body)).status,400);
  fail=true;const response=await call({action:'inspect'});assert.equal(response.status,409);assert.doesNotMatch(JSON.stringify(await response.json()),/private SQL/);
 }finally{if(previous===undefined)delete process.env.POS_INVENTORY_SHADOW_MODE;else process.env.POS_INVENTORY_SHADOW_MODE=previous;}
});
test('journal-mode keg saves reuse the explicit replacement clock and its validated request reference',async()=>{
 const previous=process.env.INVENTORY_WRITER_MODE;let captured;
 const mod=load('lib/inventory/keg-safety-server.ts',{
  'server-only':{},'next/server':{NextResponse:{json:(v,o)=>Response.json(v,o)}},
  '@/lib/common/business-time':{BUSINESS_TIMEZONE_OFFSET:'+07:00'},'@/lib/inventory/inventory-business-time':{resolveInventoryBusinessDate:async()=>({businessDate:'2026-10-12'})},
  '@/lib/supabase/server':{supabaseServer:{rpc:async(name,args)=>{captured={name,args};return {data:{ok:true},error:null};}}},
  '@/lib/inventory/writer-rpc':writer,
 });
 try{process.env.INVENTORY_WRITER_MODE='journal';const requestId='11111111-1111-4111-8111-111111111111';
  const result=await mod.runKegSafetyChange({action:'replace',itemId:1,sessionId:null,actorUsername:'owner',actorUserId:1,
   body:{replacementAt:'2026-10-12T12:00:00Z',expectedQuantity:10,previewToken:'a'.repeat(64),requestId,confirmed:true}});
  assert.equal(result.status,200);assert.equal(captured.name,'inventory_writer_apply_v1');assert.equal(captured.args.p_event.effectiveAt,'2026-10-12T12:00:00.000Z');assert.equal(captured.args.p_event.physicalEventRef,requestId);
 }finally{if(previous===undefined)delete process.env.INVENTORY_WRITER_MODE;else process.env.INVENTORY_WRITER_MODE=previous;}
});
