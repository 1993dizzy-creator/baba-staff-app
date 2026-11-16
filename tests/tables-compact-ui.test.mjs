import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { tablesText } from '../lib/text/tables.ts';
import * as detailDisplay from '../lib/sales/table-detail-display.ts';
import * as menuDisplay from '../lib/sales/table-menu-display.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';
import { overview, order } from './helpers/table-overview-fixture.mjs';

function render(data, lang, { failed=false, loading=false, selected=null, detail=null }={}) {
  let hook=0;
  const states=[data,loading,failed,selected,detail?{key:`${selected.id}:${data.serverNow}`,detail,failed:false}:null], mod={exports:{}};
  const deps={
    react:{...React,useState:()=>[states[hook++],()=>{}],useEffect(){},useCallback:fn=>fn,useRef:()=>({current:null})},
    'react/jsx-runtime':jsx,'next/navigation':{useRouter:()=>({replace(){}})},
    '@/lib/language-context':{useLanguage:()=>({lang})}, '@/lib/text/tables':{tablesText},
    '@/lib/sales/table-detail-display':detailDisplay,
    '@/lib/sales/table-menu-display':menuDisplay,
    './tables.module.css':{__esModule:true,default:new Proxy({},{get:(_,key)=>key})},
  };
  const code=ts.transpileModule(readFileSync('app/(protected)/tables/page.tsx','utf8'),{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,
  }}).outputText;
  new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name];},mod,mod.exports);
  return renderToStaticMarkup(jsx.jsx(mod.exports.default,{}));
}

for(const lang of ['ko','vi']){
 test(`${lang}: first loading is a status card without fictitious zero-table sections; background refresh keeps tiles`,()=>{
  const t=tablesText[lang],first=render(null,lang,{loading:true});
  assert.ok(first.includes('<div role="status" class="loadingCard">'));
  assert.ok(first.includes('class="spinner" aria-hidden="true"'));assert.ok(first.includes(t.loading));
  assert.ok(!first.includes('class="area"'));assert.ok(!first.includes(t.noArea));
  const refresh=render(overview({catalog:babaTableCatalog(),orders:[]}),lang,{loading:true});
  assert.ok(!refresh.includes('class="loadingCard"'));assert.equal((refresh.match(/class="tile"/g)??[]).length,27);
  const error=render(null,lang,{failed:true});assert.ok(error.includes('role="alert"'));assert.ok(error.includes(t.failed));
  assert.ok(!error.includes('class="loadingCard"'));assert.ok(!error.includes('class="area"'));
 });
 test(`${lang}: compact summary keeps original zero/null values, one collection basis time and actual 11/8/8 counts`,()=>{
  const data=overview({catalog:babaTableCatalog(),orders:[]}),before=JSON.stringify(data),html=render(data,lang),t=tablesText[lang];
  const summary=html.match(/<dl class="summary".*?<\/dl>/s)[0];
  assert.deepEqual([...summary.matchAll(/<dd>(.*?)<\/dd>/g)].map(m=>m[1].replace(/<span.*?<\/span>/g,'')),['27','0','0']);
  for(const key of ['total','occupied','paidCumulative'])assert.ok(summary.includes(t.summaryLabels[key]));
  assert.ok(!summary.includes(t.paidCumulativeReview));
  for(const key of ['reserved','unknown','free'])assert.ok(!summary.includes(`<dt>${t.summaryLabels[key]}</dt>`));
  assert.ok(html.includes(`<h1 class="srOnly">${t.title}</h1>`));
  assert.ok(html.includes(`aria-label="${t.refresh}"`));
  // Only the order-collection time that decided the states is shown, at the right end before refresh.
  const bar=html.match(/<header class="overviewBar">(.*?)<\/header>/s)[1];
  const basis=bar.match(/<p class="basis">(.*?)<\/p>/s)[1];
  assert.ok(bar.indexOf('class="summary"')<bar.indexOf('class="basis"'));assert.ok(bar.indexOf('class="basis"')<bar.indexOf('class="refresh"'));
  assert.ok(basis.startsWith(`${t.basis} <time dateTime="${data.snapshotAt}"`));assert.ok(basis.includes('>20:30</time>'));
  assert.ok(!html.includes('11/13'));assert.ok(!html.includes('01:17'));assert.ok(!html.includes(`dateTime="${data.catalogAt}"`));
  assert.ok(!html.includes('class="timing"'));assert.ok(!basis.includes('warnMark'));
  assert.equal((html.match(new RegExp(`<span>· 11${t.tableCountSuffix}</span>`,'g'))??[]).length,1);
  assert.equal((html.match(new RegExp(`<span>· 8${t.tableCountSuffix}</span>`,'g'))??[]).length,2);
  assert.equal(JSON.stringify(data),before,'presentation must not rewrite state or values');
 });

 test(`${lang}: normal idle tiles have accessible labels without permanent warnings or unknown markers`,()=>{
  const html=render(overview({catalog:babaTableCatalog(),orders:[]}),lang),t=tablesText[lang];
  assert.ok(!html.includes('class="question"'));assert.ok(!html.includes('class="tile unknown"'));
  assert.ok(html.includes(`aria-label="BAR11 \u00b7 BAR \u00b7 ${t.idle}"`));
  assert.ok(!html.includes(t.pendingVerification));assert.ok(!html.includes('statusNotice'));
  assert.ok(!html.includes('class="diagnostic"'));
  const legend=html.match(/<div class="legend">(.*?)<\/div>/s)[1];
  assert.deepEqual([...legend.matchAll(/<i class="([^"]*)"/g)].map(m=>m[1]),['swatch occupied','swatch paid','swatch reserved']);
 });

 test(`${lang}: failures remain visible and missing counts are never replaced by zero`,()=>{
  const data=overview({catalog:babaTableCatalog(),enabled:false}),t=tablesText[lang],html=render(data,lang);
  assert.ok(html.includes(t.unavailable));assert.ok(html.includes('<dd>\u2014</dd>'));
  assert.ok(html.match(/<p class="basis basisWarning">.*?<\/p>/s)[0].includes(t.basisWarning));
  const error=render(null,lang,{failed:true});assert.ok(error.includes(t.failed));
  // No snapshot: the basis shows a dash, never the browser's current time.
  const basis=error.match(/<p class="basis basisWarning">(.*?)<\/p>/s)[1];
  assert.ok(basis.includes('>—</time>'));assert.ok(!/\d{2}:\d{2}/.test(basis));
  const summary=error.match(/<dl class="summary".*?<\/dl>/s)[0];
  assert.deepEqual([...summary.matchAll(/<dd>(.*?)<\/dd>/g)].map(m=>m[1].replace(/<span.*?<\/span>/g,'')),['\u2014','\u2014','\u2014']);
 });

 test(`${lang}: selected sheet preserves source amounts, menu, status and timestamps`,()=>{
  const data=overview({catalog:babaTableCatalog(),orders:[order('sheet-source','BAR4')]}),before=JSON.stringify(data);
  const tile=data.tables.find(tile=>tile.name==='BAR4'),t=tablesText[lang];
  const html=render(data,lang,{selected:{kind:'table',id:tile.id}});
  assert.ok(!html.includes('OrderId: sheet-source'));assert.ok(html.includes('Synthetic menu'));
  for(const amount of [50000,100000]){
   const formatted=new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND',maximumFractionDigits:0}).format(amount);
   assert.ok(html.includes(formatted));
  }
  assert.ok(html.includes(t.detailStates.occupied));assert.ok(html.includes('20:30'));
  // Sheet badge carries the same state color class as the tile; the tile is marked selected.
  assert.ok(html.includes('class="detailState"'));assert.ok(html.includes(t.detailStates.occupied));
  assert.ok(new RegExp(`<button class="tile occupied selected"[^>]*aria-label="BAR4 `).test(html));
  assert.equal((html.match(/ selected"/g)??[]).length,1);
  assert.equal(JSON.stringify(data),before);
 });

 test(`${lang}: render-only color/free examples color the whole tile and keep a verified free tile white`,()=>{
  const data=overview({catalog:babaTableCatalog(),orders:[]});
  ['occupied','paid','reserved','free'].forEach((state,i)=>{data.tables[i].state=state;});
  const html=render(data,lang),buttons=[...html.matchAll(/<button class="(tile[^"]*)"[^>]*>(.*?)<\/button>/g)];
  assert.equal(buttons.length,27);
  assert.deepEqual(buttons.slice(0,5).map(m=>m[1]),['tile occupied','tile paid','tile reserved','tile','tile']);
  // No status dot inside any tile; the name is the only content and state stays in the accessible label.
  for(const m of buttons)assert.match(m[2],/^<strong>[^<]+<\/strong>$/);
  assert.ok(html.includes(`aria-label="BAR1 · BAR · ${tablesText[lang].occupied}"`));
  assert.ok(!html.includes('style="background'));
 });

 test(`${lang}: occupied tile has earliest verified start only and source menu/order numbers remain distinct`,()=>{
  const orders=[order('early','BAR4',{orderDate:'2026-11-13T11:07:00Z',orderNo:'1.4'}),order('later','BAR4',{orderDate:'2026-11-13T12:00:00Z',orderNo:'1.4'}),order('missing','BAR4',{orderNo:null})];
  orders[0].lines=[{...orders[0].lines[0],itemName:'Bánh mì thịt nướng rất dài',isOption:true,isCanceled:true,quantity:3,price:40000,amount:120000}];
  const data=overview({catalog:babaTableCatalog(),orders}),before=JSON.stringify(data),tile=data.tables.find(t=>t.name==='BAR4'),t=tablesText[lang];
  const html=render(data,lang,{selected:{kind:'table',id:tile.id}});
  assert.ok(html.includes('class="tileStart"'));assert.ok(html.includes('</span> 18:07</time>'));
  assert.ok(!html.includes('tileAmount'));
  for(const button of html.matchAll(/<button class="tile[^\"]*".*?<\/button>/g)){
   assert.ok(!button[0].includes(t.currentOrderAmount));assert.ok(!button[0].includes(t.compactAmountHint));
  }
  assert.equal((html.match(/class="tileStart"/g)??[]).length,1);
  assert.equal((html.match(new RegExp(`${t.currentOrders} \\[1.4\\]`,'g'))??[]).length,2);
  assert.ok(html.includes('1/3'));assert.ok(html.includes('2/3'));assert.ok(html.includes(t.orderNumberMissing));
  assert.ok(!html.includes(`<h3>${t.order} 1.4</h3>`));
  assert.ok(html.includes('class="orderMenu"'));assert.ok(html.includes('Bánh mì thịt nướng rất dài'));
  assert.ok(html.includes(t.option));assert.ok(html.includes(t.canceled));
  for(const amount of [40000,120000,100000])assert.ok(html.includes(new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND',maximumFractionDigits:0}).format(amount)));
  assert.equal(JSON.stringify(data),before);
  for(const state of ['idle','paid','unknown']){
   const changed=structuredClone(data);changed.tables.find(t=>t.id===tile.id).state=state;
   assert.ok(!render(changed,lang).includes('class="tileStart"'));
  }
 });

 test(`${lang}: usage is absent from the header and idle help; only verified 2+ counts appear beside existing recent payment`,()=>{
  const data=overview({catalog:babaTableCatalog(),orders:[]}),tile=data.tables.find(t=>t.name==='BAR4');
  const d={table:tile,businessDate:data.businessDate,snapshotAt:data.snapshotAt,snapshotStatus:data.snapshotStatus,current:[],previous:[{id:99}],latest:null,merges:[],
   cleaning:{enabled:false,reason:'no_payment'},usage:{count:1,status:'confirmed_order_basis',verifiedOrderCount:1,snapshotAt:data.snapshotAt}};
  const selected={kind:'table',id:tile.id},t=tablesText[lang];
  const latest={id:100,number:'100',validPaid:true,canceled:false,reissued:false,link:'direct',amount:100000,
   referenceAt:data.snapshotAt,businessDate:data.businessDate,lines:[]};
  for(const count of [0,1,null,2,3])for(const hasPayment of [false,true]){
   d.latest=hasPayment?latest:null;d.usage.count=count;
   const html=render(data,lang,{selected,detail:d}),header=html.match(/<header class="header sheetHeader">.*?<\/header>/s)[0];
   assert.ok(!header.includes('usageCount'));assert.ok(!header.includes(t.todayUsage.split('{count}')[0]));
   assert.ok(!html.includes('class="usageHelp"'));assert.ok(!html.includes(t.usageUnavailable));assert.ok(!html.includes(t.priorHistory));
   assert.equal(html.includes('class="usageCount"'),hasPayment&&count>=2);
   if(hasPayment&&count>=2)assert.ok(html.includes(`${t.latestPayment}<span class="usageCount"> · ${t.todayUsage.replace('{count}',String(count))}</span></h3>`));
   assert.ok(html.includes('class="emptyOrder idleEmpty"'));assert.ok(html.includes(t.noCurrentOrders));
  }
  d.latest=latest;d.usage.count=3;
  for(const change of [{status:'review'},{status:'unavailable'},{snapshotAt:'2026-11-13T12:00:00Z'}]){
   const html=render(data,lang,{selected,detail:{...d,usage:{...d.usage,...change}}});assert.ok(!html.includes('class="usageCount"'));
  }
  d.table={...tile,state:'unknown'};d.snapshotStatus='unavailable';
  const unknown=render(data,lang,{selected,detail:d});assert.ok(!unknown.includes('idleEmpty'));assert.ok(unknown.includes('role="alert"'));assert.ok(!unknown.includes('class="usageHelp"'));
 });
 test(`${lang}: compact current rows and receipt menus share name selection while retaining original prices, quantities and source names`,()=>{
  const source=order('menu','BAR4',{totalAmount:1234567});
  const names=['[N1] Rượu Soju Chamisul fresh/ 참이슬','[H1] Trái Cây Thập Cẩm / 모듬 과일 안주'];
  source.lines=names.map((itemName,i)=>({...source.lines[0],detailId:`menu-${i}`,itemName,quantity:i+1,price:150000+i*170000,
   amount:i===0?150000:640000,isOption:i===1,isCanceled:i===1}));
  const data=overview({catalog:babaTableCatalog(),orders:[source]}),tile=data.tables.find(t=>t.name==='BAR4');
  const latest={id:100,number:'100',validPaid:true,canceled:false,reissued:false,link:'direct',amount:790000,
   referenceAt:data.snapshotAt,businessDate:data.businessDate,lines:names.map((name,i)=>({id:i+1,name,quantity:i+1,amount:i===0?150000:640000,canceled:i===1}))};
  const d={table:tile,snapshotAt:data.snapshotAt,snapshotStatus:'ok',businessDate:data.businessDate,latest,current:[latest],merges:[],
   cleaning:{enabled:false,reason:'active_orders'},usage:{status:'review',count:null,verifiedOrderCount:2,snapshotAt:data.snapshotAt}};
  const before=JSON.stringify({data,d}),html=render(data,lang,{selected:{kind:'table',id:tile.id},detail:d}),t=tablesText[lang];
  assert.ok(!html.includes('usageHelp'));for(const key of ['usageBasis','usageUnavailable','usageReview','verifiedOrders'])assert.ok(!html.includes(t[key].replace('{count}','2')));
  const rows=[...html.matchAll(/<summary class="menuRow".*?<\/summary>/g)];assert.equal(rows.length,2);
  for(const [i,row] of rows.entries()){
   const selected=menuDisplay.localizedTableMenuName(names[i],lang);assert.ok(row[0].includes(selected));assert.ok(!row[0].includes(names[i]));
   assert.ok(row[0].includes(`×${i+1}`));assert.ok(row[0].includes('menuLineAmount'));assert.ok(!row[0].includes('menuAmounts'));
   assert.ok(html.includes(`<td title="${names[i]}">${selected}`));
  }
  assert.ok(html.includes('class="menuDisclosure"'));assert.ok(html.includes('class="menuDetails"'));assert.ok(html.includes('class="menuAmounts"'));
  assert.ok(html.includes(t.originalMenuName));for(const original of names)assert.ok(html.includes(original));
  for(const amount of [150000,320000,640000,1234567])assert.ok(html.includes(new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND',maximumFractionDigits:0}).format(amount)));
  assert.ok(rows[1][0].includes(t.option));assert.ok(rows[1][0].includes(t.canceled));assert.equal(JSON.stringify({data,d}),before);
 });
}
