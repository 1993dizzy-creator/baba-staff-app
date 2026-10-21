import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {inventoryBrowserFixture} from './helpers/inventory-keg-browser-fixture.mjs';
import {setupKegSafety,seedKegSafety,kegSafetyApi,kegState} from './helpers/keg-safety-fixture.mjs';
import {inventoryText} from '../lib/text/inventory.ts';
import {kegSafetyError} from '../lib/inventory/keg-safety.ts';
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

test('P0 KO/VI PC/mobile: one-click dryRun+save, split date/time, no typing queries, drift block, short/zero confirmation, retry and double-click',{skip},async()=>{
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
  const t=inventoryText[lang],modal=page.getByTestId('keg-safety-modal');
  await page.goto(base()+'/inventory?itemId=3');const panel=page.locator('[role=button][tabindex="0"]').first();await panel.waitFor();assert.equal(mutations.length,0);await panel.click();await modal.waitFor();
  const date=modal.getByTestId('keg-date-input'),clock=modal.getByTestId('keg-time-input'),reason=modal.locator('textarea'),save=modal.locator('button[type=submit]'),label={ko:{cancel:'취소',replace:'🍺 교체'},vi:{cancel:'Hủy',replace:'🍺 Thay keg'}}[lang],cancel=modal.getByRole('button',{name:label.cancel,exact:true});
  const setTime=async(d,hm)=>{await date.fill(d);await clock.fill(hm);};
  // No reason box, no preview button: two equal-width action buttons with touch-sized height.
  assert.equal(await reason.count(),0);assert.equal(await modal.locator('input[type=datetime-local]').count(),0);assert.equal(await modal.locator('button').count(),2);
  assert.equal(await save.innerText(),t.kegChangeTimeSubmit);
  const [cancelBox,saveBox]=[await cancel.boundingBox(),await save.boundingBox()];assert.ok(Math.abs(cancelBox.width-saveBox.width)<1);assert.equal(Math.round(cancelBox.height),46);assert.equal(Math.round(saveBox.height),46);assert.ok(Math.abs(cancelBox.y-saveBox.y)<1);assert.equal(Math.round(saveBox.x-(cancelBox.x+cancelBox.width)),8);assert.equal(await cancel.innerText(),label.cancel);assert.doesNotMatch(await cancel.innerText(),/❌/);
  // A design: gray cancel, green submit; 14px/700, 10px radius, no border.
  const assertButtonStyle=async(button,background,color)=>assert.deepEqual(await button.evaluate(el=>{const s=getComputedStyle(el);return[s.backgroundColor,s.color,s.fontSize,s.fontWeight,s.borderRadius,s.borderTopStyle];}),[background,color,'14px','700','10px','none']);
  await assertButtonStyle(cancel,'rgb(243, 244, 246)','rgb(55, 65, 81)');await assertButtonStyle(save,'rgb(5, 150, 105)','rgb(255, 255, 255)');
  // Typing never queries; one click runs dryRun, and a start-time edit that moves previous-session sales stops for review.
  await setTime('2026-10-11','17:30');assert.equal(mutations.length,0);await save.click();await page.getByTestId('keg-time-preview').waitFor();assert.equal(mutations.length,1);assert.equal(mutations[0].dryRun,true);assert.equal(mutations[0].startedLocalDateTime,'2026-10-11T17:30');assert.ok((await modal.innerText()).includes('3.03L'));assert.ok((await modal.innerText()).includes('17:30:00 (UTC+07)'));assert.ok((await modal.innerText()).includes(t.kegReviewTimeDelta));assert.equal(await save.isDisabled(),false);
  // Changing only the time invalidates the preview, without any automatic DB request.
  await clock.fill('17:31');assert.equal(mutations.length,1);assert.equal(await page.getByTestId('keg-time-preview').count(),0);await save.click();await page.getByTestId('keg-time-preview').waitFor();assert.equal(mutations.at(-1).startedLocalDateTime,'2026-10-11T17:31');
  await modal.screenshot({path:'.qa-review/keg-p0/browser/'+lang+'-'+(mobile?'mobile':'PC')+'-time.png'});
  const beforeSave=mutations.length;await save.evaluate(b=>{b.click();b.click();});await modal.waitFor({state:'hidden'});assert.equal(mutations.length,beforeSave+1);
  {const state=await kegState(db);assert.equal(state.audit.length,1);assert.match(state.audit[0].reason,/^케그 시작시각 정정 \(시스템 자동 기록\): .*17:00:00 \(UTC\+07\) → .*17:31:00 \(UTC\+07\)$/);}
  // Pre-existing snapshot drift cannot be overwritten; the one-click flow stops at the dryRun.
  await seedKegSafety(db,{previousId:138,activeId:139,date:'2026-10-11',drift:true});await page.reload();await panel.waitFor();await panel.click();let n=mutations.length;await save.click();await modal.getByRole('alert').waitFor();assert.equal(mutations.length,n+1);assert.equal(await save.isDisabled(),true);assert.ok((await modal.innerText()).includes(kegSafetyError('KEG_STORED_SNAPSHOT_MISMATCH',lang==='vi')));await cancel.click();
  // Inputs are locked while the dryRun is in flight; editing afterwards discards it and starts no follow-up request.
  await seedKegSafety(db,{previousId:138,activeId:139,date:'2026-10-11'});await page.reload();await panel.waitFor();await panel.click();await setTime('2026-10-11','17:30');delayPreview=true;await save.click();assert.equal(await date.isDisabled(),true);assert.equal(await clock.isDisabled(),true);assert.equal(await save.innerText(),t.kegCheckingSubmit);await page.getByTestId('keg-time-preview').waitFor();delayPreview=false;n=mutations.length;await clock.fill('17:32');await page.waitForTimeout(200);assert.equal(mutations.length,n);assert.equal(await page.getByTestId('keg-time-preview').count(),0);await cancel.click();
  // Future and incomplete date/time are blocked before any request.
  await page.getByRole('button',{name:t.kegReplaceShort,exact:true}).first().click();await modal.waitFor();assert.equal(await save.innerText(),t.kegReplaceSubmit);assert.equal(await save.innerText(),label.replace);await assertButtonStyle(save,'rgb(5, 150, 105)','rgb(255, 255, 255)');await assertButtonStyle(cancel,'rgb(243, 244, 246)','rgb(55, 65, 81)');n=mutations.length;
  await setTime('2099-01-01','10:00');await save.click();await page.waitForTimeout(100);assert.equal(await date.evaluate(el=>el.validity.rangeOverflow),true);assert.equal(mutations.length,n);
  await save.evaluate(b=>b.form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})));await modal.getByRole('alert').waitFor();assert.equal(mutations.length,n);assert.ok((await modal.innerText()).includes(kegSafetyError('KEG_FUTURE_TIME',lang==='vi')));
  await clock.fill('');await save.evaluate(b=>b.form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})));await modal.getByText(t.kegInvalidDateTime,{exact:true}).waitFor();assert.equal(mutations.length,n);
  // L3 0-minute replacement still requires both explicit confirmation and a staff reason.
  await setTime('2026-10-11','17:00');await save.click();await modal.getByRole('checkbox').waitFor();assert.equal(mutations.length,n+1);assert.equal(mutations.at(-1).dryRun,true);assert.equal(await save.isDisabled(),true);await reason.fill('Real equipment replacement');assert.equal(await save.isDisabled(),true);await modal.getByRole('checkbox').check();assert.equal(await save.isDisabled(),false);
  await modal.screenshot({path:'.qa-review/keg-p0/browser/'+lang+'-'+(mobile?'mobile':'PC')+'-short.png'});
  assert.equal(await modal.evaluate(el=>{const r=el.firstElementChild.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}),true);
  // Simulate a committed RPC whose HTTP response was lost. Retry reuses the kept preview: same UUID/payload, no new dryRun.
  dropCommitResponse=true;await save.click();await modal.getByRole('alert').waitFor();const first=mutations.at(-1);assert.equal(first.reason,'Real equipment replacement');assert.equal(first.confirmed,true);n=mutations.length;await save.click();await modal.waitFor({state:'hidden'});assert.equal(mutations.length,n+1);assert.deepEqual(mutations.at(-1),first);assert.equal((await kegState(db)).inventory[0].quantity,9);assert.equal((await kegState(db)).audit.length,1);assert.deepEqual(errors,[]);
  // Normal replacement: date and time edited independently, then a single (double-tapped) click runs dryRun and saves once.
  await seedKegSafety(db,{previousId:138,activeId:139,date:'2026-10-11'});f.items[0].quantity=10;await page.reload();await panel.waitFor();
  await page.getByRole('button',{name:t.kegReplaceShort,exact:true}).first().click();await modal.waitFor();await clock.fill('17:45');await date.fill('2026-10-11');n=mutations.length;
  await save.evaluate(b=>{b.click();b.click();});await modal.waitFor({state:'hidden'});assert.equal(mutations.length,n+2);
  {const [dry,commit]=mutations.slice(-2);assert.equal(dry.dryRun,true);assert.equal(dry.replacementLocalDateTime,'2026-10-11T17:45');assert.equal(commit.dryRun,undefined);assert.equal(commit.previewToken.length,64);assert.equal(commit.reason,'정상 케그 교체 (시스템 자동 기록)');assert.equal(commit.confirmed,false);
   const state=await kegState(db);assert.equal(state.inventory[0].quantity,9);assert.equal(state.audit.length,1);assert.equal(state.audit[0].reason,'정상 케그 교체 (시스템 자동 기록)');}
  // No predecessor: one click saves the first-session start time; 20L capacity is not a closed-session loss.
  await seedKegSafety(db,{previousId:138,activeId:139,date:'2026-10-11'});await db.exec("delete from inventory_keg_sessions where status='closed';update inventory_keg_sessions set capacity_quantity=20000;update inventory set package_content_quantity=20000");f.items[0].quantity=10;f.items[0].package_content_quantity=20000;
  await page.reload();await panel.waitFor();await panel.click();await setTime('2026-10-11','17:30');await modal.screenshot({path:'.qa-review/keg-p0/browser/'+lang+'-'+(mobile?'mobile':'PC')+'-first-session.png'});n=mutations.length;await save.click();await modal.waitFor({state:'hidden'});assert.equal(mutations.length,n+2);
  const firstState=await kegState(db);assert.equal(firstState.sessions.length,1);assert.equal(firstState.sessions[0].loss_quantity,null);assert.equal(firstState.inventory[0].quantity,10);assert.equal(firstState.audit[0].before_state.preview.lossMl,null);assert.equal(firstState.audit[0].before_state.preview.previousSessionId,null);assert.deepEqual(errors,[]);
  console.log('PASS P0 one-click/date+time/no typing query/drift/short confirmation/double click/lost response retry',lang,mobile?'mobile':'PC');await context.close();
 }}finally{await db.close();await browser.close();}
});
