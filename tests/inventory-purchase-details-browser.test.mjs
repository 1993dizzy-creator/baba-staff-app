import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const sample=(id,name,vi,price,oldPrice,amount,newAmount,supplier,newSupplier)=>({
 inventoryLogId:id,rootInventoryLogId:id,itemName:name,itemNameVi:vi,businessDate:'2026-10-12',supplier:newSupplier,code:'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED',quantityDelta:0,amountDelta:0,originalQuantity:2.2,effectiveQuantity:2.2,unit:'Kg',ledgerAmount:amount,
 receiptEvidence:{booked:{quantity:2.2,price:oldPrice,amount,supplier},current:{quantity:2.2,price,supplier:newSupplier},candidateStatus:'confirmed',transactionStatus:'confirmed'},
 resolution:{recommended:false,candidates:[{inventoryLogId:id,businessDate:'2026-10-12',supplier,newSupplier,price,quantity:2.2,effectiveQuantity:2.2,quantityDelta:0,unit:'Kg',oldAmount:amount,newAmount,delta:newAmount-amount,code:supplier===newSupplier?'READY':'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED',safe:supplier===newSupplier}]},
 timeline:[{id:'inventory:'+id,kind:'purchase',logId:id,occurredAt:'2026-10-12T10:10:27Z',actor:'QA actor',quantityDelta:2.2},
 {id:'ledger:1',kind:'ledger',action:'candidate_confirmed_verification_pending',occurredAt:'2026-10-12T10:10:28Z',actor:'QA reviewer'},
 {id:'ledger:2',kind:'ledger',action:'inventory_source_projected',occurredAt:'2026-10-12T10:10:28Z',actor:'QA reviewer'},
 {id:'ledger:3',kind:'ledger',action:'inventory_source_projected',occurredAt:'2026-10-12T10:13:47Z',actor:'QA reviewer'}]
});
const fixtures=process.env.QA_PURCHASE_CASES_PATH?JSON.parse(readFileSync(process.env.QA_PURCHASE_CASES_PATH,'utf8')):[
 sample(13085,'노란 멜론','Dưa vàng',38000,32000,70400,83600,'Chợ','Chợ'),
 sample(13297,'슈웹스 토닉워터','Tonic',10000,10000,480000,480000,'Dabaco','Ok Mart'),
 sample(13477,'방울토마토','Cà chua bi',50000,50000,50000,50000,'Trung Đông','Chợ')
];
test('purchase details show changed causes and localized reasons; preserve every event and audit data across KO/VI desktop/mobile',{skip:!process.env.PLAYWRIGHT_MODULE_PATH||!process.env.QA_UI_BASE_URL},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const original=JSON.stringify(fixtures);
 try{for(const lang of ['ko','vi'])for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});
  const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[],mutations=[];page.on('pageerror',e=>errors.push(e.message));let extra=false;
  const user={id:2,name:'QA',role:'owner',language:lang};await page.addInitScript(user=>localStorage.setItem('baba_user',JSON.stringify(user)),user);
  const modified=structuredClone(fixtures[0]);modified.inventoryLogId=99001;modified.rootInventoryLogId=99001;modified.receiptEvidence.current.price=modified.receiptEvidence.booked.price;
  modified.resolution.candidates[0]={...modified.resolution.candidates[0],quantityDelta:-0.2,supplierChange:undefined,newSupplier:'QA new supplier',newAmount:60000,delta:-10400,code:'PAYABLE_ALREADY_PAID',safe:false};
  modified.timeline=[...modified.timeline].reverse();modified.timeline.push({...modified.timeline[0],id:'ledger:distinct-same-time'});
  await page.route('**/api/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;let json={ok:true,data:[]};
   if(req.method()!=='GET'){mutations.push(path);await route.fulfill({status:500,json:{ok:false}});return;}
   if(path==='/api/session')json={authenticated:true,user};
   else if(path==='/api/admin/ledger')json={ok:true,month:'2026-10',fundsView:{month:'2026-10',mode:'live',asOf:'2026-10-18',businessDateExclusive:null},summary:{income:0,salesIncome:0,otherIncome:0,receivedIncome:0,expense:600400,operatingProfit:-600400,paidExpense:0,displayedExpense:600400,actualCashOutflow:0,cardSettlementDifference:0,cardGrossSales:0,monthlySettledGross:0,actualCardDeposits:0,unsettledCardGross:0},accounts:[],categories:[],partners:[],entries:[],inventoryProjectionIssues:extra?[modified]:fixtures};
   else if(path==='/api/admin/ledger/month-close')json={ok:true,month:'2026-10',state:'open'};
   else if(path==='/api/admin/ledger/payables')json={ok:true,month:'2026-10',parties:[],payables:[],totalOutstanding:600400,summary:{openingOutstanding:0,periodPurchases:600400,periodPayments:0,closingOutstanding:600400}};
   else if(path==='/api/admin/ledger/investments')json={ok:true,month:'2026-10',configured:false,periodNetChange:0};
   await route.fulfill({json});
  });
  await page.goto(process.env.QA_UI_BASE_URL+'/admin/ledger/entries?month=2026-10');
  for(const issue of fixtures){
   const row=page.getByTestId('inventory-purchase-case-'+issue.rootInventoryLogId);await row.waitFor();const detail=row.getByTestId('purchase-case-details');assert.equal(await detail.getAttribute('open'),null);
   await detail.locator(':scope > summary').click();const body=detail.getByTestId('purchase-case-detail-body'),timeline=body.getByTestId('purchase-case-timeline'),technical=body.getByTestId('purchase-case-technical');
   assert.equal(await timeline.getAttribute('open'),null);assert.equal(await technical.getAttribute('open'),null);
   const text=await body.innerText();assert.doesNotMatch(text,/PURCHASE_|SUPPLIER_|confirmed|inventory_source_|#13085|#13297|#13477/);
   assert.equal(await body.getByTestId('purchase-case-quantity-cause').count(),0);
   if(issue.inventoryLogId===13085){assert.ok(text.includes('32,000₫/kg → 38,000₫/kg'));assert.ok(text.includes('70,400₫ → 83,600₫ (+13,200₫)'));assert.equal(await body.getByTestId('purchase-case-supplier-cause').count(),0);}
   else {assert.equal(await body.getByTestId('purchase-case-price-cause').count(),0);assert.equal(await body.getByTestId('purchase-case-ledger-impact').count(),0);const c=issue.resolution.candidates[0];assert.ok(text.includes(c.supplier+' → '+c.newSupplier));assert.ok(!text.includes('0₫'));}
   assert.ok((await timeline.locator(':scope > summary').innerText()).includes(String(issue.timeline.length)));
   await timeline.locator(':scope > summary').click();const expected=[...issue.timeline].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.id.localeCompare(b.id,undefined,{numeric:true})).map(e=>'purchase-case-event-'+e.id);
   assert.deepEqual(await timeline.locator('li').evaluateAll(nodes=>nodes.map(n=>n.dataset.testid)),expected);
   assert.equal(await timeline.locator('time').count(),issue.timeline.length);
   const firstTime=await timeline.locator('time').first().innerText();const firstEvent=[...issue.timeline].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt))[0];
   assert.ok(firstTime.includes(new Date(firstEvent.occurredAt).toLocaleTimeString(lang==='ko'?'ko-KR':'vi-VN',{timeZone:'Asia/Ho_Chi_Minh',hour12:false})));
   assert.doesNotMatch(await timeline.innerText(),/inventory_source_|candidate_confirmed_|PURCHASE_/);
   await technical.locator(':scope > summary').click();assert.ok((await technical.innerText()).includes(issue.code));assert.ok((await technical.innerText()).includes('#'+issue.rootInventoryLogId));await technical.locator(':scope > summary').click();await timeline.locator(':scope > summary').click();
   assert.equal(await row.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  }
  await mkdir('.qa-review/purchase-review-details',{recursive:true});
  const captureStyle=await page.addStyleTag({content:'[class*=balanceBar]{visibility:hidden!important}'});
  await page.locator('section').filter({has:page.getByTestId('inventory-purchase-case-13085')}).screenshot({path:'.qa-review/purchase-review-details/'+lang+'-'+(mobile?'mobile':'desktop')+'.png'});
  const melon=page.getByTestId('inventory-purchase-case-13085');await melon.getByTestId('purchase-case-timeline').locator(':scope > summary').click();await melon.screenshot({path:'.qa-review/purchase-review-details/'+lang+'-'+(mobile?'mobile':'desktop')+'-history.png'});
  await melon.getByTestId('purchase-case-details').locator(':scope > summary').click();assert.equal(await melon.getByTestId('purchase-case-details').getAttribute('open'),null);
  await captureStyle.evaluate(el=>el.remove());
  extra=true;await page.reload();const row=page.getByTestId('inventory-purchase-case-99001');await row.getByTestId('purchase-case-details').locator(':scope > summary').click();
  const body=row.getByTestId('purchase-case-detail-body');assert.equal(await body.getByTestId('purchase-case-quantity-cause').count(),1);assert.equal(await body.getByTestId('purchase-case-supplier-cause').count(),1);assert.equal(await body.getByTestId('purchase-case-price-cause').count(),0);assert.ok((await body.getByTestId('purchase-case-review-reason').innerText()).includes(lang==='ko'?'지급 또는 배분':'thanh toán'));
  const timeline=body.getByTestId('purchase-case-timeline');await timeline.locator(':scope > summary').click();assert.equal(await timeline.locator('li').count(),modified.timeline.length);assert.equal(await timeline.getByTestId('purchase-case-event-ledger:distinct-same-time').count(),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);assert.deepEqual(mutations,[]);await context.close();
  console.log('PASS details, hidden unchanged fields/codes, exact prices/money/suppliers, complete chronology, audit disclosure',lang,mobile?'mobile':'desktop',fixtures.length+' recorded cases');
 }}finally{await browser.close();}
 assert.equal(JSON.stringify(fixtures),original);
});
