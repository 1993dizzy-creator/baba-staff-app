import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {inventoryText} from '../lib/text/inventory.ts';
import {commonText} from '../lib/text/common.ts';
import {offlineUiBase} from './helpers/offline-ui-base.mjs';
const BASE=offlineUiBase(),require=createRequire(import.meta.url);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=','base64');

test('registration recovery across KO/VI x 360/390/PC: saved ID, photo-only retry, lost response, duplicates and rapid clicks',
 {skip:!process.env.PLAYWRIGHT_MODULE_PATH||!BASE,timeout:300000},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
 const browser=await chromium.launch({headless:true,executablePath:process.env.QA_BROWSER_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 await mkdir('.qa-review/registration-recovery',{recursive:true});
 let completed=0;
 try{for(const lang of ['ko','vi'])for(const [size,viewport] of [['360',{width:360,height:780}],['390',{width:390,height:844}],['pc',{width:1280,height:900}]]){
  for(const scenario of ['normal','photo-success','photo-failure','photo-exception','response-lost','invalid-json','duplicate','lookup-delayed','refresh-failed']){
   const context=await browser.newContext({viewport,isMobile:size!=='pc',hasTouch:size!=='pc'}),page=await context.newPage();page.setDefaultTimeout(8000);
   const t=inventoryText[lang],c=commonText[lang],errors=[],reads=[];let posts=0,photos=0,bootstrapReads=0,visible=true;
   let item=scenario==='duplicate'?{id:632,item_name:'Fresh fryer',item_name_vi:'Bếp chiên mới',part:'kitchen',category:'Food',quantity:7,unit:'cai',purchase_price:300000,code:'FRY',is_active:true,image_path:null}:null;
   const counts={items:item?1:0,receipts:item?1:0,bookings:item?1:0,payables:item?1:0};
   const user={id:1,name:'QA',role:'staff',part:'kitchen',language:lang};
   await page.addInitScript(u=>localStorage.setItem('baba_user',JSON.stringify(u)),user);
   page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
   await page.route('**/*',route=>['localhost','127.0.0.1'].includes(new URL(route.request().url()).hostname)?route.fallback():route.abort());
   await page.route('**/storage/v1/object/public/**',route=>route.fulfill({contentType:'image/png',body:png}));
   const log=()=>({id:14406,item_id:632,item_name:item.item_name,item_name_vi:item.item_name_vi,part:'kitchen',category:'Food',unit:'cai',code:'FRY',action:'create',source:'create',reason:'purchase',change_quantity:1,prev_quantity:0,new_quantity:1,new_purchase_price:300000,new_supplier:'QA',business_date:'2026-10-30',created_at:'2026-10-30T03:00:00Z',actor_name:'QA'});
   await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url());reads.push(url.pathname+url.search);let json={ok:true,data:[]};
    if(url.pathname==='/api/session')json={authenticated:true,user};
    else if(url.pathname==='/api/inventory/items'&&req.method()==='POST'){
     posts++;assert.equal(posts,1,'one POST even with rapid clicks');const body=req.postDataJSON();
     assert.equal(body.registrationType,'new_purchase');assert.equal(body.payload.quantity,1);assert.equal(body.payload.purchase_price,300000);assert.deepEqual(body.purchaseBilledAmount,{mode:'auto'});
     if(scenario==='duplicate')return route.fulfill({status:409,json:{ok:false,error:'inventory_item_duplicate_name_code',duplicateItem:{id:632,item_name:'Old name',item_name_vi:'Tên cũ',part:'kitchen'},duplicateMatchedFields:['item_name_vi']}});
     item={...body.payload,id:632,image_path:null,is_active:true,updated_at:'2026-10-30T03:00:00Z'};for(const key of Object.keys(counts))counts[key]++;
     if(scenario==='lookup-delayed')visible=false;
     if(['response-lost','lookup-delayed'].includes(scenario))return route.abort('failed');
     if(scenario==='invalid-json')return route.fulfill({contentType:'text/html',body:'<html>response lost</html>'});
     return route.fulfill({json:{ok:true,data:item,ledgerSync:{status:'synced',code:'PROJECTED'}}});
    }else if(url.pathname==='/api/inventory/items/632/photo'&&req.method()==='POST'){
     photos++;
     if(photos===1&&scenario==='photo-exception')return route.abort('failed');
     if(photos===1&&scenario==='photo-failure')return route.fulfill({status:500,json:{ok:false,error:'upload_failed'}});
     item.image_path='632/photo.png';return route.fulfill({json:{ok:true,data:{image_path:item.image_path,updated_at:'2026-10-30T03:01:00Z'}}});
    }else if(url.pathname==='/api/inventory/bootstrap-stream'){
     bootstrapReads++;if(scenario==='refresh-failed'&&posts>0)return route.abort('failed');
     const items=bootstrapReads===1?[]:item&&visible?[item]:[];
     return route.fulfill({contentType:'application/x-ndjson',body:[{type:'items',items,supplierPartners:[],supplierAliases:[]},{type:'enrichment',statusMap:{},kegProgressMap:{},activeKegTrackingItemIds:[]},{type:'complete',timing:{}}].map(x=>JSON.stringify(x)).join('\n')+'\n'});
    }else if(url.pathname==='/api/inventory/items')json={ok:true,data:item&&visible?[item]:[],supplierPartners:[],supplierAliases:[]};
    else if(url.pathname==='/api/inventory/logs/recent')json={ok:true,data:item&&visible?[log()]:[]};
    else if(url.pathname==='/api/inventory/items/632/logs')json={ok:true,data:[log()]};
    await route.fulfill({json});
   });
   try{
    await page.goto(BASE+'/inventory');await page.getByRole('button',{name:t.openInventoryForm,exact:true}).click();
    await page.getByRole('button').filter({hasText:t.newPurchaseRegistration}).click();
    const form=page.getByTestId('inventory-edit-form');await form.waitFor();
    await page.getByPlaceholder(c.itemName,{exact:true}).first().fill(lang==='vi'?'Bếp chiên ngập dầu':'튀김기 QA');
    await page.getByPlaceholder(t.purchasePrice,{exact:true}).first().fill('300000');await page.getByPlaceholder(t.unitPlaceholder,{exact:true}).fill('cai');
    await page.getByPlaceholder(c.quantity,{exact:true}).last().fill('1');
    const hasPhoto=scenario.startsWith('photo-')||scenario==='response-lost';
    if(hasPhoto){await page.locator('#inventory-form-photo-library').setInputFiles({name:'photo.png',mimeType:'image/png',buffer:png});await form.locator('img').waitFor();}
    const save=form.getByRole('button',{name:c.save,exact:true});await page.waitForFunction(button=>!button.disabled,await save.elementHandle());
    await save.evaluate(button=>{button.click();button.click();button.click();});
    const notice=page.getByTestId('registration-result');await notice.waitFor();
    if(scenario==='lookup-delayed'){
     assert.match(await notice.innerText(),lang==='vi'?/Chưa xác nhận/:/저장 결과를 확인하지/);assert.equal(posts,1);visible=true;
     await form.getByRole('button',{name:lang==='vi'?'Kiểm tra kết quả lưu':'저장 결과 확인',exact:true}).click();
    }
    await page.getByTestId('registration-open-item').waitFor();
    await page.waitForFunction(()=>!document.querySelector('[data-testid="registration-open-item"]')?.disabled);
    await page.waitForFunction(()=>{const box=document.querySelector('[data-testid="registration-result"]')?.getBoundingClientRect();return box&&box.top>=50&&box.bottom<=window.innerHeight-55;});
    assert.match(await notice.innerText(),/#632/);assert.equal(posts,1);
    assert.ok(reads.includes('/api/inventory/items?itemId=632'),'server-selected item reloaded');
    assert.ok(reads.filter(x=>x==='/api/inventory/logs/recent').length>=2,'recent logs refreshed');
    const displayName=lang==='vi'?(item.item_name_vi||item.item_name):(item.item_name||item.item_name_vi);
    assert.ok((await page.getByTestId('inventory-recent-logs').innerText()).includes(displayName));
    if(['photo-failure','photo-exception'].includes(scenario)){
     assert.match(await notice.innerText(),lang==='vi'?/Mặt hàng đã được lưu, nhưng tải ảnh lên thất bại/:/품목은 저장됐지만 사진 업로드는 실패/);
     await page.screenshot({path:`.qa-review/registration-recovery/${lang}-${size}-${scenario}.png`});
     await page.getByTestId('registration-retry-photo').setInputFiles({name:'retry.png',mimeType:'image/png',buffer:png});
     await page.waitForFunction(()=>!document.querySelector('[data-testid="registration-retry-photo"]'));assert.equal(photos,2);assert.equal(posts,1);
    }
    if(scenario==='duplicate'){
     assert.match(await notice.innerText(),lang==='vi'?/Bếp chiên mới/:/Fresh fryer/);assert.doesNotMatch(await notice.innerText(),/Old name|Tên cũ/);
     await page.getByTestId('registration-open-item').click();await page.getByTestId('inventory-edit-form').waitFor();
     assert.equal(await page.getByTestId('inventory-edit-form').locator('input[type=number][step="0.1"]').inputValue(),'7');
    }else{
     await page.getByRole('button',{name:t.openInventoryForm,exact:true}).click();await page.getByRole('button').filter({hasText:t.newPurchaseRegistration}).click();
     await page.getByPlaceholder(c.itemName,{exact:true}).first().fill(item.item_name_vi||item.item_name);
     await page.getByText(lang==='vi'?'Các mặt hàng hiện có tương tự':'유사한 기존 품목',{exact:true}).waitFor();
    }
    assert.deepEqual(counts,{items:1,receipts:1,bookings:1,payables:1});assert.deepEqual(errors,[]);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'no horizontal overflow');
    completed++;console.log(JSON.stringify({lang,size,scenario,posts,photos,counts,ok:true}));
   }finally{await context.close();}
  }
 }}finally{await browser.close();}
 assert.equal(completed,54);
});
