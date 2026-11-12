import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTableOverview } from '../lib/sales/table-overview.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';
import { classifyOrdersForBusinessDate } from '../lib/pos/cukcuk/open-orders-core.ts';
import { calculateStoreBusinessDate } from '../lib/store-settings/business-time-core.ts';
import { input, order, now, businessDate } from './helpers/table-overview-fixture.mjs';
import { observedFacts, replayOrders, replayPaidLinks } from './fixtures/tables-observed-shape.mjs';

const view = changes => buildTableOverview(input({catalog:babaTableCatalog(),...changes}));
const noFalseStates = result => {
  assert.equal(result.tables.length,27);
  assert.equal(result.summary.free,null); assert.equal(result.summary.paid,null); assert.equal(result.summary.reserved,null);
  assert.ok(result.tables.every(t=>!['free','paid','reserved'].includes(t.state)));
};
const unknownAll = result => { noFalseStates(result); assert.ok(result.tables.every(t=>t.state==='unknown')); };

test('observed current shape: 20 Status 4 and zero open orders do not imply 27 vacant tables', () => {
  const facts=observedFacts.current;
  const orders=Array.from({length:20},(_,i)=>order('anonymous-current-'+i,null,{
    status:4,businessDate:facts.businessDate,lines:null,providerObservedAt:facts.lastSuccessAt,
  }));
  const result=view({now:new Date(facts.checkedAt),businessDate:facts.businessDate,orders,
    sync:{businessDate:facts.businessDate,lastSuccessAt:facts.lastSuccessAt,lastAttemptAt:facts.lastSuccessAt,lastErrorCode:null}});
  unknownAll(result); assert.equal(result.summary.occupied,0);
});

test('observed historical shape is excluded from the current business day, including BAR6 with no paid evidence', () => {
  const oldDay=observedFacts.historical.businessDate;
  const orders=replayOrders({businessDate:oldDay,at:'2026-11-10T13:00:00Z'}),receipts=replayPaidLinks(oldDay);
  const result=view({orders,receipts});
  unknownAll(result); assert.ok(result.tables.every(t=>t.orders.length===0));
  const classified=classifyOrdersForBusinessDate(orders,receipts,businessDate);
  assert.equal(classified.otherBusinessDate,8); assert.equal(classified.open.length,0);
});

test('synthetic current-day replay: valid Status 1 and 3 reuse the shared classifier, not raw header status alone', () => {
  for(const status of [1,3]) {
    const orders=replayOrders({businessDate,at:now.toISOString(),status});
    const classified=classifyOrdersForBusinessDate(orders,[],businessDate),result=view({orders});
    assert.equal(classified.open.length,8); assert.equal(result.summary.occupied,8);
    noFalseStates(result);
  }
});

test('synthetic seven-paid-link replay: paid-linked orders never cause green; remaining BAR6 is only a simulated candidate', () => {
  const orders=replayOrders({businessDate,at:now.toISOString()}),receipts=replayPaidLinks(businessDate);
  const classified=classifyOrdersForBusinessDate(orders,receipts,businessDate),result=view({orders,receipts});
  assert.equal(classified.converted,7); assert.deepEqual(classified.open.map(o=>o.tableName),['BAR6']);
  assert.equal(result.summary.occupied,1); noFalseStates(result);
  for(const table of result.tables)assert.equal(table.state,table.name==='BAR6'?'occupied':'unknown');
});

test('BAR4/BAR6 and floor names retain exact actual catalog identity and separate original areas', () => {
  const orders=replayOrders({businessDate,at:now.toISOString()}),result=view({orders});
  for(const name of observedFacts.historical.tableNames){
    const tile=result.tables.find(t=>t.name===name),source=babaTableCatalog().tables.find(t=>t.name===name);
    assert.equal(tile.id,source.id); assert.equal(tile.areaId,source.areaId); assert.equal(tile.areaName,source.areaName);
    assert.equal(tile.orders.length,1); assert.equal(tile.orders[0].tableName,name);
    assert.equal(tile.area,name.startsWith('BAR')?'bar':Number(name)<10?'floor1':'floor2');
  }
});

test('same-table multiple valid OrderIds remain separate; identical repeats do not duplicate order amounts', () => {
  const a=order('a','BAR4'),b=order('b','BAR4');
  const result=view({orders:[a,a,b]}),tile=result.tables.find(t=>t.name==='BAR4');
  assert.equal(result.summary.occupied,1); assert.equal(tile.orders.length,2);
  assert.equal(tile.orders[0].number,tile.orders[1].number);
  assert.deepEqual(tile.orders.map(o=>[o.id,o.amount]),[['a',100000],['b',100000]]);
});

test('regression: confirmed paid predecessor must not block another valid current order on the same table', () => {
  const orders=[order('paid-previous','BAR4'),order('valid-current','BAR4')];
  const receipts=[{orderId:'paid-previous',receiptId:900,paymentStatus:3,isCanceled:false,businessDate}];
  const classified=classifyOrdersForBusinessDate(orders,receipts,businessDate);
  assert.equal(classified.converted,1); assert.equal(classified.open.length,1);
  const result=view({orders,receipts}),tile=result.tables.find(t=>t.name==='BAR4');
  assert.equal(tile.state,'occupied'); assert.equal(result.summary.occupied,1);
  assert.equal(tile.orders.filter(o=>o.verifiedOpen).length,1);
  assert.equal(tile.orders.find(o=>o.id==='paid-previous').verifiedOpen,false);
  unknownAll(view({orders:[orders[0]],receipts}));
});

test('multi-table names are not split or allocated, including bare BAR', () => {
  const orders=['1+2','1,2','BAR4/BAR6','BAR'].map((name,i)=>order('composite-'+i,name));
  const result=view({orders});unknownAll(result);assert.equal(result.unlinked.length,4);
});

test('missing, duplicate and unmatched names stay unlinked, without a guessed seat', () => {
  const result=view({orders:[order('missing',null),order('mismatch','99')]});
  unknownAll(result);assert.equal(result.unlinked.length,2);
  const catalog=babaTableCatalog();catalog.tables[0].name='BAR4';
  const duplicate=view({catalog,orders:[order('duplicate','BAR4')]});
  unknownAll(duplicate);assert.equal(duplicate.unlinked.length,1);
});

test('Status 4/5/unknown and unresolved receipt conflicts never certify occupied; paid exclusion does not hide uncertainty', () => {
  for(const status of [4,5,6,7,8,null])unknownAll(view({orders:[order('status','BAR4',{status})]}));
  const a=order('valid','BAR4'),b=order('uncertain','BAR4',{status:7});
  unknownAll(view({orders:[a,b]}));
  for(const receipts of [
    [{orderId:'valid',receiptId:1,paymentStatus:3,isCanceled:true}],
    [{orderId:'valid',receiptId:1,paymentStatus:3,isCanceled:false},{orderId:'valid',receiptId:2,paymentStatus:3,isCanceled:false}],
  ])unknownAll(view({orders:[a],receipts}));
});

test('03:00 boundary changes the current business day and cannot revive previous-day orders', () => {
  for(const stamp of ['2026-11-13T02:59:59+07:00','2026-11-13T03:00:00+07:00']){
    const at=new Date(stamp),day=calculateStoreBusinessDate(at);
    const result=view({now:at,businessDate:day,orders:[order('boundary','BAR4',{businessDate:'2026-11-12',providerObservedAt:at.toISOString()})],
      sync:{businessDate:day,lastSuccessAt:at.toISOString(),lastAttemptAt:at.toISOString(),lastErrorCode:null}});
    assert.equal(result.summary.occupied,day==='2026-11-12'?1:0);
    if(day!=='2026-11-12')unknownAll(result);
  }
});

test('missing/failed/stale/incomplete/disabled snapshots and stale individual observations never certify current occupancy', () => {
  const base=input(),orders=[order('valid','BAR6')];
  const cases=[{enabled:false},{sync:null},{sync:{...base.sync,lastSuccessAt:'2026-11-13T10:00:00Z'}},
    {sync:{...base.sync,lastSuccessAt:'2026-11-13T14:00:00Z'}},
    ...['provider_timeout','read_failed','orders_vanished_unconfirmed','open_orders_vanished'].map(lastErrorCode=>({sync:{...base.sync,lastErrorCode}})),
    {orders:[order('valid','BAR6',{providerObservedAt:'2026-11-13T10:00:00Z'})]},
    {orders:[order('valid','BAR6',{lines:null})]},
  ];
  for(const changes of cases)unknownAll(view({orders,...changes}));
});
