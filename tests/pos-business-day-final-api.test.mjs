import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as apiPolicy from '../lib/sales/pos-business-day-api.ts';
import * as workflow from '../lib/sales/pos-business-day-final-workflow.ts';
function load(path,deps){const testModule={exports:{}};const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',code)(name=>{if(!(name in deps))throw Error('Unexpected import '+name);return deps[name];},testModule,testModule.exports);return testModule.exports;}
for(const role of ['owner','master','manager','staff','leader'])test('trusted manual service actor '+role+' refreshes before closing',async()=>{
 const calls=[];
 const service=load('lib/sales/pos-business-day-final.ts',{
  'server-only':{},'@/lib/auth/server-auth':{getAuthenticatedActor:async()=>{calls.push('session');return {ok:true,actor:{id:55,role}};}},
  '@/lib/supabase/server':{},'@/lib/ledger/pos-sales':{},'./pos-business-day-close':{
   getPosBusinessDayCloseTime:async()=>{calls.push('time');return {allowed:true};},
   closePosBusinessDay:async(date,options)=>{calls.push('close');assert.equal(options.syncRunId,100);return {status:'closed'};}},
  './pos-business-day-final-workflow':workflow,'./pos-business-day-refresh':{forceRefreshPosBusinessDay:async(origin,date)=>{calls.push('force');assert.equal(date,'2026-09-11');return 100;}},
  './pos-business-day-final-policy':{},'@/lib/ledger/pos-sales-source':{validPosBusinessDate:()=>true},
  '@/lib/store-settings/business-time-adapter':{},'@/lib/store-settings/business-time-core':{},
 });
 if(['owner','master','manager'].includes(role)){assert.equal((await service.manualClosePosBusinessDay('http://localhost','2026-09-11')).status,'closed');assert.deepEqual(calls,['session','time','force','close']);}
 else {await assert.rejects(service.manualClosePosBusinessDay('http://localhost','2026-09-11'),/FORBIDDEN/);assert.deepEqual(calls,['session']);}
});
test('manual API rejects client actor/id/role spoofing and passes only reviewed close fields',async()=>{
 const calls=[];
 const route=load('app/api/admin/sales/close/route.ts',{'@/lib/sales/pos-business-day-final':{
  manualClosePosBusinessDay:async(...args)=>{calls.push(args);return {status:'closed'};}},'@/lib/sales/pos-business-day-api':apiPolicy});
 for(const key of ['actorUsername','actor_user_id','role','syncRunId']){
  const response=await route.POST(new Request('http://localhost/api/admin/sales/close',{method:'POST',body:JSON.stringify({businessDate:'2026-09-11',[key]:'owner'})}));assert.equal(response.status,400);
 }
 assert.equal(calls.length,0);
 const response=await route.POST(new Request('http://localhost/api/admin/sales/close',{method:'POST',body:JSON.stringify({businessDate:'2026-09-11',reclose:true,expectedSourceFingerprint:'a'.repeat(64)})}));
 assert.equal((await response.json()).ok,true);assert.deepEqual(calls[0],['http://localhost','2026-09-11',true,'a'.repeat(64)]);
});
test('force helper sends force:true and requires a complete successful persisted run',async()=>{
 const previous=process.env.POS_ADMIN_SECRET,original=globalThis.fetch;process.env.POS_ADMIN_SECRET='local-test-secret';
 let payload={ok:true,result:{syncRunId:100}},saved={id:100,business_date:'2026-09-11',status:'success',source_complete:true,error_message:null};
 const query={select(){return query;},eq(){return query;},async maybeSingle(){return {data:saved,error:null};}};
 const helper=load('lib/sales/pos-business-day-refresh.ts',{'server-only':{},'@/lib/supabase/server':{supabaseServer:{from:()=>query}}});
 try{
  globalThis.fetch=async(url,options)=>{assert.equal(new URL(url).pathname,'/api/pos/cukcuk/sainvoices/sync-to-sales');assert.deepEqual(JSON.parse(options.body),{businessDate:'2026-09-11',force:true,limit:100});return Response.json(payload);};
  assert.equal(await helper.forceRefreshPosBusinessDay('http://localhost','2026-09-11'),100);
  payload={ok:false};await assert.rejects(helper.forceRefreshPosBusinessDay('http://localhost','2026-09-11'),/SYNC_FAILED/);
  payload={ok:true,warning:'limit reached',result:{syncRunId:100}};await assert.rejects(helper.forceRefreshPosBusinessDay('http://localhost','2026-09-11'),/SOURCE_INVALID/);
  payload={ok:true,result:{syncRunId:100}};saved={...saved,source_complete:null};await assert.rejects(helper.forceRefreshPosBusinessDay('http://localhost','2026-09-11'),/SOURCE_INVALID/);
 }finally{globalThis.fetch=original;if(previous===undefined)delete process.env.POS_ADMIN_SECRET;else process.env.POS_ADMIN_SECRET=previous;}
});
test('cron guard runs before orchestration and failures never expose internal errors',async()=>{
 let calls=0,deny=true;
 const route=load('app/api/cron/sales-close-final/route.ts',{'@/lib/pos/cukcuk/sales-sync-cron-shared':{authorizeCron:()=>deny?Response.json({ok:false},{status:401}):null},
  '@/lib/sales/pos-business-day-final':{finalizePreviousPosBusinessDay:async()=>{calls++;return {status:'verified_unchanged'};}}});
 assert.equal((await route.GET(new Request('http://localhost/api/cron/sales-close-final'))).status,401);assert.equal(calls,0);
 deny=false;assert.equal((await (await route.GET(new Request('http://localhost/api/cron/sales-close-final'))).json()).status,'verified_unchanged');
});
test('cron schedule is independent and existing final sync/deductions schedules remain intact',()=>{
 const crons=JSON.parse(readFileSync('vercel.json','utf8')).crons;
 for(const [path,schedule] of [['/api/cron/sales-close-final','5 20 * * *'],['/api/cron/sales-sync-final','0 20 * * *'],['/api/cron/sales-deductions-final','5 20 * * *'],['/api/inventory/snapshot','0 20 * * *']])assert.equal(crons.find(c=>c.path===path).schedule,schedule);
});
