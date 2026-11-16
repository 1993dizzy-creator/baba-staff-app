import test from 'node:test';
import assert from 'node:assert/strict';
import {overview,order,now,businessDate} from './helpers/table-overview-fixture.mjs';
import {babaTableCatalog} from '../lib/sales/baba-table-catalog.ts';
import {applyPaymentObservations} from '../lib/sales/table-auto-normal.ts';
import {selectTableDetail,unavailableTableOverview} from '../lib/sales/table-detail-refresh.ts';
import {cleaningResponseFailure} from '../lib/sales/table-cleaning-feedback.ts';
import {cleaningServiceFixture} from './helpers/tables-cleaning-service-fixture.mjs';
import {addOrder} from './helpers/tables-cleaning-fixture.mjs';
import {loadTs,nextMock} from './helpers/sales-auth-harness.mjs';
const catalog=babaTableCatalog(),live=()=>['BAR1','BAR4','BAR7'].map((name,i)=>order('live-'+i,name));
const pending=(paymentStatus=1)=>({receiptId:90,orderId:'settling',businessDate,tableName:'BAR9',paidAt:now.toISOString(),paymentStatus,isCanceled:false});

test('payment transition localizes named uncertainty and preserves three confirmed green tables with a lower-bound count',()=>{
 for(const status of [1,3,4]){
  const v=overview({catalog,orders:[...live(),order('settling',null,{status})],receipts:[pending(1)]});
  for(const name of ['BAR1','BAR4','BAR7'])assert.equal(v.tables.find(t=>t.name===name).state,'occupied');
  assert.equal(v.summary.occupied,null);assert.equal(v.summary.occupiedConfirmed,3);assert.equal(v.summary.occupiedPartial,true);
  assert.equal(v.tables.find(t=>t.name==='BAR9').state,'unknown');
 }
 const named=overview({catalog,orders:[...live(),order('settling','BAR9',{status:1})],receipts:[pending(1)]});
 assert.equal(named.summary.occupied,4);assert.equal(named.tables.find(t=>t.name==='BAR9').state,'occupied');
 const paid=overview({catalog,orders:[...live(),order('settling',null,{status:4})],receipts:[pending(3)]});
 assert.equal(paid.summary.occupied,3);assert.equal(paid.summary.occupiedPartial,false);assert.equal(paid.summary.paidCumulative,1);
});
test('truly unlocated order is not assigned; proven occupied tables still give a safe minimum',()=>{
 const v=overview({catalog,orders:[...live(),order('settling',null,{status:4})]});
 assert.equal(v.unlinked.length,1);assert.ok(v.tables.every(t=>!t.orders.some(o=>o.id==='settling')));
 assert.equal(v.summary.occupiedConfirmed,3);assert.equal(v.summary.occupiedPartial,true);assert.equal(v.summary.occupied,null);
});
test('global error, stale/future collection and conflicting duplicate orders never publish a confirmed minimum',()=>{
 for(const changes of [{readFailed:true},{sync:null},{sync:{businessDate,lastSuccessAt:'2026-11-13T10:00:00Z',lastAttemptAt:now.toISOString(),lastErrorCode:null}},
  {sync:{businessDate,lastSuccessAt:'2026-11-13T14:00:00Z',lastAttemptAt:now.toISOString(),lastErrorCode:null}},
  {orders:[order('duplicate','BAR1'),order('duplicate','BAR9')]}]){
  const v=overview({catalog,orders:live(),...changes});assert.equal(v.summary.occupiedConfirmed,null);assert.equal(v.summary.occupiedPartial,false);
  assert.ok(v.tables.every(t=>t.state==='unknown'));
 }
});
test('automatic DB evidence review keeps the minimum separate from the exact count, without changing transitions',()=>{
 const v=overview({catalog,orders:live(),receipts:[pending(3)]});
 applyPaymentObservations(v,{},{});assert.equal(v.tables.find(t=>t.name==='BAR9').state,'unknown');
 assert.equal(v.summary.occupied,null);assert.equal(v.summary.occupiedConfirmed,3);assert.equal(v.summary.occupiedPartial,true);
});
function displayFixture(){
 const v=overview({catalog,orders:[]}),table=v.tables.find(t=>t.name==='BAR4');
 const detail={table,businessDate,snapshotAt:v.snapshotAt,snapshotStatus:'ok',current:[],previous:[],latest:null,merges:[],cleaning:{enabled:false,reason:'no_payment'}};
 return {v,table,detail,result:{key:`${table.id}:${v.serverNow}`,detail,failed:false}};
}
test('refresh pending/failure retains same-day detail object but revokes action freshness',()=>{
 const {v,table,detail,result}=displayFixture(),next={...v,serverNow:'2026-11-13T13:31:00Z',snapshotAt:'2026-11-13T13:31:00Z'};
 for(const r of [result,{...result,failed:true},{...result,key:`${table.id}:${next.serverNow}`,pending:true}]){
  const selected=selectTableDetail(r,next,table.id);assert.equal(selected.detail,detail);assert.equal(selected.fresh,false);
 }
 assert.equal(selectTableDetail(result,v,table.id).fresh,true);
});
test('table/day change drops unrelated history; a new verified order immediately wins over retained status',()=>{
 const {v,table,result}=displayFixture();
 assert.equal(selectTableDetail(result,v,v.tables[0].id).detail,null);
 assert.equal(selectTableDetail(result,{...v,businessDate:'2026-11-14'},table.id).detail,null);
 const next=overview({catalog,orders:[order('new','BAR4')]});
 const selected=selectTableDetail(result,next,table.id);assert.equal(selected.fresh,false);assert.equal(selected.tile.state,'occupied');assert.equal(selected.tile.orders[0].id,'new');
});
test('failed list fetch retains historical facts immutably but hides all live state/counts/actions',()=>{
 const v=overview({catalog,orders:live()}),before=JSON.stringify(v),safe=unavailableTableOverview(v);
 assert.ok(safe.tables.every(t=>t.state==='unknown'&&t.orders.every(o=>!o.verifiedOpen)));
 assert.equal(safe.summary.occupied,null);assert.equal(safe.summary.occupiedConfirmed,null);assert.equal(safe.summary.paidCumulative,null);assert.equal(JSON.stringify(v),before);
});
test('retained newer detail never regresses to an older overview; changed payment cannot appear as the latest old card',()=>{
 const {v,table,detail,result}=displayFixture();
 const newer={...detail,table:{...table,state:'occupied',orders:[{...order('ahead','BAR4'),id:'ahead',startedAt:now.toISOString(),verifiedOpen:true}]},snapshotAt:'2026-11-13T13:31:00Z'};
 const shown=selectTableDetail({...result,detail:newer,pending:true},{...v,serverNow:'2026-11-13T13:32:00Z'},table.id);
 assert.equal(shown.tile.state,'occupied');assert.equal(shown.fresh,false);
 const paid={...v,tables:v.tables.map(t=>t.id===table.id?{...t,state:'paid',lastPaidAt:'2026-11-13T13:29:00Z'}:t)};
 assert.equal(selectTableDetail(result,paid,table.id).paymentChanged,true);
});
test('409/503/403/400 feedback preserves code/stage and separates recovery decisions',()=>{
 for(const [status,kind]of [[409,'stale'],[503,'unavailable'],[403,'forbidden'],[400,'invalid']]){
  assert.deepEqual(cleaningResponseFailure(status,{code:'SAFE_CODE',stage:'evidence'}),{status,kind,code:'SAFE_CODE',stage:'evidence'});
 }
});
test('clean HTTP preflight and RPC-stage failures are distinguishable without bypassing Origin/auth/token checks',async()=>{
 let actor={ok:true,actor:{id:1,role:'staff'}},enabled=true,error=null,calls=0;
 const api=loadTs('app/api/tables/[id]/clean/route.ts',{'next/server':nextMock,'@/lib/auth/server-auth':{getAuthenticatedActor:async()=>{if(error==='auth')throw Error('offline');return actor;}},
  '@/lib/sales/table-cleaning-server':{cleaningFeatureEnabled:()=>enabled,confirmTableCleaning:async()=>{calls++;if(error)throw Object.assign(Error(error),{stage:error==='CLEANING_STALE'?'evidence':'confirm_rpc'});return {saved:true,eventId:1,overview:null,refreshRequired:true};}}});
 const id=catalog.tables[3].id,body={requestId:'00000000-0000-4000-8000-000000000091',businessDate,receiptId:1,evidenceKey:'a'.repeat(32)};
 const send=(origin='https://offline.test',payload=body)=>api.POST(new Request(`https://offline.test/api/tables/${id}/clean`,{method:'POST',headers:{origin},body:JSON.stringify(payload)}),{params:Promise.resolve({id})});
 let response=await send('https://foreign.test');assert.equal(response.status,403);assert.equal((await response.json()).stage,'origin');assert.equal(calls,0);
 actor={ok:false,status:401,code:'RELOGIN_REQUIRED'};response=await send();assert.equal(response.status,401);assert.equal((await response.json()).stage,'authentication');assert.equal(calls,0);
 actor={ok:true,actor:{id:1,role:'outsider'}};response=await send();assert.equal((await response.json()).stage,'authorization');assert.equal(calls,0);
 actor={ok:true,actor:{id:1,role:'staff'}};response=await send('https://offline.test',{});assert.equal(response.status,400);assert.equal((await response.json()).stage,'request');assert.equal(calls,0);
 enabled=false;response=await send();assert.equal(response.status,503);assert.equal((await response.json()).stage,'feature');enabled=true;
 error='auth';response=await send();assert.equal(response.status,503);assert.equal((await response.json()).stage,'authentication');assert.equal(calls,0);
 error='CLEANING_STALE';response=await send();assert.equal(response.status,409);assert.equal((await response.json()).stage,'evidence');
 error='CLEANING_UNAVAILABLE';response=await send();assert.equal(response.status,503);assert.equal((await response.json()).stage,'confirm_rpc');
 error=null;response=await send();assert.equal(response.status,200);const saved=await response.json();assert.equal(saved.saved,true);assert.equal(saved.refreshRequired,true);assert.equal(saved.overview,null);
});
test('SQL-backed stale/context/RPC and saved-but-reload-failed outcomes preserve exactly one event and newest order priority',async()=>{
 const names=['BABA_TABLE_CLEANING_ENABLED','POS_OPEN_ORDERS_READ_ENABLED','BABA_TABLE_AUTO_NORMAL_ENABLED'],old=names.map(n=>process.env[n]);
 process.env.BABA_TABLE_CLEANING_ENABLED='true';process.env.POS_OPEN_ORDERS_READ_ENABLED='true';process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='false';const f=await cleaningServiceFixture();
 try{
  const d=await f.getDetail(),body={requestId:'00000000-0000-4000-8000-000000000093',...d.cleaning.token};
  await assert.rejects(f.service.confirmTableCleaning(f.tableId,1,{...body,evidenceKey:'b'.repeat(32)}),e=>e.message==='CLEANING_STALE'&&e.stage==='evidence');
  f.setFailWrite('40001');await assert.rejects(f.service.confirmTableCleaning(f.tableId,1,body),e=>e.message==='CLEANING_STALE'&&e.stage==='confirm_rpc');
  f.setFailWrite(true);await assert.rejects(f.service.confirmTableCleaning(f.tableId,1,body),e=>e.message==='CLEANING_UNAVAILABLE'&&e.stage==='confirm_rpc');
  f.setFailRead(true);await assert.rejects(f.service.confirmTableCleaning(f.tableId,1,body),e=>e.stage==='context');f.setFailRead(false);f.setFailWrite(false);
  assert.equal((await f.db.query('select count(*)::int n from table_operations_private.cleaning_events')).rows[0].n,0);
  f.setFailReadAfterWrite(true);const saved=await f.service.confirmTableCleaning(f.tableId,1,body);assert.equal(saved.saved,true);assert.equal(saved.overview,null);assert.equal(saved.refreshRequired,true);
  assert.equal((await f.db.query('select count(*)::int n from table_operations_private.cleaning_events')).rows[0].n,1);
  f.setFailReadAfterWrite(false);f.setFailRead(false);const retried=await f.service.confirmTableCleaning(f.tableId,1,body);assert.equal(retried.eventId,saved.eventId);
  assert.equal(retried.overview.tables.find(t=>t.id===f.tableId).state,'idle');assert.equal((await f.db.query('select count(*)::int n from table_operations_private.cleaning_events')).rows[0].n,1);
  await addOrder(f.db,f.day);await assert.rejects(f.service.confirmTableCleaning(f.tableId,1,body),/STALE/);assert.equal((await f.service.readCleaningState()).overview.tables.find(t=>t.id===f.tableId).state,'occupied');
 }finally{await f.db.close();names.forEach((n,i)=>old[i]===undefined?delete process.env[n]:process.env[n]=old[i]);}
});
