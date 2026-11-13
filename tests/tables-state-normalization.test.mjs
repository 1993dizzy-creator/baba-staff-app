import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTableOverview} from '../lib/sales/table-overview.ts';
import {babaTableCatalog} from '../lib/sales/baba-table-catalog.ts';
import {input,order,now,businessDate} from './helpers/table-overview-fixture.mjs';
import {calculateStoreBusinessDate} from '../lib/store-settings/business-time-core.ts';
const view=changes=>buildTableOverview(input({catalog:babaTableCatalog(),orders:[],...changes}));
const tile=(v,name='BAR4')=>v.tables.find(t=>t.name===name);
const receipt=(changes={})=>({orderId:'paid-order',receiptId:1,paymentStatus:3,isCanceled:false,businessDate,tableName:'BAR4',paidAt:now.toISOString(),...changes});
test('fresh zero orders: actual 27 idle seats, no physical vacancy claim and real 0/0 counts',()=>{
 const v=view();assert.ok(v.tables.every(t=>t.state==='idle'));assert.deepEqual(v.summary,{total:27,occupied:0,paid:0,free:null,reserved:null,unknown:0});
});
test('before collection: waiting is not a failure, but unobserved counts stay null; actual read/collection failures remain unknown',()=>{
 const at=new Date('2026-11-13T09:00:00+07:00');
 const changes={now:at,sync:null};const v=view(changes);assert.equal(v.snapshotStatus,'waiting');assert.ok(v.tables.every(t=>t.state==='idle'));assert.equal(v.summary.occupied,null);assert.equal(v.summary.paid,null);
 for(const c of [{readFailed:true},{sync:{businessDate,lastSuccessAt:null,lastAttemptAt:at.toISOString(),lastErrorCode:'provider_timeout'}}]){
  const failed=view({...changes,...c});assert.ok(failed.tables.every(t=>t.state==='unknown'));assert.notEqual(failed.snapshotStatus,'waiting');
 }
 assert.ok(view({sync:null}).tables.every(t=>t.state==='unknown'));
});
for(const status of [1,3])test(`Status ${status}: fresh exact-name order ignores historical availability`,()=>{
 for(const available of [true,false,null]){const catalog=babaTableCatalog();catalog.tables=catalog.tables.map(t=>({...t,available}));const v=view({catalog,orders:[order('live','BAR4',{status})]});assert.equal(tile(v).state,'occupied');assert.equal(v.summary.occupied,1);assert.equal(v.summary.paid,0);}
});
test('Status 4 with absent table name is mapped by independent paid receipt, not raw status alone',()=>{
 const orders=[order('paid-order',null,{status:4,lines:null})];const v=view({orders,receipts:[receipt()]});assert.equal(tile(v).state,'paid');assert.equal(tile(v).orders[0].tableName,'BAR4');assert.equal(tile(v).orders[0].verifiedOpen,false);assert.equal(v.summary.paid,1);
 assert.notEqual(tile(view({orders})).state,'paid');
});
test('receipts without retained snapshot orders still supply payment evidence; multiple receipts count a table once',()=>{
 const v=view({receipts:[receipt(),receipt({receiptId:2,orderId:'second'})]});assert.equal(v.summary.paid,1);assert.equal(tile(v).state,'paid');assert.equal(tile(v).lastPaidAt,now.toISOString());
});
test('new valid order wins over earlier completed orders and multiple simultaneous current orders count one table',()=>{
 const old=order('paid-order',null,{status:4});const a=order('new-a','BAR4'),b=order('new-b','BAR4');const v=view({orders:[old,a,a,b],receipts:[receipt()]});assert.equal(tile(v).state,'occupied');assert.equal(v.summary.occupied,1);assert.equal(v.summary.paid,0);assert.equal(tile(v).orders.length,3);
});
test('canceled-only receipts do not pay a table; canceled and reissued receipts count once',()=>{
 for(const changes of [{isCanceled:true},{paymentStatus:4},{paymentStatus:5}])assert.equal(view({receipts:[receipt(changes)]}).summary.paid,0);
 const receipts=[receipt({isCanceled:true}),receipt({receiptId:2})];const v=view({orders:[order('paid-order',null,{status:4})],receipts});assert.equal(tile(v).state,'paid');assert.equal(v.summary.paid,1);
 const reopened=view({orders:[order('paid-order','BAR4')],receipts:[receipt({isCanceled:true})]});assert.equal(tile(reopened).state,'unknown');
});
test('multiple active receipts, contradictory duplicate identities and null cancellation cannot certify payment',()=>{
 const duplicate=view({receipts:[receipt(),receipt({receiptId:2})]});assert.equal(tile(duplicate).state,'unknown');assert.equal(duplicate.summary.paid,null);
 const conflict=view({receipts:[receipt(),receipt({tableName:'BAR6'})]});assert.ok(conflict.tables.every(t=>t.state==='unknown'));
 assert.notEqual(tile(view({receipts:[receipt({isCanceled:null})]})).state,'paid');
 const exact=view({receipts:[receipt(),receipt()]});assert.equal(exact.summary.paid,1);
});
test('composite receipt table names stay unallocated and cannot inflate paid count',()=>{
 const v=view({orders:[order('paid-order',null,{status:4})],receipts:[receipt({tableName:'BAR10, BAR6'})]});assert.equal(v.tables.filter(t=>t.state==='paid').length,0);assert.equal(v.unlinkedReceiptCount,1);assert.equal(v.summary.paid,null);assert.equal(v.unlinked.length,1);assert.ok(v.tables.every(t=>t.state==='idle'));
});
test('current unresolved order names are surfaced rather than guessed; mismatched order/receipt names are errors',()=>{
 const unlinked=view({orders:[order('ambiguous','BAR10, BAR6')]});assert.ok(unlinked.tables.every(t=>t.state==='unknown'));assert.equal(unlinked.summary.occupied,null);
 const mismatch=view({orders:[order('paid-order','BAR6',{status:4})],receipts:[receipt()]});assert.equal(tile(mismatch,'BAR6').state,'unknown');assert.equal(mismatch.summary.paid,null);
});
test('stale snapshots, incomplete collection, stale individual rows, future timestamps and raw OrderId conflicts never become green',()=>{
 const sync=input().sync;
 for(const changes of [{sync:{...sync,lastSuccessAt:'2026-11-13T10:00:00Z'}},{sync:{...sync,lastErrorCode:'orders_vanished_unconfirmed'}},{sync:{...sync,lastSuccessAt:'2026-11-13T14:00:00Z'}},{orders:[order('x','BAR4',{providerObservedAt:'2026-11-13T10:00:00Z'})]},{orders:[order('x','BAR4'),order('x','BAR6')]}]){
  const v=view({orders:[order('x','BAR4')],...changes});assert.equal(tile(v).state,'unknown');assert.equal(v.summary.occupied,null);
 }
});
test('malformed/future payment time, other-day receipts and missing OrderId do not certify paid',()=>{
 for(const changes of [{paidAt:null},{paidAt:'invalid'},{paidAt:'2026-11-14T13:30:00Z'},{businessDate:'2026-11-12'},{orderId:''}])assert.notEqual(tile(view({receipts:[receipt(changes)]})).state,'paid');
});
test('03:00 cutoff: prior business-day receipts disappear exactly at boundary',()=>{
 const paidAt='2026-11-13T02:59:00+07:00';
 for(const stamp of ['2026-11-13T02:59:59+07:00','2026-11-13T03:00:00+07:00']){
  const at=new Date(stamp),day=calculateStoreBusinessDate(at);const v=view({now:at,businessDate:day,sync:{businessDate:day,lastSuccessAt:at.toISOString(),lastAttemptAt:null,lastErrorCode:null},receipts:[receipt({paidAt,businessDate:'2026-11-12'})]});assert.equal(tile(v).state,day==='2026-11-12'?'paid':'idle');
 }
});
test('latest valid receipt is retained without a fabricated completion expiry timer',()=>{
 const v=view({receipts:[receipt({paidAt:'2026-11-13T12:00:00Z'}),receipt({receiptId:2,orderId:'last',paidAt:'2026-11-13T13:00:00Z'})]});assert.equal(tile(v).lastPaidAt,'2026-11-13T13:00:00Z');assert.equal(tile(v).state,'paid');
});

test('revoked completed predecessor does not block a different fresh open order; canceled payment is not shown as completed',()=>{
 const orders=[order('paid-order','BAR4',{status:4}),order('new','BAR4')];
 const v=view({orders,receipts:[receipt({isCanceled:true})]});assert.equal(tile(v).state,'occupied');assert.equal(v.summary.occupied,1);assert.equal(v.summary.paid,0);
 assert.equal(tile(view({orders:[orders[0]],receipts:[receipt({isCanceled:true})]})).state,'idle');
});

test('future per-order observations, invalid chronological payment evidence and mismatched names are actual exceptions',()=>{
 const v=view({orders:[order('x','BAR4',{providerObservedAt:'2026-11-13T13:30:01Z'})]});assert.equal(tile(v).state,'unknown');
 const mismatch=view({orders:[order('paid-order','BAR6',{status:4})],receipts:[receipt()]});assert.equal(tile(mismatch,'BAR4').state,'unknown');assert.equal(tile(mismatch,'BAR6').state,'unknown');
 const earlier=view({orders:[order('paid-order','BAR4',{status:4})],receipts:[receipt({paidAt:'2026-11-13T12:00:00Z'})]});assert.equal(tile(earlier).state,'unknown');
});

test('Owner-observed 20 paid receipts / 16 table names replay: paid count is 16, not receipt count or 27 unknown',()=>{
 const names=babaTableCatalog().tables.slice(0,16).map(t=>t.name);
 const receipts=Array.from({length:20},(_,i)=>receipt({receiptId:i+1,orderId:'observed-'+i,tableName:names[i%16]}));
 const orders=receipts.map(r=>order(r.orderId,null,{status:4,lines:null}));
 const v=view({orders,receipts});assert.equal(v.summary.paid,16);assert.equal(v.summary.occupied,0);assert.equal(v.summary.unknown,0);assert.equal(v.tables.filter(t=>t.state==='idle').length,11);
});
