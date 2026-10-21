import assert from 'node:assert/strict';import test from 'node:test';
import {authHarness,loadTs,nextMock} from './helpers/pos-resolution-auth-harness.mjs';
const paths=[['app/api/admin/sales/receipts/route.ts',['GET','POST']],['app/api/admin/sales/receipts/[id]/route.ts',['GET','PATCH']],['app/api/admin/sales/receipts/[id]/refresh-pos/route.ts',['POST']],['app/api/admin/sales/today/route.ts',['GET']],['app/api/admin/sales/monthly/route.ts',['GET']],['app/api/admin/sales/receipts/[id]/resolution/route.ts',['GET','POST']],['app/api/admin/sales/receipts/[id]/resolution/recheck/route.ts',['POST']]];
const context={params:Promise.resolve({id:'10'})};
function req(method,body={actorUsername:'owner',role:'owner'}){return new Request('http://localhost/api/test?month=bad',{method,...(method==='GET'?{}:{body:JSON.stringify(body),headers:{'Content-Type':'application/json'}})});}
test('all sensitive routes reject missing/forged/disabled sessions 401 and leader/staff 403 before any data/write',async()=>{
 const secret=process.env.BABA_SESSION_SECRET;process.env.BABA_SESSION_SECRET='local-fixture-session-secret-never-production-2026';try{
  const h=authHarness();
  for(const [path,methods] of paths){const route=loadTs(path,{'next/server':nextMock,'@/lib/auth/server-auth':h.auth});
   for(const method of methods){h.setToken(undefined);assert.equal((await route[method](req(method),context)).status,401,path+method);h.setToken('fake.owner.signature');assert.equal((await route[method](req(method),context)).status,401);
    for(const role of ['staff','leader']){if(path.includes('monthly')&&role==='leader')continue;h.sign();h.setActor({role});assert.equal((await route[method](req(method),context)).status,403,path+method+role)}
    h.setActor({role:'owner',app_login_enabled:false});h.sign();assert.equal((await route[method](req(method),context)).status,401);h.setActor({app_login_enabled:true});
   }
  }
  assert.ok(h.touched.every(table=>table==='users'));
  h.sign();h.setActor({role:'leader'});
  const monthly=loadTs('app/api/admin/sales/monthly/route.ts',{'next/server':nextMock,'@/lib/auth/server-auth':h.auth,'@/lib/sales/admin-sales-business-time':{resolveAdminSalesMonth:async value=>({month:value})}});
  assert.equal((await monthly.GET(req('GET'))).status,400); // reaches month validation, not forbidden
  assert.equal((await h.auth.requireRole(['owner','master','manager','leader'])).ok,true);assert.equal((await h.auth.requireRole(['owner','master','manager'])).status,403);
 }finally{if(secret===undefined)delete process.env.BABA_SESSION_SECRET;else process.env.BABA_SESSION_SECRET=secret}
});
test('new decision ignores body actor/role and passes only signed manager identity to RPC',async()=>{
 const secret=process.env.BABA_SESSION_SECRET;process.env.BABA_SESSION_SECRET='local-fixture-session-secret-never-production-2026';try{
  const h=authHarness();h.sign();const calls=[];const policy=loadTs('lib/sales/pending-resolution-policy.ts');
  const route=loadTs('app/api/admin/sales/receipts/[id]/resolution/route.ts',{'next/server':nextMock,'@/lib/auth/server-auth':h.auth,'@/lib/sales/admin-resolution-server':{resolutionWritesEnabled:()=>true,resolutionSchemaReady:()=>true},'@/lib/sales/pending-resolution-policy':policy,'@/lib/supabase/server':{supabaseServer:{rpc:async(name,args)=>{calls.push({name,args});return {data:{status:'resolved'},error:null}}}}});
  const body={actorUsername:'owner',role:'owner',requestId:'11111111-1111-4111-8111-111111111111',expectedRevision:0,fingerprint:'a'.repeat(64),decision:'paid',amount:100,payments:[{method:'cash',amount:100}],reason:'Test',evidence:'Test cash count'};
  assert.equal((await route.POST(req('POST',body),context)).status,200);assert.equal(calls[0].args.p_actor_user_id,3);assert.equal(calls[0].args.p_request.actorUsername,undefined);assert.equal(calls[0].args.p_request.role,undefined);
  assert.equal((await route.POST(req('POST',{...body,payments:[{method:'cash',amount:99}]}),context)).status,400);assert.equal(calls.length,1);
 }finally{if(secret===undefined)delete process.env.BABA_SESSION_SECRET;else process.env.BABA_SESSION_SECRET=secret}
});
