import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {settingsApi} from './helpers/ledger-settings-api-fixture.mjs';
import {ledgerSettingsText} from '../lib/ledger/settings-text.ts';
import {ledgerSettingsTabText,partnerSettingsText} from '../lib/partners/settings-view.ts';
const require=createRequire(import.meta.url);
const enabled=!!process.env.PLAYWRIGHT_MODULE_PATH&&!!process.env.QA_UI_BASE_URL;
const compare=process.env.QA_COMPARE_BASELINE==='1';

test('settings load isolation, locale initialization, tab/reload/save freshness: KO/VI x desktop/mobile',{skip:!enabled},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const out='.tmp/settings-speed-20261019/browser';mkdirSync(out,{recursive:true});const results=[];
 try{for(const lang of ['ko','vi'])for(const mobile of [false,true]){
  const snapshots=[];
  for(const before of (compare?[true,false]:[false])){
   const api=settingsApi(),context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(15000);
   const copy=ledgerSettingsText[lang],tabs=ledgerSettingsTabText[lang],labels=partnerSettingsText[lang],records=[],errors=[],metrics={lang,mobile,before,phases:[]};let pending=0,failNext=false;
   await page.clock.setFixedTime(new Date('2026-10-19T06:00:00Z'));
   await page.addInitScript(l=>localStorage.setItem('baba_user',JSON.stringify({id:7,role:'owner',language:l})),lang);
   page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
   await context.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==new URL(process.env.QA_UI_BASE_URL).origin){await route.abort();return;}
    if(!url.pathname.startsWith('/api/')){await route.continue();return;}
    const req=route.request(),record={url:url.pathname+url.search,method:req.method(),body:req.postDataJSON(),start:performance.now()};records.push(record);pending++;
    try{const start=performance.now();let response;if(failNext&&req.method()!=='GET'){failNext=false;response=Response.json({ok:false,code:'QA_REJECTED'},{status:400});}else response=await api.request(record.url,record.method,record.body);
     record.handlerMs=performance.now()-start;const body=await response.text();record.bytes=Buffer.byteLength(body);record.status=response.status;
     // Controlled latency only; no production network or SQL is used.
     await new Promise(r=>setTimeout(r,80));await route.fulfill({status:response.status,contentType:'application/json',body});record.fulfilled=performance.now();
    }finally{pending--;}
   });
   const paint=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   async function settle(){await page.waitForTimeout(30);while(pending)await page.waitForTimeout(20);await paint();}
   async function phase(name,action,expected){const n=records.length,nq=api.calls.length+api.accounts.calls.length,start=performance.now();await action();await settle();const chunk=records.slice(n);if(expected!=null)assert.equal(chunk.length,expected,name+JSON.stringify(chunk));metrics.phases.push({name,ms:performance.now()-start,requests:chunk.length,bytes:chunk.reduce((s,r)=>s+r.bytes,0),queries:api.calls.length+api.accounts.calls.length-nq,handlerMs:chunk.reduce((s,r)=>s+r.handlerMs,0),afterLastResponseMs:chunk.length?performance.now()-Math.max(...chunk.map(r=>r.fulfilled)):null});return chunk;}
   const base=process.env.QA_UI_BASE_URL+(before?'/before':'/admin/ledger/settings');
   const tab=type=>page.getByRole('tab',{name:tabs[type],exact:true});
   const ready=type=>type==='basic'?page.locator('#settings-owner-settlement').waitFor():type==='reserves'?page.getByRole('heading',{name:'QA Reserve',exact:true}).waitFor():page.getByRole('link',{name:/QA Active/}).waitFor();
   const text=[];
   // Warm navigation compilation separately, then measure reloads for each direct entry.
   for(const type of ['basic','partners','reserves']){
    await page.goto(base+'?tab='+type);await ready(type);await settle();
    await phase('initial-'+type,async()=>{await page.reload();await ready(type);},(before&&lang==='vi'?2:1)*(type==='basic'?2:1));
    text.push(await page.getByRole('tabpanel').innerText());
   }
   await phase('tab-basic',async()=>{await tab('basic').click();await ready('basic');},2);
   await phase('accordion',()=>page.locator('[aria-controls="settings-fund-accounts"]').click(),0);
   await page.locator('[aria-controls="settings-fund-accounts"]').click();
   await phase('open-policy',()=>page.locator('[aria-controls="owner-policy-editor"]').click(),0);
   const editor=page.locator('#owner-policy-editor'),rates=editor.locator('input[inputmode="decimal"]');
   await rates.nth(0).fill('49');assert.equal(await editor.getByRole('button',{name:copy.saveProfitShare,exact:true}).isDisabled(),true);
   await rates.nth(0).fill('40');await rates.nth(2).fill('30');
   const posted=[];
   posted.push((await phase('save-policy',async()=>{await editor.getByRole('button',{name:copy.saveProfitShare,exact:true}).click();await page.getByRole('status').filter({hasText:copy.saved}).waitFor();},3))[0]);
   assert.equal(await rates.nth(0).inputValue(),'40');
   failNext=true;
   await phase('save-policy-rejected',async()=>{await editor.getByRole('button',{name:copy.saveProfitShare,exact:true}).click();await page.getByRole('alert').filter({hasText:'QA_REJECTED'}).waitFor();},1);
   await page.locator('[aria-controls="owner-participant-editor"]').click();const participants=page.locator('#owner-participant-editor');await participants.locator('input[type="month"]').fill('2026-09');
   await participants.locator('input[type="checkbox"]').first().locator('..').click();assert.equal(await participants.getByRole('button',{name:copy.saveParticipants,exact:true}).isDisabled(),true);await participants.locator('input[type="checkbox"]').first().locator('..').click();
   posted.push((await phase('save-participants',()=>participants.getByRole('button',{name:copy.saveParticipants,exact:true}).click(),3))[0]);
   await phase('tab-partners',async()=>{await tab('partners').click();await ready('partners');},1);
   await phase('partner-view',async()=>{await page.getByRole('tab',{name:new RegExp(labels.inactive)}).click();await page.getByRole('link',{name:/QA Inactive/}).waitFor();},0);
   await page.getByRole('tab',{name:new RegExp(labels.active)}).click();await page.getByRole('link',{name:/QA Active/}).waitFor();
   await page.getByRole('button',{name:labels.add,exact:true}).click();await page.locator('#partner-add-form input[required]').fill('QA Created');
   posted.push((await phase('save-partner',async()=>{await page.locator('button[form="partner-add-form"]').click();await page.getByRole('link',{name:/QA Created/}).waitFor();},2))[0]);
   await phase('tab-reserves',async()=>{await tab('reserves').click();await ready('reserves');},1);
   const card=page.locator('article').filter({has:page.getByRole('heading',{name:'QA Reserve',exact:true})});
   await phase('reserve-plan-expand',()=>card.getByRole('button',{name:copy.sectionPlan,exact:true}).click(),0);
   assert.equal(await card.locator('select').first().isDisabled(),true);
   await card.locator('input[inputmode="decimal"]').first().fill('120000');
   posted.push((await phase('save-reserve-plan',()=>card.getByRole('button',{name:copy.updatePlan,exact:true}).click(),2))[0]);
   await page.getByRole('button',{name:copy.addReserve,exact:true}).click();const form=page.locator('form');await form.getByLabel(copy.reserveName,{exact:true}).fill('QA Created Reserve');await form.getByLabel(copy.targetAmount,{exact:true}).fill('50000');
   posted.push((await phase('save-reserve-create',async()=>{await form.getByRole('button',{name:copy.createPlan,exact:true}).click();await page.getByRole('heading',{name:'QA Created Reserve',exact:true}).waitFor();},2))[0]);
   await phase('tab-reentry-basic',async()=>{await tab('basic').click();await ready('basic');},2);
   // Locale-only updates must not fetch or overwrite an unsaved rate. Baseline demonstrates both defects.
   const open=page.locator('[aria-controls="owner-policy-editor"]');if(await open.getAttribute('aria-expanded')==='false')await open.click();await page.locator('#owner-policy-editor input[inputmode="decimal"]').first().fill('39');
   await phase('language-switch',()=>page.locator('#qa-language').click(),before?2:0);
   assert.equal(await page.locator('#owner-policy-editor input[inputmode="decimal"]').first().inputValue(),before?'40':'39');
   await page.locator('#qa-language').click();await settle();
   await phase('refresh-basic',async()=>{await page.reload();await ready('basic');},(before&&lang==='vi')?4:2);
   snapshots.push({text,posted:posted.map(({url,method,body})=>({url,method,body})),rpcs:api.rpcs});
   if(!before)await page.screenshot({path:`${out}/${lang}-${mobile?'mobile':'desktop'}.png`,fullPage:true});
   assert.deepEqual(errors,[]);metrics.records=records;results.push(metrics);await context.close();
  }
  if(compare)assert.deepEqual(snapshots[1],snapshots[0]);
 }}finally{await browser.close();writeFileSync(out+'/measurements.json',JSON.stringify(results,null,2));}
});

test('settings pending read errors use the current locale without triggering another request',{skip:!enabled},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{for(const type of ['basic','partners','reserves']){
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  await page.addInitScript(()=>localStorage.setItem('baba_user',JSON.stringify({id:7,role:'owner',language:'ko'})));
  let calls=0,release;const gate=new Promise(resolve=>{release=resolve;});
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==new URL(process.env.QA_UI_BASE_URL).origin){await route.abort();return;}
   if(!url.pathname.startsWith('/api/')){await route.continue();return;}
   calls++;await gate;await route.fulfill({status:500,json:{ok:false,code:'QA_LOAD_FAILED'}});
  });
  await page.goto(process.env.QA_UI_BASE_URL+'/admin/ledger/settings?tab='+type);
  await page.getByRole('tab',{name:ledgerSettingsTabText.ko[type],exact:true}).waitFor();
  await page.locator('#qa-language').click();await page.getByRole('tab',{name:ledgerSettingsTabText.vi[type],exact:true}).waitFor();
  release();
  const alert=page.getByRole('alert').filter({hasText:/\S/});await alert.waitFor();
  const text=await alert.innerText();assert.doesNotMatch(text,/[\uAC00-\uD7A3]/);if(type!=='partners')assert.equal(text,ledgerSettingsText.vi.loadFailed('QA_LOAD_FAILED'));
  assert.equal(calls,type==='basic'?2:1);await context.close();
 }}finally{await browser.close();}
});
