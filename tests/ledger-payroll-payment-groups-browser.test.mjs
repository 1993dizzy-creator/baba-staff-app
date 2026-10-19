import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {buildLedgerEntries} from '../lib/ledger/entries.ts';
import {analyzePayrollPaymentGroups} from '../lib/ledger/payroll-payment-groups.ts';
import {octoberHistory} from './helpers/payroll-payment-group-fixture.mjs';
const require=createRequire(import.meta.url),enabled=!!process.env.PLAYWRIGHT_MODULE_PATH&&!!process.env.QA_UI_BASE_URL;
test('corrected list totals and ambiguous-link warning: KO/VI desktop/mobile, all/expense/payroll', {skip:!enabled},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const out='.tmp/payroll-group-visibility-20261019/browser';mkdirSync(out,{recursive:true});
 try{for(const lang of ['ko','vi'])for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  const page=await context.newPage();page.setDefaultTimeout(20000);await page.clock.setFixedTime(new Date('2026-10-19T06:00:00Z'));
  const user={id:1,name:'QA',role:'owner',language:lang};await page.addInitScript(u=>localStorage.setItem('baba_user',JSON.stringify(u)),user);
  const requests=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));let malformed=false;
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==new URL(process.env.QA_UI_BASE_URL).origin){await route.abort();return;}
   requests.push(url.pathname);if(!url.pathname.startsWith('/api/')){await route.continue();return;}
   assert.equal(route.request().method(),'GET','read-only browser fixture');
   let json={ok:true,data:[]};
   if(url.pathname==='/api/session')json={authenticated:true,user};
   else if(url.pathname==='/api/admin/ledger'){
    const transactions=octoberHistory();if(malformed)transactions.find(r=>r.source_type==='payroll_payment_group_reversal').amount++;
    json={ok:true,month:'2026-10',fundsView:{month:'2026-10',mode:'live',asOf:'2026-10-19'},summary:{income:41530800,salesIncome:0,otherIncome:41530800,receivedIncome:41530800,expense:176185794,operatingProfit:41530800-176185794,paidExpense:7205900,displayedExpense:7205900,actualCashOutflow:158654309,cardSettlementDifference:0,cardGrossSales:0,monthlySettledGross:0,actualCardDeposits:0,unsettledCardGross:0},accounts:[],categories:[],parties:[],partners:[],transactions,entries:buildLedgerEntries(transactions,[],new Map(),[],'2026-10'),payrollPaymentGroupIssues:analyzePayrollPaymentGroups(transactions).issues};
   }else if(url.pathname==='/api/admin/ledger/month-close')json={ok:true,month:'2026-10',state:'open'};
   else if(url.pathname==='/api/admin/ledger/payables')json={ok:true,month:'2026-10',summary:{openingOutstanding:0,periodPurchases:0,periodPayments:0,closingOutstanding:0},parties:[],payables:[],totalOutstanding:0,verification:{items:[],pendingCount:0,totalPending:0}};
   else if(url.pathname==='/api/admin/ledger/investments')json={ok:true,month:'2026-10',configured:false,periodNetChange:0};
   await route.fulfill({json});
  });
  await page.goto(process.env.QA_UI_BASE_URL+'/admin/ledger/entries?month=2026-10');
  await page.locator('[aria-controls="ledger-history-panel"]').click();
  const header=page.locator('button[class*="dateHeader"]:not([aria-controls="ledger-history-panel"])').first();try{await header.waitFor();}catch(error){console.log(JSON.stringify({url:page.url(),body:(await page.locator('body').innerText()).slice(0,5000),errors,requests}));await page.screenshot({path:out+'/failure.png'});throw error;}
  const filter=page.locator('div[class*="filterTabs"]');
  for(const [label,count,expense,income] of (lang==='ko'?[
   ['전체',5,158654309,41530800],['지출',4,158654309,0],['급여',3,151448409,0]
  ]:[['Tất cả',5,158654309,41530800],['Chi',4,158654309,0],['Lương',3,151448409,0]])){
   await filter.getByRole('button',{name:label,exact:true}).click();
   const text=(await header.innerText()).replaceAll(/[,.\s]/g,'');
   assert.ok(text.includes(`${count}${lang==='ko'?'건':'giaodịch'}`),text);
   assert.ok(text.includes(String(expense)),text);if(income)assert.ok(text.includes(String(income)),text);
   await page.screenshot({path:`${out}/${lang}-${mobile?'mobile':'desktop'}-${expense===151448409?'payroll':income?'all':'expense'}.png`,fullPage:true});
  }
  malformed=true;await page.reload();await page.getByText(lang==='ko'?'급여 역분개 연결 확인 필요':'Cần kiểm tra liên kết hoàn chi lương',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);await context.close();
 }}finally{await browser.close();}
});
