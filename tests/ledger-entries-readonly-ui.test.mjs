import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { entriesApi } from './helpers/ledger-entries-api-fixture.mjs';
import { entriesTables } from './helpers/ledger-entries-tables.mjs';
const require=createRequire(import.meta.url);
const enabled=!!process.env.PLAYWRIGHT_MODULE_PATH&&!!process.env.QA_UI_BASE_URL;
for(const lang of ['ko','vi'])for(const width of [1280,390])test(`Entries read-only UI: ${lang}/${width}, three months, filters, details, closed-month policy`,{skip:!enabled},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const records=[]; let step="start";
 try{
  const context=await browser.newContext({viewport:{width,height:width===390?844:900},serviceWorkers:'block'}),page=await context.newPage();
  page.setDefaultTimeout(7000);await page.clock.setFixedTime(new Date('2026-10-19T06:00:00Z'));
  const user={id:1,name:'QA',role:'owner',language:lang};
  await page.addInitScript(user=>{localStorage.setItem('baba_user',JSON.stringify(user));document.addEventListener('submit',e=>e.preventDefault(),true);},user);
  const api=entriesApi(entriesTables(150)),errors=[],writes=[];
  page.on('pageerror',e=>errors.push(e.name));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==new URL(process.env.QA_UI_BASE_URL).origin){await route.abort();return;}
   if(!['GET','HEAD'].includes(route.request().method())){writes.push(url.pathname);await route.abort();return;}
   if(!url.pathname.startsWith('/api/')){await route.continue();return;}
   let response;
   if(url.pathname==='/api/session')response=Response.json({authenticated:true,user});
   else if(url.pathname==='/api/attendance/leave-pending-summary')response=Response.json({pendingCount:0,hasPending:false});
   else if(url.pathname==='/api/admin/ledger'){assert.equal(url.searchParams.get('scope'),'entries');response=await api.get(url.searchParams.get('month'),'&scope=entries');}
   else if(/\/(month-close|payables|investments)$/.test(url.pathname))response=await api.auxGet(url.pathname+url.search);
   else if(/\/(display-history|pos-drilldown)$/.test(url.pathname))response=await api.detailGet(url.pathname);
   else throw Error('Unexpected read '+url.pathname);
   assert.equal(response.status,200);await route.fulfill({json:await response.json()});
  });
  for(const month of ['2026-10','2026-08','2026-09']){
   step="navigation"; if(month==="2026-10")await page.goto(process.env.QA_UI_BASE_URL+'/admin/ledger/entries?month='+month);else await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==="/api/admin/ledger"&&new URL(r.url()).searchParams.get("month")===month),page.locator('input[type="month"]').fill(month)]);
   const history=page.locator('[aria-controls="ledger-history-panel"]');await history.waitFor(); step="history"; await history.click();
   step="date"; const date=page.locator(`[aria-controls="ledger-date-${month}-10"]`);await date.waitFor();if(await date.getAttribute('aria-expanded')!=='true')await date.click();
   step="filters"; const filter=page.locator('div[class*="filterTabs"]');
   for(const label of(lang==='ko'?['지출','급여','전체']:['Chi','Lương','Tất cả']))await filter.getByRole('button',{name:label,exact:true}).click();
   step="manual-detail"; const manual=page.locator('button[class*="entryRow"]').filter({hasText:/−1\.000\s*₫/}).first();await manual.click();
   const dialog=page.getByRole('dialog');await dialog.waitFor();
   const edit=dialog.getByRole('button',{name:lang==='ko'?'수정':'Sửa',exact:true});assert.equal(await edit.count(),1);assert.equal(await edit.isDisabled(),month!=='2026-10');
   await dialog.getByRole('button',{name:lang==='ko'?'닫기':'Đóng',exact:true}).first().click();
   records.push({lang,width,month,history:true,date:true,filters:true,details:true,closedPolicy:true});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);await context.close();
 }catch(error){console.error(JSON.stringify({step,message:error.message}));throw error;}finally{await browser.close();}
 const out=process.env.ENTRIES_UI_RESULTS||'.tmp/entries-pool2-20261022';mkdirSync(out,{recursive:true});writeFileSync(`${out}/ui-${lang}-${width}.json`,JSON.stringify({source:'synthetic read-only API fixture; no production login/session/data',records},null,2));
});




