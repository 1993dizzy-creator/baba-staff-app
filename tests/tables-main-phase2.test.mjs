import test from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {overview,order,now,businessDate} from './helpers/table-overview-fixture.mjs';
import {babaTableCatalog} from '../lib/sales/baba-table-catalog.ts';
import {compactOrderAmount,verifiedCurrentOrderAmount} from '../lib/sales/table-tile-amount.ts';
import {tablesNavigationText} from '../lib/text/tables-navigation.ts';
import {cleaningServiceFixture} from './helpers/tables-cleaning-service-fixture.mjs';
import {addOrder} from './helpers/tables-cleaning-fixture.mjs';
const catalog=babaTableCatalog();
const receipt=(receiptId,orderId,tableName='BAR4',changes={})=>({receiptId,orderId,tableName,businessDate,
 paidAt:now.toISOString(),paymentStatus:3,isCanceled:false,...changes});
const paid=(key,name='BAR4',changes={})=>order(key,name,{status:4,orderDate:'2026-11-13T12:00:00Z',...changes});
const run=(orders=[],receipts=[],extra={})=>overview({catalog,orders,receipts,...extra});

test('completion receipts count independently of current paid tiles or visits',()=>{
 const first=run([paid('one')],[receipt(1,'one')]),before=JSON.stringify(first);
 assert.equal(first.summary.paid,1);assert.equal(first.summary.paidCumulative,1);
 const two=run([paid('one'),paid('two')],[receipt(1,'one'),receipt(2,'two')]);
 assert.equal(two.summary.paid,1);assert.equal(two.summary.paidCumulative,2);
 assert.equal(two.summary.paidCumulativeEvidence.reason,'verified_receipts');
 const active=run([paid('one'),order('new','BAR4')],[receipt(1,'one')]);
 assert.equal(active.tables.find(t=>t.name==='BAR4').state,'occupied');assert.equal(active.summary.paidCumulative,1);
 assert.equal(JSON.stringify(first),before);
});

test('repeated OrderId and cancellation/reissue are one completion; ambiguous active receipts never count',()=>{
 const o=paid('one'),r=receipt(1,'one');
 assert.equal(run([o,o],[r,r]).summary.paidCumulative,1);
 assert.equal(run([o],[{...r,isCanceled:true,paymentStatus:4},receipt(2,'one')]).summary.paidCumulative,1);
 const conflict=run([o],[r,receipt(2,'one')]);
 assert.equal(conflict.summary.paidCumulative,null);assert.equal(conflict.summary.paidCumulativeEvidence.reason,'evidence_conflict');
 assert.equal(conflict.summary.paidCumulativeEvidence.count,null);
 assert.equal(run([o],[{...r,isCanceled:true,paymentStatus:4}]).summary.paidCumulative,0);
 for(const changed of [{isCanceled:null},{paidAt:'invalid'},{paidAt:'2026-11-14T13:30:00Z'},{orderId:''}])assert.equal(run([o],[{...r,...changed}]).summary.paidCumulative,null);
});

test('#8885 is one paid receipt regardless of merged source tables, missing names or movement',()=>{
 const orders=[paid('target','BAR8'),...['BAR9','BAR11'].map((name,i)=>order('member-'+i,name,{orderDate:'2026-11-13T12:00:00Z',
  closureReceiptId:8885,closureMergedIntoOrderId:'target',closureConfirmedAt:now.toISOString()}))];
 const rows=[receipt(8885,'target','2')],e=run(orders,rows).summary.paidCumulativeEvidence;
 assert.equal(e.count,1);
 const same=orders.map(o=>({...o,tableName:'BAR4'}));assert.equal(run(same,rows).summary.paidCumulative,1);
 for(const group of [orders.slice(1),orders.map(o=>({...o,closureConfirmedAt:'2026-11-14T13:30:00Z'}))]){
  assert.equal(run(group,rows).summary.paidCumulative,1);
 }
 const moved=run([paid('one')],[receipt(1,'one','BAR6')]).summary.paidCumulativeEvidence;
 assert.equal(moved.reason,'verified_receipts');assert.equal(moved.count,1);
});

test('healthy empty receipt reads publish zero; unhealthy reads and 03:00 cannot retain another day totals',()=>{
 assert.equal(run().summary.paidCumulative,0);assert.equal(run().summary.paidCumulativeEvidence.reason,'verified_receipts');
 assert.equal(run([],[receipt(1,'one')]).summary.paidCumulative,1);
 for(const extra of [{enabled:false},{readFailed:true},{sync:null},{sync:{businessDate,lastSuccessAt:'2026-11-13T10:00:00Z',lastAttemptAt:now.toISOString(),lastErrorCode:null}}]){
  const e=run([paid('one')],[receipt(1,'one')],extra).summary.paidCumulativeEvidence;assert.equal(e.status,'unavailable');assert.equal(e.count,null);
 }
 const at=new Date('2026-11-14T03:00:00+07:00'),day='2026-11-14';
 const next=run([paid('one')],[receipt(1,'one')],{now:at,businessDate:day,sync:{businessDate:day,lastSuccessAt:at.toISOString(),lastAttemptAt:at.toISOString(),lastErrorCode:null}});
 assert.equal(next.summary.paidCumulative,0);
});

test('manual save and automatic retirement preserve observed completion proof; new order remains occupied',async()=>{
 const names=['BABA_TABLE_CLEANING_ENABLED','POS_OPEN_ORDERS_READ_ENABLED','BABA_TABLE_AUTO_NORMAL_ENABLED','BABA_TABLE_AUTO_NORMAL_ACTIVATION'],saved=names.map(n=>process.env[n]);
 const f=await cleaningServiceFixture({auto:true});
 try{
  process.env.BABA_TABLE_CLEANING_ENABLED='true';process.env.POS_OPEN_ORDERS_READ_ENABLED='true';process.env.BABA_TABLE_AUTO_NORMAL_ENABLED='true';process.env.BABA_TABLE_AUTO_NORMAL_ACTIVATION=f.activation;
  await addOrder(f.db,f.day,{id:'paid-order',status:4});
  await f.db.exec("update pos_open_orders_private.orders set order_date=(select ref_date from pos_sales_receipts where id=100)-interval '1 minute' where order_id='paid-order'");
  const first=await f.service.readCleaningState();assert.equal(first.overview.summary.paidCumulative,1);
  const {observe}=await import('./helpers/tables-auto-normal-fixture.mjs');await observe(f.db,f.day,f.activation);
  await f.db.exec("update table_operations_private.payment_observations set first_verified_at=clock_timestamp()-interval '31 minutes'");
  let s=await f.service.readCleaningState();assert.equal(s.overview.tables.find(t=>t.id===f.tableId).state,'idle');
  assert.equal(s.overview.summary.paid,0);assert.equal(s.overview.summary.paidCumulative,1);
  await f.db.exec('update table_operations_private.payment_observations set first_verified_at=clock_timestamp()');
  const d=await f.getDetail();await f.service.confirmTableCleaning(f.tableId,1,{requestId:'00000000-0000-4000-8000-000000000081',...d.cleaning.token});
  s=await f.service.readCleaningState();assert.equal(s.overview.summary.paidCumulative,1);
  await addOrder(f.db,f.day);s=await f.service.readCleaningState();assert.equal(s.overview.tables.find(t=>t.id===f.tableId).state,'occupied');
  assert.equal(s.overview.summary.paidCumulative,1);
 }finally{await f.db.close();names.forEach((n,i)=>saved[i]===undefined?delete process.env[n]:process.env[n]=saved[i]);}
});

test('tile sums only verified current headers once and hides incomplete/conflicting amounts without modifying orders',()=>{
 const view=run([order('one','BAR4'),order('two','BAR4')]),tile=view.tables.find(t=>t.name==='BAR4'),before=JSON.stringify(tile);
 const amount=t=>verifiedCurrentOrderAmount(t,view.snapshotAt,view.serverNow,view.snapshotStatus,view.businessDate);
 assert.equal(amount(tile),200000);assert.equal(amount({...tile,orders:[tile.orders[0],tile.orders[0]]}),100000);
 for(const state of ['idle','paid','unknown'])assert.equal(amount({...tile,state}),null);
 for(const changed of [{amount:NaN},{amount:-1},{amount:0.5},{amount:Infinity},{detailsNeedReview:true},{lines:null}]){
  assert.equal(amount({...tile,orders:[{...tile.orders[0],...changed}]}),null);
 }
 assert.equal(amount({...tile,orders:[tile.orders[0],{...tile.orders[0],amount:50000}]}),null);
 assert.equal(JSON.stringify(tile),before);
});

test('compact VND never rounds across units and marks precision loss; full values remain available separately',()=>{
 for(const [n,text] of [[0,'0'],[999,'999'],[1000,'1k'],[450000,'450k'],[450500,'450.5k'],[999999,'999.999k'],
  [1000000,'1M'],[1000001,'≈1M'],[1234567,'≈1.234M'],[1999999,'≈1.999M'],[1234000,'1.234M'],[1000000000,'1B']])assert.equal(compactOrderAmount(n),text);
 for(const n of [-1,NaN,Infinity,0.1,Number.MAX_SAFE_INTEGER+1])assert.equal(compactOrderAmount(n),null);
});

for(const lang of ['ko','vi'])test(`${lang}: submenu emojis retain links/current page and top menu labels`,()=>{
 for(const pathname of ['/tables','/tables/reservations']){
  const deps={'react/jsx-runtime':jsx,
   'next/navigation':{usePathname:()=>pathname},'next/link':{__esModule:true,default:p=>jsx.jsx('a',p)},
   '@/lib/language-context':{useLanguage:()=>({lang})},'@/lib/text/tables-navigation':{tablesNavigationText},
   '@/components/SubNav':{__esModule:true,default:({tabs})=>jsx.jsxs('div',{children:tabs.map(t=>jsx.jsx('a',{href:t.href,children:t.label},t.href))})},
   './navigation.module.css':{__esModule:true,default:new Proxy({},{get:(_,k)=>k})}};
  const mod={exports:{}},code=ts.transpileModule(readFileSync('app/(protected)/tables/layout.tsx','utf8'),{fileName:'layout.tsx',compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name];},mod,mod.exports);
  const Layout=mod.exports.default;
  const html=renderToStaticMarkup(React.createElement(Layout,null,'content'));
  assert.ok(html.includes('<span aria-hidden="true">🍽️</span>'));assert.ok(html.includes('<span aria-hidden="true">📅</span>'));
  for(const value of [tablesNavigationText[lang].overview,tablesNavigationText[lang].kitchen,'BAR'])assert.ok(html.includes(value));
  assert.match(html,new RegExp(`href="${pathname}" aria-current="page"`));
 }
});
