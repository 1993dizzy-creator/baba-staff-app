import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {applySql} from './helpers/ledger-meal-consolidation-fixture.mjs';
import {installEvidence,evidenceFreshManifest} from './helpers/ledger-meal-evidence.mjs';
const require=createRequire(import.meta.url);
const enabled=process.env.PLAYWRIGHT_MODULE_PATH&&process.env.ESBUILD_MODULE_PATH;
test('actual meal row/detail/editor TSX: KO/VI desktop/mobile, one row per date, reasons and save refresh', {skip:!enabled,timeout:120000},async()=>{
  const {build}=require(process.env.ESBUILD_MODULE_PATH),{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
  const {buildLedgerEntries}=require('../lib/ledger/entries.ts');
  const db=new PGlite();await installEvidence(db);
  await db.exec(applySql().replace("v_manifest jsonb := '[]'",`v_manifest jsonb := '${JSON.stringify(await evidenceFreshManifest(db))}'`).replace('v_actor bigint := null','v_actor bigint := 1'));
  async function readEntries(){return buildLedgerEntries((await db.query(`select t.*,business_date::text business_date,occurred_at::text occurred_at,
    jsonb_build_object('id',category_id,'name',c.name) category from ledger_transactions t join ledger_categories c on c.id=t.category_id
    where t.status='confirmed' and t.business_date between '2026-10-01' and '2026-10-31'`)).rows,[],new Map());}
  const dir=path.resolve('.tmp/meal-single-row-ui');mkdirSync(dir,{recursive:true});
  const pagePath=path.resolve('app/(protected)/admin/ledger/entries/page.tsx'),source=readFileSync(pagePath,'utf8');
  // Render the exact list-row JSX in its original lexical scope, together with
  // the real detail/editor components. No Next dev/build or .env loading.
  const start=source.indexOf('<button type="button" className={styles.entryRow}');
  const end=source.indexOf('</button>',start)+9;assert.ok(start>0);
  const exports=`\nexport {EntryDetailSheet,ManualEntrySheet};
    export function QaRows({rows,lang,openEntry}){const vi=lang==='vi',partnerByLedgerParty=new Map();return <div>{rows.map(entry=>(${source.slice(start,end)}))}</div>}`;
  writeFileSync(dir+'/entry.tsx',`
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import {QaRows,EntryDetailSheet,ManualEntrySheet} from '${pagePath.replaceAll('\\','/')}';
    const lang=new URLSearchParams(location.search).get('lang')||'ko';
    function App(){const[rows,setRows]=useState([]),[entry,setEntry]=useState(null),[manual,setManual]=useState(false),[saving,setSaving]=useState(false);
      React.useEffect(()=>{fetch('/entries').then(r=>r.json()).then(setRows)},[]);
      return <main><button onClick={()=>setManual(true)}>Add</button><QaRows rows={rows.filter(e=>e.drilldown==='meal')} lang={lang} openEntry={setEntry}/>
      {entry?<EntryDetailSheet lang={lang} entry={entry} partnersByParty={new Map()} partners={[]} accounts={[]} categories={[]} candidateDraft={null} setCandidateDraft={()=>{}} editCandidate={()=>{}} resolveCandidate={async()=>{}} saving={false} message='' posDetail={null} closed={false}
       onConfirmedEdited={async()=>{const fresh=await(await fetch('/entries')).json();setRows(fresh);setEntry(fresh.find(e=>e.transactionId===entry.transactionId))}} onAdvanceCancelled={async()=>{}} onManualDeleted={async()=>{}} onClose={()=>setEntry(null)}/>:null}
      {manual?<ManualEntrySheet lang={lang} data={{entries:rows,categories:[{id:7,name:'직원 식대',kind:'expense'}],accounts:[],partners:[]}} investments={null} month='2026-10' saving={saving} setSaving={setSaving} onClose={()=>setManual(false)} onSaved={async()=>{}} returnFocusRef={{current:null}}/>:null}</main>}
    createRoot(document.getElementById('root')).render(<App/>);`);
  await build({entryPoints:[dir+'/entry.tsx'],bundle:true,outfile:dir+'/bundle.js',jsx:'automatic',loader:{'.css':'local-css'},plugins:[{name:'local-qa',setup(b){
    b.onLoad({filter:/entries[\\/]page\.tsx$/},()=>({contents:source+exports,loader:'tsx',resolveDir:path.dirname(pagePath)}));
    b.onResolve({filter:/^next\/(navigation|link)$/},args=>({path:args.path,namespace:'qa-next'}));
    b.onLoad({filter:/.*/,namespace:'qa-next'},args=>({contents:args.path.endsWith('link')?'export default function Link(p){return <a {...p}/>}':'export const useRouter=()=>({push(){}}),useSearchParams=()=>new URLSearchParams(),usePathname=()=>"/";',loader:'tsx',resolveDir:process.cwd()}));
  }}]});
  const server=createServer(async(req,res)=>{
    if(req.url==='/entries'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await readEntries()));}
    else if(req.url==='/bundle.js'||req.url==='/bundle.css'){res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/css');res.end(readFileSync(dir+req.url));}
    else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial}main{max-width:820px;margin:auto;padding:12px}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),evidence=[];
  try{for(const lang of ['ko','vi'])for(const width of [1280,390]){
    const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.clock.setFixedTime(new Date('2026-10-01T12:00:00Z'));
    await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
      if(url.pathname.endsWith('/meal-adjust')){
        const body=route.request().postDataJSON(),id=Number(url.pathname.split('/').at(-2));const result=(await db.query('select ledger_adjust_open_meal_transaction_v1($1,$2,$3,1) r',[id,body.finalAmount,body.reason])).rows[0].r;
        return route.fulfill({json:{ok:true,result}});
      }await route.continue();});
    await page.goto(origin+'/?lang='+lang);const rows=page.locator('button[class*="entryRow"]');await rows.first().waitFor();assert.equal(await rows.count(),30);
    // Exact supplied Oct24 pair: manual #3345 +60,000 -> auto #3135, final390,000.
    const targetIndex=(await readEntries()).filter(e=>e.drilldown==='meal').findIndex(e=>e.transactionId===3135);
    await rows.nth(targetIndex).click();const dialog=page.getByRole('dialog');await dialog.waitFor();
    const text=await dialog.innerText();for(const value of ['330.000','60.000','390.000','시트 346행'])assert.ok(text.includes(value),value);
    assert.ok(text.includes(lang==='ko'?'수정 사유':'Lý do chỉnh sửa'));
    const reason=dialog.locator('span').filter({hasText:/시트 346행/}).last();
    assert.equal(await reason.evaluate(e=>e.scrollWidth<=e.clientWidth),true,'reason must wrap instead of truncating');
    const boxes=await dialog.locator('article b').evaluateAll(nodes=>nodes.map(e=>({text:e.textContent,x:e.getBoundingClientRect().x,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width})));
    console.log(JSON.stringify({lang,width,boxes}));
    assert.ok(boxes.every(b=>b.x>=0&&b.right<=width),'all meal amounts visible in viewport');
    await page.screenshot({path:dir+'/'+lang+'-'+width+'-detail.png'});
    await dialog.getByRole('button',{name:lang==='ko'?'수정':'Sửa',exact:true}).click();
    await dialog.getByLabel(lang==='ko'?'최종 식대 금액':'Số tiền ăn cuối cùng').fill('390000');
    await dialog.getByLabel(lang==='ko'?'수정 사유':'Lý do chỉnh sửa',{exact:false}).fill('UI QA verified');
    await Promise.all([page.waitForResponse(r=>r.url().endsWith('/entries')),
      dialog.getByRole('button',{name:lang==='ko'?'수정 저장':'Lưu sửa đổi',exact:true}).click()]);assert.equal(await rows.count(),30);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await dialog.getByRole('button',{name:lang==='ko'?'닫기':'Đóng',exact:true}).first().click();
    await page.getByRole('button',{name:'Add',exact:true}).click();
    const category=page.locator('select[data-manual-field="expense-category"]');await category.waitFor();
    assert.equal(await category.locator('option[value="7"]').count(),0,'no separate manual meal on automatic date');
    await page.locator('[data-manual-field="date"]').fill('2026-10-31');
    assert.equal(await category.locator('option[value="7"]').count(),1,'manual meal remains available on days without auto meal');
    await page.locator('[data-manual-field="date"]').fill('2026-10-02');
    await page.locator('[data-manual-field="time"]').fill('02:59');
    assert.equal(await category.locator('option[value="7"]').count(),0,'03:00 business-date rule');
    evidence.push({lang,width,mealRows:await rows.count(),detailValues:true,saveRefresh:true,manualDuplicateGuard:true,errors});assert.deepEqual(errors,[]);
    await context.close();
  }}finally{await browser.close();await new Promise(r=>server.close(r));await db.close();}
  writeFileSync(dir+'/results.json',JSON.stringify(evidence,null,2));
});
