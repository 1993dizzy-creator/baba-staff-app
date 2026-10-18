import { PAYMENT_REFRESH_MESSAGES } from "../lib/ledger/payable-payment-messages.ts";
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {database} from './helpers/inventory-ledger-fixture.mjs';
const require=createRequire(import.meta.url),enabled=!!process.env.PLAYWRIGHT_MODULE_PATH&&!!process.env.QA_UI_BASE_URL;
test('browser → real API handler → isolated DB → lost-response recovery; KO/VI desktop/mobile',{skip:!enabled},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH),browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const db=await database();await db.exec(readFileSync('supabase/migrations/202608210004_add_ledger_payable_payments.sql','utf8'));await db.exec(readFileSync('supabase/migrations/20261018105936_add_payable_payment_idempotency_v2.sql','utf8'));
 let denyActor=false,rpcCalls=0;
 const output=ts.transpileModule(readFileSync('app/api/admin/ledger/payables/pay/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,mod={exports:{}};
 new Function('require','module','exports',output)(name=>({
  '@/lib/ledger/payable-payment-messages':{PAYMENT_REFRESH_MESSAGES},
  '@/lib/ledger/server':{requireLedgerActor:async()=>denyActor?{actor:null,response:Response.json({ok:false,code:'FORBIDDEN'},{status:403})}:{actor:{id:2}},ledgerJson:(json,status=200)=>Response.json(json,{status})},
  '@/lib/supabase/server':{supabaseServer:{rpc:async(name,p)=>{rpcCalls++;assert.equal(name,'ledger_pay_payables_v2');try{return{data:(await db.query('select ledger_pay_payables_v2($1,$2,$3,$4,$5,$6::jsonb,$7,$8) as result',[p.p_request_id,p.p_party_id,p.p_fund_account_id,p.p_occurred_at,p.p_amount,JSON.stringify(p.p_allocations),p.p_memo,p.p_actor_user_id])).rows[0].result,error:null}}catch(e){return{data:null,error:{code:e.code}}}}}}
 })[name],mod,mod.exports);
 mkdirSync('.qa-review/october-settlement/idempotency-screenshots',{recursive:true});
 try{for(const lang of ['ko','vi'])for(const mobile of [false,true])for(const verification of [false,true]){
  const transaction=(await db.query("insert into ledger_transactions(operation_id,type,occurred_at,business_date,recognition_month,amount,category_id,party_id,status,source_type,created_by,confirmed_by) values(gen_random_uuid(),'expense','2026-10-05T12:00:00+07:00','2026-10-05','2026-10-01',40000,4,10,'confirmed','manual',2,2) returning id")).rows[0];
  const payableId=Number((await db.query("insert into ledger_payables(expense_transaction_id,party_id,original_amount,status) values($1,10,40000,'unpaid') returning id",[transaction.id])).rows[0].id);
  const remaining=async()=>Number((await db.query('select 40000-coalesce(sum(allocated_amount),0) as value from ledger_payable_allocations where payable_id=$1',[payableId])).rows[0].value);
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile}),page=await context.newPage();page.setDefaultTimeout(15000);
  await page.clock.setFixedTime(new Date('2026-10-18T06:00:00Z'));
  const user={id:2,name:'QA',role:'owner',language:lang};await page.addInitScript(user=>localStorage.setItem('baba_user',JSON.stringify(user)),user);
  const posts=[],errors=[];let loseResponse=true,legacyRequest=true;page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   const r=route.request(),path=new URL(r.url()).pathname;
   if(r.method()!=='GET'){
    assert.equal(path,'/api/admin/ledger/payables/pay');const b=r.postDataJSON();
    if(legacyRequest){legacyRequest=false;const legacy={...b};delete legacy.requestId;
     const countBefore=rpcCalls,response=await mod.exports.POST(new Request('http://localhost'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(legacy)})),json=await response.json();
     assert.equal(response.status,428);assert.equal(json.action,'refresh');assert.equal(json.message[lang],PAYMENT_REFRESH_MESSAGES[lang]);assert.equal(rpcCalls,countBefore);
     await route.fulfill({status:428,json});return;
    }
    posts.push(b);denyActor=posts.length===2;
    const response=await mod.exports.POST(new Request('http://localhost'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}));denyActor=false;
    if(loseResponse&&response.ok){loseResponse=false;await route.fulfill({status:504,json:{ok:false,code:'SIMULATED_LOST_RESPONSE_AFTER_COMMIT'}})}else await route.fulfill({status:response.status,json:await response.json()});return;
   }
   const left=await remaining(),summary={openingOutstanding:0,periodPurchases:40000,periodPayments:40000-left,closingOutstanding:left};
   const expense={id:Number(transaction.id),business_date:'2026-10-05',status:'confirmed',source_snapshot:{item_name:'테스트 품목',item_name_vi:'Mặt hàng kiểm thử'}};
   const row={id:payableId,party_id:10,original_amount:40000,status:left===40000?'unpaid':'partially_paid',outstandingAmount:left,paidAmount:40000-left,expense};
   const party={...summary,partyId:10,partyName:'QA Supplier',partnerType:'supplier',outstandingAmount:left,partialPaidAmount:40000-left,totalOpenAmount:40000,openCount:1,oldestDate:'2026-10-05'};
   const item={payableId,partyId:10,businessDate:'2026-10-05',itemName:'테스트 품목',itemNameVi:'Mặt hàng kiểm thử',supplierName:'QA Supplier',quantity:1,unitPrice:40000,amount:40000,paidAmount:40000-left,remainingAmount:left,appPaymentStatus:'unconfirmed',paymentDate:null};
   let json={ok:true,data:[]};
   if(path==='/api/session')json={authenticated:true,user};
   else if(path==='/api/admin/ledger')json={ok:true,month:'2026-10',fundsView:{month:'2026-10',mode:'live',asOf:'2026-10-18'},summary:{income:0,salesIncome:0,otherIncome:0,receivedIncome:0,expense:40000,operatingProfit:-40000,paidExpense:40000-left,displayedExpense:40000,actualCashOutflow:40000-left,cardSettlementDifference:0,cardGrossSales:0,monthlySettledGross:0,actualCardDeposits:0,unsettledCardGross:0},accounts:[{id:1,code:'store_cash',type:'cash',display_name:'현금 / Tiền mặt',is_active:true,is_business_fund:true,balance:1000000,openingBalance:1000000,reserveTotal:0,availableBalance:1000000,reserves:[]}],categories:[],partners:[],entries:[]};
   else if(path==='/api/admin/ledger/payables')json={ok:true,month:'2026-10',summary,parties:verification?[]:[party],payables:verification?[]:[row],totalOutstanding:verification?0:left,verification:{items:verification?[item]:[],pendingCount:verification?1:0,totalPending:verification?left:0}};
   else if(path==='/api/admin/ledger/payables/10')json={ok:true,party:{id:10,name:'QA Supplier'},payables:[row],payments:[],totalOutstanding:left};
   else if(path==='/api/admin/ledger/month-close')json={ok:true,month:'2026-10',state:'open'};
   else if(path==='/api/admin/ledger/investments')json={ok:true,month:'2026-10',configured:false,periodNetChange:0};
   await route.fulfill({json});
  });
  async function open(){
   await page.goto(process.env.QA_UI_BASE_URL+'/admin/ledger/entries?month=2026-10');
   const toggle=page.locator('[aria-controls="payable-status-body"]');if(await toggle.count()){if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();}else await page.locator('button[class*="payableToggle"]').first().click();
   await page.locator('#payable-parties-list > button').first().click();await page.getByRole('dialog').waitFor();
  }
  async function fill(){
   const d=page.getByRole('dialog');
   if(verification){await d.locator('button[class*="verificationDateToggle"]').click();await d.getByRole('button',{name:lang==='ko'?'개별 결제':'Thanh toán riêng',exact:true}).click();}
   else await d.locator('div[class*="payModeTabs"] button').nth(1).click();
   await d.locator(verification?'input[inputmode="decimal"]':'input[inputmode="numeric"]').fill('1000');
   await d.locator('select').selectOption('1');return d;
  }
  await open();let dialog=await fill();
  const submit=dialog.locator('footer button').first();await submit.click();
  const refresh=dialog.getByRole('button',{name:lang==='ko'?'화면 새로고침':'Tải lại trang',exact:true});await refresh.waitFor();
  assert.ok((await dialog.innerText()).includes(PAYMENT_REFRESH_MESSAGES[lang]));assert.equal(await remaining(),40000);
  const attemptBefore=await page.evaluate(()=>Object.entries(sessionStorage).find(([k])=>k.startsWith('ledger-payable-payment:'))[1]);
  await dialog.screenshot({path:'.qa-review/october-settlement/idempotency-screenshots/'+lang+'-'+(mobile?'mobile':'desktop')+'-'+(verification?'verification':'partial')+'-428.png'});
  await Promise.all([page.waitForEvent('load'),refresh.click()]);
  assert.equal(await page.evaluate(()=>Object.entries(sessionStorage).find(([k])=>k.startsWith('ledger-payable-payment:'))[1]),attemptBefore);
  await open();dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:lang==='ko'?'기존 요청 결과 확인':'Kiểm tra yêu cầu cũ',exact:true}).click();
  const recovery=dialog.getByRole('button',{name:lang==='ko'?'기존 요청 결과 확인':'Kiểm tra yêu cầu cũ',exact:true});await recovery.waitFor();assert.equal(await remaining(),39000);
  const filename=lang+'-'+(mobile?'mobile':'desktop')+'-'+(verification?'verification':'partial');
  await dialog.screenshot({path:'.qa-review/october-settlement/idempotency-screenshots/'+filename+'.png'});assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  const key=posts[0].requestId;assert.match(key,/^[0-9a-f-]{36}$/);
  // Reload deliberately resets form values; recovery sends the stored original body.
  await open();dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:lang==='ko'?'기존 요청 결과 확인':'Kiểm tra yêu cầu cũ',exact:true}).click();
  await dialog.locator('aside [role="alert"]').waitFor();
  assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).some(k=>k.startsWith('ledger-payable-payment:'))),true);
  assert.equal(await remaining(),39000);
  await open();dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:lang==='ko'?'기존 요청 결과 확인':'Kiểm tra yêu cầu cũ',exact:true}).click();
  await page.waitForFunction(()=>!Object.keys(sessionStorage).some(k=>k.startsWith('ledger-payable-payment:')));
  assert.equal(posts.length,3);assert.deepEqual(posts[0],posts[2]);assert.deepEqual(posts[0],posts[1]);assert.equal(await remaining(),39000);
  // A new legitimate identical amount gets a different key. Two synchronous clicks share it.
  await open();dialog=await fill();await dialog.locator('footer button').first().evaluate(el=>{el.click();el.click()});
  await page.waitForFunction(()=>!Object.keys(sessionStorage).some(k=>k.startsWith('ledger-payable-payment:')));
  assert.equal(posts.length,4);assert.notEqual(posts[3].requestId,key);assert.equal(await remaining(),38000);
  assert.equal(Number((await db.query('select count(*) from ledger_payable_allocations where payable_id=$1',[payableId])).rows[0].count),2);
  assert.deepEqual(errors,[]);await context.close();console.log('PASS',filename,'lost response/auth refusal/reload/same key/independent new payment/double click');
 }}finally{await browser.close();await db.close();}
});