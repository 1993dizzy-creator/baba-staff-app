import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {inventoryBrowserFixture} from './helpers/inventory-keg-browser-fixture.mjs';
import {setupKegSafety,seedKegSafety,kegSafetyApi,kegState} from './helpers/keg-safety-fixture.mjs';
import {inventoryText} from '../lib/text/inventory.ts';
import {commonText} from '../lib/text/common.ts';
import {kegSafetyError,kegSafetyText} from '../lib/inventory/keg-safety.ts';
const require=createRequire(import.meta.url),skip=!process.env.PLAYWRIGHT_MODULE_PATH||!process.env.QA_UI_BASE_URL;
const launch=()=>require(process.env.PLAYWRIGHT_MODULE_PATH).chromium.launch({headless:true,executablePath:process.env.QA_BROWSER_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const base=()=>process.env.QA_UI_BASE_URL;
const attachUser=async(context,lang)=>context.addInitScript(u=>localStorage.setItem('baba_user',JSON.stringify(u)),{id:1,username:'alice',name:'Alice',role:'owner',part:'bar',language:lang});
const normalized=body=>body.split('\n').filter(Boolean).map(line=>{const r=JSON.parse(line);if(r.type==='complete')delete r.timing;return JSON.stringify(r);}).join('\n');
const stats=values=>{const a=[...values].sort((x,y)=>x-y);return{median:a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2,p95:a[Math.ceil(a.length*0.95)-1]};};

test('P0 /inventory warm before/after: 10 PC + 10 mobile runs, real GET modules on local read fixtures',{skip:skip||!process.env.KEG_P0_BEFORE_PATH},async()=>{
 const browser=await launch(),report=[];await mkdir('.qa-review/keg-p0/browser',{recursive:true});
 try{for(const mobile of[false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});await attachUser(context,'ko');
  await context.addInitScript(()=>{
   window.__inventoryFirstPaintMs=null;let scheduled=false;
   const observer=new MutationObserver(()=>{if(scheduled)return;const found=[...document.querySelectorAll('span')].some(el=>el.textContent==='[L3] L3');if(found){scheduled=true;observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__inventoryFirstPaintMs=performance.now();}));}});
   observer.observe(document,{childList:true,subtree:true});
  });
  const page=await context.newPage(),f=inventoryBrowserFixture();let requests=[],bytes=0,stableBytes=0,urls=[],allRequests=[],pendingApi=0,lastApi=0;
  await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==new URL(base()).origin)return route.abort();allRequests.push(u.pathname);if(!u.pathname.startsWith('/api/'))return route.continue();assert.equal(req.method(),'GET');assert.ok(!u.pathname.includes('keg-sessions'));requests.push(u.pathname+u.search);pendingApi++;lastApi=Date.now();const response=await f.get(req.url()),body=await response.text();bytes+=Buffer.byteLength(body);stableBytes+=Buffer.byteLength(response.headers.get('content-type')?.includes('ndjson')?normalized(body):body);urls.push(u.pathname);await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body});pendingApi--;lastApi=Date.now();});
  const samples={before:[],after:[]};for(let round=-1;round<10;round++)for(const version of(round%2===0?['after','before']:['before','after'])){
   requests=[];bytes=0;stableBytes=0;urls=[];allRequests=[];f.db.reads.length=0;
   await page.goto(base()+(version==='before'?process.env.KEG_P0_BEFORE_PATH:'/inventory'));await page.getByText('[L3] L3',{exact:true}).waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const firstDisplayMs=await page.evaluate(()=>window.__inventoryFirstPaintMs);assert.equal(typeof firstDisplayMs,'number');const deadline=Date.now()+5000;while((pendingApi>0||Date.now()-lastApi<250)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.equal(pendingApi,0,'All inventory GETs completed');
   const sample={firstDisplayMs,apiRequests:requests.length,dbReads:f.db.reads.length,posReads:f.db.reads.filter(r=>r.table?.startsWith('pos_')).length,bytes,stableBytes,urls:[...requests].sort(),assetRequests:allRequests.length};if(round>=0)samples[version].push(sample);
  }
  assert.equal(samples.before.length,10);assert.equal(samples.after.length,10);
  for(const r of samples.after){assert.deepEqual(r.urls,samples.before[0].urls);assert.equal(r.apiRequests,samples.before[0].apiRequests);assert.equal(r.dbReads,samples.before[0].dbReads);assert.equal(r.posReads,samples.before[0].posReads);assert.equal(r.stableBytes,samples.before[0].stableBytes);}
  const summarize=rows=>({firstDisplayMs:stats(rows.map(r=>r.firstDisplayMs)),apiRequests:stats(rows.map(r=>r.apiRequests)),dbReads:stats(rows.map(r=>r.dbReads)),posReads:stats(rows.map(r=>r.posReads)),responseBytes:stats(rows.map(r=>r.bytes)),payloadBytesExcludingTiming:stats(rows.map(r=>r.stableBytes)),assetRequests:stats(rows.map(r=>r.assetRequests))});
  const result={viewport:mobile?'mobile':'PC',before:summarize(samples.before),after:summarize(samples.after),samples};report.push(result);console.log(JSON.stringify({viewport:result.viewport,before:result.before,after:result.after}));await context.close();
 }}finally{await browser.close();}
 await writeFile('.qa-review/keg-p0/performance.json',JSON.stringify(report,null,2));
});

test('P0 KO/VI PC/mobile: explicit previews, no typing queries, drift block, short/zero confirmation, retry and double-click',{skip},async()=>{
 const browser=await launch(),db=new PGlite();await setupKegSafety(db);await mkdir('.qa-review/keg-p0/browser',{recursive:true});
 try{for(const lang of['ko','vi'])for(const mobile of[false,true]){
  await seedKegSafety(db,{previousId:138,activeId:139,date:'2026-10-11'});
  const context=await browser.newContext({viewport:mobile?{width:360,height:800}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,timezoneId:lang==='ko'?'Asia/Seoul':'Asia/Ho_Chi_Minh'});await attachUser(context,lang);const page=await context.newPage();page.setDefaultTimeout(10000);
  const f=inventoryBrowserFixture(),s=kegSafetyApi(db),mutations=[],errors=[];let dropCommitResponse=false,delayPreview=false;page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==new URL(base()).origin)return route.abort();if(!u.pathname.startsWith('/api/'))return route.continue();
   if(u.pathname.includes('/keg-sessions')){
    const body=req.postDataJSON();mutations.push(body);if(delayPreview&&body.dryRun)await new Promise(r=>setTimeout(r,150));const request=new Request(req.url(),{method:req.method(),headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const response=u.pathname.endsWith('/replace')?await s.replace.POST(request):await s.session.PATCH(request,{params:Promise.resolve({id:u.pathname.split('/').at(-1)})});
    if(response.ok&&!body.dryRun){f.items[0].quantity=Number((await db.query('select quantity from inventory where id=3')).rows[0].quantity);if(dropCommitResponse){dropCommitResponse=false;return route.abort();}}
    try{await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});}catch{/* Deliberately aborted preview. */}return;
   }
   const response=await f.get(req.url());await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
  });
  const t=inventoryText[lang],c=commonText[lang],modal=page.getByTestId('keg-safety-modal');
  await page.goto(base()+'/inventory?itemId=3');const panel=page.locator('[role=button][tabindex="0"]').first();await panel.waitFor();assert.equal(mutations.length,0);await panel.click();await modal.waitFor();
  const time=modal.locator('input[type=datetime-local]'),reason=modal.locator('textarea'),save=modal.locator('button[type=submit]'),preview=modal.getByRole('button',{name:t.kegPreview,exact:true});
  await time.fill('2026-10-11T17:30');await reason.fill('Verified boundary');assert.equal(mutations.length,0);assert.equal(await save.isDisabled(),true);await preview.click();await page.getByTestId('keg-time-preview').waitFor();assert.equal(mutations.length,1);assert.ok((await modal.innerText()).includes('3.03L'));assert.ok((await modal.innerText()).includes('17:30:00 (UTC+07)'));assert.equal(await save.isDisabled(),false);
  // Every keystroke invalidates the preview, without any automatic DB request.
  await time.fill('2026-10-11T17:31');assert.equal(mutations.length,1);assert.equal(await save.isDisabled(),true);await preview.click();await page.getByTestId('keg-time-preview').waitFor();
  await modal.screenshot({path:'.qa-review/keg-p0/browser/'+lang+'-'+(mobile?'mobile':'PC')+'-time.png'});
  const beforeSave=mutations.length;await save.evaluate(b=>{b.click();b.click();});await modal.waitFor({state:'hidden'});assert.equal(mutations.length,beforeSave+1);assert.equal((await kegState(db)).audit.length,1);
  // Pre-existing snapshot drift cannot be overwritten even after explicit preview.
  await seedKegSafety(db,{previousId:138,activeId:139,date:'2026-10-11',drift:true});await page.reload();await panel.waitFor();await panel.click();await reason.fill('Review');await preview.click();await modal.getByRole('alert').waitFor();assert.equal(await save.isDisabled(),true);assert.ok((await modal.innerText()).includes(kegSafetyError('KEG_STORED_SNAPSHOT_MISMATCH',lang==='vi')));await modal.getByRole('button',{name:c.cancel,exact:true}).click();
  // A preview arriving after input edits is not accepted; this starts no follow-up request.
  await seedKegSafety(db,{previousId:138,activeId:139,date:'2026-10-11'});await page.reload();await panel.waitFor();await panel.click();delayPreview=true;await preview.click();await time.fill('2026-10-11T17:32');await page.waitForTimeout(200);assert.equal(await save.isDisabled(),true);delayPreview=false;await modal.getByRole('button',{name:c.cancel,exact:true}).click();
  // L3 0-minute replacement requires both explicit confirmation and a reason.
  await page.getByRole('button',{name:t.kegReplaceShort,exact:true}).first().click();await time.fill('2026-10-11T17:00');await preview.click();await modal.getByRole('checkbox').waitFor();assert.equal(await save.isDisabled(),true);await reason.fill('Real equipment replacement');await modal.getByRole('checkbox').check();assert.equal(await save.isDisabled(),false);
  await modal.screenshot({path:'.qa-review/keg-p0/browser/'+lang+'-'+(mobile?'mobile':'PC')+'-short.png'});
  assert.equal(await modal.evaluate(el=>{const r=el.firstElementChild.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}),true);
  // Simulate a committed RPC whose HTTP response was lost. Retry preserves UUID/payload.
  dropCommitResponse=true;await save.click();await modal.getByRole('alert').waitFor();const first=mutations.at(-1);await save.click();await modal.waitFor({state:'hidden'});assert.deepEqual(mutations.at(-1),first);assert.equal((await kegState(db)).inventory[0].quantity,9);assert.equal((await kegState(db)).audit.length,1);assert.deepEqual(errors,[]);
  // No predecessor: 20L capacity is not a closed-session loss in either language/viewport.
  await seedKegSafety(db,{previousId:138,activeId:139,date:'2026-10-11'});await db.exec("delete from inventory_keg_sessions where status='closed';update inventory_keg_sessions set capacity_quantity=20000;update inventory set package_content_quantity=20000");f.items[0].quantity=10;f.items[0].package_content_quantity=20000;
  await page.reload();await panel.waitFor();await panel.click();await time.fill('2026-10-11T17:30');await reason.fill('First session start correction');await preview.click();const firstPreview=page.getByTestId('keg-time-preview');await firstPreview.waitFor();const firstText=await firstPreview.innerText();assert.ok(firstText.includes(kegSafetyText[lang].noPrevious));assert.ok(!firstText.includes(kegSafetyText[lang].unsold));assert.ok(!/\b20(?:[.,]0+)?\s*L\b/.test(firstText));assert.equal(await save.isDisabled(),false);
  await modal.screenshot({path:'.qa-review/keg-p0/browser/'+lang+'-'+(mobile?'mobile':'PC')+'-first-session.png'});await save.click();await modal.waitFor({state:'hidden'});const firstState=await kegState(db);assert.equal(firstState.sessions.length,1);assert.equal(firstState.sessions[0].loss_quantity,null);assert.equal(firstState.inventory[0].quantity,10);assert.equal(firstState.audit[0].before_state.preview.lossMl,null);assert.deepEqual(errors,[]);
  console.log('PASS P0 preview/no typing query/drift/short confirmation/double click/lost response retry',lang,mobile?'mobile':'PC');await context.close();
 }}finally{await db.close();await browser.close();}
});
