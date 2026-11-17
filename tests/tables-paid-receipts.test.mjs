import {createFallbackBusinessTimeSnapshot} from '../lib/store-settings/business-time-adapter-core.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {projectPaidCumulative} from '../lib/sales/table-paid-cumulative.ts';
import * as policy from '../lib/sales/table-overview.ts';
import * as core from '../lib/pos/cukcuk/open-orders-core.ts';
import {babaTableCatalog} from '../lib/sales/baba-table-catalog.ts';
import {addStoreDays,calculateStoreBusinessDate} from '../lib/store-settings/business-time-core.ts';
import {evaluateOpenOrdersCronWindow} from '../lib/pos/cukcuk/open-orders-cron-policy.ts';
import {fetchAllExactPages} from '../lib/sales/daily-sales-summary.ts';
import {cleaningServiceFixture} from './helpers/tables-cleaning-service-fixture.mjs';
import {addOrder,scope} from './helpers/tables-cleaning-fixture.mjs';
import {observe} from './helpers/tables-auto-normal-fixture.mjs';
import {loadTs} from './helpers/sales-auth-harness.mjs';
import {order} from './helpers/table-overview-fixture.mjs';

const day='2026-11-16',now=new Date('2026-11-16T13:32:13Z');
const row=(receiptId,changes={})=>({receiptId,orderId:'verified-'+receiptId,businessDate:day,paymentStatus:3,isCanceled:false,
 paidAt:'2026-11-16T13:20:00Z',tableName:null,...changes});
const project=(receipts,extra={})=>projectPaidCumulative({businessDate:day,now,healthy:true,cutoff:'03:00',receipts,...extra});

test('sanitized operating investigation shape: three receipts, two missing source table names -> completion 3',()=>{
 // Shape from 2026-11-16 20:30-20:32 (+07) read-only findings, not live credentials/data.
 const receipts=['1','4','8'].map((name,i)=>row(1001+i,{tableName:name}));
 const orders=receipts.map((r,i)=>order(r.orderId,i<2?null:'8',{businessDate:day,orderDate:'2026-11-16T13:00:00Z',
  providerObservedAt:now.toISOString(),status:i<2?4:1}));
 const result=policy.buildTableOverview({businessDate:day,now,enabled:true,catalog:babaTableCatalog(),orders,receipts,
  sync:{businessDate:day,lastSuccessAt:now.toISOString(),lastAttemptAt:now.toISOString(),lastErrorCode:null},cutoff:'03:00'});
 assert.equal(orders.filter(o=>o.tableName===null).length,2);assert.equal(result.summary.paidCumulative,3);
 assert.equal(result.summary.paidCumulativeEvidence.status,'ok');
 assert.equal(project(receipts.map(r=>({...r,tableName:null}))).count,3);
});

test('normal empty read is zero; unavailable/failed reads are never zero',()=>{
 assert.deepEqual(project([]),{count:0,status:'ok',reason:'verified_receipts',coverage:'queried_receipts'});
 assert.equal(project([],{healthy:false}).count,null);assert.equal(project([row(1)],{healthy:false}).status,'unavailable');
});

test('IDs deduplicate; cancellation and reissue do not add a second completion',()=>{
 const r=row(1);assert.equal(project([r,r]).count,1);
 assert.equal(project([r,{...r,tableName:'another irrelevant name'}]).count,1);
 assert.equal(project([{...r,isCanceled:true},row(2,{paymentStatus:4,isCanceled:true})]).count,0);
 assert.equal(project([{...r,paymentStatus:4,isCanceled:true},row(2,{orderId:r.orderId})]).count,1);
 assert.equal(project([{...r,paymentStatus:5,isCanceled:false},row(2,{orderId:r.orderId})]).count,1);
});

test('multiple active receipts for one OrderId fail closed, including paid plus pending',()=>{
 for(const status of [1,3]){
  const result=project([row(1),row(2,{orderId:'verified-1',paymentStatus:status})]);
  assert.equal(result.count,null);assert.equal(result.reason,'evidence_conflict');
 }
 assert.equal(project([row(1),row(2)]).count,2);
});

test('conflicting receipt identity/status, missing OrderId, null cancellation, invalid/future/day-mismatched time never publish a number',()=>{
 for(const receipts of [[row(1),row(1,{paymentStatus:1})],[row(0)],[row(1,{orderId:''})],[row(1,{isCanceled:null})],
  [row(1,{paidAt:'invalid'})],[row(1,{paidAt:'2026-11-17T13:00:00Z'})],[row(1,{paidAt:'2026-11-16T02:59:59+07:00'})],
  [row(1,{paymentStatus:null})],[row(1,{businessDate:undefined})]])assert.equal(project(receipts).count,null);
});

test('a merged payment is one receipt; source table membership and movement never multiply it',()=>{
 const r=row(8885,{orderId:'target',tableName:'2'});
 assert.equal(project([r,r,r]).count,1);assert.equal(project([{...r,tableName:null}]).count,1);
});

test('03:00 changes the selected business date; previous-day rows cannot carry a completion forward',()=>{
 const r=row(1,{paidAt:'2026-11-17T02:59:59+07:00'});
 for(const stamp of ['2026-11-17T02:59:59+07:00','2026-11-17T03:00:00+07:00']){
  const at=new Date(stamp),businessDate=calculateStoreBusinessDate(at);
  assert.equal(project([r],{now:at,businessDate}).count,businessDate===day?1:0);
 }
});

test('normal GET and cleaning/automatic paths share receipt counts across manual save, expiry and new orders',async()=>{
 const names=['BABA_TABLE_CLEANING_ENABLED','BABA_TABLE_AUTO_NORMAL_ENABLED','BABA_TABLE_AUTO_NORMAL_ACTIVATION','POS_OPEN_ORDERS_READ_ENABLED'];
 const saved=names.map(n=>process.env[n]),f=await cleaningServiceFixture({auto:true});let readFailed=false,normalQueries=0;
 const snapshot=async()=>f.context();
 const normal=loadTs('lib/sales/table-overview-server.ts',{'server-only':{},'./table-overview':policy,
  './baba-table-catalog':{babaTableCatalog},'./daily-sales-summary':{fetchAllExactPages},
  '@/lib/store-settings/business-time-adapter':{loadBusinessTimeAdapter:async()=>({databaseBusinessDate:f.day,snapshot:createFallbackBusinessTimeSnapshot('2026-11-13'),context:{isOpen:true}})},
  '@/lib/store-settings/business-time-core':{addStoreDays},'@/lib/pos/cukcuk/open-orders-scope':{openOrdersScope:()=>scope},
  '@/lib/pos/cukcuk/open-orders-core':core,'@/lib/pos/cukcuk/open-orders-cron-policy':{evaluateOpenOrdersCronWindow},
  '@/lib/supabase/server':{supabaseServer:{rpc(){return {abortSignal:async()=>({data:(await snapshot()).snapshot,error:null})};},from(){
   normalQueries++;const q={};for(const name of ['select','eq','in','order','abortSignal'])q[name]=()=>q;
   q.range=async()=>{const ctx=await snapshot();return {data:readFailed?null:ctx.receipts,error:readFailed?{message:'offline'}:null,count:ctx.receipts.length};};return q;
  }}}});
 const compare=async expected=>{
  process.env.BABA_TABLE_CLEANING_ENABLED='true';process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='true';
  const cleaned=await f.service.readCleaningState();assert.equal(cleaned.overview.summary.paidCumulative,expected);
  process.env.BABA_TABLE_CLEANING_ENABLED='false';process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='false';
  const direct=await normal.readTableOverview();assert.equal(direct.summary.paidCumulative,expected);
  process.env.BABA_TABLE_CLEANING_ENABLED='true';process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='true';
  return cleaned;
 };
 try{
  process.env.POS_OPEN_ORDERS_READ_ENABLED='true';process.env.BABA_TABLE_AUTO_NORMAL_ACTIVATION=f.activation;
  await f.db.exec(`insert into pos_sales_receipts(id,source,branch_id,business_date,payment_status,is_canceled,total_amount,final_amount,ref_date,raw_json)
   select 101,source,branch_id,business_date,3,false,100000,100000,ref_date,'{"OrderId":"another-1","TableName":"1"}' from pos_sales_receipts where id=100;
   insert into pos_sales_receipts(id,source,branch_id,business_date,payment_status,is_canceled,total_amount,final_amount,ref_date,raw_json)
   select 102,source,branch_id,business_date,3,false,100000,100000,ref_date,'{"OrderId":"another-8","TableName":"8"}' from pos_sales_receipts where id=100;`);
  await compare(3);await observe(f.db,f.day,f.activation);
  await f.db.exec("update table_operations_private.payment_observations set first_verified_at=clock_timestamp()-interval '31 minutes'");
  let s=await compare(3);assert.equal(s.overview.tables.find(t=>t.id===f.tableId).state,'idle');
  await f.db.exec('update table_operations_private.payment_observations set first_verified_at=clock_timestamp()');
  const d=await f.getDetail(),savedResult=await f.service.confirmTableCleaning(f.tableId,1,{requestId:'00000000-0000-4000-8000-000000000091',...d.cleaning.token});
  assert.equal(savedResult.overview.summary.paidCumulative,3);await compare(3);
  await addOrder(f.db,f.day);s=await compare(3);assert.equal(s.overview.tables.find(t=>t.id===f.tableId).state,'occupied');
  await f.db.exec("update pos_open_orders_private.sync_state set last_error_code='provider_timeout'");await compare(null);
  await f.db.exec('update pos_open_orders_private.sync_state set last_error_code=null');
  process.env.BABA_TABLE_CLEANING_ENABLED='false';process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='false';readFailed=true;
  assert.equal((await normal.readTableOverview()).summary.paidCumulative,null);assert.equal(normalQueries,6,'one existing receipt read per normal GET, no extra queries');
 }finally{await f.db.close();names.forEach((n,i)=>saved[i]===undefined?delete process.env[n]:process.env[n]=saved[i]);}
});
