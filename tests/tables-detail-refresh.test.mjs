import test from 'node:test';
import assert from 'node:assert/strict';
import {tableDetailEvidenceKey,selectTableDetail,unavailableTableOverview} from '../lib/sales/table-detail-refresh.ts';
import {beforeOpeningScene} from './helpers/tables-before-opening-fixture.mjs';
import {overview,order,now,businessDate} from './helpers/table-overview-fixture.mjs';
import {babaTableCatalog} from '../lib/sales/baba-table-catalog.ts';

test('five list refreshes with only server/collection timestamps changed share one detail request identity',()=>{
 const {view,table,detail}=beforeOpeningScene(),key=tableDetailEvidenceKey(view,table.id);
 for(let n=1;n<=6;n++){
  const next={...view,serverNow:new Date(Date.parse(view.serverNow)+n*60000).toISOString()};
  assert.equal(tableDetailEvidenceKey(next,table.id),key);
  assert.equal(selectTableDetail({key,detail,failed:n===5,pending:n===4},next,table.id).detail,detail);
 }
 const active=overview({catalog:babaTableCatalog(),orders:[order('live','BAR1')]}),id=active.tables[0].id;
 const later=structuredClone(active);later.serverNow=new Date(now.getTime()+60000).toISOString();later.snapshotAt=later.serverNow;
 for(const t of later.tables)for(const o of t.orders)o.collectedAt=later.serverNow;
 assert.equal(tableDetailEvidenceKey(active,id),tableDetailEvidenceKey(later,id));
});
test('same evidence retains display but a newer collection snapshot, pending/failure, or different receipt never authorizes old cleaning',()=>{
 const {view,table,detail}=beforeOpeningScene();view.snapshotStatus='ok';view.snapshotAt=view.serverNow;
 detail.snapshotStatus='ok';detail.snapshotAt=view.snapshotAt;
 const key=tableDetailEvidenceKey(view,table.id),result={key,detail,failed:false};
 assert.equal(selectTableDetail(result,view,table.id).fresh,true);
 const next={...view,serverNow:new Date(Date.parse(view.serverNow)+60000).toISOString()};next.snapshotAt=next.serverNow;
 assert.equal(tableDetailEvidenceKey(next,table.id),key);
 for(const [r,v]of [[result,next],[{...result,pending:true},view],[{...result,failed:true},view],[result,unavailableTableOverview(view)]]){
  assert.equal(selectTableDetail(r,v,table.id).fresh,false);
 }
 const changed=structuredClone(view);changed.tables.find(t=>t.id===table.id).lastPaidAt=view.serverNow;
 assert.equal(selectTableDetail(result,changed,table.id).fresh,false);
});
test('new order, menu change, state transition, business date and payment/merge/cancel/reissue evidence change request identity',()=>{
 const {view,table}=beforeOpeningScene(),key=tableDetailEvidenceKey(view,table.id);
 for(const mutate of [v=>{v.businessDate='2026-11-18';},v=>{v.beforeOpening=false;},v=>{v.tables[0].state='paid';},v=>{v.tables[0].paymentObservation={receiptId:1,expired:true};},v=>{v.tables[0].detailEvidence='receipt-reissued';}]){
  const next=structuredClone(view);mutate(next);assert.notEqual(tableDetailEvidenceKey(next,table.id),key);
 }
 const catalog=babaTableCatalog(),receipt={receiptId:91,orderId:'paid',businessDate,tableName:'BAR1',paidAt:now.toISOString(),paymentStatus:3,isCanceled:false};
 const base=overview({catalog,orders:[order('paid','BAR1',{status:4})],receipts:[receipt]});
 const baseKey=tableDetailEvidenceKey(base,table.id);
 for(const changes of [{receipts:[{...receipt,isCanceled:true}]},{receipts:[{...receipt,receiptId:92}]},
  {orders:[order('paid','BAR1',{status:4,closureReceiptId:91,closureMergedIntoOrderId:'target'})],receipts:[receipt]},
  {orders:[order('new','BAR1')],receipts:[receipt]},
  {orders:[order('paid','BAR1',{status:1,totalAmount:200000})],receipts:[]}]){
  assert.notEqual(tableDetailEvidenceKey(overview({catalog,orders:[order('paid','BAR1',{status:4})],receipts:[receipt],...changes}),table.id),baseKey);
 }
});
test('unrelated table changes do not refetch selected table details',()=>{
 const {view,table}=beforeOpeningScene(),next=structuredClone(view);
 next.tables[1].detailEvidence='other receipt';next.tables[1].state='paid';
 assert.equal(tableDetailEvidenceKey(next,table.id),tableDetailEvidenceKey(view,table.id));
});
import {cleaningServiceFixture} from './helpers/tables-cleaning-service-fixture.mjs';

test('isolated SQL receipt amount/number correction changes detail identity while table state and counts remain unchanged',async()=>{
 const names=['BABA_TABLE_CLEANING_ENABLED','POS_OPEN_ORDERS_READ_ENABLED','BABA_TABLE_AUTO_NORMAL_ENABLED'],saved=names.map(n=>process.env[n]);
 process.env.BABA_TABLE_CLEANING_ENABLED='true';process.env.POS_OPEN_ORDERS_READ_ENABLED='true';process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='false';
 const f=await cleaningServiceFixture();
 try{
  const before=(await f.service.readCleaningState()).overview;
  const original=await f.db.query('select id,final_amount,ref_no,status_changed_at from pos_sales_receipts where id=100');assert.equal(original.rows.length,1);
  await f.db.exec("update pos_sales_receipts set final_amount=150000,ref_no='corrected-100',status_changed_at=clock_timestamp() where id=100");
  const after=(await f.service.readCleaningState()).overview;
  assert.notEqual(tableDetailEvidenceKey(before,f.tableId),tableDetailEvidenceKey(after,f.tableId));
  assert.equal(before.tables.find(t=>t.id===f.tableId).state,after.tables.find(t=>t.id===f.tableId).state);
  assert.deepEqual(before.summary,after.summary);
 }finally{await f.db.close();names.forEach((n,i)=>{if(saved[i]===undefined)delete process.env[n];else process.env[n]=saved[i];});}
});

test('a stale detail body with the same snapshot timestamp cannot certify a new receipt or undo cleaning',()=>{
 const {view,table,detail}=beforeOpeningScene();view.snapshotStatus='ok';view.snapshotAt=view.serverNow;detail.snapshotStatus='ok';detail.snapshotAt=view.snapshotAt;
 const next=structuredClone(view);next.tables.find(t=>t.id===table.id).detailEvidence='new receipt version';
 const stale={key:tableDetailEvidenceKey(next,table.id),detail,failed:false};
 const result=selectTableDetail(stale,next,table.id);assert.equal(result.fresh,false);assert.equal(result.paymentChanged,true);assert.equal(result.tile,next.tables.find(t=>t.id===table.id));
 const oldPaid={...detail,table:{...table,state:'paid'}},cleaned={key:tableDetailEvidenceKey(view,table.id),detail:oldPaid,failed:false};
 assert.equal(selectTableDetail(cleaned,view,table.id).fresh,false);assert.equal(selectTableDetail(cleaned,view,table.id).tile.state,'idle');
});
