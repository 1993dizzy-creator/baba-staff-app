import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { tablesText } from '../lib/text/tables.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';
import { overview, order } from './helpers/table-overview-fixture.mjs';

function render(data, lang, { failed=false, selected=null }={}) {
  let hook=0;
  const states=[data,false,failed,selected], mod={exports:{}};
  const deps={
    react:{...React,useState:()=>[states[hook++],()=>{}],useEffect(){},useCallback:fn=>fn,useRef:()=>({current:null})},
    'react/jsx-runtime':jsx,'next/navigation':{useRouter:()=>({replace(){}})},
    '@/lib/language-context':{useLanguage:()=>({lang})}, '@/lib/text/tables':{tablesText},
    './tables.module.css':{__esModule:true,default:new Proxy({},{get:(_,key)=>key})},
  };
  const code=ts.transpileModule(readFileSync('app/(protected)/tables/page.tsx','utf8'),{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,
  }}).outputText;
  new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name];},mod,mod.exports);
  return renderToStaticMarkup(jsx.jsx(mod.exports.default,{}));
}

for(const lang of ['ko','vi']){
 test(`${lang}: compact summary keeps original zero/null values, one collection basis time and actual 11/8/8 counts`,()=>{
  const data=overview({catalog:babaTableCatalog(),orders:[]}),before=JSON.stringify(data),html=render(data,lang),t=tablesText[lang];
  const summary=html.match(/<dl class="summary".*?<\/dl>/s)[0];
  assert.deepEqual([...summary.matchAll(/<dd>(.*?)<\/dd>/g)].map(m=>m[1]),['27','0','0']);
  for(const key of ['total','occupied','paid'])assert.ok(summary.includes(t.summaryLabels[key]));
  for(const key of ['reserved','unknown','free'])assert.ok(!summary.includes(t.summaryLabels[key]));
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
  assert.deepEqual([...summary.matchAll(/<dd>(.*?)<\/dd>/g)].map(m=>m[1]),['\u2014','\u2014','\u2014']);
 });

 test(`${lang}: selected sheet preserves source amounts, menu, status and timestamps`,()=>{
  const data=overview({catalog:babaTableCatalog(),orders:[order('sheet-source','BAR4')]}),before=JSON.stringify(data);
  const tile=data.tables.find(tile=>tile.name==='BAR4'),t=tablesText[lang];
  const html=render(data,lang,{selected:{kind:'table',id:tile.id}});
  assert.ok(html.includes('sheet-source'));assert.ok(html.includes('Synthetic menu'));
  for(const amount of [50000,100000]){
   const formatted=new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND',maximumFractionDigits:0}).format(amount);
   assert.ok(html.includes(formatted));
  }
  assert.ok(html.includes(t.occupied));assert.ok(html.includes('20:30'));
  // Sheet badge carries the same state color class as the tile; the tile is marked selected.
  assert.ok(html.includes(`<span class="stateBadge occupied">${t.occupied}</span>`));
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
}
