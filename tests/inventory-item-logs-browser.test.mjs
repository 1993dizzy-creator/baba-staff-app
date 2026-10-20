import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {fixture,database,route,call} from './helpers/inventory-item-logs-fixture.mjs';
import {inventoryText} from '../lib/text/inventory.ts';
import {commonText} from '../lib/text/common.ts';
const require=createRequire(import.meta.url);
// The real UI is used. All API and external requests are intercepted.
test('item-log spinner, lazy Keg details, preserved mismatches and races in KO/VI desktop/mobile',{skip:!process.env.PLAYWRIGHT_MODULE_PATH||!process.env.QA_UI_BASE_URL},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH),browser=await chromium.launch({headless:true,executablePath:process.env.QA_BROWSER_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const samples={},metrics=[];await mkdir('.qa-review/keg-logs/browser',{recursive:true});
 for(const code of ['L3','L4']){
  const f=fixture(code,50),beforeDb=database(f.tables,{delay:3}),afterDb=database(f.tables,{delay:3});
  const before=await call(route(beforeDb),f.itemId),after=await call(route(afterDb),f.itemId,'?includeKegSalesBreakdown=false'),detail=await call(route(database(f.tables)),f.itemId,'?kegLogId=10049');
  samples[f.itemId]={before,after,detail,beforeQueries:beforeDb.reads.length,afterQueries:afterDb.reads.length};
 }
 try{for(const lang of ['ko','vi'])for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:360,height:800}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile}),page=await context.newPage();page.setDefaultTimeout(15000);
  const t=inventoryText[lang],c=commonText[lang],errors=[],reads=[],writes=[],gates=new Map();let mode='ok',detailFailure=false;
  const user={id:1,name:'QA',role:'owner',part:'bar',language:lang};await page.addInitScript(u=>localStorage.setItem('baba_user',JSON.stringify(u)),user);
  page.on('pageerror',e=>errors.push(e.message));
  const items=[3,4,8].map(id=>({id,code:id===8?'N':'L'+id,item_name:id===8?'일반 품목':'L'+id+' 생맥주',item_name_vi:id===8?'Mặt hàng thường':'L'+id+' Bia tươi',part:'bar',category:'음료',category_vi:'Đồ uống',quantity:2,unit:id===8?'Lon':'Keg',is_active:true,updated_at:'2026-10-20T03:00:00Z',purchase_price:10000}));
  const normal={ok:true,data:[{id:800,item_id:8,item_name:'일반 품목',item_name_vi:'Mặt hàng thường',action:'update',source:'edit_form',part:'bar',created_at:'2026-10-20T03:00:00Z',change_quantity:1,prev_quantity:1,new_quantity:2,unit:'Lon'}]};
  const hold=key=>{let release;const promise=new Promise(r=>{release=r;});gates.set(key,promise);return()=>{gates.delete(key);release();};};
  await page.route('**/*',async r=>{
   const req=r.request(),url=new URL(req.url());if(url.origin!==new URL(process.env.QA_UI_BASE_URL).origin)return r.abort();if(!url.pathname.startsWith('/api/'))return r.continue();
   reads.push(url.pathname+url.search);if(req.method()!=='GET')writes.push(url.pathname);let json={ok:true,data:[],items:[]},status=200;
   if(url.pathname==='/api/session')json={authenticated:true,user};
   else if(url.pathname==='/api/inventory/bootstrap-stream')return r.fulfill({contentType:'application/x-ndjson',body:[{type:'items',items,supplierPartners:[],supplierAliases:[]},{type:'enrichment',statusMap:{},kegProgressMap:{},activeKegTrackingItemIds:[]},{type:'complete',timing:{}}].map(x=>JSON.stringify(x)).join('\n')+'\n'});
   else if(/^\/api\/inventory\/items\/\d+\/logs$/.test(url.pathname)){
    const id=Number(url.pathname.split('/')[4]),detail=url.searchParams.has('kegLogId'),key=id+':'+(detail?'detail':'logs');
    if(gates.has(key))await gates.get(key);
    if(detail){if(detailFailure){status=503;json={ok:false};}else json=samples[id].detail.body;}
    else if(mode==='network')return r.abort();
    else if(mode==='invalid')return r.fulfill({body:'invalid JSON',contentType:'application/json'});
    else if(mode==='error'){status=500;json={ok:false};}
    else if(mode==='empty')json={ok:true,data:[]};
    else if(id===8)json=normal;
    else{const sample=url.searchParams.get('includeKegSalesBreakdown')==='false'?samples[id].after:samples[id].before;await new Promise(resolve=>setTimeout(resolve,sample.ms));json=sample.body;}
   }
   try{await r.fulfill({status,json});}catch{/* An intentionally aborted request may already be disposed. */}
  });
  const name=id=>lang==='ko'?items.find(i=>i.id===id).item_name:items.find(i=>i.id===id).item_name_vi;
  const card=id=>page.getByText('['+items.find(i=>i.id===id).code+'] '+name(id),{exact:true}).locator('xpath=ancestor::div[contains(@style,"box-shadow")][1]');
  const open=async id=>{const target=card(id);if(await target.getByRole('button',{name:t.logItemTitle,exact:true}).count()===0)await target.getByRole('button',{name:c.detail,exact:true}).click();await target.getByRole('button',{name:t.logItemTitle,exact:true}).click();};
  const dialog=page.getByTestId('inventory-item-logs-modal'),close=()=>dialog.getByRole('button',{name:c.close,exact:true}).last();
  // Compare the old and new first-content display in the same browser, using measured local handler delays.
  if(process.env.QA_INVENTORY_BEFORE_PATH&&lang==='ko'&&!mobile)for(const id of [3,4])for(const version of ['before','after']){
   await page.goto(process.env.QA_UI_BASE_URL+(version==='before'?process.env.QA_INVENTORY_BEFORE_PATH:'/inventory')+'?itemId='+id);await page.getByRole('button',{name:t.logItemTitle,exact:true}).waitFor();
   const started=performance.now();await page.getByRole('button',{name:t.logItemTitle,exact:true}).click();
   await page.getByText(t.kegPreviousSold,{exact:true}).first().waitFor();
   metrics.push({code:'L'+id,version,firstDisplayMs:performance.now()-started,apiMs:samples[id][version].ms,queries:samples[id][version+'Queries'],bytes:samples[id][version].bytes});
  }
  await page.goto(process.env.QA_UI_BASE_URL+'/inventory?itemId=3');await card(3).waitFor();
  let release=hold('3:logs');await open(3);await dialog.waitFor();const spinner=page.getByTestId('inventory-item-logs-loading');await spinner.waitFor();
  assert.equal(await spinner.getAttribute('role'),'status');assert.equal(await spinner.innerText(),c.loading);assert.ok((await dialog.innerText()).includes(name(3)));assert.equal(await close().isVisible(),true);
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await spinner.locator('[aria-hidden=true]').evaluate(el=>getComputedStyle(el).animationName),'none');await page.emulateMedia({reducedMotion:'no-preference'});
  await dialog.screenshot({path:'.qa-review/keg-logs/browser/'+lang+'-'+(mobile?'mobile':'desktop')+'-loading.png'});
  release();await spinner.waitFor({state:'hidden'});assert.equal(await dialog.getByText(t.kegPreviousSold,{exact:true}).count(),50);assert.equal(reads.some(u=>u.includes('kegLogId=')),false);
  const target=page.getByTestId('inventory-keg-log-detail-10049');await target.waitFor();assert.ok((await target.innerText()).includes(t.kegSalesDetailsPending));
  detailFailure=true;await target.getByRole('button').click();await target.getByRole('alert').waitFor();detailFailure=false;
  release=hold('3:detail');const detailBefore=reads.filter(u=>u.includes('kegLogId=')).length;
  await target.getByRole('button').evaluate(b=>{b.click();b.click();});await page.getByTestId('inventory-keg-log-loading-10049').waitFor();assert.equal(reads.filter(u=>u.includes('kegLogId=')).length,detailBefore+1);release();
  await dialog.getByText(t.kegSalesBreakdownMismatch,{exact:true}).waitFor();assert.equal(await dialog.getByText(t.kegSalesQuantity,{exact:true}).count(),1);assert.equal(await dialog.getByText(t.kegPreviousSold,{exact:true}).count(),50);
  await dialog.screenshot({path:'.qa-review/keg-logs/browser/'+lang+'-'+(mobile?'mobile':'desktop')+'-detail.png'});
  assert.equal(await dialog.evaluate(el=>{const panel=el.firstElementChild,r=panel.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&panel.scrollWidth<=panel.clientWidth;}),true);
  await close().click();
  // Late L3 logs must not replace the L4 modal, including the same log ids.
  release=hold('3:logs');await open(3);await spinner.waitFor();await close().click();await open(4);release();await spinner.waitFor({state:'hidden'});assert.ok((await dialog.innerText()).includes(name(4)));assert.ok(!(await dialog.innerText()).includes(name(3)));await close().click();
  // A detail response arriving after close/reopen must not hydrate another item's same-id row.
  await open(3);await spinner.waitFor({state:'hidden'});release=hold('3:detail');await page.getByTestId('inventory-keg-log-detail-10049').getByRole('button').click();await page.getByTestId('inventory-keg-log-loading-10049').waitFor();await close().click();await open(4);release();await spinner.waitFor({state:'hidden'});assert.equal(await dialog.getByText(t.kegSalesQuantity,{exact:true}).count(),0);await close().click();
  for(const failure of ['empty','error','network','invalid']){
   mode=failure;await open(8);await spinner.waitFor({state:'hidden'});
   if(failure==='empty')await dialog.getByText(c.noLogs,{exact:true}).waitFor();else{await dialog.getByRole('alert').waitFor();mode='ok';await dialog.getByRole('button',{name:t.itemLogsRetry,exact:true}).click();await spinner.waitFor({state:'hidden'});assert.equal(await dialog.getByRole('alert').count(),0);}
   assert.equal(await dialog.getByText(t.kegSalesDetailsPending,{exact:true}).count(),0);await close().click();
  }
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);console.log('PASS normal/Keg, loading/empty/failure/retry, late logs/details, duplicate click, mismatch, KO/VI viewport',lang,mobile?'mobile':'desktop');await context.close();
 }}finally{await browser.close();}
 if(metrics.length)await writeFile('.qa-review/keg-logs/browser-benchmark.json',JSON.stringify(metrics,null,2));console.log(JSON.stringify(metrics));
});
