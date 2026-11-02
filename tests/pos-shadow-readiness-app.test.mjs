import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
function load(path,deps){const m={exports:{}};const c=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});assert.deepEqual(c.diagnostics,[]);new Function('require','module','exports',c.outputText)(name=>{assert.ok(name in deps,name);return deps[name];},m,m.exports);return m.exports;}
const source=load('lib/pos/cukcuk/shadow-source-contract.ts',{});
test('readiness source ignores forged local revisions and gate never authorizes replacement',async()=>{
 const called=[];
 const client={from(table){assert.equal(table,'pos_sales_receipts');const q={select(){return q;},eq(){return q;},async maybeSingle(){return {data:{source:'cukcuk',raw_json:{RefID:'synthetic',BranchID:'b',RefDate:'2026-10-09T20:01:00+07:00',Revision:99},synced_at:'2026-10-12T00:00:00Z',revision:900},error:null};}};return q;},async rpc(name,args){called.push({name,args});return {data:{result:'recorded',operatingInventoryWritten:false},error:null};}};
 const mod=load('lib/sales/inventory-shadow-readiness.ts',{'server-only':{},'@/lib/supabase/server':{supabaseServer:client},'@/lib/pos/cukcuk/shadow-source-contract':source});
 const r=await mod.inventoryShadowReadiness({action:'source',receiptId:10},'owner');assert.equal(r.automaticConfirmation,false);assert.equal(r.localAdminRevision,900);assert.equal(r.fields.revisionCandidate,99);
 assert.equal((await mod.inventoryShadowReadiness({action:'gate'},'owner')).replacementAllowed,false);
 await mod.inventoryShadowReadiness({action:'transfer_writer',logId:1,expectedLogHash:'a'.repeat(64),kind:'physical_return',effectiveAt:'2026-10-12T00:00:00Z',proof:'synthetic',physicalEventRef:'return-1'},'owner');
 assert.equal(called[0].name,'pos_shadow_register_writer_movement');assert.equal(called[0].args.p_evidence.physicalEventRef,'return-1');
});
test('readiness API is default off, role protected, shadow only, input bounded, SQL detail hidden',async()=>{
 const old=process.env.POS_INVENTORY_SHADOW_MODE;let authorized=true,calls=0,fail=false;
 const route=load('app/api/admin/sales/inventory-shadow/readiness/route.ts',{
  'next/server':{NextResponse:{json:(b,o)=>Response.json(b,o)}},
  '@/lib/auth/server-auth':{requireRole:async roles=>{assert.deepEqual(roles,['owner','master']);return authorized?{ok:true,actor:{username:'owner'}}:{ok:false,code:'FORBIDDEN',status:403};}},
  '@/lib/sales/inventory-shadow-readiness':{inventoryShadowReadiness:async()=>{calls++;if(fail)throw {code:'42501',details:'SECRET SQL ROW'};return {status:'BLOCKED',replacementAllowed:false};}},
 });
 const call=body=>route.POST(new Request('http://localhost/api/admin/sales/inventory-shadow/readiness',{method:'POST',body:JSON.stringify(body)}));
 try{
  delete process.env.POS_INVENTORY_SHADOW_MODE;assert.equal((await call({action:'gate'})).status,409);assert.equal(calls,0);
  process.env.POS_INVENTORY_SHADOW_MODE='shadow';authorized=false;assert.equal((await call({action:'gate'})).status,403);authorized=true;
  for(const b of [{action:'gate',mode:'live'},{action:'source',receiptId:-1},{action:'transfer_writer',logId:1},{action:'recovery',manifest:{first:{}}}])assert.equal((await call(b)).status,400);
  assert.equal(calls,0);assert.equal((await call({action:'gate'})).status,200);
  fail=true;const response=await call({action:'writer',logId:1});assert.equal(response.status,403);assert.doesNotMatch(JSON.stringify(await response.json()),/SECRET/);
 }finally{if(old===undefined)delete process.env.POS_INVENTORY_SHADOW_MODE;else process.env.POS_INVENTORY_SHADOW_MODE=old;}
});
