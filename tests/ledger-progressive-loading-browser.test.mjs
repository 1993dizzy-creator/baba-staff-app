import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {entriesApi} from './helpers/ledger-entries-api-fixture.mjs';
import {entriesTables} from './helpers/ledger-entries-tables.mjs';
const require=createRequire(import.meta.url),enabled=!!process.env.PLAYWRIGHT_MODULE_PATH&&!!process.env.QA_UI_BASE_URL;
const out='.tmp/ledger-loading-phase2-20261019/browser',compare=process.env.QA_COMPARE_BASELINE==='1';
const beforeSource=compare?readFileSync('.tmp/ledger-loading-phase2-20261019/route.before.txt','utf8'):undefined;

async function openSession(browser,{lang='ko',mobile=false,before=false,delay=20,fail=[],hold=null}={}){
 const api=entriesApi(entriesTables(150),{source:before?beforeSource:undefined});
 const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'}),page=await context.newPage(),records=[],errors=[];
 page.setDefaultTimeout(15000);
 await page.addInitScript(l=>{
  // Freeze the business date only. Keep browser Performance/Resource Timing real.
  const NativeDate=Date,fixed=NativeDate.parse('2026-10-19T06:00:00Z');
  window.Date=class extends NativeDate {constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};
  localStorage.setItem('baba_user',JSON.stringify({id:1,role:'owner',name:'QA',language:l}));
  window.__ledgerTimings=[];
  // Measure browser paint directly; Playwright selector polling is not render time.
  let scheduled=false;
  const observer=new MutationObserver(()=>{
   if(scheduled)return;
   const selector=location.pathname.includes('entries')?'[aria-controls="ledger-history-panel"]':'[class*="cashFlow"]';
   const target=document.querySelector(selector);if(!target||target.getBoundingClientRect().height===0)return;
   scheduled=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(!target.isConnected){scheduled=false;return;}
    window.__ledgerFirstDataAt=performance.now();observer.disconnect();
   }));
  });
  observer.observe(document,{childList:true,subtree:true});
  const original=window.fetch;
  window.fetch=async(...args)=>{
   const url=new URL(String(args[0]),location.href),start=performance.now();
   // Store only route, allowed non-personal query parameters, and timings. Never response data.
   const safe=new URLSearchParams();for(const key of ['month','scope','mode'])if(url.searchParams.has(key))safe.set(key,url.searchParams.get(key));
   const record={path:url.pathname.replace(/\/\d+(?=\/|$)/g,'/:id')+'?'+safe.toString(),start};window.__ledgerTimings.push(record);
   try{const response=await original(...args);record.headersAt=performance.now();record.serverTiming=response.headers.get('server-timing');
    response.json=async()=>{const text=await response.text();record.bodyAt=performance.now();const parse=performance.now(),body=JSON.parse(text);record.parseMs=performance.now()-parse;record.doneAt=performance.now();const entry=performance.getEntriesByName(url.href).at(-1);if(entry){record.ttfbMs=entry.responseStart-entry.requestStart;record.downloadMs=entry.responseEnd-entry.responseStart;record.responseEndAt=entry.responseEnd;record.bodyReadDelayMs=Math.max(0,record.bodyAt-entry.responseEnd);}return body;};return response;
   }catch(e){record.aborted=e.name==='AbortError';throw e;}
  };
 },lang);
 page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==new URL(process.env.QA_UI_BASE_URL).origin){await route.abort();return;}
  if(!url.pathname.startsWith('/api/')){await route.continue();return;}
  assert.equal(req.method(),'GET','No writes or production calls in browser verification');
  const path=url.pathname+url.search,record={path,start:performance.now(),done:false};records.push(record);
  try{const start=performance.now();let response;
   if(fail.some(p=>path.includes(p)))response=Response.json({ok:false,code:'QA_UNAVAILABLE'},{status:500});
   else if(url.pathname==='/api/admin/ledger')response=await api.get(url.searchParams.get('month'),'&scope='+url.searchParams.get('scope'));
   else if(url.pathname.endsWith('/payroll-cost')){const month=url.searchParams.get('month');response=Response.json({ok:true,month,status:month==='2026-10'?'predicted':'finalized',amount:15000,recognizedAmount:month==='2026-10'?0:15000,adjustment:month==='2026-10'?15000:0,batchStatus:month==='2026-10'?'paying':'completed'});}
   else if(/\/(display-history|pos-drilldown)$/.test(url.pathname))response=await api.detailGet(url.pathname);
   else response=await api.auxGet(path);
   const body=await response.text();record.handlerMs=performance.now()-start;record.bytes=Buffer.byteLength(body);record.serverTiming=response.headers.get('server-timing');
   if(hold)await hold(path);
   await new Promise(resolve=>setTimeout(resolve,typeof delay==='function'?delay(path):delay));
   await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body});record.done=true;
  }catch(e){if(req.isNavigationRequest())throw e;if(!page.isClosed())throw e;}
 });
 const ready=kind=>kind==='dashboard'?page.locator('[class*="cashFlow"]').first().waitFor():page.locator('[aria-controls="ledger-history-panel"]').waitFor();
 const paint=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const settle=async()=>{await page.waitForTimeout(30);while(records.some(r=>!r.done))await page.waitForTimeout(20);await paint();};
 const path=kind=>before?'/before-'+kind:'/admin/ledger'+(kind==='entries'?'/entries':'');
 return{context,page,api,records,errors,ready,paint,settle,path};
}

test('progressive load: 8/9/10, KO/VI, desktop/mobile, final amounts/detail/edit equal before/after',{skip:!enabled},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH),browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),results=[];mkdirSync(out,{recursive:true});
 try{for(const kind of ['dashboard','entries'])for(const lang of ['ko','vi'])for(const mobile of [false,true]){
  const snapshots=[];
  for(const before of compare?[true,false]:[false]){
   const s=await openSession(browser,{lang,mobile,before,delay:20}),{page}=s,states=[];
   for(const month of ['2026-08','2026-09','2026-10']){
    const start=performance.now();await page.goto(process.env.QA_UI_BASE_URL+s.path(kind)+'?month='+month);await s.ready(kind);await s.settle();const detail=[];
    if(kind==='dashboard'){
     const toggles=page.locator('button[aria-expanded="false"]');const n=await toggles.count();for(let i=0;i<n;i++)await toggles.first().click();
     await page.getByRole('button',{name:lang==='ko'?'상세보기 ›':'Chi tiết ›',exact:true}).click();await page.getByRole('dialog').waitFor();await s.settle();detail.push(await page.getByRole('dialog').innerText());await page.getByRole('dialog').getByRole('button',{name:lang==='ko'?'닫기':'Đóng',exact:true}).first().click();
    }else{
     await page.locator('[aria-controls="ledger-history-panel"]').click();const header=page.locator(`[aria-controls="ledger-date-${month}-10"]`);await header.waitFor();if(await header.getAttribute('aria-expanded')==='false')await header.click();
     const filters=page.locator('div[class*="filterTabs"]');for(const label of(lang==='ko'?['지출','급여','전체']:['Chi','Lương','Tất cả'])){await filters.getByRole('button',{name:label,exact:true}).click();detail.push(await header.innerText());}
     await page.locator('button[class*="entryRow"]').filter({hasText:/−1\.000\s*₫/}).first().click();await page.getByRole('dialog').waitFor();await s.settle();const dialog=page.getByRole('dialog');detail.push(await dialog.innerText());const edit=dialog.getByRole('button',{name:lang==='ko'?'수정':'Sửa',exact:true});assert.equal(await edit.isDisabled(),month!=='2026-10');if(month==='2026-10'){await edit.click();assert.ok(await dialog.locator('input,select,textarea').count()>0);}await dialog.getByRole('button',{name:lang==='ko'?'닫기':'Đóng',exact:true}).first().click();
    }
    states.push({month,text:await page.locator('main').last().innerText(),detail});results.push({kind,lang,mobile,before,month,ms:performance.now()-start});
    if(!before&&month==='2026-10')await page.screenshot({path:`${out}/${kind}-${lang}-${mobile?'mobile':'desktop'}.png`});
   }
   snapshots.push(states);assert.deepEqual(s.errors,[]);await s.context.close();
  }
  if(compare)assert.deepEqual(snapshots[1],snapshots[0]);
 }}finally{await browser.close();writeFileSync(out+'/equality.json',JSON.stringify(results,null,2));}
});

test('first data timing: 5 fresh contexts and 5 warm reloads per screen/version; slow auxiliary requests',{skip:!enabled},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH),browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),results=[];mkdirSync(out,{recursive:true});
 try{for(const kind of ['dashboard','entries'])for(const before of compare?[true,false]:[false])for(const mode of ['fresh-context','warm-reload']){
  let s;
  if(mode==='warm-reload'){
   s=await openSession(browser,{before,delay:p=>p.startsWith('/api/admin/ledger?')||p.includes('/month-close?')?180:800});
   await s.page.goto(process.env.QA_UI_BASE_URL+s.path(kind)+'?month=2026-10');await s.ready(kind);await s.settle();
  }
  for(let i=0;i<5;i++){
   if(!s||mode==='fresh-context')s=await openSession(browser,{before,delay:p=>p.startsWith('/api/admin/ledger?')||p.includes('/month-close?')?180:800});
   const {page}=s;const n=s.records.length,start=performance.now();await page.goto(process.env.QA_UI_BASE_URL+s.path(kind)+'?month=2026-10');const documentAt=performance.now()-start;await s.ready(kind);await page.waitForFunction(()=>Number.isFinite(window.__ledgerFirstDataAt));const observedFirstDataMs=performance.now()-start,firstDataAt=await page.evaluate(()=>window.__ledgerFirstDataAt),firstDataMs=firstDataAt,atFirst=await page.evaluate(()=>({done:window.__ledgerTimings.filter(r=>r.doneAt<=window.__ledgerFirstDataAt).map(r=>r.path),pending:window.__ledgerTimings.filter(r=>r.doneAt==null||r.doneAt>window.__ledgerFirstDataAt).map(r=>r.path)})),doneAtFirst=atFirst.done,pendingAtFirst=atFirst.pending;
   if(!before)assert.ok(pendingAtFirst.length>0,'auxiliary reads must still be in flight at first paint');
   await s.settle();const allDataMs=performance.now()-start,client=await page.evaluate(()=>window.__ledgerTimings),navigation=await page.evaluate(()=>{const n=performance.getEntriesByType('navigation')[0];return n?{ttfbMs:n.responseStart-n.requestStart,responseEndMs:n.responseEnd,domContentLoadedMs:n.domContentLoadedEventEnd,fcpMs:performance.getEntriesByName('first-contentful-paint')[0]?.startTime??null}:null;});
   results.push({kind,before,mode,run:i+1,documentAt,firstDataMs,firstDataAt,observedFirstDataMs,allDataMs,doneAtFirst,pendingAtFirst,requests:s.records.slice(n).map(({path,handlerMs,bytes,serverTiming})=>({path,handlerMs,bytes,serverTiming})),client,navigation});
   if(mode==='fresh-context'){await s.context.close();s=null;}
  }
  if(s)await s.context.close();
 }}finally{await browser.close();writeFileSync(out+'/performance.json',JSON.stringify(results,null,2));}
});

test('auxiliary failures stay local; close-status failure blocks unsafe entry editing; stale month responses are rejected',{skip:!enabled},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH),browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});mkdirSync(out,{recursive:true});
 try{
  for(const lang of ['ko','vi'])for(const mobile of [false,true])for(const kind of ['dashboard','entries']){
   const s=await openSession(browser,{lang,mobile,fail:kind==='dashboard'?['card-settlements','payroll-cost']:['payables?','mode=summary']});await s.page.goto(process.env.QA_UI_BASE_URL+s.path(kind)+'?month=2026-10');await s.ready(kind);await s.settle();
   if(kind==='dashboard'){assert.match(await s.page.locator('section[aria-label="KPI"]').innerText(),/확인 필요|Cần kiểm tra/);assert.doesNotMatch(await s.page.locator('section[aria-label="KPI"]').innerText(),/📊[^]*?\n0 ₫/);}else{assert.match(await s.page.locator('section[class*="payableSummary"]').innerText(),/조회 실패|Không thể tải/);assert.ok(await s.page.locator('p[role="alert"]').count()>=2);}
   assert.deepEqual(s.errors,[]);await s.context.close();
   const core=await openSession(browser,{lang,mobile,fail:[kind==='dashboard'?'scope=dashboard':'scope=entries']});
   await core.page.goto(process.env.QA_UI_BASE_URL+core.path(kind)+'?month=2026-10');
   await core.page.getByRole('alert').filter({hasText:/\S/}).first().waitFor();await core.settle();
   assert.equal(await core.page.locator(kind==='dashboard'?'[class*="cashFlow"]':'[aria-controls="ledger-history-panel"]').count(),0);assert.deepEqual(core.errors,[]);await core.context.close();
  }
  const closed=await openSession(browser,{fail:['month-close?']});await closed.page.goto(process.env.QA_UI_BASE_URL+closed.path('entries')+'?month=2026-08');await closed.page.getByText('장부를 불러오지 못했습니다.',{exact:false}).waitFor();assert.equal(await closed.page.locator('[aria-controls="ledger-history-panel"]').count(),0);await closed.context.close();
  for(const kind of ['dashboard','entries']){
   let release;const gate=new Promise(r=>{release=r;});const s=await openSession(browser,{hold:p=>p.includes('month=2026-10')&&!p.startsWith('/api/admin/ledger?')&&!p.includes('/month-close?')?gate:Promise.resolve()});
   await s.page.goto(process.env.QA_UI_BASE_URL+s.path(kind)+'?month=2026-10');await s.ready(kind);
   // Dashboard month input switches immediately; Entries has the same URL contract.
   await s.page.locator('input[type="month"]').first().fill('2026-09');await s.page.waitForURL('**month=2026-09');await s.ready(kind);await s.page.waitForTimeout(80);await s.paint();const newMonthText=await s.page.locator('main').last().innerText();release();await s.settle();assert.equal(await s.page.locator('main').last().innerText(),newMonthText);assert.equal(await s.page.locator('input[type="month"]').first().inputValue(),'2026-09');
   assert.deepEqual(s.errors,[]);await s.context.close();
  }
 }finally{await browser.close();}
});

test('card and payroll estimates update independently and never publish a final profit while either is pending',{skip:!enabled},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH),browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{for(const held of ['card-settlements','payroll-cost']){
  let release;const gate=new Promise(r=>{release=r;});const s=await openSession(browser,{hold:p=>p.includes(held)?gate:Promise.resolve()});
  await s.page.goto(process.env.QA_UI_BASE_URL+s.path('dashboard')+'?month=2026-10');await s.ready('dashboard');await s.page.waitForTimeout(80);await s.paint();
  const completed=s.records.filter(r=>r.done).map(r=>r.path);assert.ok(completed.some(p=>p.includes(held==='card-settlements'?'payroll-cost':'card-settlements')));
  assert.equal(await s.page.locator('section[aria-label="KPI"] article').nth(1).locator('strong').innerText(),'-');
  await s.page.getByRole('button',{name:'상세보기 ›',exact:true}).click();await s.page.getByRole('dialog').waitFor();const text=await s.page.getByRole('dialog').innerText();assert.match(text,/확인 중/);if(held==='card-settlements')assert.match(text,/15\.000\s*₫/);
  release();await s.settle();assert.deepEqual(s.errors,[]);await s.context.close();
 }}finally{await browser.close();}
});

test('entries waits for month-close status before showing a closed month, even when all other APIs finish',{skip:!enabled},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH),browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{
  let release;const gate=new Promise(r=>{release=r;});const s=await openSession(browser,{hold:p=>p.includes('/month-close?')?gate:Promise.resolve()});
  await s.page.goto(process.env.QA_UI_BASE_URL+s.path('entries')+'?month=2026-08');await s.page.waitForTimeout(250);
  assert.ok(s.records.some(r=>r.path.startsWith('/api/admin/ledger?')&&r.done));assert.equal(await s.page.locator('[aria-controls="ledger-history-panel"]').count(),0);
  release();await s.ready('entries');await s.settle();assert.match(await s.page.locator('section[class*="monthCloseCard"]').innerText(),/3차 마감/);assert.deepEqual(s.errors,[]);await s.context.close();
 }finally{await browser.close();}
});
