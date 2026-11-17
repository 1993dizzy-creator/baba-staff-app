import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildTableOverview} from '../lib/sales/table-overview.ts';
import * as policy from '../lib/sales/table-overview.ts';
import * as core from '../lib/pos/cukcuk/open-orders-core.ts';
import {babaTableCatalog} from '../lib/sales/baba-table-catalog.ts';
import {createFallbackBusinessTimeSnapshot,calculateBusinessTimeContext} from '../lib/store-settings/business-time-adapter-core.ts';
import {addStoreDays} from '../lib/store-settings/business-time-core.ts';
import {loadTs} from './helpers/sales-auth-harness.mjs';
import {order} from './helpers/table-overview-fixture.mjs';

const snapshot=createFallbackBusinessTimeSnapshot('2026-11-17'),catalog=babaTableCatalog();
const at=clock=>new Date(`2026-11-17T${clock.length===5?clock+':00':clock}+07:00`);
function scene(clock,changes={}){
 const now=at(clock),context=calculateBusinessTimeContext(now,snapshot);
 return buildTableOverview({now,businessDate:context.businessDate,businessTime:snapshot,cutoff:snapshot.cutoff,catalog,enabled:true,sync:null,orders:[],receipts:[],...changes});
}
const goodSync=(clock)=>{const now=at(clock);return {businessDate:calculateBusinessTimeContext(now,snapshot).businessDate,lastSuccessAt:now.toISOString(),lastAttemptAt:now.toISOString(),lastErrorCode:null};};

test('unified empty first-success policy covers every required boundary without inventing occupancy or completed zeros',()=>{
 for(const [clock,phase,health]of [['16:00','before_collection','waiting'],['16:59','before_collection','waiting'],['17:00','first_start','waiting'],
  ['17:02','first_run','waiting'],['17:06','first_run','waiting'],['17:06:59.999','first_run','waiting'],['17:07','collecting','delayed'],
  ['01:00','collecting','delayed'],['02:52','collecting','delayed'],['02:54:59','collecting','delayed'],['02:55','outside_collection','delayed'],['03:00','before_opening','waiting']]){
  const v=scene(clock);assert.equal(v.collection.phase,phase,clock);assert.equal(v.collection.health,health,clock);
  assert.equal(v.collection.normalWaiting,health==='waiting');assert.equal(v.summary.total,27);assert.equal(v.summary.occupied,null);assert.equal(v.summary.paidCumulative,null);
  assert.ok(v.tables.every(t=>t.state===(phase==='before_opening'?'idle':'unknown')),clock);
 }
});
test('explicit failed attempt/read/evidence overrides all grace; stale/future success cannot become normal waiting',()=>{
 for(const clock of ['16:00','16:59','17:00','17:02','17:06','01:00']){
  const sync={...goodSync(clock),lastSuccessAt:null,lastErrorCode:'provider_timeout'};
  assert.equal(scene(clock,{sync}).collection.health,'collection_failed');assert.equal(scene(clock,{readFailed:true}).collection.health,'read_failed');
  assert.equal(scene(clock,{sync}).collection.normalWaiting,false);
  const old={...goodSync(clock),lastSuccessAt:new Date(at(clock).getTime()-600001).toISOString()};
  assert.equal(scene(clock,{sync:old}).collection.health,'stale');
  const future={...goodSync(clock),lastSuccessAt:new Date(at(clock).getTime()+1).toISOString()};assert.equal(scene(clock,{sync:future}).collection.health,'unavailable');
 }
 const duplicateNames={...catalog,tables:catalog.tables.map((t,i)=>i===1?{...t,name:'BAR1'}:t)};
 assert.equal(scene('16:00',{catalog:duplicateNames}).collection.health,'evidence_conflict');
 assert.equal(scene('16:00',{catalog:duplicateNames}).collection.normalWaiting,false);
 const r={receiptId:1,orderId:'p',businessDate:'2026-11-17',tableName:'BAR1',paidAt:at('16:00').toISOString(),paymentStatus:3,isCanceled:false};
 const conflict=scene('16:00',{receipts:[r,{...r,paymentStatus:1}]});assert.equal(conflict.collection.health,'evidence_conflict');assert.equal(conflict.collection.normalWaiting,false);
});
test('first successful collection and exact ten-minute freshness restore verified values, also after store close',()=>{
 for(const clock of ['16:59','17:02','17:06','17:07','01:00','02:52','02:54:59','02:55']){
  const sync=goodSync(clock),now=at(clock),day=sync.businessDate;
  const live=order('live','BAR1',{businessDate:day,orderDate:new Date(now.getTime()-60000).toISOString(),providerObservedAt:now.toISOString()});
  const v=scene(clock,{sync,orders:[live]});assert.equal(v.collection.health,'healthy',clock);assert.equal(v.summary.occupied,1);assert.equal(v.tables[0].state,'occupied');
  const ten={...sync,lastSuccessAt:new Date(now.getTime()-600000).toISOString()};assert.equal(scene(clock,{sync:ten}).collection.health,'healthy');
 }
 const prev=goodSync('02:54:59'),old=order('yesterday','BAR1',{businessDate:prev.businessDate,providerObservedAt:prev.lastSuccessAt});
 const next=scene('03:00',{sync:prev,orders:[old]});assert.equal(next.businessDate,'2026-11-17');assert.equal(next.collection.hasSuccess,false);assert.equal(next.snapshotAt,null);
 assert.ok(next.tables.every(t=>t.orders.length===0&&t.state==='idle'));assert.equal(next.summary.occupied,null);
});
test('partial confirmed occupied count remains N+ when a different named payment is unresolved',()=>{
 const sync=goodSync('17:07'),now=at('17:07'),day=sync.businessDate;
 const rows=[order('live','BAR1',{businessDate:day,orderDate:now.toISOString(),providerObservedAt:now.toISOString()}),order('paying','BAR2',{businessDate:day,status:4,orderDate:now.toISOString(),providerObservedAt:now.toISOString()})];
 const v=scene('17:07',{sync,orders:rows,receipts:[{receiptId:2,orderId:'paying',businessDate:day,tableName:'BAR2',paidAt:now.toISOString(),paymentStatus:1,isCanceled:false}]});
 assert.equal(v.summary.occupied,null);assert.equal(v.summary.occupiedConfirmed,1);assert.equal(v.summary.occupiedPartial,true);assert.equal(v.collection.health,'evidence_conflict');
});
test('real general and cleaning-active read paths share the same collection judgment before, during grace, after close and on errors',async()=>{
 const names=['POS_OPEN_ORDERS_READ_ENABLED','BABA_TABLE_CLEANING_ENABLED','BABA_TABLE_AUTO_NORMAL_ENABLED'],saved=names.map(n=>process.env[n]);
 process.env.POS_OPEN_ORDERS_READ_ENABLED='true';process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='false';
 try{for(const clock of ['16:00','16:59','17:00','17:02','17:06','17:07','01:00','02:52','02:54:59','02:55','03:00'])for(const mode of ['empty','success','failed','occupied','paid','read_failed']){
  const now=at(clock),context=calculateBusinessTimeContext(now,snapshot),day=context.businessDate;
  const sync=mode==='empty'?null:['success','occupied','paid','read_failed'].includes(mode)?goodSync(clock):{...goodSync(clock),lastSuccessAt:null,lastErrorCode:'provider_timeout'};
  const orders=['occupied','paid','read_failed'].includes(mode)?[order('parity','BAR1',{businessDate:day,status:mode==='paid'?4:1,orderDate:now.toISOString(),providerObservedAt:now.toISOString()})]:[];
  const receipts=mode==='paid'?[{id:91,order_id:'parity',business_date:day,table_name:'BAR1',ref_date:now.toISOString(),payment_status:3,is_canceled:false,final_amount:100000,ref_no:'91',status_changed_at:null,version:'offline-r1'}]:[];
  const deps={'server-only':{},'@/lib/store-settings/business-time-adapter':{loadBusinessTimeAdapter:async()=>({databaseBusinessDate:day,snapshot,context})},
   '@/lib/store-settings/business-time-core':{addStoreDays},'@/lib/pos/cukcuk/open-orders-core':core,'@/lib/pos/cukcuk/open-orders-scope':{openOrdersScope:()=> 'offline-only'},
   './baba-table-catalog':{babaTableCatalog},'./table-overview':policy,'./daily-sales-summary':{fetchAllExactPages:async()=>({data:mode==='read_failed'?null:receipts,error:mode==='read_failed'?{message:'offline'}:null})},
   './table-auto-normal':{autoNormalActivation:()=>null},
   '@/lib/supabase/server':{supabaseServer:{rpc(name){return {abortSignal:async()=>({data:name==='pos_open_orders_read'?{sync,orders}:{enabled:true,snapshot:{sync,orders},receipts,keys:{},cleanedTableIds:[],manualEnabled:false},error:mode==='read_failed'&&name!=='pos_open_orders_read'?{message:'offline'}:null})};}}}};
  const general=loadTs('lib/sales/table-overview-server.ts',deps),clean=loadTs('lib/sales/table-cleaning-server.ts',{...deps,'./table-overview-server':{validOrders:general.validOrders}});
  const main=loadTs('lib/sales/table-overview-server.ts',{...deps,'./table-cleaning-server':clean});
  process.env.BABA_TABLE_CLEANING_ENABLED='false';const off=await main.readTableOverview(now);
  process.env.BABA_TABLE_CLEANING_ENABLED='true';const on=await main.readTableOverview(now);
  assert.deepEqual({...on,tables:on.tables.map(t=>({...t,detailEvidence:undefined}))},{...off,tables:off.tables.map(t=>({...t,detailEvidence:undefined}))},clock+' '+mode);
 }}finally{names.forEach((n,i)=>{if(saved[i]===undefined)delete process.env[n];else process.env[n]=saved[i];});}
});
test('existing Vercel order/settlement schedules and 150s/180s safety budgets are preserved',()=>{
 const crons=JSON.parse(readFileSync('vercel.json','utf8')).crons;
 for(const [path,schedule]of [['/api/cron/pos-open-orders-sync','2-57/5 10-19 * * *'],['/api/cron/sales-sync','*/5 10-18 * * *'],['/api/cron/sales-sync-final','0 20 * * *']]){
  assert.equal(crons.find(row=>row.path===path)?.schedule,schedule,path);
 }
 assert.equal(core.OPEN_ORDERS_RUN_BUDGET_MS,150000);assert.equal(core.OPEN_ORDERS_LEASE_MS,180000);assert.equal(core.DEFAULT_STALE_AFTER_MS,600000);
});

test('general receipt-read failure retains already-read order facts as unverified history',async()=>{
 const saved=process.env.POS_OPEN_ORDERS_READ_ENABLED;process.env.POS_OPEN_ORDERS_READ_ENABLED='true';
 const now=at('17:02'),context=calculateBusinessTimeContext(now,snapshot),sync=goodSync('17:02'),day=context.businessDate;
 const live=order('preserved','BAR1',{businessDate:day,orderDate:now.toISOString(),providerObservedAt:now.toISOString()});
 const service=loadTs('lib/sales/table-overview-server.ts',{'server-only':{},'./table-overview':policy,'./baba-table-catalog':{babaTableCatalog},
  '@/lib/store-settings/business-time-adapter':{loadBusinessTimeAdapter:async()=>({databaseBusinessDate:day,snapshot,context})},
  '@/lib/store-settings/business-time-core':{addStoreDays},'@/lib/pos/cukcuk/open-orders-core':core,'@/lib/pos/cukcuk/open-orders-scope':{openOrdersScope:()=> 'offline'},
  '@/lib/supabase/server':{supabaseServer:{rpc(){return {abortSignal:async()=>({data:{sync,orders:[live]},error:null})};}}},
  './daily-sales-summary':{fetchAllExactPages:async()=>({data:null,error:{message:'offline-private-error'}})}});
 const clean=process.env.BABA_TABLE_CLEANING_ENABLED,auto=process.env.BABA_TABLE_AUTO_NORMAL_ENABLED;
 process.env.BABA_TABLE_CLEANING_ENABLED='false';process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='false';
 try{const v=await service.readTableOverview(now);assert.equal(v.collection.health,'read_failed');assert.equal(v.collection.normalWaiting,false);
  assert.equal(v.tables[0].orders[0].id,'preserved');assert.equal(v.tables[0].orders[0].verifiedOpen,false);assert.equal(v.tables[0].state,'unknown');assert.equal(v.summary.occupied,null);
 }finally{for(const [n,value]of [['POS_OPEN_ORDERS_READ_ENABLED',saved],['BABA_TABLE_CLEANING_ENABLED',clean],['BABA_TABLE_AUTO_NORMAL_ENABLED',auto]]){if(value===undefined)delete process.env[n];else process.env[n]=value;}}
});

test('a request crossing 03:00 cannot certify the previously selected business day even with a one-second-old success',()=>{
 const day='2026-11-16',now=at('03:00'),success=at('02:59:59').toISOString();
 const raw=order('old-day-live','BAR1',{businessDate:day,orderDate:success,providerObservedAt:success});
 const v=scene('03:00',{businessDate:day,sync:{businessDate:day,lastSuccessAt:success,lastAttemptAt:success,lastErrorCode:null},orders:[raw]});
 assert.equal(v.collection.health,'unavailable');assert.equal(v.collection.normalWaiting,false);assert.equal(v.summary.occupied,null);
 assert.ok(v.tables.every(t=>t.state==='unknown'&&t.orders.every(o=>!o.verifiedOpen)));assert.equal(v.serverNow,now.toISOString());
});

test('a configured closed day still does not expect a collection before the collector starts',()=>{
 const closed={...snapshot,hours:snapshot.hours.map(h=>({...h,isClosed:true,openTime:null,closeTime:null}))};
 for(const clock of ['03:00','11:53','16:00']){
  const v=scene(clock,{businessTime:closed});assert.equal(v.beforeOpening,false);assert.equal(v.collection.phase,'before_collection');
  assert.equal(v.collection.health,'waiting');assert.equal(v.collection.normalWaiting,true);assert.equal(v.summary.occupied,null);
 }
});
