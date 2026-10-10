import assert from 'node:assert/strict';
import test from 'node:test';
import {projectDailyEffectivePurchases} from '../lib/inventory/daily-effective-purchases.ts';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
// API requests are all intercepted; this suite never writes to a database.
test('snapshot UI and quick-save across KO/VI and desktop/mobile', {skip:!process.env.PLAYWRIGHT_MODULE_PATH}, async () => {
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
const browser=await chromium.launch({executablePath:process.env.QA_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try {
 for (const lang of ['ko','vi']) for (const mobile of [false,true]) {
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});
  const page=await context.newPage();page.setDefaultTimeout(6000);const writes=[];const reads=[];let missing=true,fail=true;
  const user={id:1,name:'QA',role:'owner',part:'kitchen',language:lang};
  const item={id:1,item_name:'Oil',item_name_vi:'Dau',part:'kitchen',category:'Food',category_vi:'Food',quantity:2,unit:'bottle',purchase_price:lang==='vi'&&mobile?30000.5:30000,supplier:'QA',supplier_partner_id:null,code:'QA',is_active:true,updated_at:'2026-10-10T03:00:00.000Z',low_stock_threshold:1,low_stock_enabled:false,package_content_quantity:null,package_content_unit:null};
  const log={id:100,item_id:1,item_name:'Oil',item_name_vi:'Dau',part:'kitchen',category:'Food',category_vi:'Food',change_quantity:2,prev_quantity:0,new_quantity:2,unit:'bottle',code:'QA',reason:'purchase',new_purchase_price:item.purchase_price,new_supplier:'QA',created_at:'2026-10-10T03:00:00Z'};
  await page.addInitScript(user=>localStorage.setItem('baba_user',JSON.stringify(user)),user);
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());reads.push(url.pathname+url.search);
   let json={ok:true,data:[],items:[]};let status=200;
   if(req.method()==='PATCH'){
    const body=req.postDataJSON();writes.push(body);
    await new Promise(resolve=>setTimeout(resolve,100));
    if(fail){status=409;json={ok:false,error:'INVENTORY_CONFLICT',message:'Item changed. Reload before saving.'};}
    else {missing=false;item.updated_at=new Date().toISOString();json={ok:true,mode:body.mode,...(body.reason==='purchase'?{ledgerSync:{status:'synced',code:'REBOOKED',inventoryLogId:101}}:{})};}
   }
   else if(url.pathname==='/api/session')json={authenticated:true,user};
   else if(url.pathname==='/api/inventory/snapshot/list')json={ok:true,batches:[{id:10,snapshot_date:'2026-10-03'}],currentBusinessDate:'2026-10-10',purchaseDateMap:{'2026-10-10':true}};
   else if(url.pathname==='/api/inventory/snapshot/name-sync')json={ok:true,canSync:true,dailySyncItems:[],languageMissingItems:missing?[{itemId:1,currentItemName:lang==='ko'?'Oil':null,currentItemNameVi:lang==='ko'?null:'Dau',missingLanguages:[lang==='ko'?'vi':'ko'],registeredAt:'2026-10-03T03:00:00Z',lastUpdatedAt:item.updated_at}]:[]};
   else if(url.pathname==='/api/inventory/logs')json={ok:true,data:projectDailyEffectivePurchases([log,{...log,id:12407,item_id:613,item_name:'Canceled oil',item_name_vi:'Canceled oil',is_active:false}],[{...log,id:12883,change_quantity:-2,correction_of_inventory_log_id:12407}])};
   else if(url.pathname==='/api/inventory/items')json={ok:true,data:[item],supplierPartners:[],supplierAliases:[]};
   else if(url.pathname==='/api/inventory/items/1/logs')json={ok:true,data:[log]};
   else if(url.pathname==='/api/inventory/bootstrap-stream') { await route.fulfill({contentType:'application/x-ndjson',body:[{type:'items',items:[item],supplierPartners:[],supplierAliases:[]},{type:'enrichment',statusMap:{},kegProgressMap:{},activeKegTrackingItemIds:[]},{type:'complete',timing:{}}].map(row=>JSON.stringify(row)).join('\n')+'\n'});return; }
   else if(url.pathname==='/api/inventory/snapshot/10')json={ok:true,items:[{...item,id:200,item_id:1,batch_id:10,change_quantity:2,total_purchase_price:2*item.purchase_price}]};
   await route.fulfill({status,json});
  });
  page.on('dialog',d=>d.dismiss());
  await page.goto('http://localhost:3000/inventory/snapshots');
  const banner=page.getByTestId('inventory-language-missing-banner');await banner.waitFor();
  assert.equal(await page.getByText('Canceled oil',{exact:false}).count(),0);
  await banner.locator('button').first().click();const row=page.getByTestId('inventory-language-missing-item-1');
  assert.match(await row.innerText(),lang==='ko'?/등록일/:/Ngày đăng ký/);
  assert.equal(reads.some(u=>u.startsWith('/api/inventory/items?')),false);
  await row.locator('button').first().click();assert.equal(await row.locator('input').count(),1);
  await row.locator('input').fill('Dau moi');const inlineCount=writes.length;await row.locator('button').last().evaluate(button=>{button.click();button.click();});await row.getByRole('alert').waitFor();assert.equal(writes.length,inlineCount+1);
  assert.equal(await row.locator('input').inputValue(),'Dau moi');assert.equal(new URL(page.url()).pathname,'/inventory/snapshots');
  assert.deepEqual(writes[0].payload,lang==='ko'?{item_name_vi:'Dau moi'}:{item_name:'Dau moi'});
  fail=false;await row.locator('button').last().click();await banner.waitFor({state:'hidden'});
  // Open a purchase history card, then its item editor.
  await page.locator('input').first().fill('QA');
  await page.getByRole('button').filter({hasText:lang==='ko'?'Oil':'Dau'}).first().click();
  await page.getByRole('button',{name:lang==='ko'?'\uc218\uc815':'S\u1eeda',exact:true}).click();
  const initialScroll=await page.evaluate(()=>window.scrollY);
  const dialog=page.getByRole('dialog');await dialog.locator('input').first().waitFor();
  assert.equal(reads.filter(u=>u==='/api/inventory/items?itemId=1').length,1);
  assert.equal(reads.some(u=>u.includes('bootstrap')),false);
  const form=dialog.getByTestId('inventory-edit-form');
  const itemName=dialog.locator('input').nth(2);
  await itemName.fill('Updated name');
  const saveName=lang==='ko'?'\uc800\uc7a5':'L\u01b0u';
  await form.getByRole('button',{name:saveName,exact:true}).click();
  fail=true;
  const confirm=dialog.getByRole('button').filter({hasText:lang==='ko'?'\uc7ac\uace0\ud655\uc778':'Kiem tra kho'}).last();
  const confirmCount=writes.length;await confirm.evaluate(button=>{button.click();button.click();});
  assert.equal(await dialog.getByRole('button',{name:lang==='ko'?'\ub2eb\uae30':'\u0110\u00f3ng',exact:true}).first().isDisabled(),true);
  await page.waitForTimeout(200);assert.equal(writes.length,confirmCount+1);
  assert.equal(await itemName.inputValue(),'Updated name');
  assert.equal(await dialog.count(),1);
  fail=false;await confirm.click();await dialog.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>window.scrollY),initialScroll);
  assert.equal(await page.locator('input').first().inputValue(),'QA');
  assert.ok(await page.getByRole('button',{name:lang==='ko'?'\uc218\uc815':'S\u1eeda',exact:true}).count());
  const editWrite=writes.at(-1);assert.equal(editWrite.source,'edit_form');assert.equal(editWrite.expectedQuantity,2);assert.equal(typeof editWrite.expectedUpdatedAt,'string');
  assert.equal(editWrite.payload.quantity,2);assert.equal(editWrite.payload.purchase_price,item.purchase_price);assert.equal(editWrite.payload.supplier,'QA');
  assert.equal(new URL(page.url()).pathname,'/inventory/snapshots');
  // Historical date: select day 3 and retain it while the editor opens/closes.
  await page.getByRole('button',{name:lang==='ko'?'\ub2eb\uae30':'\u0110\u00f3ng',exact:true}).last().click();
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.getByRole('button',{name:'3',exact:true}).click();
  await page.waitForTimeout(100);
  assert.ok(reads.some(u=>u==='/api/inventory/snapshot/10'));
  console.log('PASS inline failure/success, lazy modal failure/success, immutable accounting, date',lang,mobile?'mobile':'desktop');
  await page.goto('http://localhost:3000/inventory?itemId=1');
  await page.locator('input[type=number]').first().fill('3');
  await page.getByRole('button',{name:lang==='ko'?'\ube60\ub978\uc800\uc7a5':'L\u01b0u nhanh',exact:true}).click();
  await page.getByRole('button').filter({hasText:lang==='ko'?'\uad6c\ub9e4\uc785\uace0':'Nhap mua'}).last().click();
  const money=page.locator('input[inputmode=numeric]').last();await money.waitFor();
  await money.fill('1234567');assert.equal(await money.inputValue(),'1,234,567');
  await money.evaluate(input=>input.setSelectionRange(3,3));await money.press('8');assert.equal(await money.inputValue(),'12,834,567');
  assert.equal(await money.evaluate(input=>input.selectionStart),4);
  await money.fill('');assert.equal(await money.inputValue(),'');await money.fill('123456');
  const quickConfirm=page.getByRole('button').filter({hasText:lang==='ko'?'\uad6c\ub9e4\uc785\uace0 \uc800\uc7a5':'Nhap mua L\u01b0u'}).last();
  fail=true;await quickConfirm.click();await page.waitForTimeout(100);assert.equal(await money.inputValue(),'123,456');
  fail=false;await quickConfirm.click();await money.waitFor({state:'hidden'});
  assert.equal(writes.at(-1).payload.purchase_price,123456);assert.equal(writes.at(-1).payload.quantity,3);
  assert.equal(writes.at(-1).mode,'quick-save');
  console.log('PASS quick-save comma/caret/mobile keyboard, numeric API, failure/success',lang,mobile?'mobile':'desktop');
  await context.close();
 }
}finally{await browser.close();}

});
