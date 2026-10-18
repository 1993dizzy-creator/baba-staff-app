import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url);
test('compact purchase reviews: recorded three cases, details, compound/unknown/zero changes and resolve refresh in KO/VI desktop/mobile',{skip:!process.env.PLAYWRIGHT_MODULE_PATH||!process.env.QA_UI_BASE_URL},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{for(const lang of ['ko','vi'])for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});
  const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));let resolved=false,extra=false;
  const user={id:2,name:'QA',role:'owner',language:lang};await page.addInitScript(user=>localStorage.setItem('baba_user',JSON.stringify(user)),user);
  const candidate=(id,oldAmount,newAmount,supplier,newSupplier)=>({inventoryLogId:id,businessDate:'2026-10-12',quantity:2.2,effectiveQuantity:2.2,quantityDelta:0,unit:'Kg',price:38000,supplier,newSupplier,oldAmount,newAmount,delta:newAmount-oldAmount,safe:supplier===newSupplier,code:supplier===newSupplier?'READY':'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED'});
  const melon=candidate(13085,70400,83600,'Chợ','Chợ'),tonic={...candidate(13297,480000,480000,'Dabaco','Ok Mart'),quantity:48,effectiveQuantity:48,unit:'Lon'},tomato={...candidate(13477,50000,50000,'Trung Đông','Chợ'),quantity:1,effectiveQuantity:1};
  const make=(c,name,nameVi,date)=>({inventoryLogId:c.inventoryLogId,rootInventoryLogId:c.inventoryLogId,code:'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED',itemName:name,itemNameVi:nameVi,businessDate:date,supplier:c.newSupplier,originalQuantity:c.effectiveQuantity,effectiveQuantity:c.effectiveQuantity,quantityDelta:0,amountDelta:0,unit:c.unit,ledgerAmount:c.oldAmount,resolution:{candidates:[c],recommended:false},timeline:[{id:'inventory:'+c.inventoryLogId,kind:'purchase',logId:c.inventoryLogId,occurredAt:'2026-10-12T10:10:27Z',actor:'QA actor',quantityDelta:c.quantity}],receiptEvidence:{booked:{quantity:c.quantity,price:32000,amount:c.oldAmount,supplier:c.supplier},current:{quantity:c.quantity,price:c.price,supplier:c.newSupplier},candidateStatus:'confirmed',transactionStatus:'confirmed'}});
  const issues=()=>[
   ...(!resolved?[make(melon,'노란 멜론','Dưa vàng','2026-10-12')]:[]),make(tonic,'슈웹스 토닉워터(노란색) 320ml','Soda Schweppe tonic vàng 320ml','2026-10-15'),make(tomato,'방울토마토','Cà chua bi','2026-10-17'),
   ...(extra?[make({...melon,inventoryLogId:9001,quantityDelta:-0.2,newSupplier:'Ok Mart'},'복합','Kết hợp','2026-10-12'),{...make({...melon,inventoryLogId:9002,delta:0,newAmount:70400},'변경 없음','Không đổi','2026-10-12')},{...make({...melon,inventoryLogId:9003},'자료 부족','Thiếu dữ liệu','2026-10-12'),resolution:{candidates:[],recommended:false}}]:[])
  ];
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());let json={ok:true,data:[]};
   if(req.method()!=='GET'){posts.push({path:url.pathname,body:req.postDataJSON()});assert.equal(url.pathname,'/api/admin/ledger/inventory-projection/13085/resolve');resolved=true;json={ok:true,status:'synced',code:'REBOOKED'};}
   else if(url.pathname==='/api/session')json={authenticated:true,user};
   else if(url.pathname==='/api/admin/ledger')json={ok:true,month:'2026-10',fundsView:{month:'2026-10',mode:'live',asOf:'2026-10-18',businessDateExclusive:null},summary:{income:0,salesIncome:0,otherIncome:0,receivedIncome:0,expense:600400,operatingProfit:-600400,paidExpense:0,displayedExpense:600400,actualCashOutflow:0,cardSettlementDifference:0,cardGrossSales:0,monthlySettledGross:0,actualCardDeposits:0,unsettledCardGross:0},accounts:[],categories:[],partners:[],entries:[],inventoryProjectionIssues:issues()};
   else if(url.pathname.endsWith('/13085/resolve'))json={ok:true,candidates:[melon],recommended:false};
   else if(url.pathname==='/api/admin/ledger/month-close')json={ok:true,month:'2026-10',state:'open'};
   else if(url.pathname==='/api/admin/ledger/payables')json={ok:true,month:'2026-10',parties:[],payables:[],totalOutstanding:600400,summary:{openingOutstanding:0,periodPurchases:600400,periodPayments:0,closingOutstanding:600400}};
   else if(url.pathname==='/api/admin/ledger/investments')json={ok:true,month:'2026-10',configured:false,periodNetChange:0};
   await route.fulfill({json});
  });
  await page.goto(process.env.QA_UI_BASE_URL+'/admin/ledger/entries?month=2026-10');
  const banner=page.locator('section').filter({has:page.getByText(lang==='ko'?'⚠ 장부 확인 필요 3건':'⚠ Cần kiểm tra sổ 3 mục',{exact:true})});await banner.waitFor();
  assert.ok((await banner.innerText()).includes(lang==='ko'?'금액 변경 1건 · 거래처 변경 2건':'Đổi số tiền 1 mục · Đổi nhà cung cấp 2 mục'));
  const melonRow=page.getByTestId('inventory-purchase-case-13085');
  const compact=await melonRow.innerText();assert.ok(compact.includes('70,400₫ → 83,600₫ (+13,200₫)'));assert.ok(!compact.includes('2.2 → 2.2'));assert.ok(!compact.includes('#13085'));assert.ok(!compact.includes(lang==='ko'?'최종 상태':'Trạng thái cuối'));
  for(const [id,change] of [[13297,'Dabaco → Ok Mart'],[13477,'Trung Đông → Chợ']]){const row=page.getByTestId('inventory-purchase-case-'+id);assert.ok((await row.innerText()).includes(change));assert.ok(!(await row.getByTestId('purchase-case-changes').innerText()).includes('₫'));}
  const badge=melonRow.locator('> div').nth(2).locator('span');assert.equal(await badge.count(),1);
  assert.equal(await badge.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 244, 220)');
  const delta=melonRow.getByTestId('purchase-case-changes').locator('strong');assert.equal((await delta.innerText()).trim(),'(+13,200₫)');
  assert.equal(await delta.evaluate(el=>getComputedStyle(el).color),'rgb(180, 73, 62)');assert.equal(await delta.evaluate(el=>getComputedStyle(el).fontWeight),'800');
  assert.equal(await melonRow.locator('> div').nth(1).evaluate(el=>getComputedStyle(el).color),'rgb(107, 114, 128)');
  for(const [id,supplier] of [[13297,'Ok Mart'],[13477,'Chợ']]){const emphasized=page.getByTestId('inventory-purchase-case-'+id).getByTestId('purchase-case-changes').locator('strong');assert.equal(await emphasized.innerText(),supplier);assert.equal(await emphasized.evaluate(el=>getComputedStyle(el).fontWeight),'800');}
  await mkdir('.qa-review/purchase-review-styled',{recursive:true});await page.screenshot({path:'.qa-review/purchase-review-styled/'+lang+'-'+(mobile?'mobile':'desktop')+'.png',fullPage:true});await banner.screenshot({path:'.qa-review/purchase-review-styled/'+lang+'-'+(mobile?'mobile':'desktop')+'-banner.png'});
  await melonRow.locator(':scope > details > summary').click();assert.equal(await melonRow.getByTestId('purchase-case-timeline').getAttribute('open'),null);assert.ok(!(await melonRow.innerText()).includes('#13085'));await melonRow.locator(':scope > details > summary').click();
  await page.locator('#inventory-projection-13085').click();const dialog=page.getByRole('dialog');await dialog.waitFor();await dialog.locator('select').selectOption('13085');await dialog.getByText('83,600₫',{exact:true}).waitFor();assert.ok((await dialog.innerText()).includes('70,400₫'));assert.ok((await dialog.innerText()).includes('13,200₫'));
  await dialog.locator('footer button').click();await dialog.waitFor({state:'hidden'});await melonRow.waitFor({state:'detached'});assert.equal(posts.length,1);assert.deepEqual(posts[0].body,{purchaseLogId:13085});
  extra=true;await page.reload();const compound=page.getByTestId('inventory-purchase-case-9001');await compound.waitFor();assert.equal(await compound.getByTestId('purchase-case-changes').locator(':scope > div').count(),2);assert.ok((await compound.innerText()).includes('2.2 → 2Kg (-0.2)'));
  for(const id of [9002,9003]){const row=page.getByTestId('inventory-purchase-case-'+id);assert.equal(await row.count(),1);assert.ok(!(await row.getByTestId('purchase-case-changes').innerText()).includes('₫'));}
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  for(const row of await page.locator('[data-testid^="inventory-purchase-case-"]').all())assert.equal(await row.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  assert.deepEqual(errors,[]);await context.close();console.log('PASS compact reviews, details, resolve refresh, compound/unknown/zero, no overflow',lang,mobile?'mobile':'desktop');
 }}finally{await browser.close();}
});
