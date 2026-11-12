import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { tablesText } from '../lib/text/tables.ts';
import { babaTableCatalog } from '../lib/sales/baba-table-catalog.ts';
import { overview } from './helpers/table-overview-fixture.mjs';

function render(data, lang, { failed=false }={}) {
  let hook=0;
  const states=[data,false,failed,null], mod={exports:{}};
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
 test(`${lang}: compact summary keeps original zero/null values, separate source clocks and actual 11/8/8 counts`,()=>{
  const data=overview({catalog:babaTableCatalog(),orders:[]}),before=JSON.stringify(data),html=render(data,lang),t=tablesText[lang];
  const summary=html.match(/<dl class="summary".*?<\/dl>/s)[0];
  assert.deepEqual([...summary.matchAll(/<dd>(.*?)<\/dd>/g)].map(m=>m[1]),['27','0','—','—','—']);
  for(const label of Object.values(t.summaryLabels))assert.ok(summary.includes(label));
  assert.ok(html.includes('11/13'));assert.ok(html.includes('20:30'));assert.ok(html.includes('01:17'));
  assert.ok(html.includes(data.snapshotAt));assert.ok(html.includes(data.catalogAt));
  assert.equal((html.match(new RegExp(`11${t.tableCountSuffix}`,'g'))??[]).length,1);
  assert.equal((html.match(new RegExp(`8${t.tableCountSuffix}`,'g'))??[]).length,2);
  assert.equal(JSON.stringify(data),before,'presentation must not rewrite state or values');
 });

 test(`${lang}: unknown tiles use question markers and accessible status; persistent warning has collapsible detail`,()=>{
  const html=render(overview({catalog:babaTableCatalog(),orders:[]}),lang),t=tablesText[lang];
  assert.equal((html.match(/class="question" aria-hidden="true">\?<\/span>/g)??[]).length,27);
  assert.ok(!html.includes(`<small>${t.unknown}</small>`));
  assert.ok(html.includes(`aria-label="BAR11 · BAR · ${t.unknown}"`));
  assert.ok(html.includes(`<summary>${t.reviewCount.replace('{count}','27')}</summary>`));
  assert.match(html,/<details class="statusNotice">/);
  assert.ok(html.includes(t.unknownHelp));assert.equal(html.split(t.pendingVerification).length-1,1);
  const legend=html.match(/<div class="legend">(.*?)<\/div>/s)[1];
  assert.equal((legend.match(/<i /g)??[]).length,3);assert.ok(!legend.includes(t.free));
 });

 test(`${lang}: stale and catalog reasons remain available; errors retain an alert and never turn unknown values into zero`,()=>{
  const data=overview({catalog:babaTableCatalog(),enabled:false}),t=tablesText[lang],html=render(data,lang);
  assert.ok(html.includes(t.delayed));assert.match(html,/<dd>—<\/dd>/);
  assert.ok(html.includes(t.reviewCount.replace('{count}','27')));
  const missing=overview({catalog:{status:'unavailable',tables:[],collectedAt:null}}),missingHtml=render(missing,lang);
  assert.ok(missingHtml.includes(`<summary>${t.catalogCheck}</summary>`));assert.ok(missingHtml.includes(t.noCatalog));
  const error=render(null,lang,{failed:true});assert.ok(error.includes(`role="alert" class="notice">${t.failed}`));
 });

 test(`${lang}: render-only color/free examples preserve the three colors and keep a verified free tile marker-free`,()=>{
  const data=overview({catalog:babaTableCatalog(),orders:[]});
  ['occupied','paid','reserved','free'].forEach((state,i)=>{data.tables[i].state=state;});
  const html=render(data,lang),buttons=[...html.matchAll(/<button class="tile[^"]*"[^>]*>(.*?)<\/button>/g)].map(m=>m[1]);
  assert.equal(buttons.length,27);
  for(const [i,color]of ['#22C55E','#3B82F6','#A855F7'].entries())assert.ok(buttons[i].includes(`background:${color}`));
  assert.ok(!buttons[3].includes('class="dot"'));assert.ok(!buttons[3].includes('class="question"'));
 });
}
