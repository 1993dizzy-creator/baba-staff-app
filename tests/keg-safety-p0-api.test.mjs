import assert from 'node:assert/strict';
import test,{before,after,beforeEach} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {setupKegSafety,seedKegSafety,kegState,kegSafetyApi} from './helpers/keg-safety-fixture.mjs';
let db;before(async()=>{db=new PGlite();await setupKegSafety(db);});beforeEach(async()=>seedKegSafety(db));after(async()=>db?.close());
const api=options=>kegSafetyApi(db,options);
const request=body=>new Request('http://local/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
test('authenticated staff preview makes no writes; confirmed replacement retries do not deduct again',async()=>{
 const s=api(),state=await kegState(db),body={itemId:3,expectedQuantity:10,replacementAt:'2026-07-10T11:00Z',actorUsername:'bob'};
 let r=await s.replace.POST(request({...body,dryRun:true}));const p=await r.json();assert.equal(r.status,200);assert.equal(p.actorUsername,'alice');assert.equal(s.calls[0].name,'inventory_preview_keg_change');assert.deepEqual(await kegState(db),state);
 const save={...body,previewToken:p.previewToken,requestId:'10000000-0000-4000-8000-000000000001'};r=await s.replace.POST(request(save));assert.equal(r.status,200);assert.equal((await r.json()).quantity,9);r=await s.replace.POST(request(save));assert.equal((await r.json()).replayed,true);assert.equal((await kegState(db)).inventory[0].quantity,9);assert.ok(s.calls.every(c=>c.args.p_actor_username==='alice'));
});
test('PATCH only writes through the atomic RPC after preview and reason; no direct session UPDATE',async()=>{
 const s=api(),options={params:Promise.resolve({id:'23'})},body={startedAt:'2026-07-10T10:30Z'};
 const p=await(await s.session.PATCH(request({...body,dryRun:true}),options)).json();assert.equal(p.soldMl,3030);
 let r=await s.session.PATCH(request({...body,previewToken:p.previewToken,requestId:'10000000-0000-4000-8000-000000000001'}),options);assert.equal(r.status,409);assert.equal((await r.json()).code,'KEG_REASON_REQUIRED');
 r=await s.session.PATCH(request({...body,previewToken:p.previewToken,requestId:'10000000-0000-4000-8000-000000000001',reason:'Verified time'}),options);assert.equal(r.status,200);assert.equal((await kegState(db)).audit.length,1);
});
test('missing migration fails closed; unauthenticated, bad ids/times/calendar dates and absent tokens never mutate',async()=>{
 const denied=api({authenticated:false});assert.equal((await denied.replace.POST(request({itemId:3}))).status,401);assert.equal(denied.calls.length,0);
 const s=api(),state=await kegState(db);for(const body of [{itemId:3},{itemId:3,dryRun:true,replacementAt:'2026-02-30T10:00'},{itemId:3,dryRun:true,replacementAt:'2099-01-01T10:00Z'},{itemId:0,dryRun:true},{itemId:3,requestId:'bad',replacementAt:'2026-07-10T10:30Z'}])assert.ok((await s.replace.POST(request(body))).status>=400);
 assert.equal(s.calls.length,0);assert.deepEqual(await kegState(db),state);const missing=api({missingRpc:true});const r=await missing.replace.POST(request({itemId:3,dryRun:true,replacementAt:'2026-07-10T11:00Z'}));assert.equal(r.status,503);assert.equal((await r.json()).code,'KEG_SAFETY_UNAVAILABLE');assert.deepEqual(await kegState(db),state);
 assert.equal(s.helper.parseKegSafetyTime('2026-07-10T17:00').toISOString(),'2026-07-10T10:00:00.000Z');
});

test('RPC business-date mismatch is a clear HTTP 400 for preview and save without writes',async()=>{
 const s=api({businessDateOverride:'2026-07-11'}),body={itemId:3,expectedQuantity:10,replacementAt:'2026-07-10T11:00Z'},before=await kegState(db);
 let r=await s.replace.POST(request({...body,dryRun:true}));assert.equal(r.status,400);assert.equal((await r.json()).code,'KEG_BUSINESS_DATE_MISMATCH');
 r=await s.replace.POST(request({...body,previewToken:'a'.repeat(64),requestId:'10000000-0000-4000-8000-000000000001'}));assert.equal(r.status,400);assert.equal((await r.json()).code,'KEG_BUSINESS_DATE_MISMATCH');assert.deepEqual(await kegState(db),before);
});