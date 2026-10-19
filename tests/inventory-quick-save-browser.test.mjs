import assert from 'node:assert/strict';
import test from 'node:test';
import {inventoryPurchaseErrorMessage} from '../lib/inventory/reasons.ts';
import {projectDailyEffectivePurchases} from '../lib/inventory/daily-effective-purchases.ts';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
// API requests are all intercepted; this suite never writes to a database.
test('simple purchase save preserves signs, confirmation and automatic correction across KO/VI and desktop/mobile', {skip:!process.env.PLAYWRIGHT_MODULE_PATH}, async () => {
const base=process.env.INVENTORY_QA_BASE_URL??'http://localhost:3043';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname),'Browser test requires a loopback harness; never run against Production');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
const browser=await chromium.launch({executablePath:process.env.QA_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try {
 for (const lang of ['ko','vi']) for (const mobile of [false,true]) {
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});
  const page=await context.newPage();page.setDefaultTimeout(6000);const writes=[];const reads=[];let missing=true,fail=true;let errorCode=null,errorDetails={},codeOnly=false;let accept=false;const confirmations=[],alerts=[];
  const gates=new Map();
  const hold=path=>{let release;const promise=new Promise(resolve=>{release=resolve;});gates.set(path,promise);return ()=>{gates.delete(path);release();};};
  const releaseCalendar=hold('/api/inventory/snapshot/list');
  const releaseMovements=hold('/api/inventory/logs');
  let loadFailure=false,logsFailure=true;
  const user={id:1,name:'QA',role:'owner',part:'kitchen',language:lang};
  const item={id:1,item_name:lang==='ko'?'Oil':'',item_name_vi:lang==='ko'?'':'Dau',part:'kitchen',category:'Food',category_vi:'Food',quantity:2,unit:'bottle',purchase_price:lang==='vi'&&mobile?30000.5:30000,supplier:'QA',supplier_partner_id:10,image_path:'qa.png',code:'QA',is_active:true,updated_at:'2026-10-10T03:00:00.000Z',low_stock_threshold:1,low_stock_enabled:false,package_content_quantity:null,package_content_unit:null};
  const log={id:100,item_id:1,item_name:'Oil',item_name_vi:'Dau',part:'kitchen',category:'Food',category_vi:'Food',change_quantity:2,prev_quantity:0,new_quantity:2,unit:'bottle',code:'QA',reason:'purchase',new_purchase_price:item.purchase_price,new_supplier:'QA',created_at:'2026-10-10T03:00:00Z'};
  await page.addInitScript(user=>localStorage.setItem('baba_user',JSON.stringify(user)),user);
  await page.route('**/storage/v1/object/public/**',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=','base64')}));
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url());reads.push(url.pathname+url.search);
   if(gates.has(url.pathname))await gates.get(url.pathname);
   let json={ok:true,data:[],items:[]};let status=200;
   if(url.pathname.endsWith('/photo')) {item.image_path='qa-uploaded.png';item.updated_at=new Date().toISOString();json={ok:true,data:{image_path:item.image_path,updated_at:item.updated_at}};}
   else if(req.method()==='PATCH'){
    const body=req.postDataJSON();writes.push(body);
    await new Promise(resolve=>setTimeout(resolve,100));
    if(fail){status=409;json={ok:false,error:'INVENTORY_CONFLICT',message:'Item changed. Reload before saving.'};}
    else if(errorCode){status=409;json={ok:false,...errorDetails,...(codeOnly?{code:errorCode}:{error:errorCode})};}
    else {Object.assign(item,body.payload);missing=!item.item_name?.trim()||!item.item_name_vi?.trim();item.updated_at=new Date().toISOString();json={ok:true,mode:body.mode,...(body.reason==='purchase'?{ledgerSync:{status:'synced',code:'REBOOKED',inventoryLogId:101}}:{})};}
   }
   else if(url.pathname==='/api/session')json={authenticated:true,user};
   else if(url.pathname==='/api/inventory/snapshot/list')json={ok:true,batches:[{id:10,snapshot_date:'2026-10-03'}],currentBusinessDate:'2026-10-10',purchaseDateMap:{'2026-10-10':true}};
   else if(url.pathname==='/api/inventory/snapshot/name-sync')json={ok:true,canSync:true,dailySyncItems:[],languageMissingItems:missing?[{itemId:1,currentItemName:lang==='ko'?'Oil':null,currentItemNameVi:lang==='ko'?null:'Dau',missingLanguages:[lang==='ko'?'vi':'ko'],registeredAt:'2026-10-03T03:00:00Z',lastUpdatedAt:item.updated_at}]:[]};
   else if(url.pathname==='/api/inventory/logs')json={ok:true,data:projectDailyEffectivePurchases([log,{...log,id:12407,item_id:613,item_name:'Canceled oil',item_name_vi:'Canceled oil',is_active:false}],[{...log,id:12883,change_quantity:-2,correction_of_inventory_log_id:12407}])};
   else if(url.pathname==='/api/inventory/items')json={ok:true,data:[item],supplierPartners:[{id:10,name:"QA"}],supplierAliases:[]};
   else if(url.pathname==='/api/inventory/items/1/logs')json={ok:true,data:[log]};
   else if(url.pathname==='/api/inventory/bootstrap-stream') { await route.fulfill({contentType:'application/x-ndjson',body:[{type:'items',items:[item],supplierPartners:[{id:10,name:"QA"}],supplierAliases:[]},{type:'enrichment',statusMap:{},kegProgressMap:{},activeKegTrackingItemIds:[]},{type:'complete',timing:{}}].map(row=>JSON.stringify(row)).join('\n')+'\n'});return; }
   else if(url.pathname==='/api/inventory/snapshot/10')json={ok:true,items:[{...item,id:200,item_id:1,batch_id:10,change_quantity:2,total_purchase_price:2*item.purchase_price}]};
   if(logsFailure && url.pathname==='/api/inventory/items/1/logs'){status=500;json={ok:false,error:'qa_failure'};}
   if(loadFailure && url.pathname==='/api/inventory/items'){status=500;json={ok:false,message:'QA load failed'};}
   await route.fulfill({status,json});
  });
  page.on('dialog',async d=>{if(d.type()==='confirm'){confirmations.push(d.message());if(accept)await d.accept();else await d.dismiss();}else{alerts.push(d.message());await d.dismiss();}});


  releaseCalendar();releaseMovements();missing=false;logsFailure=false;fail=false;
  await page.goto(base+'/inventory?itemId=1');
  const quickName=lang==='ko'?'빠른저장':'Lưu nhanh',purchaseName=lang==='ko'?'구매입고':'Nhap mua';
  const open=async value=>{await page.locator('input[type=number]').first().fill(value);await page.getByRole('button',{name:quickName,exact:true}).click();await page.getByRole('button').filter({hasText:purchaseName}).last().click();};
  const save=()=>page.getByRole('button',{name:purchaseName+' '+(lang==='ko'?'저장':'Lưu'),exact:true});
  await open('5');let delta=page.getByTestId('quick-purchase-delta');assert.equal((await delta.innerText()).trim(),purchaseName+': +3');assert.equal(await delta.evaluate(el=>getComputedStyle(el).color),'rgb(46, 139, 87)');
  assert.equal(await page.getByRole('region',{name:lang==='ko'?'원입고 수량 정정':'Sửa lô nhập gốc'}).count(),0);assert.equal(await save().count(),1);
  await save().click();await delta.waitFor({state:'hidden'});assert.equal(confirmations.length,0);assert.equal(item.quantity,5);assert.equal(writes.at(-1).reason,'purchase');
  await open('2');delta=page.getByTestId('quick-purchase-delta');assert.equal((await delta.innerText()).trim(),purchaseName+': -3'+(lang==='ko'?' (수량정정)':' (điều chỉnh số lượng)'));assert.equal(await delta.evaluate(el=>getComputedStyle(el).color),'rgb(220, 38, 38)');assert.doesNotMatch(await delta.innerText(),/\+-/);
  const before=writes.length;accept=false;await save().click();await page.waitForTimeout(150);assert.equal(writes.length,before);assert.equal(item.quantity,5);assert.equal(confirmations.at(-1),lang==='ko'?'오늘 입고된 수량을 정정하시겠습니까?':'Bạn có muốn điều chỉnh số lượng hàng đã nhập hôm nay không?');
  accept=true;
  const purchasePanel=delta.locator('..').locator('..');await purchasePanel.locator('select').selectOption('__custom__');
  await purchasePanel.locator('input[type=text]').first().fill('QA draft supplier');await purchasePanel.locator('input[inputmode=numeric]').fill('123456');
  const errors=[
    ['purchase_correction_ambiguous',{candidateCount:3,candidateCountExact:true,blockReason:'multiple_candidates'}],
    ['purchase_correction_root_not_found',{}],['purchase_correction_exceeds_purchase',{}],
    ['purchase_correction_review_required',{blockReason:'payment_completed'}],['purchase_correction_review_required',{blockReason:'payment_allocated'}],
    ['purchase_correction_review_required',{blockReason:'month_closed'}],['purchase_correction_later_stock_check',{}],
    ['QUANTITY_CONFLICT',{}],['INVENTORY_CONFLICT',{},true],['quantity_conflict',{}],['inventory_conflict',{}],
    ['purchase_correction_ambiguous',{candidateCount:1001,candidateCountExact:false,blockReason:'candidate_limit'}],['purchase_correction_review_required',{}],['qa_unknown',{}],
  ];
  const fallback=lang==='ko'?'정정 요청을 완료하지 못했습니다. 입력값은 유지했습니다. 관리자에게 문의해 주세요.':'Không thể hoàn tất yêu cầu điều chỉnh. Dữ liệu bạn nhập được giữ nguyên. Vui lòng liên hệ quản lý.';
  const readCount=()=>reads.filter(u=>u.startsWith('/api/inventory/items?')||u.startsWith('/api/inventory/bootstrap-stream')).length;
  for(const [code,details,onlyCode=false] of errors){
    errorCode=code;errorDetails=details;codeOnly=onlyCode;const priorWrites=writes.length,priorConfirm=confirmations.length,priorAlerts=alerts.length,priorReads=readCount();
    const shown=page.waitForEvent('dialog',d=>d.type()==='alert');await save().evaluate(button=>{button.click();button.click();});await shown;
    assert.equal(alerts.at(-1),inventoryPurchaseErrorMessage(code,lang,details)??fallback);assert.equal(writes.length,priorWrites+1);assert.equal(confirmations.length,priorConfirm+1);assert.equal(alerts.length,priorAlerts+1);assert.equal(readCount(),priorReads);
    assert.equal(item.quantity,5);assert.equal(await page.locator('input[type=number]').first().inputValue(),'2');assert.equal(await purchasePanel.locator('input[type=text]').first().inputValue(),'QA draft supplier');assert.equal(await purchasePanel.locator('input[inputmode=numeric]').inputValue(),'123,456');
    assert.equal(await save().count(),1);assert.equal(await page.getByRole('region',{name:lang==='ko'?'원입고 수량 정정':'Sửa lô nhập gốc'}).count(),0);
  }
  errorDetails={};codeOnly=false;
  errorCode=null;const attempts=writes.length,confirms=confirmations.length;await save().evaluate(button=>{button.click();button.click();});await delta.waitFor({state:'hidden'});assert.equal(writes.length,attempts+1);assert.equal(confirmations.length,confirms+1);assert.equal(item.quantity,2);assert.equal(writes.at(-1).selectedPurchaseRootId,undefined);assert.equal(writes.at(-1).expectedQuantity,5);
  console.log('PASS positive green +3; negative red -3; one save button; confirm/cancel; concise ambiguity; duplicate-click protection',lang,mobile?'mobile':'desktop');
  await page.goto(base+'/inventory?itemId=1&mode=edit');await page.getByTestId('inventory-edit-form').waitFor();const form=page.getByTestId('inventory-edit-form');await form.locator('input[type=number][step="0.1"]').fill('1.5');await form.getByRole('button',{name:lang==='ko'?'저장':'Lưu',exact:true}).click();
  const reason=()=>page.getByRole('button',{name:new RegExp(purchaseName)}).last();accept=false;const prior=writes.length;await reason().click();await page.waitForTimeout(100);assert.equal(writes.length,prior);
  const values=()=>form.locator('input,select,textarea').evaluateAll(elements=>elements.map(el=>el.value));const draftValues=await values();accept=true;
  for(const [code,details,onlyCode=false] of errors){errorCode=code;errorDetails=details;codeOnly=onlyCode;const priorWrites=writes.length,priorConfirm=confirmations.length;
    const shown=page.waitForEvent('dialog',d=>d.type()==='alert');await reason().evaluate(button=>{button.click();button.click();});await shown;
    assert.equal(alerts.at(-1),inventoryPurchaseErrorMessage(code,lang,details)??fallback);assert.equal(writes.length,priorWrites+1);assert.equal(confirmations.length,priorConfirm+1);assert.deepEqual(await values(),draftValues);assert.equal(item.quantity,2);
  }
  errorCode=null;errorDetails={};codeOnly=false;await reason().click();await page.waitForTimeout(300);assert.equal(writes.at(-1).autoSelectPurchaseRoot,true);assert.equal(writes.at(-1).selectedPurchaseRootId,undefined);assert.equal(item.quantity,1.5);assert.equal(writes.at(-1).source,'edit_form');
  console.log('PASS 14 error cases for both forms; exact alerts; retained quantity/supplier/price; one request; no failure refetch',lang,mobile?'mobile':'desktop');
  console.log('PASS edit form simple confirmation and automatic receipt mode',lang,mobile?'mobile':'desktop');
  await context.close();
 }
}finally{await browser.close();}

});
