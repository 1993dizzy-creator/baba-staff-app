import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {buildPurchaseCases} from '../lib/inventory/purchase-cases.ts';
const require=createRequire(import.meta.url);
// User-provided production IDs/links, with synthetic quantity/price/time/actor.
const log=(id,item,name,minute,delta,root=null,reason='purchase')=>({id,item_id:item,item_name:name,item_name_vi:name==='토닉워터'?'Tonic':'Ginger ale',business_date:'2026-10-11',created_at:`2026-10-11T03:${String(minute).padStart(2,'0')}:00Z`,change_quantity:delta,new_purchase_price:20000,new_supplier:'QA supplier',purchase_supplier_partner_id:10,unit:'can',reason,source:'edit_form',actor_name:'QA actor',correction_of_inventory_log_id:root});
const logs=[log(12971,309,'토닉워터',1,10),log(12982,309,'토닉워터',10,-2,null,'stock_check'),log(13000,309,'토닉워터',20,-10,12971),log(13001,309,'토닉워터',21,12),log(12972,566,'진저에일',2,10),log(12998,566,'진저에일',18,-10,12972),log(12983,477,'진저에일',11,2,null,'stock_check'),log(13002,477,'진저에일',22,8)];
const issues=logs.filter(l=>l.reason==='purchase').map(l=>({inventoryLogId:l.id,status:'review_required',code:'PURCHASE_ORIGINAL_CANCELLED',itemName:l.item_name,itemNameVi:l.item_name_vi,businessDate:l.business_date,quantityDelta:l.change_quantity,amountDelta:l.change_quantity*20000,originalQuantity:null,createdAt:l.created_at}));
const candidate=(id,quantity,corrections=[],cancelled=false)=>({id,source_key:`inventory-log:${id}`,status:cancelled?'dismissed':'confirmed',dismissal_reason:cancelled?'Inventory purchase fully cancelled':null,resolved_transaction_id:cancelled?null:id,proposed_amount:quantity*20000,source_snapshot:{change_quantity:quantity,purchase_price:20000,purchase_amount:quantity*20000,supplier:'QA supplier',purchase_supplier_partner_id:10,inventory_correction_log_ids:corrections}});
const candidates=[candidate(12971,10),candidate(12972,10)];
const transactions=[{id:12971,amount:200000,status:'confirmed'},{id:12972,amount:200000,status:'confirmed'},{id:13001,amount:240000,status:'confirmed'},{id:13002,amount:160000,status:'confirmed'}];
const audits=[{id:1,entity_type:'inventory_log',entity_id:13000,action:'inventory_source_projected',created_at:'2026-10-11T03:20:01Z',actor_user_id:1,after_snapshot:{amount:200000,transactionId:12971}}];
test('purchase case banner and chronology across KO/VI desktop/mobile, completed 10/11 cases never replayed',{skip:!process.env.PLAYWRIGHT_MODULE_PATH || !process.env.QA_UI_BASE_URL},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{for(const lang of ['ko','vi'])for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});const page=await context.newPage();page.setDefaultTimeout(10000);let completed=false;const mutations=[];
  const master=[{id:566,is_active:false},{id:477,is_active:true,code:'O6'}],masterBefore=JSON.stringify(master);
  await page.addInitScript(user=>localStorage.setItem('baba_user',JSON.stringify(user)),{id:2,name:'QA',role:'owner',part:'bar',language:lang});
  // Catch every API request. This test cannot reach any actual database.
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());if(req.method()!=='GET'){mutations.push(url.pathname);await route.fulfill({status:500,json:{ok:false}});return;}
   let json={ok:true,data:[]};
   if(url.pathname==='/api/session')json={authenticated:true,user:{id:2,name:'QA',role:'owner',language:lang}};
   else if(url.pathname==='/api/admin/ledger'){
    const state=completed?[candidate(12971,0,[13000],true),candidate(12972,0,[12998],true),candidate(13001,12),candidate(13002,8)]:candidates;
    const cases=buildPurchaseCases({logs,issues,candidates:state,transactions,audits,actors:new Map([[1,'QA reviewer']])});
    json={ok:true,month:'2026-10',fundsView:{month:'2026-10',mode:'live',asOf:'2026-10-11',businessDateExclusive:null},summary:{income:0,salesIncome:0,otherIncome:0,receivedIncome:0,expense:400000,operatingProfit:-400000,paidExpense:0,displayedExpense:400000,actualCashOutflow:0,cardSettlementDifference:0,cardGrossSales:0,monthlySettledGross:0,actualCardDeposits:0,unsettledCardGross:0},accounts:[],categories:[],partners:[],entries:[],inventoryProjectionIssues:cases};
   }
   else if(url.pathname==='/api/admin/ledger/month-close')json={ok:true,month:'2026-10',state:'open'};
   else if(url.pathname==='/api/admin/ledger/payables')json={ok:true,month:'2026-10',parties:[],payables:[],totalOutstanding:400000,summary:{openingOutstanding:0,periodPurchases:400000,periodPayments:0,closingOutstanding:400000}};
   else if(url.pathname==='/api/admin/ledger/investments')json={ok:true,month:'2026-10',configured:false,periodNetChange:0};
   await route.fulfill({json});
  });
  await page.goto(process.env.QA_UI_BASE_URL+'/admin/ledger/entries?month=2026-10');
  const warning=page.locator('section').filter({has:page.getByText(lang==='ko'?'⚠️ 입고 수정 장부 반영 확인 필요':'⚠️ Cần kiểm tra ghi sổ nhập kho',{exact:true})});await warning.waitFor();
  assert.match(await warning.innerText(),lang==='ko'?/4건/:/4 thay đổi/);
  await warning.locator(':scope > details > summary').click();
  for(const id of [12971,12972,13001,13002])assert.equal(await page.getByTestId('inventory-purchase-case-'+id).count(),1);
  assert.equal(await page.getByTestId('inventory-purchase-case-13000').count(),0);assert.equal(await page.getByTestId('inventory-purchase-case-12998').count(),0);
  const tonic=page.getByTestId('inventory-purchase-case-12971');const text=await tonic.innerText();assert.match(text,lang==='ko'?/토닉워터/:/Tonic/);assert.match(text,/12971/);assert.match(text,/2026-10-11/);assert.match(text,/10 → 0can \(-10\)/);assert.match(text,/200,000₫/);assert.match(text,lang==='ko'?/관리자 확인 필요/:/Cần quản trị viên kiểm tra/);
  await tonic.locator('summary').click();assert.deepEqual(await tonic.locator('ol li').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-testid'))),['purchase-case-event-inventory:12971','purchase-case-event-inventory:12982','purchase-case-event-inventory:13000','purchase-case-event-ledger:1']);
  assert.ok((await tonic.innerText()).includes('QA actor'));assert.ok((await tonic.innerText()).includes('QA reviewer'));assert.match(await tonic.innerText(),lang==='ko'?/재고조사 \(입고 수량 집계 제외\)/:/Kiểm kê \(không đổi số lượng nhập\)/);
  const o6=page.getByTestId('inventory-purchase-case-13002');await o6.locator('summary').click();assert.deepEqual(await o6.locator('ol li').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-testid'))),['purchase-case-event-inventory:12983','purchase-case-event-inventory:13002']);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);assert.equal(await tonic.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await mkdir('.qa-review/purchase-cases-browser',{recursive:true});await page.screenshot({path:'.qa-review/purchase-cases-browser/'+lang+'-'+(mobile?'mobile':'desktop')+'.png',fullPage:true});
  // Already completed state is provided as read-only evidence, never a POST.
  completed=true;await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/ledger'),page.reload()]);await page.getByRole('heading').first().waitFor();
  assert.equal(await warning.count(),0);assert.equal(await page.getByTestId('inventory-purchase-case-12971').count(),0);assert.equal(await page.getByTestId('inventory-purchase-case-12972').count(),0);assert.deepEqual(mutations,[]);assert.equal(JSON.stringify(master),masterBefore);
  console.log('PASS case IDs, separate receipts/items, stock-check chronology, localized responsive list, completed cases hidden without mutation',lang,mobile?'mobile':'desktop');await context.close();
 }}finally{await browser.close();}
});