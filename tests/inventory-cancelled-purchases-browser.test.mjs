import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {analyzeDailyEffectivePurchases} from '../lib/inventory/daily-effective-purchases.ts';
const require=createRequire(import.meta.url);
// All API requests are intercepted. No operational database access.
test('completed cancellation history: KO/VI desktop/mobile, links, missing evidence and empty dates',{skip:!process.env.PLAYWRIGHT_MODULE_PATH||!process.env.QA_UI_BASE_URL},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH);
 const browser=await chromium.launch({headless:true,executablePath:process.env.QA_BROWSER_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{for(const lang of ['ko','vi'])for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:360,height:800}:{width:1280,height:900}});
  const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[],reads=[],writes=[];
  page.on('pageerror',e=>errors.push(e.message));
  const user={id:1,name:'QA',role:'owner',language:lang};await page.addInitScript(u=>localStorage.setItem('baba_user',JSON.stringify(u)),user);
  const roots=[{id:12972,item_id:1,item_name:'슈웹스 진저에일 320ml',item_name_vi:'Schweppes gừng 320ml',unit:'Hộp'},{id:12971,item_id:2,item_name:'슈웹스 토닉워터 320ml',item_name_vi:'Schweppes tonic 320ml',unit:'Lon'}].map(r=>({...r,reason:'purchase',change_quantity:24,new_purchase_price:10000,business_date:'2026-10-11',created_at:'2026-10-11T03:00:00Z'}));
  const corrections=roots.map((r,i)=>({...r,id:i?13000:12998,change_quantity:-24,correction_of_inventory_log_id:r.id}));
  const analysis=analyzeDailyEffectivePurchases(roots,corrections);assert.deepEqual(analysis.purchases,[]);
  const completed=analysis.diagnostics.map(r=>({...r,projectionStatusUnavailable:false,projectionStatuses:r.logIds.map(id=>({inventory_log_id:id,status:'synced',code:id===r.rootLogId?'PURCHASE_CANCELLED':'REBOOKED'}))}));
  let diagnostics=completed;
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin!==new URL(process.env.QA_UI_BASE_URL).origin)return route.abort();
   if(!url.pathname.startsWith('/api/'))return route.continue();
   reads.push(url.pathname);if(req.method()!=='GET')writes.push(url.pathname);let json={ok:true,data:[],items:[]};
   if(url.pathname==='/api/session')json={authenticated:true,user};
   else if(url.pathname==='/api/inventory/snapshot/list')json={ok:true,batches:[{id:11,snapshot_date:'2026-10-11'}],currentBusinessDate:'2026-10-20',purchaseDateMap:{'2026-10-11':true}};
   else if(url.pathname==='/api/inventory/snapshot/name-sync')json={ok:true,canSync:true,dailySyncItems:[],languageMissingItems:[]};
   else if(url.pathname==='/api/inventory/logs')json={ok:true,data:[],purchaseDiagnostics:url.searchParams.get('businessDate')==='2026-10-11'?diagnostics:[]};
   else if(/^\/api\/inventory\/items\/\d+\/logs$/.test(url.pathname))json={ok:true,data:[...roots,...corrections].filter(r=>r.item_id===Number(url.pathname.split('/')[4]))};
   await route.fulfill({json});
  });
  const select=async()=>{await page.goto(process.env.QA_UI_BASE_URL+'/inventory/snapshots');await page.getByRole('button',{name:'11',exact:true}).waitFor();assert.equal(await page.getByTestId('snapshot-cancelled-purchases').count(),0);await page.getByRole('button',{name:'11',exact:true}).click();};
  await select();const banner=page.getByTestId('snapshot-cancelled-purchases');await banner.waitFor();const header=banner.getByRole('button').first();
  assert.equal(await header.getAttribute('aria-expanded'),'false');assert.match(await header.innerText(),lang==='ko'?/취소된 입고 이력 2건/:/Lịch sử nhập đã hủy: 2 mục/);
  const height=(await banner.boundingBox()).height;assert.ok(height>=50&&height<=60,'height '+height);
  assert.equal(await banner.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(249, 250, 251)');
  assert.equal(await banner.evaluate(el=>getComputedStyle(el).borderRadius),'14px');
  await header.focus();await page.keyboard.press('Enter');assert.equal(await header.getAttribute('aria-expanded'),'true');
  for(const [i,r]of roots.entries()){const row=page.getByTestId('snapshot-cancelled-purchase-'+r.id);assert.ok((await row.innerText()).includes('#'+r.id+' → #'+corrections[i].id));assert.ok((await row.innerText()).includes(lang==='ko'?r.item_name:r.item_name_vi));assert.equal(await row.evaluate(el=>el.scrollWidth<=el.clientWidth),true);}
  assert.equal(await banner.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  assert.doesNotMatch(await banner.innerText(),/PURCHASE_CANCELLED|REBOOKED|0Hộp|0Lon/);
  await mkdir('.qa-review/cancelled-purchases',{recursive:true});await banner.screenshot({path:'.qa-review/cancelled-purchases/'+lang+'-'+(mobile?'mobile':'desktop')+'.png'});
  for(const r of roots){await page.getByTestId('snapshot-cancelled-purchase-'+r.id).click();const close=page.getByRole('button',{name:lang==='ko'?'닫기':'Đóng',exact:true}).last();await close.waitFor();assert.ok(reads.includes('/api/inventory/items/'+r.item_id+'/logs'));await close.click();}
  await header.click();assert.equal(await header.getAttribute('aria-expanded'),'false');await header.click();
  await page.getByRole('button',{name:'20',exact:true}).click();await banner.waitFor({state:'detached'});await page.getByRole('button',{name:'11',exact:true}).click();await banner.waitFor();assert.equal(await header.getAttribute('aria-expanded'),'false');
  const variants=[{projectionStatuses:[]},{projectionStatusUnavailable:true},{projectionStatuses:completed[0].projectionStatuses.slice(1)},{projectionStatuses:completed[0].projectionStatuses.slice(0,1)},...['pending','review_required','failed'].map(status=>({projectionStatuses:completed[0].projectionStatuses.map(s=>({...s,status}))})),{projectionStatuses:completed[0].projectionStatuses.map(s=>({...s,code:'UNKNOWN'}))},{code:'invalid_correction_family'},{code:'linked_correction'},{rootLogId:null},{logIds:[12972]}];
  diagnostics=[...completed,...variants.map((v,i)=>{const id=90000+i;return{...completed[0],...v,logId:id,rootLogId:v.rootLogId===null?null:id,log:{...roots[0],id,item_name:'확인 필요 '+i,item_name_vi:'Cần kiểm tra '+i},logIds:(v.logIds||completed[0].logIds).map(n=>n===12972?id:n),projectionStatuses:(v.projectionStatuses||completed[0].projectionStatuses).map(s=>({...s,inventory_log_id:s.inventory_log_id===12972?id:s.inventory_log_id}))};})];
  await select();await banner.waitFor();assert.match(await header.innerText(),lang==='ko'?/2건/:/2 mục/);
  const review=page.getByRole('region',{name:lang==='ko'?'입고 기록 확인':'Kiểm tra nhật ký nhập',exact:true});assert.equal(await review.locator('article').count(),variants.length);assert.equal(await review.getByRole('button').count(),variants.length);
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  console.log('PASS height',height,'IDs, original history, empty date, mixed evidence, keyboard, reset, no writes',lang,mobile?'mobile':'desktop');await context.close();
 }}finally{await browser.close();}
});
