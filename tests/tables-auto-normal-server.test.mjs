import test from 'node:test';
import assert from 'node:assert/strict';
import {cleaningServiceFixture} from './helpers/tables-cleaning-service-fixture.mjs';
import {loadTs} from './helpers/sales-auth-harness.mjs';
import {addOrder,tableId} from './helpers/tables-cleaning-fixture.mjs';
import {autoContext} from './helpers/tables-auto-normal-fixture.mjs';
import * as autoNormal from '../lib/sales/table-auto-normal.ts';
import {applyPaymentObservations} from '../lib/sales/table-auto-normal.ts';
import {overview,now} from './helpers/table-overview-fixture.mjs';
import {babaTableCatalog} from '../lib/sales/baba-table-catalog.ts';

test('real SQL-backed observer and overview/detail/manual cleaning priorities',async t=>{
 const env=['BABA_TABLE_CLEANING_ENABLED','POS_OPEN_ORDERS_READ_ENABLED','BABA_TABLE_AUTO_NORMAL_ENABLED','BABA_TABLE_AUTO_NORMAL_ACTIVATION'],saved=env.map(n=>process.env[n]);
 const f=await cleaningServiceFixture({auto:true});
 process.env.BABA_TABLE_CLEANING_ENABLED='true';process.env.POS_OPEN_ORDERS_READ_ENABLED='true';
 process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='true';process.env.BABA_TABLE_AUTO_NORMAL_ACTIVATION=f.activation;
 const worker=loadTs('lib/sales/table-payment-observer-server.ts',{'server-only':{},'@/lib/supabase/server':{supabaseServer:f.adapter},
  './table-auto-normal':autoNormal,'./table-cleaning-server':f.service});
 const current=async()=> (await f.service.readCleaningState()).overview.tables.find(t=>t.id===tableId);
 try{
 await t.test('GET and detail do not insert; worker observes after policy succeeds; button stays enabled',async()=>{
  assert.equal((await current()).state,'paid');assert.equal((await f.getDetail()).cleaning.enabled,true);
  assert.equal((await f.db.query('select count(*)::int n from table_operations_private.payment_observations')).rows[0].n,0);
  await worker.observeVerifiedPayments();const tile=await current();assert.equal(tile.state,'paid');assert.ok(tile.paymentObservation);
  assert.equal((await f.getDetail()).timer.enabled,true);
  assert.equal((await f.getDetail()).cleaning.enabled,true);
 });
 await t.test('automatic expiry hides action, keeps history, never fabricates manual record',async()=>{
  await f.db.exec("update table_operations_private.payment_observations set first_verified_at=clock_timestamp()-interval '30 minutes'");
  assert.equal((await current()).state,'idle');const detail=await f.getDetail();assert.equal(detail.cleaning.enabled,false);
  assert.equal(detail.timer.expired,true);
  assert.equal(detail.latest.id,100);assert.equal(detail.current.length,1);
  assert.equal((await f.db.query('select count(*)::int n from table_operations_private.cleaning_events')).rows[0].n,0);
 });
 await t.test('automatic OFF restores ordinary paid display; manual feature still saves immediately',async()=>{
  process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='false';const detail=await f.getDetail();assert.equal(detail.cleaning.enabled,true);
  await f.service.confirmTableCleaning(tableId,1,{requestId:'00000000-0000-4000-8000-000000000001',...detail.cleaning.token});
  assert.equal((await current()).state,'idle');process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='true';assert.equal((await current()).state,'idle');
 });
 await t.test('automatic works with manual app switch OFF; stale activation falls back safely',async()=>{
  process.env.BABA_TABLE_CLEANING_ENABLED='false';assert.equal((await current()).state,'idle');
  await assert.rejects(()=>f.service.confirmTableCleaning(tableId,1,{}),/DISABLED/);
  process.env.BABA_TABLE_CLEANING_ENABLED='true';const old=process.env.BABA_TABLE_AUTO_NORMAL_ACTIVATION;
  process.env.BABA_TABLE_AUTO_NORMAL_ACTIVATION='00000000-0000-4000-8000-000000000001';assert.equal((await current()).state,'idle');
  process.env.BABA_TABLE_AUTO_NORMAL_ACTIVATION=old;
 });
 await t.test('new valid open order takes precedence over expired timer and manual cleaning',async()=>{
  await addOrder(f.db,f.day);assert.equal((await current()).state,'occupied');assert.equal((await f.getDetail()).cleaning.enabled,false);
  await worker.observeVerifiedPayments();assert.deepEqual((await autoContext(f.db,f.day,f.activation)).observations,{});
 });
 }finally{await f.db.close();env.forEach((n,i)=>saved[i]===undefined?delete process.env[n]:process.env[n]=saved[i]);}
});

test('observer rejects full-policy unknown/merge conflict and catches DB failure independently',async()=>{
 const saved=process.env.BABA_TABLE_AUTO_NORMAL_ENABLED;process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='true';
 let called=0,logs=0;const oldLog=console.error;console.error=()=>logs++;
 try{
  const worker=loadTs('lib/sales/table-payment-observer-server.ts',{'server-only':{},'./table-auto-normal':{autoNormalActivation:()=> 'key'},
   './table-cleaning-server':{readCleaningState:async()=>{throw Error('private secret must not escape');}},
   '@/lib/supabase/server':{supabaseServer:{rpc(){called++;}}}});
  await worker.observeVerifiedPayments();assert.equal(called,0);assert.equal(logs,1);
 }finally{console.error=oldLog;if(saved===undefined)delete process.env.BABA_TABLE_AUTO_NORMAL_ENABLED;else process.env.BABA_TABLE_AUTO_NORMAL_ENABLED=saved;}
});

test('expired timer cannot override occupied/unknown; missing DB proof and canceled observed receipt stay unknown',()=>{
 const base=overview({catalog:babaTableCatalog(),orders:[]}),table=base.tables.find(t=>t.id===tableId);
 const o={receiptId:100,firstVerifiedAt:new Date(now.getTime()-1800000).toISOString(),expiresAt:now.toISOString(),expired:true};
 for(const state of ['occupied','unknown','paid','idle']){
  const view=structuredClone(base);view.tables.find(t=>t.id===tableId).state=state;
  applyPaymentObservations(view,{[tableId]:o},{[tableId]:{receiptId:100}});
  assert.equal(view.tables.find(t=>t.id===tableId).state,state==='paid'?'idle':state);
 }
 table.state='paid';applyPaymentObservations(base,{[tableId]:o},{});assert.equal(table.state,'unknown');
 table.state='idle';applyPaymentObservations(base,{}, {},[tableId]);assert.equal(table.state,'unknown');
 assert.equal(base.summary.paid,null);
});
