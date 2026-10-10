import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {purchaseRepairError} from '../lib/inventory/purchase-repair-contract.ts';
const require=createRequire(import.meta.url);
test('daily sync details and centered supplier approvals across KO/VI desktop/mobile',{skip:!process.env.PLAYWRIGHT_MODULE_PATH || !process.env.QA_UI_BASE_URL},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{for(const lang of ['ko','vi'])for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});const page=await context.newPage();page.setDefaultTimeout(10000);const requests=[];let synced=false,economic=false,resolved=false,blockedCode=null,postCode='SUPPLIER_CHANGE_CONFIRMATION_STALE',fingerprint='a'.repeat(64);
  const user={id:2,name:'QA',role:'owner',part:'kitchen',language:lang};await page.addInitScript(user=>localStorage.setItem('baba_user',JSON.stringify(user)),user);
  const root={id:12848,item_id:314,item_name:'배',item_name_vi:'Lê',part:'kitchen',category:'Fruit',category_vi:'Fruit',code:'QA',unit:'kg',change_quantity:1,prev_quantity:0,new_quantity:1,new_supplier:'Chợ',new_purchase_price:35000,created_at:'2026-10-09T04:00:00Z',reason:'purchase'};
  const candidate=()=>({inventoryLogId:12848,businessDate:'2026-10-09',quantity:1,effectiveQuantity:1,unit:'kg',price:35000,supplier:'Chợ',newSupplier:'An Liên',oldAmount:35000,newAmount:35000,delta:0,quantityDelta:0,safe:false,code:blockedCode||'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED',supplierChange:{valid:true,requiresConfirmation:true,beforeSupplier:'Chợ',afterSupplier:'An Liên',beforePartnerId:'7',afterPartnerId:'27',confirmationFingerprint:fingerprint}});
  const issue={inventoryLogId:12848,code:'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED',itemName:'배',itemNameVi:'Lê',supplier:'Chợ',businessDate:'2026-10-09',quantityDelta:0,amountDelta:0,originalQuantity:1};
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());requests.push({path:url.pathname,method:req.method(),body:req.method()==='POST'?req.postDataJSON():null});let json={ok:true,data:[]},status=200;
   if(url.pathname==='/api/session')json={authenticated:true,user};
   else if(url.pathname==='/api/inventory/snapshot/list')json={ok:true,batches:[{id:9,snapshot_date:'2026-10-09'}],currentBusinessDate:'2026-10-09',purchaseDateMap:{'2026-10-09':true,'2026-10-10':true}};
   else if(url.pathname==='/api/inventory/logs')json={ok:true,data:[root]};
   else if(url.pathname==='/api/inventory/snapshot/name-sync'){
    if(req.method()==='POST'){synced=true;json={ok:true,businessDate:'2026-10-09',syncedCount:economic?0:1,reviewRequiredCount:economic?1:0,failedCount:0,results:[{itemId:314,currentItemName:'배',currentItemNameVi:'Lê',status:economic?'review_required':'synced',targets:[{purchaseLogId:12848,correctionLogId:12849,status:economic?'review_required':'synced',code:economic?'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED':'METADATA_SYNCED'}]}]};}
    else json={ok:true,canSync:true,languageMissingItems:[],dailySyncItems:synced?[]:[{itemId:314,currentItemName:'배',currentItemNameVi:'Lê',logIds:[12848],issues:economic?['supplier_changed']:['ko_changed'],quantityReviewRequired:false,changes:economic?[{field:'supplier',from:'Chợ',to:'An Liên'}]:[{field:'item_name',from:'배',to:'신선한 배'}]}]};
   }
   else if(url.pathname==='/api/admin/ledger')json={ok:true,month:'2026-10',fundsView:{month:'2026-10',mode:'live',asOf:'2026-10-10',businessDateExclusive:null},summary:{income:0,salesIncome:0,otherIncome:0,receivedIncome:0,expense:35000,operatingProfit:-35000,paidExpense:0,displayedExpense:35000,actualCashOutflow:0,cardSettlementDifference:0,cardGrossSales:0,monthlySettledGross:0,actualCardDeposits:0,unsettledCardGross:0},accounts:[],categories:[],partners:[],entries:[],inventoryProjectionIssues:resolved?[]:[issue]};
   else if(url.pathname==='/api/admin/ledger/month-close')json={ok:true,month:'2026-10',state:'open'};
   else if(url.pathname==='/api/admin/ledger/payables')json={ok:true,month:'2026-10',parties:[],payables:[],totalOutstanding:35000,summary:{openingOutstanding:0,periodPurchases:35000,periodPayments:0,closingOutstanding:35000}};
   else if(url.pathname==='/api/admin/ledger/investments')json={ok:true,month:'2026-10',configured:false,periodNetChange:0};
   else if(url.pathname.endsWith('/12848/resolve')){
    if(req.method()==='POST'){await new Promise(resolve=>setTimeout(resolve,150));if(postCode){status=409;json={ok:false,status:'blocked',code:postCode};}else{resolved=true;json={ok:true,status:'synced',code:'REBOOKED'};}}
    else json={ok:true,status:'ok',candidates:[candidate()],recommended:false};
   }
   await route.fulfill({status,json});
  });
  page.on('dialog',d=>d.accept());
  await page.goto(process.env.QA_UI_BASE_URL+'/inventory/snapshots');
  const banner=page.getByTestId('snapshot-name-sync-banner');await banner.waitFor();await banner.getByRole('button').first().click();await page.getByTestId('snapshot-name-sync-item-314').getByRole('button').click();
  const details=page.getByTestId('inventory-daily-sync-results');await details.waitFor();assert.match(await details.innerText(),/#12848/);assert.match(await details.innerText(),lang==='ko'?/배/:/Lê/);assert.equal(await details.locator('a').count(),0);assert.equal(requests.some(r=>r.path.includes('/resolve')),false);
  synced=false;economic=true;await page.reload();await banner.waitFor();await banner.getByRole('button').first().click();await page.getByTestId('snapshot-name-sync-item-314').getByRole('button').click();await details.waitFor();assert.match(await details.innerText(),/SUPPLIER_CHANGE_CONFIRMATION_REQUIRED/);assert.match(await details.innerText(),/#12848/);assert.ok((await details.locator('a').getAttribute('href')).includes('month=2026-10'));
  await details.locator('a').click();await page.locator('#inventory-projection-12848').waitFor();await page.locator('#inventory-projection-12848').click();
  const dialog=page.getByRole('dialog');await dialog.locator('select').waitFor();await dialog.locator('select').selectOption('12848');
  const save=dialog.locator('footer button');const panel=dialog.locator(':scope > div');const box=await panel.boundingBox(),vp=page.viewportSize();assert.ok(box.width<=540 && box.y>=0 && box.y+box.height<=vp.height);assert.ok(Math.abs((box.y+box.height/2)-vp.height/2)<=20);assert.equal(await dialog.evaluate(el=>getComputedStyle(el).alignItems),'center');assert.equal(await panel.locator(':scope > div').evaluate(el=>getComputedStyle(el).overflowY),'auto');
  const text=await dialog.innerText();assert.ok(text.includes('Chợ')&&text.includes('An Liên'));assert.match(text,/35,000₫/);assert.match(text,/0₫/);assert.doesNotMatch(text,/금액 변경 확인 필요|Cần xác nhận thay đổi số tiền|수정 수량|Số lượng điều chỉnh|0kg/);
  assert.equal(await save.isDisabled(),true);await dialog.getByRole('checkbox').check();assert.equal(await save.isDisabled(),false);
  await mkdir('.qa-review/economic-sync-browser',{recursive:true});await page.screenshot({path:'.qa-review/economic-sync-browser/'+lang+'-'+(mobile?'mobile':'desktop')+'.png'});
  await save.click();await dialog.getByRole('alert').first().waitFor();assert.ok((await dialog.innerText()).includes(purchaseRepairError('SUPPLIER_CHANGE_CONFIRMATION_STALE',lang==='vi')));assert.equal(await save.isDisabled(),true);
  fingerprint='b'.repeat(64);await Promise.all([page.waitForResponse(response=>response.url().endsWith('/12848/resolve')&&response.request().method()==='GET'),dialog.getByRole('button',{name:lang==='ko'?'최신 정보 다시 조회':'Tải lại thông tin',exact:true}).click()]);await dialog.locator('select').selectOption('');await dialog.locator('select').selectOption('12848');assert.equal(await dialog.getByRole('checkbox').isChecked(),false);
  await dialog.locator('header button').click();
  for(const code of ['PAYABLE_ALREADY_PAID','MONTH_CLOSED','MANUAL_LEDGER_OVERRIDE','SUPPLIER_MISMATCH']){
   blockedCode=code;await page.locator('#inventory-projection-12848').click();await dialog.locator('select').selectOption('12848');assert.equal(await save.isDisabled(),true);assert.equal(await dialog.getByRole('checkbox').count(),0);assert.ok((await dialog.innerText()).includes(purchaseRepairError(code,lang==='vi')));await dialog.locator('header button').click();
  }
  blockedCode=null;postCode=null;await page.locator('#inventory-projection-12848').click();await dialog.locator('select').selectOption('12848');await dialog.getByRole('checkbox').check();const before=requests.filter(r=>r.method==='POST'&&r.path.endsWith('/resolve')).length;await save.evaluate(button=>{button.click();button.click();});await dialog.waitFor({state:'hidden'});const posts=requests.filter(r=>r.method==='POST'&&r.path.endsWith('/resolve'));assert.equal(posts.length,before+1);assert.deepEqual(posts.at(-1).body,{purchaseLogId:12848,supplierConfirmation:{confirmed:true,fingerprint:'b'.repeat(64)}});
  console.log('PASS metadata sync/details, centered zero-difference supplier confirmation, stale/paid/closed/manual protections',lang,mobile?'mobile':'desktop');await context.close();
 }}finally{await browser.close();}
});
