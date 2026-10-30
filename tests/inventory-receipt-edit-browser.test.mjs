import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {projectDailyEffectivePurchases} from '../lib/inventory/daily-effective-purchases.ts';
import {inventoryText} from '../lib/text/inventory.ts';
import {inventoryPurchaseErrorMessage} from '../lib/inventory/reasons.ts';
import {ledgerSyncNotice} from '../lib/inventory/ledger-sync-contract.ts';
import {offlineUiBase} from './helpers/offline-ui-base.mjs';
const BASE=offlineUiBase();
const require=createRequire(import.meta.url);
// Real UI against an offline build. Every /api request is intercepted; nothing reaches a database.
test('당일 로그 merge and 입고 수정 across KO/VI and 360/390/PC',{skip:!process.env.PLAYWRIGHT_MODULE_PATH||!BASE,timeout:240000},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
 const browser=await chromium.launch({headless:true,executablePath:process.env.QA_BROWSER_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 await mkdir('.qa-review/receipt-edit',{recursive:true});
 const DAY='2026-10-10';
 try{for(const lang of ['ko','vi'])for(const [label,viewport] of [['360',{width:360,height:780}],['390',{width:390,height:844}],['pc',{width:1280,height:900}]])for(const role of label==='390'?['owner','staff']:['owner']){
  const mobile=label!=='pc',context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile}),page=await context.newPage();page.setDefaultTimeout(8000);
  const t=inventoryText[lang],errors=[],reads=[],patches=[];let patchResult='ok',singleReceipt=false;
  const user={id:1,name:'QA',role,part:'kitchen',language:lang};
  const base={item_id:1,item_name:'배',item_name_vi:'Lê',part:'kitchen',category:'Fruit',category_vi:'Fruit',unit:'kg',code:'P',action:'update',source:'edit_form',reason:'purchase',business_date:DAY,actor_name:'QA'};
  const longSupplier='Hà Giang Mart cửa hàng trái cây nhập khẩu rất dài';
  const rootA={...base,id:100,change_quantity:10,prev_quantity:0,new_quantity:10,new_purchase_price:30000,new_supplier:'Chợ A',purchase_supplier_partner_id:7,correction_of_inventory_log_id:null,created_at:'2026-10-09T21:00:00Z'};
  // #110 has an earlier inventory-only edit waiting for the owner's Ledger review.
  const rootB={...base,id:110,change_quantity:5,prev_quantity:10,new_quantity:15,new_purchase_price:28000,new_supplier:longSupplier,purchase_supplier_partner_id:8,correction_of_inventory_log_id:null,created_at:'2026-10-10T02:00:00Z',ledger_projection_status:'review_required'};
  // Staff variant: the save itself returns an inventory-only result (Ledger review required).
  const savedLedger=role==='staff'?{status:'review_required',code:'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED'}:{status:'synced',code:'REBOOKED'};
  const corrections=[
   {...rootA,id:101,change_quantity:-1,correction_of_inventory_log_id:100,created_at:'2026-10-09T22:00:00Z'},
   {...rootA,id:102,change_quantity:-1,correction_of_inventory_log_id:100,created_at:'2026-10-09T23:00:00Z'},
   {...rootA,id:103,change_quantity:2,new_purchase_price:31000,correction_of_inventory_log_id:100,created_at:'2026-10-10T00:00:00Z',action:'receipt_edit',new_note:'영수증 확인'},
  ];
  const stockCheck={...base,id:140,reason:'stock_check',change_quantity:-1,created_at:'2026-10-10T03:00:00Z'};
  const item={id:1,item_name:'배',item_name_vi:'Lê',part:'kitchen',category:'Fruit',category_vi:'Fruit',quantity:14,unit:'kg',purchase_price:29000,supplier:'Master supplier',supplier_partner_id:9,code:'P',is_active:true,updated_at:'2026-10-10T03:00:00.000Z',image_path:null};
  const partners=[{id:7,name:'Chợ A',partnerType:'food',emoji:'',isActive:true},{id:8,name:longSupplier,partnerType:'food',emoji:'',isActive:true},{id:12,name:'Postpaid',partnerType:'food',emoji:'',isActive:true}];
  await page.addInitScript(u=>localStorage.setItem('baba_user',JSON.stringify(u)),user);
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.hostname==='localhost'||url.hostname==='127.0.0.1')return route.fallback();return route.abort();});
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());reads.push(url.pathname+url.search);let status=200,json={ok:true,data:[],items:[]};
   if(req.method()==='PATCH'){const body=req.postDataJSON();patches.push(body);
    if(patchResult==='ok'){corrections.push({...rootA,id:200+corrections.length,change_quantity:Number(body.payload.quantity)-10,new_purchase_price:body.payload.purchase_price,new_supplier:body.payload.supplier,purchase_supplier_partner_id:body.payload.supplierPartnerId,correction_of_inventory_log_id:100,created_at:'2026-10-10T04:00:00Z',action:'receipt_edit',new_note:body.payload.reason});item.updated_at=new Date().toISOString();json={ok:true,mode:body.mode,completion:role==='staff'?'ledger_review':'complete',ledgerSync:savedLedger};}
    else{status=409;json={ok:false,error:'purchase_correction_review_required',blockReason:'payment_completed'};}}
   else if(url.pathname==='/api/session')json={authenticated:true,user};
   else if(url.pathname==='/api/inventory/snapshot/list')json={ok:true,batches:[],currentBusinessDate:DAY,purchaseDateMap:{[DAY]:true}};
   else if(url.pathname==='/api/inventory/snapshot/name-sync')json={ok:true,canSync:true,dailySyncItems:[],languageMissingItems:[]};
   else if(url.pathname==='/api/inventory/logs')json={ok:true,data:projectDailyEffectivePurchases([rootA,rootB,stockCheck],corrections)};
   else if(url.pathname==='/api/inventory/items'&&url.searchParams.get('itemId')==='1')json={ok:true,data:[item],supplierPartners:partners,supplierAliases:[]};
   else if(url.pathname==='/api/inventory/items/1/logs')json={ok:true,data:singleReceipt?[rootA,...corrections]:[rootA,rootB,...corrections,stockCheck],businessDate:url.searchParams.get('businessDate')};
   else if(url.pathname==='/api/inventory/bootstrap-stream'){await route.fulfill({contentType:'application/x-ndjson',body:[{type:'items',items:[item],supplierPartners:partners,supplierAliases:[]},{type:'enrichment',statusMap:{},kegProgressMap:{},activeKegTrackingItemIds:[]},{type:'complete',timing:{}}].map(r=>JSON.stringify(r)).join('\n')+'\n'});return;}
   await route.fulfill({status,json});
  });
  const shot=name=>page.screenshot({path:`.qa-review/receipt-edit/${lang}-${label}-${role}-${name}.png`,fullPage:false});
  const noOverflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'page must not scroll horizontally');
  try{
   await page.goto(BASE+'/inventory/snapshots');
   const card=page.getByTestId('snapshot-purchase-card-100');await card.waitFor();await noOverflow();
   await card.click();
   const entryA=page.getByTestId('daily-log-purchase-100'),entryB=page.getByTestId('daily-log-purchase-110');await entryA.waitFor();await entryB.waitFor();
   assert.ok(reads.includes(`/api/inventory/items/1/logs?businessDate=${DAY}`),JSON.stringify(reads));
   await page.getByText(new RegExp('^(?:📅\\s*)?'+(lang==='vi'?'Nhật ký trong ngày':'당일 로그')+'\\s*'+DAY+'$')).waitFor();
   assert.equal(await page.getByRole('button',{name:t.editItem,exact:true}).count(),0,'item edit button removed from the modal');
   // Three corrections of #100 are one card in its final state; #110 stays separate.
   assert.match(await entryA.innerText(),lang==='vi'?/Đã sửa 3 lần/:/수정 3회/);
   assert.equal(await page.locator('[data-testid^="daily-log-purchase-"]').count(),2);
   // Simplified modal: the opened receipt is in the daily log, so no separate 선택한 로그 block,
   // no modal 동기화 button, no reclassification chips for receipts; the opened card is highlighted.
   assert.equal(await page.getByText(lang==='vi'?'Nhật ký đã chọn':'선택한 로그',{exact:true}).count(),0);
   assert.equal(await page.getByRole('button',{name:t.syncLog,exact:true}).count(),0);
   assert.equal(await page.locator('[data-testid^="log-reason-buttons-"]').count(),0);
   assert.equal(await entryA.locator('xpath=..').getAttribute('data-selected'),'true');
   assert.equal(await entryB.locator('xpath=..').getAttribute('data-selected'),null);
   // Mobile: supplier/price-change tags wrap inside the modal instead of being clipped.
   const tabs=page.getByTestId('daily-log-group-tabs');await tabs.waitFor();
   assert.ok(await tabs.evaluate(el=>[...el.children].every(child=>child.getBoundingClientRect().right<=el.getBoundingClientRect().right+1)),'tags fit the row');
   // Inventory-only state is visible and the receipt cannot be edited again until reviewed.
   await page.getByTestId('daily-log-ledger-pending-110').waitFor();await page.getByTestId('receipt-edit-notice-110').waitFor();
   assert.equal(await entryB.getByRole('button',{name:lang==='vi'?'Sửa nhập hàng':'입고 수정'}).count(),0);
   assert.equal(await page.getByTestId('daily-log-ledger-pending-100').count(),0);
   await shot('daily-log');
   await entryA.getByRole('button',{name:lang==='vi'?'Xem lịch sử sửa':'수정 이력 보기'}).click();
   assert.equal(await page.getByTestId('daily-log-history-100').locator(':scope > div').count(),4,'root plus three corrections in history');
   await shot('history');
   await entryA.getByRole('button',{name:lang==='vi'?'Sửa nhập hàng':'입고 수정'}).click();
   const form=page.getByTestId('receipt-edit-form-100');await form.waitFor();
   const input=field=>page.getByTestId('receipt-edit-'+field+'-100');
   assert.equal(await input('quantity').inputValue(),'10');assert.equal(await input('price').inputValue(),'31,000');
   const select=form.locator('select');assert.equal(await select.count(),role==='owner'?1:0);
   // Reason is required: no request is sent without it.
   await form.getByRole('button',{name:lang==='vi'?'Lưu sửa đổi':'수정 저장'}).click();
   await form.getByRole('alert').waitFor();assert.equal(patches.length,0);
   await input('quantity').fill('12');await input('price').fill('32000');await input('reason').fill('QA 정정');await input('note').fill('메모');
   if(role==='owner'){await page.waitForFunction(()=>document.querySelectorAll('[data-testid="receipt-edit-form-100"] select option').length>3);await select.selectOption('12');}
   await noOverflow();await shot('form');
   await form.getByRole('button',{name:lang==='vi'?'Lưu sửa đổi':'수정 저장'}).click();
   await form.waitFor({state:'detached'});
   assert.equal(patches.length,1);const body=patches[0];
   assert.equal(body.mode,'purchase-receipt-edit');assert.equal(body.id,1);assert.equal(body.purchaseLogId,100);assert.equal(body.expectedQuantity,14);assert.ok(body.expectedUpdatedAt);
   assert.deepEqual(body.payload,{quantity:12,purchase_price:32000,supplier:role==='owner'?'Postpaid':'Chợ A',supplierPartnerId:role==='owner'?12:7,note:'메모',reason:'QA 정정'});
   assert.equal(Object.hasOwn(body,'selectedPurchaseRootId'),false);
   await page.getByTestId('daily-log-purchase-100').waitFor();
   await page.waitForFunction(()=>/수정 4회|Đã sửa 4 lần/.test(document.querySelector('[data-testid="daily-log-purchase-100"]')?.textContent??''));
   // An inventory-only save is not reported as a completed edit.
   if(role==='staff')assert.equal(await page.getByTestId('receipt-edit-notice-100').innerText(),ledgerSyncNotice(savedLedger,lang==='vi'));
   else assert.equal(await page.getByTestId('receipt-edit-notice-100').count(),0);
   await shot('saved');
   // A paid receipt is refused by the server; the reason is shown and the input kept.
   patchResult='paid';
   await page.getByTestId('daily-log-purchase-100').getByRole('button',{name:lang==='vi'?'Sửa nhập hàng':'입고 수정'}).click();
   const again=page.getByTestId('receipt-edit-form-100');await again.waitFor();
   await input('price').fill('33000');await input('reason').fill('재정정');
   await again.getByRole('button',{name:lang==='vi'?'Lưu sửa đổi':'수정 저장'}).click();
   await page.waitForFunction(m=>document.querySelector('[data-testid="receipt-edit-form-100"] [role=alert]')?.textContent===m,inventoryPurchaseErrorMessage('purchase_correction_review_required',lang,{blockReason:'payment_completed'}));
   assert.equal(await input('price').inputValue(),'33,000');
   await noOverflow();await shot('blocked');
   // One receipt that day: a single plain card, no highlight or tags, and the modal fits its content.
   await page.getByRole('button',{name:lang==='vi'?'Đóng':'닫기',exact:true}).last().click();
   singleReceipt=true;await page.getByTestId('snapshot-purchase-card-100').click();
   const single=page.getByTestId('daily-log-purchase-100');await single.waitFor();
   assert.equal(await page.locator('[data-testid^="daily-log-purchase-"]').count(),1);
   assert.equal(await single.locator('xpath=..').getAttribute('data-selected'),null);
   assert.equal(await page.getByTestId('daily-log-group-tabs').count(),0);
   assert.equal(await page.getByTestId('receipt-edit-notice-100').count(),0,'old notice cleared when the modal reopens');
   assert.ok(await single.evaluate(el=>{let node=el;while(node&&getComputedStyle(node).overflowY!=='auto')node=node.parentElement;return !!node&&node.scrollHeight<=node.clientHeight+1;}),'single receipt modal needs no scroll');
   await noOverflow();await shot('single');
   assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }}finally{await browser.close();}
});
