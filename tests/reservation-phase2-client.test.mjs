import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './helpers/sales-auth-harness.mjs';
import { reservationText } from '../lib/text/reservations.ts';

test('client never caches private data; requests preserve method, encode route and combine cancellation with timeout',async()=>{
  const original=globalThis.fetch;const c=loadTs('components/reservations/client.ts');let request;
  try {
    globalThis.fetch=async(url,init)=>{request={url,init};return Response.json({ok:true,items:[]});};
    const controller=new AbortController();
    assert.deepEqual(await c.reservationRequest('/3/tables',{method:'POST',body:'{"expectedVersion":1}',signal:controller.signal}),{ok:true,items:[]});
    assert.equal(request.url,'/api/tables/reservations/3/tables');assert.equal(request.init.cache,'no-store');
    assert.equal(request.init.method,'POST');assert.equal(request.init.headers['Content-Type'],'application/json');
    assert.notEqual(request.init.signal,controller.signal);controller.abort();assert.ok(request.init.signal.aborted);
  }finally{globalThis.fetch=original;}
});

test('KO/VI error handling separates conflicts, permissions and validation, with no raw server message in user text',async()=>{
  const original=globalThis.fetch;const c=loadTs('components/reservations/client.ts');
  try {
    for(const lang of ['ko','vi'])for(const [status,code,key] of [[409,'table_conflict','conflict'],[409,'source_conflict','sourceConflict'],[403,'forbidden','denied'],[400,'invalid_input','invalid'],[503,'unavailable','unavailable']]) {
      globalThis.fetch=async()=>Response.json({ok:false,code,message:'SYNTHETIC PRIVATE SERVER DETAIL'},{status});
      let failure;try{await c.reservationRequest('');}catch(e){failure=e;}
      assert.equal(c.errorText(failure,reservationText[lang]),reservationText[lang][key]);
      assert.ok(!c.errorText(failure,reservationText[lang]).includes('PRIVATE'));
    }
  }finally{globalThis.fetch=original;}
});
