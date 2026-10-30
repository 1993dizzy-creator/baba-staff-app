import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {projectDailyEffectivePurchases} from '../lib/inventory/daily-effective-purchases.ts';
import {inventoryText} from '../lib/text/inventory.ts';
import {commonText} from '../lib/text/common.ts';
import {INVENTORY_REASON_LABELS} from '../lib/inventory/reasons.ts';
import {offlineUiBase} from './helpers/offline-ui-base.mjs';
const BASE=offlineUiBase();
const require=createRequire(import.meta.url);
const DAY='2026-10-27';
// 실청구금액 on every receipt screen against an offline build. Every /api request is
// intercepted; nothing reaches a database. Orange: 3.57kg x 85,000 = 303,450, billed 303,000.
test('실청구금액: registration, quick save, edit-form purchase and 입고 수정 across KO/VI and 360/390/PC',{skip:!process.env.PLAYWRIGHT_MODULE_PATH||!BASE,timeout:300000},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
 const browser=await chromium.launch({headless:true,executablePath:process.env.QA_BROWSER_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 await mkdir('.qa-review/billed-amount',{recursive:true});
 const results=[];
 try{for(const lang of ['ko','vi'])for(const [label,viewport] of [['360',{width:360,height:780}],['390',{width:390,height:844}],['pc',{width:1280,height:900}]]){
  const mobile=label!=='pc',context=await browser.newContext({viewport,isMobile:mobile,hasTouch:mobile}),page=await context.newPage();page.setDefaultTimeout(8000);
  const t=inventoryText[lang],c=commonText[lang],purchase=INVENTORY_REASON_LABELS[lang].purchase,errors=[],writes=[],dialogs=[];
  const user={id:1,name:'QA',role:'owner',part:'kitchen',language:lang};
  const item={id:1,item_name:'오렌지',item_name_vi:'Cam',part:'kitchen',category:'Fruit',category_vi:'Fruit',quantity:2,unit:'kg',purchase_price:85000,supplier:'Chợ',supplier_partner_id:7,code:'OR',is_active:true,updated_at:'2026-10-27T03:00:00.000Z',low_stock_threshold:1,low_stock_enabled:false,package_content_quantity:null,package_content_unit:null,image_path:null};
  const root={id:100,item_id:1,item_name:'오렌지',item_name_vi:'Cam',part:'kitchen',category:'Fruit',category_vi:'Fruit',unit:'kg',code:'OR',action:'update',source:'quick_save',reason:'purchase',business_date:DAY,actor_name:'QA',change_quantity:3.57,prev_quantity:0,new_quantity:3.57,new_purchase_price:85000,new_supplier:'Chợ',purchase_supplier_partner_id:7,correction_of_inventory_log_id:null,created_at:'2026-10-27T02:00:00Z',billed_amount:null,billed_amount_mode:null};
  const corrections=[];const partners=[{id:7,name:'Chợ',partnerType:'food',emoji:'',isActive:true}];
  await page.addInitScript(u=>localStorage.setItem('baba_user',JSON.stringify(u)),user);
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{dialogs.push(d.message());if(d.type()==='confirm')d.accept();else d.dismiss();});
  await page.route('**/*',route=>{const u=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(u.hostname)?route.fallback():route.abort();});
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());let json={ok:true,data:[],items:[]};
   if(req.method()==='PATCH'||req.method()==='POST'){const body=req.postDataJSON();writes.push({method:req.method(),body});
    if(body.mode==='purchase-receipt-edit'){const billed=body.purchaseBilledAmount;
     corrections.push({...root,id:200+corrections.length,action:'receipt_edit',source:'edit_form',change_quantity:Number(body.payload.quantity)-3.57-corrections.reduce((s,r)=>s+r.change_quantity,0),
      new_purchase_price:body.payload.purchase_price,correction_of_inventory_log_id:100,created_at:'2026-10-27T04:00:00Z',new_note:body.payload.reason,
      billed_amount:billed?.mode==='manual'?billed.amount:null,billed_amount_mode:billed?.mode??null});
     item.updated_at=new Date().toISOString();json={ok:true,mode:body.mode,completion:'complete',ledgerSync:{status:'synced',code:'REBOOKED'}};}
    else json={ok:true,mode:body.mode,data:{...item,id:2},ledgerSync:{status:'synced',code:'PROJECTED'}};}
   else if(url.pathname==='/api/session')json={authenticated:true,user};
   else if(url.pathname==='/api/inventory/snapshot/list')json={ok:true,batches:[],currentBusinessDate:DAY,purchaseDateMap:{[DAY]:true}};
   else if(url.pathname==='/api/inventory/snapshot/name-sync')json={ok:true,canSync:true,dailySyncItems:[],languageMissingItems:[]};
   else if(url.pathname==='/api/inventory/logs')json={ok:true,data:projectDailyEffectivePurchases([root],corrections)};
   else if(url.pathname==='/api/inventory/items')json={ok:true,data:[item],supplierPartners:partners,supplierAliases:[]};
   else if(url.pathname==='/api/inventory/items/1/logs')json={ok:true,data:[root,...corrections],businessDate:url.searchParams.get('businessDate')};
   else if(url.pathname==='/api/inventory/bootstrap-stream'){await route.fulfill({contentType:'application/x-ndjson',body:[{type:'items',items:[item],supplierPartners:partners,supplierAliases:[]},{type:'enrichment',statusMap:{},kegProgressMap:{},activeKegTrackingItemIds:[]},{type:'complete',timing:{}}].map(r=>JSON.stringify(r)).join('\n')+'\n'});return;}
   await route.fulfill({json});
  });
  const shot=name=>page.screenshot({path:`.qa-review/billed-amount/${lang}-${label}-${name}.png`});
  const noOverflow=async where=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),`${where}: page must not scroll horizontally`);
  // Field fits its container: input, chips and restore button inside the field box.
  const fits=async field=>assert.ok(await field.evaluate(el=>{const box=el.getBoundingClientRect();return [...el.querySelectorAll('input,button,span')].every(n=>n.getBoundingClientRect().right<=box.right+1&&n.getBoundingClientRect().left>=box.left-1);}),'billed field content stays inside its box');
  const field=id=>({root:page.getByTestId(id),input:page.getByTestId(id+'-input'),mode:()=>page.getByTestId(id).getAttribute('data-mode'),diff:()=>page.getByTestId(id+'-difference').innerText(),calc:()=>page.getByTestId(id+'-calculated').innerText(),restore:page.getByTestId(id+'-restore')});
  const diffText=n=>(lang==='vi'?'Chênh lệch ':'차액 ')+(n>0?'+':n<0?'−':'')+Math.abs(n).toLocaleString('en-US')+' ₫';
  try{
   // 1) New receipt registration: auto follows quantity/price, manual is kept, restore returns to auto.
   await page.goto(BASE+'/inventory');
   await page.getByRole('button',{name:t.openInventoryForm,exact:true}).click();
   await page.getByRole('button').filter({hasText:t.newPurchaseRegistration}).click();
   const reg=field('registration-billed-amount');await reg.root.waitFor();
   assert.equal(await reg.mode(),'auto');assert.equal(await reg.input.inputValue(),'');
   await page.getByPlaceholder(c.itemName,{exact:true}).first().fill('오렌지 QA');
   await page.getByPlaceholder(t.purchasePrice,{exact:true}).first().fill('85000');
   await page.getByPlaceholder(t.unitPlaceholder,{exact:true}).fill('kg');
   const qty=page.getByPlaceholder(c.quantity,{exact:true}).last();await qty.fill('3.57');
   assert.equal(await reg.input.inputValue(),'303,450');assert.equal(await reg.diff(),diffText(0));
   assert.ok(await page.evaluate(()=>{const field=document.querySelector('[data-testid="registration-billed-amount"]');const qty=[...document.querySelectorAll('input[type=number][step="0.1"]')].pop();
    return !!qty&&!!field&&qty.compareDocumentPosition(field)===Node.DOCUMENT_POSITION_FOLLOWING&&field.getBoundingClientRect().top-qty.getBoundingClientRect().bottom<60;}),'billed field directly under quantity');
   await qty.fill('4');assert.equal(await reg.input.inputValue(),'340,000','auto recalculates');
   await reg.input.fill('303000');assert.equal(await reg.mode(),'manual');assert.equal(await reg.input.inputValue(),'303,000');
   await qty.fill('3.57');assert.equal(await reg.input.inputValue(),'303,000','manual amount kept');assert.equal(await reg.diff(),diffText(-450));
   await noOverflow('registration');await fits(reg.root);await reg.root.scrollIntoViewIfNeeded();await shot('registration-manual');
   await reg.restore.click();assert.equal(await reg.mode(),'auto');assert.equal(await reg.input.inputValue(),'303,450');
   await reg.input.fill('303000');
   await qty.fill('0.004');const refusedWrites=writes.length;await page.getByRole('button',{name:c.save,exact:true}).last().click();await page.waitForTimeout(200);
   assert.equal(writes.length,refusedWrites,'0.004 rounds to 0: no request');assert.equal(dialogs.at(-1),lang==='vi'?'Số lượng nhập phải từ 0.01 trở lên.':'입고 수량은 0.01 이상이어야 합니다.');
   await qty.fill('3.57');
   await page.getByRole('button',{name:c.save,exact:true}).last().click();
   await page.waitForFunction(()=>true);await page.waitForTimeout(300);
   const post=writes.find(w=>w.method==='POST');assert.ok(post,'registration POST sent: '+JSON.stringify(dialogs));
   assert.deepEqual(post.body.purchaseBilledAmount,{mode:'manual',amount:303000});assert.equal(post.body.registrationType,'new_purchase');
   assert.equal(post.body.payload.quantity,3.57);assert.equal(post.body.payload.purchase_price,85000);
   // 2) Quick save: increase 2 -> 5.57 kg. The amount is the increase (3.57) x price, not the final stock.
   await page.goto(BASE+'/inventory?itemId=1');
   await page.locator('input[type=number]').first().fill('5.57');
   await page.getByRole('button',{name:t.quickSave,exact:true}).click();
   await page.getByRole('button').filter({hasText:purchase}).last().click();
   const quick=field('quick-billed-amount');await quick.root.waitFor();
   assert.equal(await quick.input.inputValue(),'303,450','3.57 x 85,000 (not 5.57 x 85,000 = 473,450)');
   await quick.input.fill('303000');assert.equal(await quick.diff(),diffText(-450));
   await noOverflow('quick save');await fits(quick.root);await shot('quick-manual');
   const quickSaveButton=page.getByRole('button',{name:purchase+' '+c.save,exact:true});
   assert.ok(await quickSaveButton.isVisible(),'save button reachable');
   await quickSaveButton.click();await page.waitForTimeout(300);
   const quickBody=writes.filter(w=>w.body.mode==='quick-save').at(-1)?.body;assert.ok(quickBody,'quick save sent');
   assert.deepEqual(quickBody.purchaseBilledAmount,{mode:'manual',amount:303000});assert.equal(quickBody.payload.quantity,5.57);assert.equal(quickBody.expectedQuantity,2);
   // 3) Edit form purchase increase: the reason sheet shows the billed amount of the increase.
   await page.goto(BASE+'/inventory?itemId=1&mode=edit');
   const form=page.getByTestId('inventory-edit-form');await form.waitFor();
   await form.locator('input[type=number][step="0.1"]').fill('5.57');
   await form.getByRole('button',{name:c.save,exact:true}).click();
   const edit=field('edit-billed-amount');await edit.root.waitFor();
   assert.equal(await edit.input.inputValue(),'303,450');await edit.input.fill('303000');
   await noOverflow('edit reason sheet');await fits(edit.root);await shot('edit-form-manual');
   await page.getByRole('button',{name:new RegExp(purchase)}).last().click();await page.waitForTimeout(300);
   const editBody=writes.filter(w=>w.body.source==='edit_form').at(-1)?.body;assert.ok(editBody,'edit form save sent');
   assert.deepEqual(editBody.purchaseBilledAmount,{mode:'manual',amount:303000});assert.equal(editBody.autoSelectPurchaseRoot,true);
   // 4) 입고 수정 of today's receipt; then the card shows the billed amount and reopening keeps manual.
   await page.goto(BASE+'/inventory/snapshots');
   const card=page.getByTestId('snapshot-purchase-card-100');await card.waitFor();await card.click();
   const entry=page.getByTestId('daily-log-purchase-100');await entry.waitFor();
   assert.equal(await page.getByTestId('daily-log-billed-100').getAttribute('data-mode'),'auto');
   await entry.getByRole('button',{name:lang==='vi'?'Sửa nhập hàng':'입고 수정'}).click();
   const formRe=page.getByTestId('receipt-edit-form-100');await formRe.waitFor();
   const re=field('receipt-edit-billed-100');assert.equal(await re.input.inputValue(),'303,450');
   const qtyRe=page.getByTestId('receipt-edit-quantity-100');await qtyRe.fill('4');assert.equal(await re.input.inputValue(),'340,000');
   await re.input.fill('303000');await qtyRe.fill('3.57');assert.equal(await re.input.inputValue(),'303,000');assert.equal(await re.diff(),diffText(-450));
   await page.getByTestId('receipt-edit-reason-100').fill('영수증 금액');
   await noOverflow('receipt edit');await fits(re.root);await re.root.scrollIntoViewIfNeeded();await shot('receipt-edit-manual');
   await formRe.getByRole('button',{name:lang==='vi'?'Lưu sửa đổi':'수정 저장'}).click();await formRe.waitFor({state:'detached'});
   const reBody=writes.filter(w=>w.body.mode==='purchase-receipt-edit').at(-1).body;
   assert.deepEqual(reBody.purchaseBilledAmount,{mode:'manual',amount:303000});assert.equal(reBody.payload.quantity,3.57);
   const billedLine=page.getByTestId('daily-log-billed-100');
   await page.waitForFunction(()=>document.querySelector('[data-testid="daily-log-billed-100"]')?.getAttribute('data-mode')==='manual');
   const lineText=await billedLine.innerText();
   assert.match(lineText,/303,000 ₫/);assert.match(lineText,/303,450 ₫/);assert.match(lineText,/−450 ₫/);
   const total=lang==='vi'?'Tổng':'합계';
   assert.match(await entry.locator('xpath=..').innerText(),new RegExp(total+'\\s*303,000'),'card total = billed amount');
   assert.doesNotMatch(await entry.locator('xpath=..').innerText(),new RegExp(total+'\\s*303,450'));
   await noOverflow('saved card');await billedLine.scrollIntoViewIfNeeded();await shot('card-saved');
   await entry.getByRole('button',{name:lang==='vi'?'Sửa nhập hàng':'입고 수정'}).click();
   await formRe.waitFor();assert.equal(await re.mode(),'manual');assert.equal(await re.input.inputValue(),'303,000','reopen keeps manual');
   await re.restore.click();assert.equal(await re.mode(),'auto');assert.equal(await re.input.inputValue(),'303,450');
   // Daily list after the save: the receipt row and the day total are the billed amount.
   await page.getByRole('button',{name:lang==='vi'?'Hủy':'취소',exact:true}).click();
   await page.getByRole('button',{name:lang==='vi'?'Đóng':'닫기',exact:true}).last().click();
   await page.waitForFunction(()=>/303,000/.test(document.querySelector('[data-testid="snapshot-purchase-card-100"]')?.textContent??''));
   const list=await page.getByTestId('snapshot-purchase-card-100').innerText();assert.match(list,/303,000/);assert.doesNotMatch(list,/303,450/);
   assert.match(await page.locator('body').innerText(),new RegExp(c.total+'\\s*303,000'),'day total = billed amount');
   await noOverflow('daily list');await page.getByTestId('snapshot-purchase-card-100').scrollIntoViewIfNeeded();await shot('daily-total');
   assert.deepEqual(errors,[]);
   results.push({lang,label,ok:true});
  }finally{await context.close();}
 }}finally{await browser.close();}
 console.log(JSON.stringify(results));
});
