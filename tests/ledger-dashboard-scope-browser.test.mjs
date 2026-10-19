import test from 'node:test';import assert from 'node:assert/strict';import{createRequire}from'node:module';import{mkdirSync,writeFileSync}from'node:fs';
import{dashboardApi}from'./helpers/ledger-dashboard-api-fixture.mjs';import{dashboardTables}from'./helpers/ledger-dashboard-tables.mjs';
const require=createRequire(import.meta.url),enabled=!!process.env.PLAYWRIGHT_MODULE_PATH&&!!process.env.QA_UI_BASE_URL;
test('full/light real GET → dashboard: KO/VI desktop/mobile, 3 months, expand/profit/month/reload equality',{skip:!enabled},async()=>{
 const{chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH),browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const out='.tmp/dashboard-scope-20261019/browser';mkdirSync(out,{recursive:true});const measurements=[];
 try{for(const lang of ['ko','vi'])for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(20000);
  await page.clock.setFixedTime(new Date('2026-10-19T06:00:00Z'));await page.addInitScript(lang=>localStorage.setItem('baba_user',JSON.stringify({id:1,name:'QA',role:'owner',language:lang})),lang);
  let light=false,requests=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==new URL(process.env.QA_UI_BASE_URL).origin){await route.abort();return;}
   if(!url.pathname.startsWith('/api/')){await route.continue();return;}
   assert.equal(route.request().method(),'GET');requests.push(url.pathname+url.search);const month=url.searchParams.get('month');let json={ok:true,month};
   if(url.pathname==='/api/admin/ledger'){
    assert.equal(url.searchParams.get('scope'),'dashboard');
    const response=await dashboardApi(dashboardTables()).get(month,light?'&scope=dashboard':'');json=await response.json();assert.equal(response.status,200);
   }else if(url.pathname==='/api/admin/ledger/payroll-cost')json={ok:true,month,status:month==='2026-10'?'predicted':'finalized',amount:15000,recognizedAmount:month==='2026-10'?0:15000,adjustment:month==='2026-10'?15000:0,batchStatus:month==='2026-10'?'paying':'completed'};
   else if(url.pathname==='/api/admin/ledger/card-settlements')json={ok:true,month,summary:{monthlyCardGross:30000,monthlySettledGross:10000,monthlySettlementDifference:200,actualDifferenceRate:0.02}};
   await route.fulfill({json});
  });
  for(const month of ['2026-08','2026-09','2026-10']){
   const snapshots=[];
   for(const compact of [false,true]){
    light=compact;requests=[];await page.goto(process.env.QA_UI_BASE_URL+'/admin/ledger?month='+month);await page.locator('[class*="cashFlow"]').first().waitFor();
    const toggles=page.locator('button[aria-expanded="false"]');const count=await toggles.count();for(let i=0;i<count;i++)await toggles.first().click();
    await page.getByRole('button',{name:lang==='ko'?'상세보기 ›':'Chi tiết ›',exact:true}).click();await page.getByRole('dialog').waitFor();
    await page.waitForFunction(()=>{const text=document.body.innerText;return !text.includes('확인 중')&&!text.includes('Đang kiểm tra');});
    const detail=await page.getByRole('dialog').innerText();await page.getByRole('dialog').getByRole('button',{name:lang==='ko'?'닫기':'Đóng',exact:true}).first().click();
    const main=await page.locator('main').last().innerText();snapshots.push({main,detail});
    assert.equal(requests.filter(p=>p.startsWith('/api/admin/ledger?')).length,2);assert.equal(requests.length,month==='2026-10'?5:3);
    measurements.push({lang,mobile,month,mode:compact?'dashboard':'full',requests:requests.length});
    if(compact)await page.screenshot({path:`${out}/${lang}-${mobile?'mobile':'desktop'}-${month}.png`,fullPage:true});
   }
   assert.deepEqual(snapshots[1],snapshots[0]);
  }
  // URL month change and a real reload must keep the compact scope and selected month.
  requests=[];await page.locator('input[type="month"]').fill('2026-09');await page.waitForURL('**month=2026-09');await page.locator('[class*="cashFlow"]').first().waitFor();
  await page.reload();await page.locator('[class*="cashFlow"]').first().waitFor();assert.equal(await page.locator('input[type="month"]').inputValue(),'2026-09');
  assert.ok(requests.some(p=>p==='/api/admin/ledger?month=2026-09&scope=dashboard'));assert.deepEqual(errors,[]);await context.close();
 }}finally{await browser.close();}
 writeFileSync(out+'/requests.json',JSON.stringify(measurements,null,2));
});
