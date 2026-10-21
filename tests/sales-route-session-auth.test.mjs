// Sales/POS admin routes trust only the signed server session, never body actorUsername.
import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTs,authHarness,nextMock} from './helpers/sales-auth-harness.mjs';

const context={params:Promise.resolve({id:'10'})};
const routes=[
 ['app/api/admin/sales/sync/route.ts','POST',['owner','master','manager']],
 ['app/api/admin/sales/receipts/[id]/refresh-pos/route.ts','POST',['owner','master','manager']],
 ['app/api/admin/sales/receipts/route.ts','GET',['owner','master','manager']],
 ['app/api/admin/sales/receipts/route.ts','POST',['owner','master','manager']],
 ['app/api/admin/sales/receipts/[id]/route.ts','GET',['owner','master','manager']],
 ['app/api/admin/sales/receipts/[id]/route.ts','PATCH',['owner','master','manager']],
 ['app/api/admin/sales/today/route.ts','GET',['owner','master','manager']],
 ['app/api/admin/sales/monthly/route.ts','GET',['owner','master','manager','leader']],
];
function request(method){
 return new Request('http://local/api?businessDate=2026-10-17&month=2026-10',method==='GET'?{method}:
  {method,headers:{'Content-Type':'application/json'},body:JSON.stringify({actorUsername:'owner',role:'owner'})});
}
async function call(path,method,harness){
 const api=loadTs(path,{'next/server':nextMock,'@/lib/auth/server-auth':harness.auth});
 // Route handlers below the auth gate are not exercised: unmocked modules are empty.
 const response=await api[method](request(method),context).catch(()=>Response.json({},{status:599}));
 const body=await response.clone().json().catch(()=>({}));
 return {status:response.status,error:body.error};
}
const AUTH_CODES=['RELOGIN_REQUIRED','SESSION_CONFIG_ERROR','FORBIDDEN'];

test('missing or forged session is 401; a role outside the route list is 403 despite body actorUsername',async()=>{
 const old=process.env.BABA_SESSION_SECRET;process.env.BABA_SESSION_SECRET='fixture-only-session-secret-32-bytes';
 try{
  for(const [path,method,allowed] of routes){
   const missing=authHarness();assert.deepEqual(await call(path,method,missing),{status:401,error:'RELOGIN_REQUIRED'},`${method} ${path} missing`);
   const forged=authHarness();forged.setToken('owner.forged');assert.deepEqual(await call(path,method,forged),{status:401,error:'RELOGIN_REQUIRED'},`${method} ${path} forged`);
   for(const role of ['leader','staff'].filter(role=>!allowed.includes(role))){
    const h=authHarness();h.setActor({role});h.sign();assert.deepEqual(await call(path,method,h),{status:403,error:'FORBIDDEN'},`${method} ${path} ${role}`);
   }
   const inactive=authHarness();inactive.setActor({is_active:false});inactive.sign();assert.deepEqual(await call(path,method,inactive),{status:401,error:'RELOGIN_REQUIRED'},`${method} ${path} inactive`);
   for(const role of allowed){
    const h=authHarness();h.setActor({role});h.sign();const log=console.error;console.error=()=>{};
    const result=await call(path,method,h).finally(()=>{console.error=log;});
    assert.ok(!AUTH_CODES.includes(result.error),`${method} ${path} ${role} must pass the session gate (got ${JSON.stringify(result)})`);
   }
  }
 }finally{if(old===undefined)delete process.env.BABA_SESSION_SECRET;else process.env.BABA_SESSION_SECRET=old;}
});
