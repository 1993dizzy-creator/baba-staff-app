import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const root='.qa-review/october-settlement/';
test('unified root settlement and payment-verification queue across KO/VI desktop/mobile',{skip:!process.env.PLAYWRIGHT_MODULE_PATH||!process.env.QA_UI_BASE_URL},async()=>{
 const entries=JSON.parse(readFileSync(root+'entries.json')),comparison=JSON.parse(readFileSync(root+'comparison.json')),verification=JSON.parse(readFileSync(root+'verification.json'));
 const target=entries.find(e=>e.items.some(i=>i.transactionId===2369)),partial=entries.filter(e=>e.items.some(i=>[2266,2327].includes(i.transactionId)));
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH),browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{for(const lang of ['ko','vi'])for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile}),page=await context.newPage();page.setDefaultTimeout(15000);const errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
  const user={id:2,name:'QA',role:'owner',language:lang};await page.addInitScript(user=>localStorage.setItem('baba_user',JSON.stringify(user)),user);
  await page.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;let json={ok:true,data:[]};if(req.method()!=='GET'){posts.push(path);await route.fulfill({status:500,json:{ok:false}});return;}
   if(path==='/api/session')json={authenticated:true,user};
   else if(path==='/api/admin/ledger')json={ok:true,month:'2026-10',fundsView:{month:'2026-10',mode:'live',asOf:'2026-10-18',businessDateExclusive:null},summary:{income:comparison.totals.income,salesIncome:comparison.totals.income,otherIncome:0,receivedIncome:0,expense:comparison.totals.expenseAfter,operatingProfit:comparison.totals.profitAfter,paidExpense:0,displayedExpense:comparison.totals.expenseAfter,actualCashOutflow:0,cardSettlementDifference:0,cardGrossSales:0,monthlySettledGross:0,actualCardDeposits:0,unsettledCardGross:0},accounts:[],categories:[],partners:[],entries:[target,...partial]};
   else if(path==='/api/admin/ledger/month-close')json={ok:true,month:'2026-10',state:'open'};
   else if(path==='/api/admin/ledger/payables')json={ok:true,month:'2026-10',parties:[],payables:[],totalOutstanding:comparison.ordinaryMonthBalance.after.closingOutstanding,summary:comparison.ordinaryMonthBalance.after,verification};
   else if(path==='/api/admin/ledger/investments')json={ok:true,month:'2026-10',configured:false,periodNetChange:0};
   await route.fulfill({json});
  });
  await page.goto(process.env.QA_UI_BASE_URL+'/admin/ledger/entries?month=2026-10');
  const history=page.locator('[aria-controls="ledger-history-panel"]');await history.waitFor();if(await history.getAttribute('aria-expanded')==='false')await history.click();
  const dateToggle=page.locator('[aria-controls="ledger-date-'+target.businessDate+'"]');if(await dateToggle.getAttribute('aria-expanded')==='false')await dateToggle.click();await page.locator('#ledger-date-'+target.businessDate+' button[class*="entryRow"]').first().click();
  const dialog=page.getByRole('dialog');await dialog.waitFor();const panel=dialog.getByTestId('purchase-settlement').filter({hasText:'#2911'});await panel.locator(':scope > summary').click();
  const text=await panel.innerText();const money=n=>Number(n).toLocaleString(lang==='vi'?'vi-VN':'ko-KR',{maximumFractionDigits:3})+'₫';
  for(const amount of [49500,-500,49000,0])assert.ok(text.includes(money(amount)));assert.ok(text.includes(lang==='ko'?'정산 완료':'Đã quyết toán'));assert.ok(!text.includes('49,500₫ / 49,500₫'));
  await mkdir(root+'screenshots',{recursive:true});await dialog.screenshot({path:root+'screenshots/'+lang+'-'+(mobile?'mobile':'desktop')+'-root.png'});
  await panel.locator('details > summary').click();assert.ok((await panel.innerText()).includes('#2911'));assert.ok((await panel.innerText()).includes('#2879'));
  assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true);await dialog.locator('header button').first().click();
  await page.locator('button[class*="payableToggle"]').first().click();await page.getByRole('button',{name:lang==='ko'?/기타.*결제 미확인/:/Khác.*Chưa xác minh/}).click();
  const queue=page.getByRole('dialog');await queue.waitFor();
  for(const toggle of await queue.locator('button[class*="verificationDateToggle"]').all())await toggle.click();
  assert.equal(await queue.getByTestId('purchase-settlement').count(),verification.pendingCount);
  assert.equal(await queue.locator('[data-testid="purchase-settlement"]').filter({hasText:'#2911'}).count(),0);
  const first=queue.getByTestId('purchase-settlement').first();await first.locator(':scope > summary').click();assert.ok((await first.innerText()).includes(lang==='ko'?'최종 미지급액':'Công nợ cuối'));
  await queue.screenshot({path:root+'screenshots/'+lang+'-'+(mobile?'mobile':'desktop')+'-queue.png'});assert.equal(await queue.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);await context.close();console.log('PASS original / adjustment / recognized / real paid / remaining, audit links and pending queue',lang,mobile?'mobile':'desktop');
 }}finally{await browser.close();}
});
