import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {buildLedgerEntries} from '../lib/ledger/entries.ts';
const require=createRequire(import.meta.url);

// Production-shaped facts: receipts 13561 (#620, 270000₫) and 13563 (#621, 65000₫), partner #33
// with an unspecified payment mode, category 기타 -> 가공식품, pending candidates 1900/1901 (#31).
const snapshot=(id,item,amount)=>({inventory_log_id:id,item_id:item,item_name:'품목'+item,item_name_vi:'Mặt hàng '+item,category:'가공식품',category_vi:'Thực phẩm chế biến',unit:'ea',change_quantity:1,purchase_price:amount,purchase_amount:amount,supplier:'Unspecified Mart'});
const candidates=[[1900,13561,620,270000],[1901,13563,621,65000]].map(([id,log,item,amount])=>({id,business_date:'2026-10-19',proposed_amount:amount,proposed_category_id:31,proposed_party_id:33,source_key:'inventory-log:'+log,source_snapshot:snapshot(log,item,amount),category:{name:'가공식품'},party:{name:'Unspecified Mart'}}));
const entries=buildLedgerEntries([],candidates,new Map([[33,{paymentMode:'unspecified',defaultFundAccountId:null,defaultFundAccountName:null}]]),[],'2026-10');

test('monthly 일괄 동기화 summary keeps one banner with exact Ledger shortcuts that open 13561/13563 across KO/VI desktop/mobile',{skip:!process.env.PLAYWRIGHT_MODULE_PATH || !process.env.QA_UI_BASE_URL},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{for(const lang of ['ko','vi'])for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});const page=await context.newPage();page.setDefaultTimeout(15000);
  const user={id:2,name:'QA',role:'owner',part:'kitchen',language:lang};await page.addInitScript(user=>localStorage.setItem('baba_user',JSON.stringify(user)),user);
  let synced=false;const posts=[];
  const root=(id,item,price)=>({id,item_id:item,item_name:'품목'+item,item_name_vi:'Mặt hàng '+item,part:'kitchen',category:'기타',category_vi:'Khác',code:'QA',unit:'ea',change_quantity:1,prev_quantity:0,new_quantity:1,new_supplier:'Unspecified Mart',new_purchase_price:price,created_at:'2026-10-19T04:00:00Z',reason:'purchase',business_date:'2026-10-19'});
  const target=(log,candidate)=>({purchaseLogId:log,correctionLogId:log+1,status:'review_required',code:'RESOLUTION_REQUIRED',ledgerMonth:'2026-10',sourceKey:'inventory-log:'+log,candidateId:candidate,transactionId:null});
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());let json={ok:true,data:[]};
   if(url.pathname==='/api/session')json={authenticated:true,user};
   else if(url.pathname==='/api/inventory/snapshot/list')json={ok:true,batches:[{id:9,snapshot_date:'2026-10-19'}],currentBusinessDate:'2026-10-19',purchaseDateMap:{'2026-10-19':true}};
   else if(url.pathname==='/api/inventory/logs')json={ok:true,data:[root(13561,620,270000),root(13563,621,65000)]};
   else if(url.pathname==='/api/inventory/snapshot/name-sync'){
    if(req.method()==='POST'){synced=true;posts.push(req.postDataJSON());json={ok:true,month:'2026-10',syncedCount:0,reviewRequiredCount:2,failedCount:0,skippedCount:0,skipped:[],results:[
     {businessDate:'2026-10-19',itemId:620,currentItemName:'품목620',currentItemNameVi:'Mặt hàng 620',status:'review_required',code:'RESOLUTION_REQUIRED',targets:[target(13561,1900)]},
     {businessDate:'2026-10-19',itemId:621,currentItemName:'품목621',currentItemNameVi:'Mặt hàng 621',status:'review_required',code:'RESOLUTION_REQUIRED',targets:[target(13563,1901)]}]};}
    else{
     // The monthly panel reads ?month=; the per-date read only feeds the language list now.
     const pending=synced?[]:[620,621].map(item=>({itemId:item,currentItemName:'품목'+item,currentItemNameVi:'Mặt hàng '+item,logIds:[item===620?13561:13563],issues:['category_changed','category_vi_changed'],quantityReviewRequired:false,changes:[{field:'category',from:'기타',to:'가공식품'},{field:'category_vi',from:'Khác',to:'Thực phẩm chế biến'}]}));
     json=url.searchParams.has('month')?{ok:true,month:url.searchParams.get('month'),canSync:true,languageMissingItems:[],monthlySyncItems:pending.map(item=>({...item,businessDate:'2026-10-19',targets:[]}))}
      :{ok:true,canSync:true,languageMissingItems:[],dailySyncItems:pending};
    }
   }
   else if(url.pathname==='/api/admin/ledger')json={ok:true,month:'2026-10',fundsView:{month:'2026-10',mode:'live',asOf:'2026-10-20',businessDateExclusive:null},summary:{income:0,salesIncome:0,otherIncome:0,receivedIncome:0,expense:0,operatingProfit:0,paidExpense:0,displayedExpense:0,actualCashOutflow:0,cardSettlementDifference:0,cardGrossSales:0,monthlySettledGross:0,actualCardDeposits:0,unsettledCardGross:0},accounts:[],categories:[{id:31,name:'가공식품',kind:'expense',parent_id:null},{id:66,name:'기타 재고매입',kind:'expense',parent_id:null}],partners:[],entries,inventoryProjectionIssues:[]};
   else if(url.pathname==='/api/admin/ledger/month-close')json={ok:true,month:'2026-10',state:'open'};
   else if(url.pathname==='/api/admin/ledger/payables')json={ok:true,month:'2026-10',parties:[],payables:[],totalOutstanding:0,summary:{openingOutstanding:0,periodPurchases:0,periodPayments:0,closingOutstanding:0}};
   else if(url.pathname==='/api/admin/ledger/investments')json={ok:true,month:'2026-10',configured:false,periodNetChange:0};
   await route.fulfill({status:200,json});
  });
  page.on('dialog',d=>d.accept());
  await page.goto(process.env.QA_UI_BASE_URL+'/inventory/snapshots');
  // The 당일 banner's 전체 동기화 is now the monthly panel's 일괄 동기화 (confirmed by the dialog handler).
  assert.equal(await page.getByTestId('snapshot-name-sync-banner').count(),0);
  const syncAll=page.getByTestId('monthly-name-sync-all');await syncAll.click();
  const summary=page.getByRole('status').filter({hasText:lang==='ko'?'2개 관리자 확인 필요':'2 cần quản trị viên kiểm tra'});await summary.waitFor();
  assert.deepEqual(posts,[{action:'sync_month',month:'2026-10',targets:[{businessDate:'2026-10-19',itemId:620},{businessDate:'2026-10-19',itemId:621}]}]);
  // Single summary inside the monthly panel: no separate duplicate warning card.
  assert.equal(await summary.count(),1);assert.equal(await summary.evaluate(el=>el.closest('[data-testid="monthly-name-sync"]')!==null),true);assert.equal(await page.getByTestId('inventory-daily-sync-results').count(),0);
  assert.equal(await page.getByText('RESOLUTION_REQUIRED').count(),0);
  const links=summary.getByTestId('inventory-daily-sync-actions').getByRole('link');assert.equal(await links.count(),2);
  assert.deepEqual(await links.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href'))),[
   '/admin/ledger/entries?month=2026-10&inventoryLogId=13561&sourceKey=inventory-log%3A13561',
   '/admin/ledger/entries?month=2026-10&inventoryLogId=13563&sourceKey=inventory-log%3A13563']);
  assert.match(await links.first().innerText(),lang==='ko'?/품목620[\s\S]*장부에서 확인/:/Mặt hàng 620[\s\S]*Xem trong sổ/);
  for(const box of await links.evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height};}))){assert.ok(box.left>=0&&box.right<=page.viewportSize().width,'link inside viewport');assert.ok(box.height>=32,'tap target');}
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'no horizontal page scroll');
  const shots='.qa-review/display-category-sync-browser/';await mkdir(shots,{recursive:true});
  await page.screenshot({path:shots+lang+'-'+(mobile?'mobile':'desktop')+'-summary.png'});
  // Real navigation opens the exact receipt in the shared partner group.
  for(const [index,log,candidate,amount] of [[1,13563,1901,'65.000'],[0,13561,1900,'270.000']]){
   await page.goto(process.env.QA_UI_BASE_URL+'/inventory/snapshots');synced=false;
   await syncAll.click();await summary.waitFor();
   await Promise.all([page.waitForURL(url=>url.pathname==='/admin/ledger/entries'&&url.searchParams.get('inventoryLogId')===String(log)),links.nth(index).click()]);
   const focused=page.locator('article[data-focused="true"]');await focused.waitFor();
   assert.equal(await focused.count(),1);assert.equal(await focused.getAttribute('aria-current'),'true');
   const text=await focused.innerText();assert.match(text,new RegExp(lang==='ko'?'품목'+(log===13561?620:621):'Mặt hàng '+(log===13561?620:621)));assert.ok(text.includes(amount),text);
   assert.equal(await page.locator('article').filter({hasText:lang==='ko'?'품목62':'Mặt hàng 62'}).count(),2,'both receipts of the group listed, one focused');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'no horizontal page scroll in ledger');
   await page.screenshot({path:shots+lang+'-'+(mobile?'mobile':'desktop')+'-ledger-'+candidate+'.png'});
  }
  console.log('PASS single summary + exact ledger shortcuts',lang,mobile?'mobile':'desktop');await context.close();
 }}finally{await browser.close();}
});
