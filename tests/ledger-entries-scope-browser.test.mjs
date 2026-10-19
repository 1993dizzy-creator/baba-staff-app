import test from'node:test';import assert from'node:assert/strict';import{createRequire}from'node:module';import{mkdirSync,writeFileSync}from'node:fs';
import{entriesApi}from'./helpers/ledger-entries-api-fixture.mjs';import{entriesTables}from'./helpers/ledger-entries-tables.mjs';
const require=createRequire(import.meta.url),enabled=!!process.env.PLAYWRIGHT_MODULE_PATH&&!!process.env.QA_UI_BASE_URL;
test('Entries full/compact equality and timings: 3 months × KO/VI × PC/mobile, filters, dates, details, month switch',{skip:!enabled},async()=>{
 const{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH),browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),out='.tmp/entries-scope-20261019/browser';mkdirSync(out,{recursive:true});const measurements=[];
 try{for(const lang of ['ko','vi'])for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(20000);
  await page.clock.setFixedTime(new Date('2026-10-19T06:00:00Z'));await page.addInitScript(lang=>localStorage.setItem('baba_user',JSON.stringify({id:1,name:'QA',role:'owner',language:lang})),lang);
  const tables=entriesTables(150),mainApi=entriesApi(tables),auxApi=entriesApi(tables);for(const suffix of ['month-close?month=2026-08&mode=status','payables?month=2026-08','investments?month=2026-08&mode=summary'])await auxApi.auxGet('/api/admin/ledger/'+suffix);
  let compact=false,requests=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==new URL(process.env.QA_UI_BASE_URL).origin){await route.abort();return;}
   if(!url.pathname.startsWith('/api/')){await route.continue();return;}
   assert.equal(route.request().method(),'GET','read-only isolated browser');const record={url:url.pathname+url.search,start:performance.now()};requests.push(record);let response;
   if(url.pathname==='/api/admin/ledger'){assert.equal(url.searchParams.get('scope'),compact?'entries':null);response=await mainApi.get(url.searchParams.get('month'),compact?'&scope=entries':'');}
   else if(/\/(month-close|payables|investments)$/.test(url.pathname))response=await auxApi.auxGet(url.pathname+url.search);
   else if(/\/(display-history|pos-drilldown)$/.test(url.pathname))response=await auxApi.detailGet(url.pathname);
   else throw Error('Unexpected API '+url.pathname);
   const json=await response.json();assert.equal(response.status,200);record.handlerMs=performance.now()-record.start;record.bytes=Buffer.byteLength(JSON.stringify(json));await route.fulfill({json});
  });
  const paint=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  async function timed(name,action,metrics){const count=requests.length,start=performance.now();await action();await paint();metrics[name]={ms:performance.now()-start,requests:requests.length-count,urls:requests.slice(count).map(r=>r.url)};}
  for(const month of ['2026-08','2026-09','2026-10']){
   const snapshots=[];
   for(const light of [false,true]){
    compact=light;requests=[];const metrics={lang,mobile,month,mode:light?'entries':'full'},start=performance.now();
    await page.goto(process.env.QA_UI_BASE_URL+(light?'/admin/ledger/entries':'/before')+'?month='+month);const history=page.locator('[aria-controls="ledger-history-panel"]');await history.waitFor();await paint();metrics.initialMs=performance.now()-start;
    assert.equal(requests.length,(!light&&lang==='vi')?8:4,JSON.stringify({lang,mobile,month,light,requests}));metrics.initialRequests=requests.map(r=>({url:r.url,handlerMs:r.handlerMs,bytes:r.bytes}));
    await timed('historyExpand',()=>history.click(),metrics);const header=page.locator(`[aria-controls="ledger-date-${month}-10"]`);await header.waitFor();if(await header.getAttribute('aria-expanded')==='true')await header.click();
    await timed('dateExpand',()=>header.click(),metrics);
    const filter=page.locator('div[class*="filterTabs"]');const headers=[];
    for(const label of(lang==='ko'?['지출','급여','전체']:['Chi','Lương','Tất cả'])){await timed('filter-'+label,()=>filter.getByRole('button',{name:label,exact:true}).click(),metrics);headers.push(await header.innerText());}
    const rows=page.locator('button[class*="entryRow"]');const manual=rows.filter({hasText:/−1\.000\s*₫/}).first();
    await timed('detailManual',async()=>{await Promise.all([page.waitForResponse(r=>r.url().endsWith('/display-history')),manual.click()]);await page.getByRole('dialog').waitFor();},metrics);const dialog=page.getByRole('dialog'),manualText=await dialog.innerText();
    const edit=dialog.getByRole('button',{name:lang==='ko'?'수정':'Sửa',exact:true});assert.equal(await edit.count(),1);assert.equal(await edit.isDisabled(),month!=='2026-10');
    if(month==='2026-10'){await edit.click();assert.ok((await dialog.locator('input,select,textarea').count())>0);}
    await dialog.getByRole('button',{name:lang==='ko'?'닫기':'Đóng',exact:true}).first().click();
    const pos=rows.filter({hasText:/30\.000\s*₫/}).first();await timed('detailPos',async()=>{await pos.click();await page.getByRole('dialog').waitFor();},metrics);assert.equal(metrics.detailPos.requests,1);
    await page.getByRole('dialog').getByRole('button',{name:lang==='ko'?'닫기':'Đóng',exact:true}).first().click();await paint();
    const main=await page.locator('main').last().innerText();snapshots.push({main,headers,manualText});
    if(light)await page.screenshot({path:`${out}/${lang}-${mobile?'mobile':'desktop'}-${month}.png`});
    const nextMonth=month==='2026-10'?'2026-09':'2026-'+String(Number(month.slice(5))+1).padStart(2,'0');
    await timed('monthChange',async()=>{await page.locator('input[type="month"]').fill(nextMonth);await page.waitForURL('**month='+nextMonth);await page.locator('[aria-controls="ledger-history-panel"]').waitFor();},metrics);assert.equal(metrics.monthChange.requests,4);measurements.push(metrics);
   }
   assert.deepEqual(snapshots[1],snapshots[0]);
  }
  requests=[];await page.reload();await page.locator('[aria-controls="ledger-history-panel"]').waitFor();assert.equal(requests.length,4);assert.equal(await page.locator('input[type="month"]').inputValue(),'2026-09');assert.deepEqual(errors,[]);await context.close();
 }}finally{await browser.close();}
 writeFileSync(out+'/measurements.json',JSON.stringify(measurements,null,2));
});
