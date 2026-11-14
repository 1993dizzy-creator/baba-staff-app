import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, authHarness, nextMock } from './helpers/sales-auth-harness.mjs';
import { fixture, create, rpc } from './helpers/reservation-hardening-fixture.mjs';

const PATH='app/api/tables/reservations/[id]/confirm/route.ts';
const post=(api, id, body) => api.POST(new Request('https://offline.invalid/api/tables/reservations/'+id+'/confirm', {
  method:'POST',body:typeof body==='string'?body:JSON.stringify(body),headers:{'content-type':'application/json'}
}),{params:Promise.resolve({id:String(id)})});

test('confirmation API uses real signed-session authentication and final RPC for all five roles; no client actor/transition override', async () => {
  const old=process.env.BABA_SESSION_SECRET;
  process.env.BABA_SESSION_SECRET='synthetic-reservation-test-session-key-32-bytes';
  const db=await fixture();
  try {
    const checks=[null,'forged',{id:6,role:'staff',is_active:false},{id:7,role:'staff',app_login_enabled:false},
      ...['owner','master','manager','leader','staff'].map((role,i)=>({id:i+1,role}))];
    for(const check of checks) {
      const r=await create(db); const h=authHarness(); let calls=0;
      if(check==='forged') h.setToken('forged');
      else if(check) { h.setActor(check); h.sign(check.id); }
      const api=loadTs(PATH,{'next/server':nextMock,'@/lib/auth/server-auth':h.auth,'@/lib/supabase/server':{supabaseServer:{
        rpc:async (name,args)=> { calls++; assert.equal(args.p_actor_user_id,check.id); assert.equal(args.p_to_status,'confirmed');
          return {data:await rpc(db,name,[args.p_actor_user_id,args.p_reservation_id,args.p_expected_version,args.p_to_status,args.p_reason]),error:null}; }
      }}});
      const response=await post(api,r.id,{expectedVersion:1,actorUserId:999,p_actor_user_id:999,toStatus:'cancelled'});
      const allowed=check && typeof check==='object' && check.is_active!==false && check.app_login_enabled!==false;
      assert.equal(response.status,allowed?200:401,JSON.stringify(check));
      assert.equal(calls,allowed?1:0);
      assert.equal(response.headers.get('Cache-Control'),'private, no-store');
      if(allowed) {
        const body=await response.json();
        assert.deepEqual(Object.keys(body.reservation).sort(),['confirmedAt','confirmedBy','id','status','version']);
        assert.equal(body.reservation.confirmedBy,check.id);
        h.setActor({is_active:false});
        assert.equal((await post(api,r.id,{expectedVersion:2})).status,401,'live actor is rechecked on next request');
      }
    }
  } finally { await db.close(); if(old===undefined) delete process.env.BABA_SESSION_SECRET; else process.env.BABA_SESSION_SECRET=old; }
});

test('confirmation HTTP rejects missing/NULL/noninteger/string versions; maps conflicts and hides DB errors and PII', async () => {
  let calls=0;
  const answer={data:{status:'ok',reservation:{id:1,status:'confirmed',version:2,confirmedBy:5,confirmedAt:'2026-11-15T12:00:00Z',
    customerContact:'SYNTHETIC-PRIVATE',note:'SYNTHETIC-PRIVATE'}},error:null};
  const api=loadTs(PATH,{'next/server':nextMock,'@/lib/auth/server-auth':{getAuthenticatedActor:async()=>({ok:true,actor:{id:5}})},
    '@/lib/supabase/server':{supabaseServer:{rpc:async()=>{calls++;return answer;}}}});
  for(const body of [{},{expectedVersion:null},{expectedVersion:0},{expectedVersion:-1},{expectedVersion:1.5},
    {expectedVersion:'1'},{expectedVersion:2147483647},[],null,'{bad']) {
    assert.equal((await post(api,1,body)).status,400,JSON.stringify(body));
  }
  for(const id of ['0','-1','x','1.5','9007199254740992']) assert.equal((await post(api,id,{expectedVersion:1})).status,400);
  assert.equal(calls,0);
  assert.ok(!JSON.stringify(await (await post(api,1,{expectedVersion:1})).json()).includes('SYNTHETIC-PRIVATE'));
  for(const [code,status] of [['version_conflict',409],['invalid_transition',409],['not_found',404],['forbidden',403],['invalid_input',400]]) {
    answer.data={status:code};assert.equal((await post(api,1,{expectedVersion:1})).status,status);
  }
  answer.error={message:'SYNTHETIC-PRIVATE'};
  const failure=await post(api,1,{expectedVersion:1});
  assert.equal(failure.status,503); assert.ok(!JSON.stringify(await failure.json()).includes('SYNTHETIC-PRIVATE'));
});
