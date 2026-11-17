import * as refresh from '../lib/sales/table-detail-refresh.ts';
import {createFallbackBusinessTimeSnapshot} from '../lib/store-settings/business-time-adapter-core.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectTableDetail, detailNumber } from '../lib/sales/table-detail.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';
import { overview, order, now, businessDate } from './helpers/table-overview-fixture.mjs';
import { calculateStoreBusinessDate, addStoreDays } from '../lib/store-settings/business-time-core.ts';
import { loadTs, authHarness, nextMock } from './helpers/sales-auth-harness.mjs';
import * as core from '../lib/pos/cukcuk/open-orders-core.ts';
import * as projection from '../lib/sales/table-overview.ts';
import * as detail from '../lib/sales/table-detail.ts';
import { evaluateOpenOrdersCronWindow } from '../lib/pos/cukcuk/open-orders-cron-policy.ts';

export const receipt = (id, changes={}) => ({id,order_id:'paid-'+id,ref_no:String(id),business_date:businessDate,
 table_name:'BAR4',ref_date:now.toISOString(),final_amount:'100000',payment_status:3,is_canceled:false,status_changed_at:null,...changes});
export function fixture({rows=[],orders=[],name='BAR4',at=now,day=businessDate,sync,collectionExpected=true}={}) {
 const catalog=babaTableCatalog();
 const view=overview({catalog,orders,now:at,businessDate:day,collectionExpected,...(sync===undefined?{}:{sync}),
  receipts:rows.map(r=>({orderId:r.order_id??'',receiptId:r.id,businessDate:r.business_date,tableName:r.table_name,
   paidAt:r.ref_date,paymentStatus:r.payment_status,isCanceled:r.is_canceled}))});
 return projectTableDetail({table:view.tables.find(t=>t.name===name),catalog:catalog.tables,overview:view,orders,receipts:rows,now:at,historyFrom:addStoreDays(day,-7)});
}

test('multiple payments, cancellation and reissue: latest valid receipt first; no count mutation or private payload',()=>{
 const rows=[receipt(10,{order_id:'same',payment_status:4,is_canceled:true}),receipt(11,{order_id:'same'}),receipt(12,{ref_date:'2026-11-13T13:00:00Z'})];
 const before=JSON.stringify(rows),d=fixture({rows});
 assert.deepEqual(d.current.map(r=>r.id),[11,10,12]);assert.equal(d.latest.id,11);assert.equal(d.latest.reissued,true);
 assert.equal(d.current.find(r=>r.id===10).canceled,true);assert.equal(d.table.state,'paid');
 assert.equal(d.cleaning.reason,'storage_not_approved');assert.equal(d.cleaning.enabled,false);
 assert.equal(d.timer.enabled,false);assert.equal(JSON.stringify(rows),before);
 assert.doesNotMatch(JSON.stringify(d),/raw_json|customer|status_changed_at/);
 const view=overview({catalog:babaTableCatalog(),orders:[],receipts:rows.map(r=>({orderId:r.order_id,receiptId:r.id,businessDate:r.business_date,tableName:r.table_name,paidAt:r.ref_date,paymentStatus:r.payment_status,isCanceled:r.is_canceled}))});
 assert.equal(view.summary.paid,1);assert.equal(view.tables.length,27);
});

test('two active receipts, null cancellation, future time, missing amount, duplicate conflicts never certify latest',()=>{
 for(const rows of [[receipt(1,{order_id:'same'}),receipt(2,{order_id:'same'})],[receipt(1,{is_canceled:null})],
  [receipt(1,{ref_date:'2026-11-14T13:30:00Z'})],[receipt(1,{final_amount:null})]]) {
  const d=fixture({rows});assert.equal(d.latest,null);assert.ok(d.current.every(r=>r.uncertain));assert.equal(d.cleaning.enabled,false);
 }
 assert.throws(()=>fixture({rows:[receipt(1),receipt(1,{final_amount:123})]}),/CONFLICT/);
 assert.equal(detailNumber(''),null);assert.equal(detailNumber(null),null);assert.equal(detailNumber('100000'),100000);
});

test('current order wins; no cleanup or timer at 29:59, 30:00 or 30:01 using uncertified ref/status observation time',()=>{
 for(const seconds of [1799,1800,1801]){
  const at=new Date(now.getTime()+seconds*1000),sync={businessDate,lastSuccessAt:at.toISOString(),lastAttemptAt:at.toISOString(),lastErrorCode:null};
  const d=fixture({rows:[receipt(1,{status_changed_at:now.toISOString()})],at,sync});
  assert.equal(d.table.state,'paid');assert.deepEqual(d.timer,{enabled:false,reason:'unverified_payment_time'});
  assert.equal(d.cleaning.enabled,false);assert.equal('deadline' in d,false);
 }
 const d=fixture({rows:[receipt(1)],orders:[order('new-order','BAR4')]});
 assert.equal(d.table.state,'occupied');assert.equal(d.cleaning.reason,'active_orders');
});

test('03:00 boundary and previous history: old receipts never become current settlements',()=>{
 for(const stamp of ['2026-11-14T02:59:59+07:00','2026-11-14T03:00:00+07:00']){
  const at=new Date(stamp),day=calculateStoreBusinessDate(at),r=receipt(1);
  const d=fixture({rows:[r],at,day,sync:null,collectionExpected:false});
  assert.equal(d.current.length,day===businessDate?1:0);assert.equal(d.previous.length,day===businessDate?0:1);
  assert.equal(d.cleaning.enabled,false);
 }
 const d=fixture({rows:[receipt(1,{business_date:'2026-10-01'})]});assert.equal(d.previous.length,0);
});

test('BAR8/BAR9/BAR11 and #8885: v3 relationships outrank receipt table 2, never infer seat movement',()=>{
 const rows=[receipt(8885,{order_id:'target',table_name:'2',final_amount:1090000})];
 const orders=[order('target','BAR8',{status:4}),...['BAR9','BAR11'].map((name,i)=>order('member-'+i,name,{
  closureReceiptId:8885,closureMergedIntoOrderId:'target',closureConfirmedAt:now.toISOString()}))];
 for(const name of ['BAR8','BAR9','BAR11']){
  const d=fixture({rows,orders,name});assert.equal(d.current.length,1);assert.equal(d.current[0].link,'verified_merge');
  assert.equal(d.merges.length,1);assert.deepEqual(d.merges[0].tables,['BAR9','BAR11','BAR8']);
  assert.equal(d.merges[0].receiptTable,'2');assert.equal(d.cleaning.enabled,false);
 }
 assert.equal(fixture({rows,orders,name:'2'}).current.length,0);
 const canceled=rows.map(r=>({...r,is_canceled:true,payment_status:4}));
 const d=fixture({rows:canceled,orders,name:'BAR9'});assert.equal(d.merges[0].verified,false);assert.equal(d.latest,null);
 assert.equal(fixture({rows,orders:orders.filter(o=>o.orderId!=='target'),name:'BAR9'}).merges[0].verified,false);
});

test('failed or delayed collection cannot offer cleanup even with a receipt',()=>{
 const rows=[receipt(1)];
 for(const sync of [null,{businessDate,lastSuccessAt:'2026-11-13T10:00:00Z',lastAttemptAt:now.toISOString(),lastErrorCode:null},
  {businessDate,lastSuccessAt:now.toISOString(),lastAttemptAt:now.toISOString(),lastErrorCode:'incomplete'}]){
  const d=fixture({rows,sync});assert.equal(d.cleaning.reason,'snapshot_unhealthy');assert.equal(d.cleaning.enabled,false);
 }
});

test('detail API authenticates all five roles, rejects unknown ids and hides internal errors',async()=>{
 const old=process.env.BABA_SESSION_SECRET;process.env.BABA_SESSION_SECRET='offline-only-detail-test-session-secret';
 try{
  const tableId=babaTableCatalog().tables[0].id;
  for(const role of [null,'master','owner','manager','leader','staff']){
   const h=authHarness();if(role){h.setActor({role});h.sign();}let reads=0;
   const api=loadTs('app/api/tables/[id]/detail/route.ts',{'next/server':nextMock,'@/lib/auth/server-auth':h.auth,'@/lib/sales/table-detail-refresh':refresh,
    '@/lib/sales/table-detail-server':{readTableDetail:async()=>{reads++;return {synthetic:true};}}});
   const res=await api.GET(new Request('http://offline.test'),{params:Promise.resolve({id:tableId})});
   assert.equal(res.status,role?200:401);assert.equal(reads,role?1:0);assert.equal(res.headers.get('Cache-Control'),'private, no-store');
   assert.deepEqual(Object.keys(api).sort(),['GET','dynamic']);
   if(role){assert.equal((await api.GET(null,{params:Promise.resolve({id:'invalid'})})).status,404);}
  }
  const h=authHarness();h.setActor({role:'staff'});h.sign();
  const api=loadTs('app/api/tables/[id]/detail/route.ts',{'next/server':nextMock,'@/lib/auth/server-auth':h.auth,'@/lib/sales/table-detail-refresh':refresh,
   '@/lib/sales/table-detail-server':{readTableDetail:async()=>{throw Error('secret-not-to-return');}}});
  const res=await api.GET(null,{params:Promise.resolve({id:tableId})});assert.equal(res.status,503);assert.doesNotMatch(JSON.stringify(await res.json()),/secret/);
 }finally{if(old===undefined)delete process.env.BABA_SESSION_SECRET;else process.env.BABA_SESSION_SECRET=old;}
});

test('detail server uses only local snapshot and narrow receipt/line projections; disabled reads do no work',async()=>{
 const old=process.env.POS_OPEN_ORDERS_READ_ENABLED,originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>assert.fail('no CUKCUK or external calls');
 try{
  const calls=[],base=overview({catalog:babaTableCatalog(),orders:[]}),r=receipt(1);
  let failLines=false;
  const service=loadTs('lib/sales/table-detail-server.ts',{
   'server-only':{},'./table-detail':detail,'./table-overview':projection,
   './table-overview-server':{validOrders:orders=>Array.isArray(orders)},'./baba-table-catalog':{babaTableCatalog},
   '@/lib/store-settings/business-time-adapter':{loadBusinessTimeAdapter:async()=>({databaseBusinessDate:businessDate,snapshot:createFallbackBusinessTimeSnapshot('2026-11-13'),context:{isOpen:true}})},
   '@/lib/store-settings/business-time-core':{addStoreDays},'@/lib/pos/cukcuk/open-orders-core':core,
   '@/lib/pos/cukcuk/open-orders-cron-policy':{evaluateOpenOrdersCronWindow},'@/lib/pos/cukcuk/open-orders-scope':{openOrdersScope:()=> 'offline'},
   './daily-sales-summary':{fetchAllExactPages:async fn=>fn(0,999)},
   '@/lib/supabase/server':{supabaseServer:{rpc(name,args){calls.push(['rpc',name,args]);return {abortSignal:async()=>({data:{sync:{businessDate,lastSuccessAt:now.toISOString(),lastAttemptAt:now.toISOString(),lastErrorCode:null},orders:[]},error:null})};},
    from(table){const q={};for(const m of ['select','eq','gte','lte','in','order','abortSignal'])q[m]=(...args)=>{calls.push([table,m,...args]);return q;};
     q.range=async()=>({data:table==='pos_sales_receipts'?[r]:[{id:1,receipt_id:1,item_name:'Synthetic menu',quantity:'2',final_amount:'100000',is_canceled:false}],error:failLines&&table==='pos_sales_receipt_lines'?{message:'offline'}:null});return q;}}},
  });
  process.env.POS_OPEN_ORDERS_READ_ENABLED='false';await assert.rejects(service.readTableDetail(base.tables[3].id,now),/DISABLED/);assert.equal(calls.length,0);
  process.env.POS_OPEN_ORDERS_READ_ENABLED='true';assert.equal(await service.readTableDetail('unknown',now),null);
  const d=await service.readTableDetail(base.tables[3].id,now);assert.equal(d.latest.lines[0].amount,100000);
  assert.ok(calls.some(c=>c[0]==='pos_sales_receipts'&&c[1]==='gte'&&c[3]===businessDate));
  assert.equal(d.historyFrom,businessDate);assert.deepEqual(d.previous,[]);
  assert.ok(calls.some(c=>c[0]==='pos_sales_receipt_lines'&&c[1]==='in'&&c[2]==='receipt_id'));
  for(const call of calls.filter(c=>c[1]==='select'))assert.doesNotMatch(call[2],/customer|raw_json(?!->>)/);
  failLines=true;await assert.rejects(service.readTableDetail(base.tables[3].id,now),/LINES_UNAVAILABLE/);
  assert.equal(d.cleaning.enabled,false);
 }finally{globalThis.fetch=originalFetch;if(old===undefined)delete process.env.POS_OPEN_ORDERS_READ_ENABLED;else process.env.POS_OPEN_ORDERS_READ_ENABLED=old;}
 assert.doesNotMatch(readFileSync('lib/sales/table-detail-server.ts','utf8'),/\.insert\(|\.update\(|\.delete\(|loginCukcuk|runCentral/);
});

test('detail service and HTTP distinguish context, snapshot, receipts, lines and unknown failures without leaking exception text',async()=>{
 const names=['POS_OPEN_ORDERS_READ_ENABLED','BABA_TABLE_CLEANING_ENABLED','BABA_TABLE_AUTO_NORMAL_ENABLED'],saved=names.map(n=>process.env[n]);
 process.env.POS_OPEN_ORDERS_READ_ENABLED='true';process.env.BABA_TABLE_CLEANING_ENABLED='false';process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='false';
 let stage='empty',lineReads=0;
 const catalog=babaTableCatalog(),id=catalog.tables.find(t=>t.name==='BAR4').id,secret='secret-token-customer-internal-SQL';
 const service=loadTs('lib/sales/table-detail-server.ts',{
  'server-only':{},'./table-detail':detail,'./table-overview':projection,'./table-overview-server':{validOrders:o=>Array.isArray(o)},'./baba-table-catalog':{babaTableCatalog},
  '@/lib/store-settings/business-time-adapter':{loadBusinessTimeAdapter:async()=>{if(stage==='context')throw Error(secret);return {databaseBusinessDate:businessDate,snapshot:createFallbackBusinessTimeSnapshot(businessDate),context:{isOpen:true}};}},
  '@/lib/store-settings/business-time-core':{addStoreDays},'@/lib/pos/cukcuk/open-orders-core':core,'@/lib/pos/cukcuk/open-orders-cron-policy':{evaluateOpenOrdersCronWindow},'@/lib/pos/cukcuk/open-orders-scope':{openOrdersScope:()=> 'offline'},
  './daily-sales-summary':{fetchAllExactPages:async fn=>fn(0,999)},
  '@/lib/supabase/server':{supabaseServer:{rpc(){return {abortSignal:async()=>{
   if(stage==='snapshot-reject')throw Error(secret);
   return {data:{sync:{businessDate,lastSuccessAt:now.toISOString(),lastAttemptAt:now.toISOString(),lastErrorCode:null},orders:[]},error:stage==='snapshot'?{message:secret}:null};
  }};},from(table){const q={};for(const m of ['select','eq','gte','lte','in','order','abortSignal'])q[m]=()=>q;
   q.range=async()=>{if(table==='pos_sales_receipt_lines')lineReads++;
    if(stage==='receipts-reject'&&table==='pos_sales_receipts')throw Error(secret);
    return {data:table==='pos_sales_receipts'?(stage==='empty'?[]:[receipt(1)]):[],error:stage===(table==='pos_sales_receipts'?'receipts':'lines')?{message:secret}:null};
   };return q;}}},
 });
 const api=loadTs('app/api/tables/[id]/detail/route.ts',{'next/server':nextMock,'@/lib/auth/server-auth':{getAuthenticatedActor:async()=>({ok:true})},'@/lib/sales/table-detail-refresh':refresh,
  '@/lib/sales/table-detail-server':{readTableDetail:async()=>{if(stage==='unknown')throw Object.assign(Error(secret),{detailStage:secret});return service.readTableDetail(id,now);}}});
 try{
  for(const [value,expected]of [['empty',null],['success',null],['context','context'],['snapshot','snapshot'],['snapshot-reject','snapshot'],['receipts','receipts'],['receipts-reject','receipts'],['lines','lines'],['unknown','detail']]){
   stage=value;const res=await api.GET(null,{params:Promise.resolve({id})}),body=await res.json();
   assert.equal(res.status,expected?503:200,value);assert.doesNotMatch(JSON.stringify(body),new RegExp(secret));
   if(expected)assert.deepEqual(body,{ok:false,...refresh.detailFailure(expected)});
   else {assert.equal(body.ok,true);if(value==='empty'){assert.deepEqual(body.detail.current,[]);assert.equal(lineReads,0);}}
  }
  for(const stage of ['__proto__','constructor',secret,{},null])assert.equal(refresh.detailFailure(stage).stage,'detail');
 }finally{names.forEach((n,i)=>{if(saved[i]===undefined)delete process.env[n];else process.env[n]=saved[i];});}
});
