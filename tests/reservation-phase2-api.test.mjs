import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, authHarness, nextMock } from './helpers/sales-auth-harness.mjs';
import { fixture, rpc, json, create, ingest, queryRows } from './helpers/reservation-hardening-fixture.mjs';
import * as policy from '../lib/reservations/policy.ts';
import * as dto from '../lib/reservations/dto.ts';
import * as types from '../lib/reservations/types.ts';
import * as time from '../lib/common/business-time.ts';
import * as zalo from '../lib/zalo/webhook-poc.ts';

const order={reservation_list_v1:['p_actor_user_id','p_business_date_from','p_business_date_to','p_statuses'],
  reservation_get_v1:['p_actor_user_id','p_reservation_id','p_reveal_contact'],
  reservation_create_v1:['p_actor_user_id','p_input'],reservation_update_v1:['p_actor_user_id','p_reservation_id','p_expected_version','p_input'],
  reservation_transition_v1:['p_actor_user_id','p_reservation_id','p_expected_version','p_to_status','p_reason'],
  reservation_link_table_v1:['p_actor_user_id','p_reservation_id','p_expected_version','p_table_id'],
  reservation_release_table_v1:['p_actor_user_id','p_reservation_id','p_expected_version','p_link_id','p_reason'],
  reservation_inbox_list_v1:['p_actor_user_id','p_statuses','p_business_date_from','p_business_date_to','p_limit'],
  reservation_inbox_get_v1:['p_actor_user_id','p_inbox_id'],reservation_inbox_dismiss_v1:['p_actor_user_id','p_inbox_id','p_note'],
  reservation_inbox_reprocess_v1:['p_actor_user_id','p_inbox_id','p_entry']};
function harness(db) {
  const h=authHarness();const calls=[];let override;
  const api=loadTs('lib/reservations/server-api.ts',{'server-only':{},'next/server':nextMock,'@/lib/auth/server-auth':h.auth,
    '@/lib/common/business-time':time,'@/lib/zalo/webhook-poc':zalo,'./policy.ts':policy,'./dto.ts':dto,'./types.ts':types,
    '@/lib/supabase/server':{supabaseServer:{rpc:async(name,args)=>{
      calls.push([name,args]);
      if(override) return override(name,args);
      try { return {data:await rpc(db,name,order[name].map(key=> ['p_input','p_entry'].includes(key) ? json(args[key]) : args[key])),error:null}; }
      catch(e) { return {data:null,error:{code:e.code,message:e.message}}; }
    }}}});
  return {h,calls,setOverride(v){override=v;},request:async(action,{id,query='',body,method}={})=>{
    const req=new Request('https://offline.invalid/api/tables/reservations'+(id?'/'+id:'')+query,
      {method:method??(body===undefined?'GET':'POST'),...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const response=await api.reservationsApi(req,id?{params:Promise.resolve({id:String(id)})}:undefined,action);
    return {response,body:await response.json()};
  }};
}
function login(h,id,role) {h.h.setActor({id,role,is_active:true,app_login_enabled:true});h.h.sign(id);}
const key=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const payload=extra=>({customerName:'SYNTHETIC PRIVATE NAME',customerContact:'SYNTHETIC PRIVATE CONTACT',note:'SYNTHETIC PRIVATE NOTE',
  partySize:4,durationMinutes:120,reservedAt:'2026-11-15T19:00:00+07:00',requestKey:key(1),...extra});

test('all five roles list/detail via signed session; Staff minimum DTO remains safe even if RPC includes unexpected private fields',async()=>{
  const old=process.env.BABA_SESSION_SECRET;process.env.BABA_SESSION_SECRET='offline-phase-two-session-secret-32-characters';
  const db=await fixture();
  try {
    const r=await create(db,payload({requestKey:undefined}));const h=harness(db);
    for(const [id,role] of [[1,'owner'],[2,'master'],[3,'manager'],[4,'leader'],[5,'staff']]) {
      login(h,id,role);
      const list=await h.request('list',{query:'?from=2026-11-15&to=2026-11-15'});
      assert.equal(list.response.status,200,role);assert.equal(list.body.tables.length,27);
      assert.equal(list.body.permissions.manage,role!=='staff');
      const detail=await h.request('detail',{id:r.id});assert.equal(detail.response.status,200);
      if(role==='staff') {
        assert.ok(!JSON.stringify(list.body).includes('SYNTHETIC PRIVATE'));
        assert.ok(!JSON.stringify(detail.body).includes('SYNTHETIC PRIVATE'));
        for(const field of ['customerName','customerContact','note','cancelReason']) assert.ok(!(field in detail.body.reservation));
        assert.equal((await h.request('detail',{id:r.id,query:'?reveal=1'})).response.status,403);
      } else assert.equal(detail.body.reservation.customerName,'SYNTHETIC PRIVATE NAME');
      assert.equal(list.response.headers.get('Cache-Control'),'private, no-store');
    }
    login(h,5,'staff');
    h.setOverride(()=>({data:{status:'ok',reservation:{...r,...payload({}),secret:'SYNTHETIC PRIVATE HIDDEN'},
      events:[{id:1,type:'reservation_updated',fromStatus:'pending',toStatus:'pending',actorUserId:4,createdAt:'2026-11-14T12:00:00Z',changes:{reason:'SYNTHETIC PRIVATE HISTORY'}}],
      tableHistory:[],secret:'SYNTHETIC PRIVATE HIDDEN'},error:null}));
    assert.ok(!JSON.stringify((await h.request('detail',{id:r.id})).body).includes('SYNTHETIC PRIVATE'));
  }finally{await db.close();if(old===undefined)delete process.env.BABA_SESSION_SECRET;else process.env.BABA_SESSION_SECRET=old;}
});

test('unauthenticated, forged, inactive, blocked and unknown roles are rejected before any RPC; Staff cannot mutate or read Inbox',async()=>{
  const old=process.env.BABA_SESSION_SECRET;process.env.BABA_SESSION_SECRET='offline-phase-two-session-secret-32-characters';const db=await fixture();
  try {
    const h=harness(db);
    for(const action of ['list','detail','create','update','transition','assign','release','inboxList','inboxDetail','dismiss','reprocess']) {
      assert.equal((await h.request(action,{id:1})).response.status,401);
    }
    h.h.setToken('forged');assert.equal((await h.request('list')).response.status,401);
    for(const flags of [{is_active:false},{app_login_enabled:false}]) {
      login(h,5,'staff');h.h.setActor(flags);assert.equal((await h.request('list')).response.status,401);
    }
    assert.equal(h.calls.length,0);
    login(h,8,'outsider');assert.equal((await h.request('list')).response.status,403);
    login(h,5,'staff');
    for(const action of ['create','update','transition','assign','release','inboxList','inboxDetail','dismiss','reprocess']) {
      assert.equal((await h.request(action,{id:1,body:{actorUserId:1,role:'owner'}})).response.status,403,action);
    }
    assert.equal(h.calls.length,0);
  }finally{await db.close();if(old===undefined)delete process.env.BABA_SESSION_SECRET;else process.env.BABA_SESSION_SECRET=old;}
});

test('create, edit, reveal audit, transitions and assignment use formal RPCs; request actor ignored, stale and time conflicts return safe 409',async()=>{
  const old=process.env.BABA_SESSION_SECRET;process.env.BABA_SESSION_SECRET='offline-phase-two-session-secret-32-characters';const db=await fixture();
  try {
    const h=harness(db);login(h,4,'leader');
    const made=await h.request('create',{body:payload({p_actor_user_id:1,actorUserId:1,role:'owner'})});
    assert.equal(made.response.status,200);assert.equal(h.calls[0][1].p_actor_user_id,4);
    assert.ok(!('actorUserId' in h.calls[0][1].p_input));assert.ok(!('customerContact' in made.body.reservation));
    const id=made.body.reservation.id;
    assert.equal((await h.request('create',{body:payload({})})).body.duplicateRequest,true);
    assert.equal((await h.request('update',{id,body:{expectedVersion:1,partySize:8}})).response.status,200);
    assert.equal((await h.request('update',{id,body:{expectedVersion:1,partySize:9}})).response.status,409);
    const viewed=await h.request('detail',{id,query:'?reveal=1'});
    assert.equal(viewed.body.reservation.customerContact,'SYNTHETIC PRIVATE CONTACT');
    assert.equal((await queryRows(db,"select count(*)::int n from reservation_private.reservation_events where event_type='contact_viewed'"))[0].n,1);
    const assigned=await h.request('assign',{id,body:{expectedVersion:2,tableId:policy.reservationTables[0].id}});
    assert.equal(assigned.response.status,200);
    const second=await h.request('create',{body:payload({requestKey:key(2)})});
    const clash=await h.request('assign',{id:second.body.reservation.id,body:{expectedVersion:1,tableId:policy.reservationTables[0].id}});
    assert.equal(clash.response.status,409);assert.equal(clash.body.conflictReservationId,id);
    assert.ok(!JSON.stringify(clash.body).includes('SYNTHETIC PRIVATE'));
    assert.equal((await h.request('release',{id,body:{expectedVersion:3,linkId:assigned.body.reservation.tables[0].linkId,reason:'synthetic'}})).response.status,200);
    assert.equal((await h.request('transition',{id,body:{expectedVersion:4,toStatus:'cancelled',reason:'synthetic reason'}})).response.status,200);
  }finally{await db.close();if(old===undefined)delete process.env.BABA_SESSION_SECRET;else process.env.BABA_SESSION_SECRET=old;}
});

test('strict HTTP validation: versions, calendar dates, offset, UUID membership and 93-day ranges',async()=>{
  const old=process.env.BABA_SESSION_SECRET;process.env.BABA_SESSION_SECRET='offline-phase-two-session-secret-32-characters';const db=await fixture();
  try {
    const h=harness(db);login(h,4,'leader');
    for(const body of [payload({partySize:0}),payload({partySize:'2'}),payload({reservedAt:'2026-02-31T19:00:00+07:00'}),
      payload({reservedAt:'2026-11-15T19:00:00'}),payload({requestKey:undefined}),payload({customerName:' '}),payload({note:'x'.repeat(1001)})]) {
      assert.equal((await h.request('create',{body})).response.status,400);
    }
    for(const expectedVersion of [undefined,null,0,-1,1.5,'1']) for(const action of ['update','transition','assign','release']) {
      assert.equal((await h.request(action,{id:1,body:{expectedVersion}})).response.status,400);
    }
    assert.equal((await h.request('assign',{id:1,body:{expectedVersion:1,tableId:'BAR1'}})).response.status,400);
    assert.equal((await h.request('assign',{id:1,body:{expectedVersion:1,tableId:'00000000-0000-0000-0000-000000000000'}})).response.status,400);
    for(const query of ['?from=2026-02-31&to=2026-03-01','?from=2026-11-15&to=2026-11-14','?from=2026-01-01&to=2026-12-31','?status=unknown']) {
      assert.equal((await h.request('list',{query})).response.status,400);
    }
    assert.equal(h.calls.length,0);
    assert.equal(policy.localVisit('2026-11-15','02:59'),'2026-11-15T02:59:00+07:00');
    assert.equal(time.getBusinessDate(new Date(policy.localVisit('2026-11-15','02:59'))),'2026-11-14');
    assert.equal(time.getBusinessDate(new Date(policy.localVisit('2026-11-15','03:00'))),'2026-11-15');
    assert.equal(policy.monthWindow('2026-11').days.length,42);
  }finally{await db.close();if(old===undefined)delete process.env.BABA_SESSION_SECRET;else process.env.BABA_SESSION_SECRET=old;}
});

test('Inbox review, candidate linking and duplicate policy; reprocess trusts server raw only and requires allowlist',async()=>{
  const old=process.env.BABA_SESSION_SECRET,oldAllowed=process.env.ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS;
  process.env.BABA_SESSION_SECRET='offline-phase-two-session-secret-32-characters';const db=await fixture();
  try {
    const h=harness(db);login(h,4,'leader');const msg=await ingest(db);
    const list=await h.request('inboxList',{query:'?from=2020-01-01&to=2020-01-02'});assert.equal(list.response.status,200);
    const original=await h.request('inboxDetail',{id:msg.inboxId});
    assert.equal(original.body.item.originalText,'synthetic original');assert.ok(!('rawPayload' in original.body.item));
    assert.equal(original.body.processingHistoryAvailable,false);
    assert.equal((await h.request('create',{body:payload({sourceInboxId:msg.inboxId})})).response.status,200);
    assert.equal((await h.request('create',{body:payload({requestKey:key(2),sourceInboxId:msg.inboxId})})).body.code,'source_conflict');
    const linked=await h.request('inboxDetail',{id:msg.inboxId});assert.equal(linked.body.linkedReservations.length,1);
    const bad=await ingest(db,{status:'quarantined',quarantine_reason:'unknown_event_shape',chat_id:null,message_id:null,message_text:null,payload_sha256:'b'.repeat(64),raw_payload:{unrecognized:'synthetic'}});
    assert.equal((await h.request('inboxDetail',{id:bad.inboxId})).body.item.originalText,JSON.stringify({unrecognized:'synthetic'}));
    delete process.env.ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS;
    assert.equal((await h.request('reprocess',{id:bad.inboxId,body:{rawPayload:payload({})}})).body.code,'allowlist_unset');
    process.env.ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS='synthetic-allowed';
    assert.equal((await h.request('reprocess',{id:bad.inboxId,body:{p_entry:{status:'received'}}})).body.item.status,'quarantined');
    assert.equal((await h.request('dismiss',{id:bad.inboxId,body:{note:'synthetic review'}})).body.item.status,'dismissed');
  }finally{await db.close();if(old===undefined)delete process.env.BABA_SESSION_SECRET;else process.env.BABA_SESSION_SECRET=old;
    if(oldAllowed===undefined)delete process.env.ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS;else process.env.ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS=oldAllowed;}
});

test('RPC failures never return database messages, raw payloads or unknown fields',async()=>{
  const old=process.env.BABA_SESSION_SECRET;process.env.BABA_SESSION_SECRET='offline-phase-two-session-secret-32-characters';const db=await fixture();
  try {
    const h=harness(db);login(h,4,'leader');
    h.setOverride(()=>({data:null,error:{code:'XX000',message:'SYNTHETIC PRIVATE DB DETAIL'}}));
    const result=await h.request('list');assert.equal(result.response.status,503);assert.deepEqual(result.body,{ok:false,code:'unavailable'});
  }finally{await db.close();if(old===undefined)delete process.env.BABA_SESSION_SECRET;else process.env.BABA_SESSION_SECRET=old;}
});
