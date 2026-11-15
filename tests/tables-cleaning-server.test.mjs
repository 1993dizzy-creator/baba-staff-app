import test from 'node:test';
import assert from 'node:assert/strict';
import {cleaningServiceFixture} from './helpers/tables-cleaning-service-fixture.mjs';
import {addOrder} from './helpers/tables-cleaning-fixture.mjs';
import {loadTs,authHarness,nextMock} from './helpers/sales-auth-harness.mjs';
import {detailTableName,orderElapsedMinutes,preferLatestOverview} from '../lib/sales/table-detail-display.ts';
import {babaTableCatalog} from '../lib/sales/baba-table-catalog.ts';
import {overview,order,now} from './helpers/table-overview-fixture.mjs';

test('detail names and elapsed time preserve identities and use only verified earliest order time',()=>{
 const data=overview({catalog:babaTableCatalog(),orders:[]}),bar=data.tables[0],one=data.tables.find(t=>t.name==='1'),eleven=data.tables.find(t=>t.name==='11');
 assert.equal(detailTableName(bar,'vi'),'BAR1');assert.equal(detailTableName(one,'vi'),'Bàn 1');assert.equal(detailTableName(eleven,'ko'),'테이블 11');assert.equal(one.name,'1');
 const occupied=overview({catalog:babaTableCatalog(),orders:[order('early','BAR4',{orderDate:'2026-11-13T12:45:00Z'}),order('late','BAR4',{orderDate:'2026-11-13T13:00:00Z'})]}).tables.find(t=>t.name==='BAR4');
 assert.equal(orderElapsedMinutes(occupied,now.toISOString(),now.toISOString(),'ok'),45);
 assert.equal(orderElapsedMinutes(occupied,null,now.toISOString(),'ok'),null);
 assert.equal(orderElapsedMinutes(occupied,now.toISOString(),now.toISOString(),'unavailable'),null);
 occupied.orders[0].startedAt='invalid';assert.equal(orderElapsedMinutes(occupied,now.toISOString(),now.toISOString(),'ok'),null);
 const newer={...data,serverNow:'2026-11-13T13:31:00Z'};
 assert.equal(preferLatestOverview(newer,data),newer,'delayed cleanup cannot overwrite a newer order snapshot');
 assert.equal(preferLatestOverview(data,newer),newer);
});

test('real SQL-backed service: gate off, save success, shared reload, failure and concurrent new order',{timeout:30000},async()=>{
 const old=[process.env.BABA_TABLE_CLEANING_ENABLED,process.env.POS_OPEN_ORDERS_READ_ENABLED];
 process.env.BABA_TABLE_CLEANING_ENABLED='true';process.env.POS_OPEN_ORDERS_READ_ENABLED='true';const f=await cleaningServiceFixture();
 try{
  process.env.BABA_TABLE_CLEANING_ENABLED='false';assert.equal(await f.service.readCleaningState(),null);process.env.BABA_TABLE_CLEANING_ENABLED='true';
  await f.db.exec('update table_operations_private.config set enabled=false');assert.equal(await f.service.readCleaningState(),null);
  await f.db.exec('update table_operations_private.config set enabled=true');
  let d=await f.getDetail();assert.equal(d.cleaning.enabled,true);const request={requestId:'00000000-0000-4000-8000-000000000001',...d.cleaning.token};
  f.setFailWrite(true);await assert.rejects(f.service.confirmTableCleaning(f.tableId,1,request),/UNAVAILABLE/);
  assert.equal((await f.service.readCleaningState()).overview.tables.find(t=>t.id===f.tableId).state,'paid');
  f.setFailWrite(false);const result=await f.service.confirmTableCleaning(f.tableId,1,request);assert.equal(result.overview.tables.find(t=>t.id===f.tableId).state,'idle');
  assert.equal((await f.getDetail()).table.state,'idle');assert.equal((await f.service.confirmTableCleaning(f.tableId,1,request)).eventId,result.eventId);
  await addOrder(f.db,f.day);assert.equal((await f.service.readCleaningState()).overview.tables.find(t=>t.id===f.tableId).state,'occupied');
  await assert.rejects(f.service.confirmTableCleaning(f.tableId,1,request),/STALE/);
  await f.db.exec('delete from pos_open_orders_private.orders');
  d=await f.getDetail();
  f.setBeforeWrite(db=>addOrder(db,f.day,{id:'raced'}));
  await assert.rejects(f.service.confirmTableCleaning(f.tableId,1,{...request,...d.cleaning.token}),/STALE/);
 }finally{await f.db.close();for(const [i,key]of ['BABA_TABLE_CLEANING_ENABLED','POS_OPEN_ORDERS_READ_ENABLED'].entries())if(old[i]===undefined)delete process.env[key];else process.env[key]=old[i];}
});

test('clean API: signed sessions, role, CSRF, default-off, actor supplied by server and stale conflict',async()=>{
 const previous=process.env.BABA_SESSION_SECRET;process.env.BABA_SESSION_SECRET='offline-only-cleaning-session-secret';
 try{
  const id=babaTableCatalog().tables[3].id,body={requestId:'00000000-0000-4000-8000-000000000001',businessDate:'2026-11-15',receiptId:1,evidenceKey:'a'.repeat(32),actorId:999};
  for(const role of [null,'staff','owner','master','manager','leader','outsider']){
   const h=authHarness();if(role){h.setActor({role});h.sign();}let enabled=true,calls=0,stale=false;
   const api=loadTs('app/api/tables/[id]/clean/route.ts',{'next/server':nextMock,'@/lib/auth/server-auth':h.auth,
    '@/lib/sales/table-cleaning-server':{cleaningFeatureEnabled:()=>enabled,confirmTableCleaning:async(_id,actor)=>{calls++;assert.notEqual(actor,999);if(stale)throw Error('CLEANING_STALE');return {eventId:1,overview:{}};}}});
   const send=(origin='http://offline.test',payload=body)=>api.POST(new Request('http://offline.test/api/tables/'+id+'/clean',{method:'POST',headers:{origin},body:JSON.stringify(payload)}),{params:Promise.resolve({id})});
   assert.equal((await send('http://external.test')).status,403);
   assert.equal((await send()).status,!role?401:role==='outsider'?403:200);
   if(role&&role!=='outsider'){enabled=false;assert.equal((await send()).status,503);enabled=true;
    assert.equal((await send('http://offline.test',{})).status,400);stale=true;assert.equal((await send()).status,409);}
   if(!role||role==='outsider')assert.equal(calls,0);
  }
 }finally{if(previous===undefined)delete process.env.BABA_SESSION_SECRET;else process.env.BABA_SESSION_SECRET=previous;}
});
