import test from 'node:test';
import assert from 'node:assert/strict';
import {projectTableDetail} from '../lib/sales/table-detail.ts';
import {babaTableCatalog} from '../lib/sales/baba-table-catalog.ts';
import {overview,order,now,businessDate} from './helpers/table-overview-fixture.mjs';
import {verifiedOrderStart} from '../lib/sales/table-detail-display.ts';
import {calculateStoreBusinessDate} from '../lib/store-settings/business-time-core.ts';
const row=(id,changes={})=>({id,order_id:'paid-'+id,ref_no:String(id),business_date:businessDate,table_name:'BAR4',
 ref_date:now.toISOString(),final_amount:100000,payment_status:3,is_canceled:false,status_changed_at:null,...changes});
function detail({orders=[],receipts=[],name='BAR4',at=now,day=businessDate,sync}={}){
 const catalog=babaTableCatalog(),view=overview({catalog,orders,now:at,businessDate:day,...(sync===undefined?{}:{sync}),receipts:receipts.map(r=>({
  orderId:r.order_id,receiptId:r.id,businessDate:r.business_date,tableName:r.table_name,paidAt:r.ref_date,paymentStatus:r.payment_status,isCanceled:r.is_canceled}))});
 return projectTableDetail({table:view.tables.find(t=>t.name===name),catalog:catalog.tables,overview:view,orders,receipts,now:at,historyFrom:day,cutoff:'03:00'});
}

test('single verified open order counts once, exact repeated collections and later payment never add a use',()=>{
 const o=order('one','BAR4'),r=row(1,{order_id:'one'}),before=JSON.stringify(o);
 assert.equal(detail({orders:[o]}).usage.count,1);
 assert.equal(detail({orders:[o,o]}).usage.count,1);
 assert.equal(detail({orders:[o],receipts:[r,r]}).usage.count,1);
 assert.equal(detail({orders:[{...o,status:4}],receipts:[r]}).usage.verifiedOrderCount,1);
 assert.equal(JSON.stringify(o),before);
 assert.equal(detail({orders:[o],name:'BAR6'}).usage.count,null,'never allocate BAR4 to BAR6 or invent zero');
});

test('cancellation/reissue shares OrderId; multiple active receipts and missing/null/future evidence are never extra uses',()=>{
 const o=order('one','BAR4',{status:4}),r=row(1,{order_id:'one'});
 const d=detail({orders:[o],receipts:[{...r,payment_status:4,is_canceled:true},row(2,{order_id:'one'})]});
 assert.equal(d.usage.count,1);assert.equal(d.usage.verifiedOrderCount,1);
 for(const receipts of [[r,row(2,{order_id:'one'})],[{...r,is_canceled:null}],[{...r,ref_date:'2026-11-14T13:00:00Z'}],
  [{...r,final_amount:null}],[{...r,final_amount:' '}],[{...r,payment_status:4,is_canceled:true}]])assert.equal(detail({orders:[o],receipts}).usage.count,null);
});

test('multiple unrelated OrderIds are confirmed orders, not proof of independent visits; duplicate numbers remain distinct',()=>{
 const orders=[order('one','BAR4'),order('two','BAR4'),order('three','BAR4')];
 const d=detail({orders});assert.equal(d.usage.count,null);assert.equal(d.usage.status,'review');
 assert.equal(d.usage.reason,'ambiguous_visits');assert.equal(d.usage.verifiedOrderCount,3);
 const paid=orders.map((o,i)=>row(i+1,{order_id:o.orderId}));
 assert.equal(detail({orders,receipts:paid}).usage.count,null);
 assert.equal(detail({orders,receipts:paid}).usage.verifiedOrderCount,3);
 assert.equal(detail({orders:[orders[0],{...orders[0],tableName:'BAR6'}]}).usage.count,null);
});

test('receipt-only, unknown table, ambiguous move, missing timestamps and unhealthy snapshots never fabricate 0 or confirmed visits',()=>{
 assert.equal(detail().usage.count,null);
 assert.equal(detail({receipts:[row(1)]}).usage.status,'review');
 for(const o of [order('one','BAR4',{providerObservedAt:undefined}),order('one','BAR4',{orderDate:'invalid'}),
  order('one',null,{status:4}),order('one','BAR4',{status:4})]){
  const d=detail({orders:[o],receipts:[row(1,{order_id:'one',table_name:'BAR6'})]});assert.equal(d.usage.count,null);
 }
 for(const sync of [null,{businessDate,lastSuccessAt:'2026-11-13T10:00:00Z',lastAttemptAt:now.toISOString(),lastErrorCode:null},
  {businessDate,lastSuccessAt:now.toISOString(),lastAttemptAt:now.toISOString(),lastErrorCode:'provider_timeout'}]){
  assert.equal(detail({orders:[order('one','BAR4')],sync}).usage.status,'unavailable');
 }
});

test('#8885 uses verified v3 source-table groups; same-table merged orders count one group; receipt table is not movement evidence',()=>{
 const receipts=[row(8885,{order_id:'target',table_name:'2',final_amount:1090000})];
 const source=[order('target','BAR8',{status:4}),...['BAR9','BAR11'].map((name,i)=>order('member-'+i,name,{
  closureReceiptId:8885,closureMergedIntoOrderId:'target',closureConfirmedAt:now.toISOString()}))];
 for(const name of ['BAR8','BAR9','BAR11']){
  const d=detail({orders:source,receipts,name});assert.equal(d.usage.count,1);assert.equal(d.usage.verifiedOrderCount,1);
 }
 assert.equal(detail({orders:source,receipts,name:'2'}).usage.count,null);
 const same=source.map(o=>({...o,tableName:'BAR4'}));
 assert.equal(detail({orders:same,receipts}).usage.count,1);assert.equal(detail({orders:same,receipts}).usage.verifiedOrderCount,3);
 for(const orders of [source.slice(1),source.map(o=>({...o,closureConfirmedAt:'2026-11-14T13:30:00Z'}))]){
  assert.equal(detail({orders,receipts,name:'BAR9'}).usage.count,null);
 }
 for(const changes of [{ref_date:'2026-11-14T13:30:00Z'},{ref_date:null},{final_amount:null},{final_amount:' '},{is_canceled:null}]){
  assert.equal(detail({orders:source,receipts:[{...receipts[0],...changes}],name:'BAR9'}).usage.count,null);
 }
});

test('03:00 cutoff uses configured businessDate; previous-day receipts cannot create new uses',()=>{
 for(const stamp of ['2026-11-14T02:59:59+07:00','2026-11-14T03:00:00+07:00']){
  const at=new Date(stamp),day=calculateStoreBusinessDate(at),orders=[order('boundary','BAR4',{
   businessDate:day,orderDate:at.toISOString(),providerObservedAt:at.toISOString()})],sync={businessDate:day,lastSuccessAt:at.toISOString(),lastAttemptAt:at.toISOString(),lastErrorCode:null};
  assert.equal(detail({orders,at,day,sync}).usage.count,1);
  assert.equal(detail({receipts:[row(1,{business_date:'2026-11-12'})],at,day,sync}).usage.count,null);
 }
});

test('tile order-start clock selects earliest verified current start only, regardless of machine timezone',()=>{
 const data=overview({catalog:babaTableCatalog(),orders:[order('early','BAR4',{orderDate:'2026-11-13T11:07:00Z'}),
  order('later','BAR4',{orderDate:'2026-11-13T12:00:00Z'})]}),tile=data.tables.find(t=>t.name==='BAR4');
 const call=t=>verifiedOrderStart(t,data.snapshotAt,data.serverNow,data.snapshotStatus,data.businessDate);
 assert.equal(call(tile),'2026-11-13T11:07:00Z');
 for(const state of ['unknown','idle','paid','reserved','free'])assert.equal(call({...tile,state}),null);
 for(const fields of [{startedAt:'invalid'},{startedAt:'2026-11-14T13:30:00Z'},{startedAt:'2026-11-12T13:30:00Z'},
  {startedAt:'2026-11-13'},{collectedAt:null},{collectedAt:'2026-11-13T10:00:00Z'},{collectedAt:'2026-11-14T13:30:00Z'}]){
  assert.equal(call({...tile,orders:tile.orders.map((o,i)=>i?o:{...o,...fields})}),null);
 }
 assert.equal(call({...tile,orders:tile.orders.map(o=>({...o,verifiedOpen:false}))}),null);
 assert.equal(verifiedOrderStart(tile,data.snapshotAt,data.serverNow,'stale',data.businessDate),null);
});
