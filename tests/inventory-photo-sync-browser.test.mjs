import assert from 'node:assert/strict';import test from 'node:test';import {createRequire} from 'node:module';
import {photoSync622} from './helpers/inventory-photo-sync-fixture.mjs';
import {findInventoryLogNameSyncItems} from '../lib/inventory/snapshot-name-sync.ts';
import {inventoryLogDisplayUpdate,inventoryPurchaseLogCurrentItemSyncUpdate} from '../lib/inventory/ledger-sync-contract.ts';
const require=createRequire(import.meta.url);
test('photo-only #622 hides the false sync banner; real edits and Ledger review remain across KO/VI desktop/mobile',{skip:!process.env.PLAYWRIGHT_MODULE_PATH},async()=>{
 const base=process.env.INVENTORY_QA_BASE_URL??'http://localhost:3045';assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname));const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH),browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{for(const lang of ['ko','vi'])for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile}),page=await context.newPage();page.setDefaultTimeout(8000);const f=photoSync622(),requests=[],writes=[];let economic=false;const user={id:2,role:'owner',name:'QA',part:'etc',language:lang};
  await page.addInitScript(user=>localStorage.setItem('baba_user',JSON.stringify(user)),user);
  await page.route('**/*',route=>{const host=new URL(route.request().url()).hostname;return ['localhost','127.0.0.1','[::1]'].includes(host)?route.continue():route.abort();});
  await page.route('**/api/**',async route=>{const req=route.request(),url=new URL(req.url());requests.push({method:req.method(),path:url.pathname});let json={ok:true,data:[]};
   if(url.pathname==='/api/session')json={authenticated:true,user};
   else if(url.pathname==='/api/inventory/snapshot/list')json={ok:true,batches:[],currentBusinessDate:f.businessDate,purchaseDateMap:{[f.businessDate]:true}};
   else if(url.pathname==='/api/inventory/logs')json={ok:true,data:[f.root]};
   else if(url.pathname==='/api/inventory/snapshot/name-sync'){
    const plans=findInventoryLogNameSyncItems(f.businessDate,f.logs,[f.master]);
    if(req.method()==='POST'){const results=[];for(const plan of plans){const targets=[];for(const target of plan.targets){const money=target.changes.some(c=>['supplier','supplier_partner_id','purchase_price'].includes(c.field));const payload=money?inventoryPurchaseLogCurrentItemSyncUpdate(target.syncItem):inventoryLogDisplayUpdate(target.syncItem);writes.push({money,payload});Object.assign(f.root,payload);targets.push({purchaseLogId:target.purchaseLogId,correctionLogId:target.correctionLogId,status:economic?'review_required':'synced',code:economic?'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED':'METADATA_SYNCED'});}results.push({itemId:plan.itemId,currentItemName:plan.currentItemName,currentItemNameVi:plan.currentItemNameVi,status:economic?'review_required':'synced',code:economic?'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED':'METADATA_SYNCED',targets});}json={ok:true,businessDate:f.businessDate,results,syncedCount:economic?0:results.length,reviewRequiredCount:economic?results.length:0,failedCount:0};}
    else json={ok:true,canSync:true,dailySyncItems:plans,languageMissingItems:[]};
   }
   await route.fulfill({json});
  });page.on('dialog',d=>d.accept());
  const waitName=()=>page.waitForResponse(r=>r.url().includes('/api/inventory/snapshot/name-sync')&&r.request().method()==='GET');let loaded=waitName();await page.goto(base+'/inventory/snapshots');await loaded;await page.waitForTimeout(100);
  const banner=page.getByTestId('snapshot-name-sync-banner');assert.equal(await banner.count(),0);assert.equal(writes.length,0);assert.equal(f.root.purchase_supplier_partner_id,7);assert.equal(f.master.quantity,4);
  f.master.item_name='화분 새 표시명';f.master.item_name_vi='Chậu trang trí mới';loaded=waitName();await page.reload();await loaded;await banner.waitFor();await banner.getByRole('button').first().click();const card=page.getByTestId('snapshot-name-sync-item-622');await card.waitFor();assert.doesNotMatch(await card.innerText(),/거래처 연결|Liên kết nhà cung cấp/);await card.getByRole('button').click();await banner.waitFor({state:'hidden'});
  assert.equal(f.root.purchase_supplier_partner_id,7);assert.equal(f.root.new_purchase_price,300000);assert.equal(f.root.new_supplier,'Shopee');assert.equal(writes.length,1);assert.equal(writes[0].money,false);assert.equal('purchase_supplier_partner_id' in writes[0].payload,false);
  f.logs.push({...f.photo,id:13629,source:'edit_form',created_at:f.businessDate+'T04:00:00Z',new_supplier:'Other Shop',purchase_supplier_partner_id:27,new_purchase_price:350000},{...f.photo,id:13630,created_at:f.businessDate+'T04:01:00Z'});economic=true;loaded=waitName();await page.reload();await loaded;await banner.waitFor();await banner.getByRole('button').first().click();await card.waitFor();assert.match(await card.innerText(),/Other Shop/);assert.match(await card.innerText(),/Shopee/);await card.getByRole('button').click();const details=page.getByTestId('inventory-daily-sync-actions');await details.waitFor();assert.equal(await page.getByTestId('inventory-daily-sync-results').count(),0);assert.equal(await details.getByRole('link').getAttribute('href'),'/admin/ledger/entries?month='+f.businessDate.slice(0,7)+'&inventoryLogId=13626&sourceKey=inventory-log%3A13626');assert.match(await details.getByRole('link').getAttribute('title'),/#13626/);assert.equal(f.root.purchase_supplier_partner_id,27);assert.equal(f.master.quantity,4);assert.equal(requests.filter(r=>r.method==='POST').length,2);
  console.log('PASS #622 no false banner; display sync preserves partner; real edit + photo retains Ledger review',lang,mobile?'mobile':'desktop');await context.close();
 }}finally{await browser.close();}
});
