import test from 'node:test';
import assert from 'node:assert/strict';
import {projectPaidOrderUsage} from '../lib/sales/table-paid-usage.ts';
import {paidOrderElapsedMinutes,verifiedPaidReferenceTime,orderElapsedMinutes,receiptOrderTimeRange,verifiedReceiptOrderUsage} from '../lib/sales/table-detail-display.ts';
import {projectTableDetail} from '../lib/sales/table-detail.ts';
import {buildTableOverview} from '../lib/sales/table-overview.ts';
import {babaTableCatalog} from '../lib/sales/baba-table-catalog.ts';
import {order} from './helpers/table-overview-fixture.mjs';

const day='2026-11-16',now=new Date('2026-11-16T15:10:00Z'),catalog=babaTableCatalog();
const receipt=(id=900,changes={})=>({id,order_id:'paid-'+id,ref_no:String(id),business_date:day,table_name:'BAR5',
 ref_date:'2026-11-16T15:05:00Z',final_amount:664400,payment_status:3,is_canceled:false,status_changed_at:null,...changes});
const source=(key='paid-900',changes={})=>order(key,'BAR5',{businessDate:day,orderDate:'2026-11-16T14:00:00Z',providerObservedAt:now.toISOString(),status:4,...changes});
function scenario({receipts=[receipt()],orders=[source()],at=now,businessDate=day}={}){
 const overview=buildTableOverview({businessDate,now:at,catalog,enabled:true,orders,
  sync:{businessDate,lastSuccessAt:at.toISOString(),lastAttemptAt:at.toISOString(),lastErrorCode:null},
  receipts:receipts.map(r=>({receiptId:r.id,orderId:r.order_id??'',businessDate:r.business_date,tableName:r.table_name,
   paidAt:r.ref_date,paymentStatus:r.payment_status,isCanceled:r.is_canceled}))});
 const table=overview.tables.find(t=>t.name==='BAR5'),d=projectTableDetail({table,overview,catalog:catalog.tables,orders,receipts,now:at,historyFrom:businessDate});
 return {d,input:{table,overview,catalog:catalog.tables,orders,receipts,now:at,latest:d.latest}};
}

test('one original order -> latest paid receipt is a fixed 65 minutes, never now minus start',()=>{
 const {d,input}=scenario(),before=JSON.stringify(input);assert.equal(d.table.state,'paid');assert.equal(d.paidUsage.minutes,65);assert.equal(paidOrderElapsedMinutes(d),65);
 assert.equal(projectPaidOrderUsage({...input,now:new Date(now.getTime()+20*60000)}).minutes,65);
 assert.equal(scenario({at:new Date(now.getTime()+20*60000)}).d.paidUsage.minutes,65);assert.equal(JSON.stringify(input),before);
 assert.equal(verifiedPaidReferenceTime(d.table,d.snapshotAt,input.overview.serverNow,'ok',day),receipt().ref_date);
});
test('zero and sub-minute boundaries are valid; end before start is never published',()=>{
 for(const [end,expected] of [['2026-11-16T14:00:00Z',0],['2026-11-16T14:00:59Z',0],['2026-11-16T14:01:00Z',1],['2026-11-16T13:59:59Z',null]]){
  assert.equal(scenario({receipts:[receipt(900,{ref_date:end})]}).d.paidUsage?.minutes??null,expected);
 }
});
test('lost table name still permits exact OrderId processing time without certifying physical occupancy',()=>{
 const {d}=scenario({orders:[source('paid-900',{tableName:null})]});assert.equal(d.table.state,'paid');
 assert.equal(d.table.orders[0].tableName,'BAR5');assert.equal(d.paidUsage.minutes,65);assert.deepEqual(d.paidUsage,d.latest.orderUsage);
});
test('missing/invalid/future/local-zone-less starts, observations and mismatched tables fail closed',()=>{
 const {input}=scenario();
 for(const change of [{orderDate:''},{orderDate:'invalid'},{orderDate:'2026-11-16T14:00:00'},
  {orderDate:'2026-11-16T15:06:00Z'},{orderDate:'2026-11-15T19:59:59Z'},
  {providerObservedAt:null},{providerObservedAt:'2026-11-16T15:11:00Z'}, {tableName:'BAR8'},{status:5},{status:null}]){
  assert.equal(projectPaidOrderUsage({...input,orders:[source('paid-900',change)]}),null);
 }
 assert.equal(projectPaidOrderUsage({...input,orders:[]}),null);assert.equal(projectPaidOrderUsage({...input,orders:[source(),source()]}),null);
 for(const changes of [{ref_date:'invalid'},{ref_date:'2026-11-16T15:11:00Z'},{table_name:'BAR8'},{order_id:null}])
  assert.equal(projectPaidOrderUsage({...input,receipts:[receipt(900,changes)]}),null);
 assert.equal(projectPaidOrderUsage({...input,orders:[source('paid-900',{tableName:null})]}).minutes,65);
});
test('cancellation/reissue uses the sole valid receipt; duplicate active receipts hide usage',()=>{
 const canceled=receipt(899,{order_id:'paid-900',payment_status:4,is_canceled:true});
 const d=scenario({receipts:[canceled,receipt()]}).d;assert.equal(d.latest.reissued,true);assert.equal(d.paidUsage.minutes,65);
 assert.equal(scenario({receipts:[receipt(900,{is_canceled:true})]}).d.paidUsage,null);
 assert.equal(scenario({receipts:[receipt(),receipt(901,{order_id:'paid-900'})]}).d.paidUsage,null);
});
test('#8885-style closure and source generation uncertainty never merge several order durations',()=>{
 const {input}=scenario();
 for(const orders of [[source('paid-900',{closureReceiptId:900})],[source(),source('member',{tableName:'BAR9',closureReceiptId:900,closureMergedIntoOrderId:'paid-900'})],
  [source('paid-900',{closureMergedIntoOrderId:'target'})]])assert.equal(projectPaidOrderUsage({...input,orders}),null);
});
test('latest independent payment selects its own linked order, not the earliest historical order',()=>{
 const d=scenario({orders:[source(),source('paid-901',{orderDate:'2026-11-16T14:50:00Z'})],
  receipts:[receipt(),receipt(901,{ref_date:'2026-11-16T15:09:00Z'})]}).d;
 assert.equal(d.latest.id,901);assert.equal(d.paidUsage.minutes,19);
});
test('03:00 business day rejects cross-day source/payment and old-day display',()=>{
 const at=new Date('2026-11-17T02:59:59+07:00'),r=receipt(900,{ref_date:at.toISOString()}),o=source('paid-900',{orderDate:'2026-11-17T01:54:59+07:00',providerObservedAt:at.toISOString()});
 const d=scenario({receipts:[r],orders:[o],at}).d;assert.equal(d.paidUsage.minutes,65);
 const next=scenario({receipts:[r],orders:[o],at:new Date('2026-11-17T03:00:00+07:00'),businessDate:'2026-11-17'}).d;
 assert.equal(next.paidUsage,null);assert.equal(verifiedPaidReferenceTime(d.table,d.snapshotAt,'2026-11-16T20:00:00Z','ok','2026-11-17'),null);
});
test('cleaning/retirement/new open order/failed snapshot and changed receipt invalidate both paid displays',()=>{
 const {d,input}=scenario();
 for(const state of ['idle','unknown','occupied','reserved']){
  const changed={...d,table:{...d.table,state}};assert.equal(paidOrderElapsedMinutes(changed),null);
  assert.equal(verifiedPaidReferenceTime(changed.table,d.snapshotAt,input.overview.serverNow,'ok',day),null);
 }
 for(const changed of [{...d,snapshotStatus:'unavailable'},{...d,snapshotAt:'2026-11-16T15:11:00Z'},
  {...d,latest:{...d.latest,id:901}},{...d,table:{...d.table,lastPaidAt:'2026-11-16T15:06:00Z'}}])assert.equal(paidOrderElapsedMinutes(changed),null);
 const active=scenario({orders:[source(),source('new',{status:1,orderDate:'2026-11-16T15:06:00Z'})]}).d;
 assert.equal(active.table.state,'occupied');assert.equal(active.paidUsage,null);assert.equal(orderElapsedMinutes(active.table,active.snapshotAt,input.overview.serverNow,'ok'),4);
});
test('real SQL-backed cleaning decoration clears usage on automatic expiry/manual save and protects new order priority',async()=>{
 const {cleaningServiceFixture}=await import('./helpers/tables-cleaning-service-fixture.mjs');
 const {addOrder}=await import('./helpers/tables-cleaning-fixture.mjs'),{observe}=await import('./helpers/tables-auto-normal-fixture.mjs');
 const names=['BABA_TABLE_CLEANING_ENABLED','POS_OPEN_ORDERS_READ_ENABLED','BABA_TABLE_AUTO_NORMAL_ENABLED','BABA_TABLE_AUTO_NORMAL_ACTIVATION'],saved=names.map(n=>process.env[n]),f=await cleaningServiceFixture({auto:true});
 try{
  process.env.BABA_TABLE_CLEANING_ENABLED='true';process.env.POS_OPEN_ORDERS_READ_ENABLED='true';process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='true';process.env.BABA_TABLE_AUTO_NORMAL_ACTIVATION=f.activation;
  await addOrder(f.db,f.day,{id:'paid-order',status:4});
  await f.db.exec("update pos_open_orders_private.orders set order_date=(select ref_date from pos_sales_receipts where id=100)-interval '65 minutes' where order_id='paid-order'");
  let d=await f.getDetail();assert.equal(paidOrderElapsedMinutes(d),65);assert.equal(d.paidUsage.receiptId,100);
  const beforeRefresh=d;
  await f.db.exec("update pos_open_orders_private.orders set table_name=null where order_id='paid-order'; update pos_open_orders_private.sync_state set last_success_at=clock_timestamp()");
  d=await f.service.decorateCleaningDetail(beforeRefresh);assert.notEqual(d.snapshotAt,beforeRefresh.snapshotAt);
  assert.equal(paidOrderElapsedMinutes(d),65);assert.deepEqual(d.paidUsage,d.latest.orderUsage);
  await observe(f.db,f.day,f.activation);await f.db.exec("update table_operations_private.payment_observations set first_verified_at=clock_timestamp()-interval '31 minutes'");
  d=await f.getDetail();assert.equal(d.table.state,'idle');assert.equal(d.paidUsage,null);
  await f.db.exec('update table_operations_private.payment_observations set first_verified_at=clock_timestamp()');
  d=await f.getDetail();assert.equal(paidOrderElapsedMinutes(d),65);
  await f.service.confirmTableCleaning(f.tableId,1,{requestId:'00000000-0000-4000-8000-000000000099',...d.cleaning.token});
  d=await f.getDetail();assert.equal(d.table.state,'idle');assert.equal(d.paidUsage,null);
  await addOrder(f.db,f.day);d=await f.getDetail();assert.equal(d.table.state,'occupied');assert.equal(d.paidUsage,null);
 }finally{await f.db.close();names.forEach((n,i)=>saved[i]===undefined?delete process.env[n]:process.env[n]=saved[i]);}
});
test('every historical valid receipt has its own fixed range while a new order is occupied',()=>{
 const d=scenario({orders:[source(),source('paid-901',{orderDate:'2026-11-16T14:50:00Z'}),source('active',{status:1,orderDate:'2026-11-16T15:06:00Z'})],
  receipts:[receipt(),receipt(901,{ref_date:'2026-11-16T15:09:00Z'})]}).d;
 assert.equal(d.table.state,'occupied');assert.equal(d.paidUsage,null);
 assert.deepEqual(d.current.map(r=>r.orderUsage.minutes),[19,65]);
 assert.equal(receiptOrderTimeRange(d.current[1].orderUsage,'분'),'11.16 21:00 ~ 22:05 · 65분');
 assert.equal(verifiedReceiptOrderUsage(d.current[0],d.snapshotAt,'ok',day).minutes,19);
});
test('calendar midnight repeats both dates; one business day remains enforced across 03:00',()=>{
 const at=new Date('2026-11-17T01:10:00+07:00'),d=scenario({at,orders:[source('paid-900',{orderDate:'2026-11-16T23:50:00+07:00',providerObservedAt:at.toISOString()})],
  receipts:[receipt(900,{ref_date:'2026-11-17T00:55:00+07:00'})]}).d;
 assert.equal(receiptOrderTimeRange(d.latest.orderUsage,'p'),'11.16 23:50 ~ 11.17 00:55 · 65p');
 const late=scenario({at:new Date('2026-11-17T03:10:00+07:00'),businessDate:'2026-11-17',
  orders:[source('paid-900',{businessDate:'2026-11-17',orderDate:'2026-11-17T02:30:00+07:00',providerObservedAt:'2026-11-17T03:10:00+07:00'})],
  receipts:[receipt(900,{business_date:'2026-11-17',ref_date:'2026-11-17T03:05:00+07:00'})]}).d;
 assert.equal(late.latest.orderUsage,null);
});
