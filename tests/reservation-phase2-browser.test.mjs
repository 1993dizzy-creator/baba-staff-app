// Isolated Next build of the real reservation page/routes + real signed sessions + PGlite.
// No repository .env is loaded. Test binaries: .local/browser-qa/node_modules/playwright.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fixture, create, ingest, rpc, json, queryRows } from './helpers/reservation-hardening-fixture.mjs';
import { getBusinessDate } from '../lib/common/business-time.ts';
import { createServerSessionToken } from '../lib/auth/session-token.ts';
import { reservationText } from '../lib/text/reservations.ts';
import { reservationTables } from '../lib/reservations/policy.ts';

test('reservation browser → signed API → isolated DB: KO/VI, responsive UI, create/edit/confirm, conflict and Inbox', {timeout:180000}, async t=>{
  const root=process.cwd();const work=path.resolve('.local/reservation-phase2');const preview=path.join(work,'preview');
  const put=(file,text)=>{const target=path.join(preview,file);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,text);};
  mkdirSync(path.join(work,'tmp'),{recursive:true});
  put('package.json',JSON.stringify({name:'baba-reservation-offline-check',private:true,version:'1.0.0'}));
  put('tsconfig.json',JSON.stringify({compilerOptions:{target:'ES2022',lib:['dom','esnext'],strict:true,noEmit:true,skipLibCheck:true,
    esModuleInterop:true,module:'esnext',moduleResolution:'bundler',jsx:'react-jsx',resolveJsonModule:true,allowImportingTsExtensions:true,
    baseUrl:root,paths:{'@/*':['./*']},plugins:[{name:'next'}]},include:['**/*.ts','**/*.tsx','.next/types/**/*.ts'],exclude:['node_modules']}));
  put('next.config.mjs','export default { devIndicators:false, experimental:{externalDir:true} };');
  put('postcss.config.mjs',readFileSync('postcss.config.mjs','utf8'));
  put('app/layout.tsx',`import {LanguageProvider} from '@/lib/language-context';import '@/app/globals.css';
    export default function Layout({children}:{children:React.ReactNode}){return <html><body><LanguageProvider>{children}</LanguageProvider></body></html>}`);
  put('app/tables/layout.tsx',`export {default} from '@/app/(protected)/tables/layout';`);
  put('app/tables/reservations/page.tsx',`export {default} from '@/app/(protected)/tables/reservations/page';`);
  put('app/login/page.tsx','export default function Login(){return <main>Offline login boundary</main>}');
  for(const route of ['route.ts','[id]/route.ts','[id]/confirm/route.ts','[id]/transition/route.ts','[id]/tables/route.ts',
    'inbox/route.ts','inbox/[id]/route.ts','inbox/[id]/dismiss/route.ts','inbox/[id]/reprocess/route.ts']) {
    // Copy only tiny route adapters. Their imports resolve to actual repository server code.
    put('app/api/tables/reservations/'+route,readFileSync('app/api/tables/reservations/'+route,'utf8'));
  }
  if(!existsSync(path.join(preview,'node_modules'))) symlinkSync(path.join(root,'node_modules'),path.join(preview,'node_modules'),'junction');
  const db=await fixture();const today=getBusinessDate();let queue=Promise.resolve();const rpcLog=[];
  await db.exec("alter table public.users add column username text, add column name text, add column full_name text, add column part text, add column position text;");
  await db.exec("update public.users set username='synthetic',name='Synthetic employee'");
  const sample=await create(db,{customerName:'SYNTHETIC PRIVATE CUSTOMER',customerContact:'SYNTHETIC PRIVATE CONTACT',
    note:'SYNTHETIC PRIVATE NOTE',reservedAt:`${today}T19:00:00+07:00`});
  const confirmed=await create(db,{customerName:'Khách thử nghiệm tên dài để kiểm tra khả năng xuống dòng trong giao diện đặt bàn',reservedAt:`${today}T20:00:00+07:00`});
  await rpc(db,'reservation_transition_v1',[4,confirmed.id,1,'confirmed',null]);
  const inbox=await ingest(db,{message_text:'Tin nhắn thử nghiệm đặt bàn. Không sử dụng dữ liệu khách hàng thật.'});
  const quarantined=await ingest(db,{status:'quarantined',quarantine_reason:'unknown_event_shape',message_id:null,chat_id:null,
    message_text:null,payload_sha256:'b'.repeat(64),raw_payload:{unknownShape:'SYNTHETIC QUARANTINED ORIGINAL'}});
  const transport=http.createServer((req,res)=>{
    queue=queue.then(async()=>{
      res.setHeader('Content-Type','application/json');
      try {
        const url=new URL(req.url,'http://127.0.0.1');
        if(url.pathname==='/rest/v1/users') {
          const id=Number(url.searchParams.get('id')?.replace('eq.',''));
          const rows=await queryRows(db,'select * from public.users where id=$1',[id]);
          res.end(JSON.stringify(rows));return;
        }
        const fn=url.pathname.replace('/rest/v1/rpc/','');
        if(!/^reservation_[a-z_]+_v1$/.test(fn)) {res.statusCode=404;res.end('{}');return;}
        let text='';for await(const chunk of req)text+=chunk;
        const args=JSON.parse(text);const entries=Object.entries(args);
        const sql=`select public.${fn}(${entries.map(([key],i)=>`${key} => $${i+1}${['p_input','p_entry'].includes(key)?'::jsonb':''}`).join(',')}) data`;
        const result=await db.query(sql,entries.map(([key,value])=>['p_input','p_entry'].includes(key)?JSON.stringify(value):value));
        rpcLog.push(fn);res.end(JSON.stringify(result.rows[0].data));
      } catch(e) {res.statusCode=400;res.end(JSON.stringify({code:e.code??'XX000',message:'offline fixture error'}));}
    }).catch(()=>{res.statusCode=500;res.end('{}');});
  });
  await new Promise(resolve=>transport.listen(0,'127.0.0.1',resolve));const transportPort=transport.address().port;
  const secret='offline-reservation-browser-session-secret-32';const oldSecret=process.env.BABA_SESSION_SECRET;
  const oldTemp=process.env.TEMP,oldTmp=process.env.TMP;
  process.env.BABA_SESSION_SECRET=secret;
  process.env.TEMP=path.join(work,'tmp');process.env.TMP=path.join(work,'tmp');
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,ComSpec:process.env.ComSpec,
    TEMP:path.join(work,'tmp'),TMP:path.join(work,'tmp'),NEXT_TELEMETRY_DISABLED:'1',
    NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${transportPort}`,SUPABASE_SERVICE_ROLE_KEY:'offline-synthetic-key',
    NEXT_PUBLIC_SUPABASE_ANON_KEY:'offline-synthetic-key',BABA_SESSION_SECRET:secret,ZALO_BOT_WEBHOOK_POC_ALLOWED_GROUP_IDS:'offline-group'};
  const next=path.resolve('node_modules/next/dist/bin/next');const buildLog=path.join(work,'preview-build.log');
  let server,browser;const contexts=[];let descriptor;
  try {
    descriptor=openSync(buildLog,'w');
    const build=spawnSync(process.execPath,[next,'build','--webpack'],{cwd:preview,env,windowsHide:true,stdio:['ignore',descriptor,descriptor],timeout:120000});
    closeSync(descriptor);descriptor=undefined;
    assert.equal(build.status,0,readFileSync(buildLog,'utf8').slice(-6000));
    t.diagnostic('isolated reservation Next production build PASS');
    const probe=http.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
    const serverLog=openSync(path.join(work,'preview-server.log'),'w');
    server=spawn(process.execPath,[next,'start','--hostname','127.0.0.1','--port',String(port)],{cwd:preview,env,windowsHide:true,stdio:['ignore',serverLog,serverLog]});
    closeSync(serverLog);
    const origin=`http://127.0.0.1:${port}`;
    for(let n=0;n<100;n++) {try{if((await fetch(origin+'/login')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
    const {chromium}=await import(pathToFileURL(path.resolve('.local/browser-qa/node_modules/playwright/index.mjs')).href);
    browser=await chromium.launch({channel:'chrome',headless:true,env:{...env}});
    const errors=[];
    async function session(lang='ko',role='leader',width=390) {
      const context=await browser.newContext({viewport:{width,height:900},locale:lang==='ko'?'ko-KR':'vi-VN'});contexts.push(context);
      await context.addCookies([{name:'baba_session',value:createServerSessionToken(role==='staff'?5:4),url:origin}]);
      await context.addInitScript(({lang,role})=>localStorage.setItem('baba_user',JSON.stringify({language:lang,role})),{lang,role});
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',route=>{
        const u=new URL(route.request().url());
        if(u.hostname!=='127.0.0.1' && u.protocol!=='data:') return route.abort();return route.continue();
      });
      await page.goto(origin+'/tables/reservations');await page.getByRole('heading',{name:reservationText[lang].title,exact:true}).waitFor();
      await page.getByRole('button',{name:reservationText[lang].refresh,exact:true}).waitFor();
      await page.waitForFunction(()=>!document.querySelector('[role="status"]')?.textContent?.includes('…'));
      return page;
    }
    async function fit(page,label) {
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label+' page overflow');
      assert.ok(await page.evaluate(()=>[...document.querySelectorAll('dialog[open]')].every(d=>d.scrollWidth<=d.clientWidth+1)),label+' modal overflow');
    }
    await t.test('KO/VI at 320/390/430/1280: actual BABA navigation, loading completion, calendar and mobile/desktop detail sheets',async()=>{
      for(const lang of ['ko','vi'])for(const width of [320,390,430,1280]) {
        const page=await session(lang,'leader',width);const copy=reservationText[lang];
        await page.getByRole('button',{name:copy.create,exact:true}).click();
        const dialog=page.getByRole('dialog');await dialog.getByRole('textbox',{name:copy.name,exact:true}).waitFor();
        await fit(page,lang+width);await page.screenshot({path:path.join(work,`${lang}-${width}-form.png`),fullPage:true});
        const box=await dialog.boundingBox();if(width<768)assert.ok(box.y+box.height>895);else assert.ok(box.x>0 && box.y>0);
        await dialog.getByRole('button',{name:copy.close,exact:true}).click();
        await page.getByRole('button',{name:copy.schedule,exact:true}).click();
        await page.locator('button[aria-label^="'+today.slice(0,7)+'"]').first().waitFor();
        await fit(page,lang+width);await page.screenshot({path:path.join(work,`${lang}-${width}-calendar.png`),fullPage:true});
        await page.close();
      }
    });
    await t.test('manual create + table assignment, edit without overwriting masked contact, confirmation and actual partial assignment conflict',async()=>{
      const page=await session();const copy=reservationText.ko;
      async function register(name) {
        await page.getByRole('button',{name:copy.create,exact:true}).click();const d=page.getByRole('dialog');
        await d.getByRole('textbox',{name:copy.name,exact:true}).fill(name);
        await d.getByRole('textbox',{name:copy.contact,exact:true}).fill('SYNTHETIC-KEEP-CONTACT');
        await d.getByLabel(copy.table,{exact:true}).selectOption(reservationTables[0].id);
        await d.getByRole('button',{name:copy.save,exact:true}).click();
        await page.getByRole('dialog').getByText(name,{exact:true}).waitFor();
      }
      await register('Synthetic browser one');
      await page.getByRole('dialog').getByRole('button',{name:copy.edit,exact:true}).click();
      await page.getByRole('dialog').getByLabel(copy.party,{exact:true}).fill('7');
      await page.getByRole('dialog').getByRole('button',{name:copy.save,exact:true}).click();
      await page.getByRole('dialog').getByRole('button',{name:copy.confirm,exact:true}).click();
      await page.getByRole('dialog').getByText(copy.states.confirmed,{exact:true}).first().waitFor();
      const row=(await queryRows(db,"select customer_contact,party_size,status from reservation_private.reservations where customer_name='Synthetic browser one'"))[0];
      assert.deepEqual(row,{customer_contact:'SYNTHETIC-KEEP-CONTACT',party_size:7,status:'confirmed'});
      await page.getByRole('dialog').getByRole('button',{name:copy.close,exact:true}).click();
      await register('Synthetic browser conflict');
      await page.getByRole('dialog').getByText(copy.partial,{exact:true}).waitFor();
      assert.equal((await queryRows(db,"select count(*)::int n from reservation_private.reservations where customer_name='Synthetic browser conflict'"))[0].n,1);
      await page.screenshot({path:path.join(work,'ko-conflict.png'),fullPage:true});
      await page.getByRole('dialog').getByLabel(copy.table,{exact:true}).selectOption(reservationTables[1].id);
      await page.getByRole('dialog').getByRole('button',{name:copy.assign,exact:true}).click();
      await page.getByRole('dialog').getByText(copy.partial,{exact:true}).waitFor({state:'hidden'});
      assert.equal((await queryRows(db,"select count(*)::int n from reservation_private.reservation_table_links l join reservation_private.reservations r on r.id=l.reservation_id where r.customer_name='Synthetic browser conflict' and l.released_at is null"))[0].n,1);
      await page.close();
    });
    await t.test('actual stale version 409 shows fresh data and does not double-confirm',async()=>{
      const page=await session();const copy=reservationText.ko;
      await page.getByRole('button',{name:copy.detail+' #'+sample.id,exact:true}).click();
      await page.getByRole('dialog').getByRole('button',{name:copy.confirm,exact:true}).waitFor();
      await rpc(db,'reservation_update_v1',[4,sample.id,1,json({partySize:6})]);
      await page.getByRole('dialog').getByRole('button',{name:copy.confirm,exact:true}).click();
      await page.getByRole('dialog').getByText(copy.conflict,{exact:true}).waitFor();
      assert.equal((await queryRows(db,'select status from reservation_private.reservations where id=$1',[sample.id]))[0].status,'pending');
      await page.getByRole('dialog').getByRole('button',{name:copy.confirm,exact:true}).click();
      await page.getByRole('dialog').getByText(copy.states.confirmed,{exact:true}).first().waitFor();
      assert.equal((await queryRows(db,"select count(*)::int n from reservation_private.reservation_events where reservation_id=$1 and event_type='status_changed'",[sample.id]))[0].n,1);
      await page.close();
    });
    await t.test('Inbox original → candidate → linked reservation, with processing-history limitation visible',async()=>{
      const page=await session();const copy=reservationText.ko;
      await page.getByRole('button',{name:copy.inbox,exact:true}).click();
      await page.getByRole('button').filter({hasText:copy.inboxId+' #'+inbox.inboxId}).click();
      await page.getByRole('dialog').getByText(copy.inboxHistoryLimit,{exact:true}).waitFor();
      await page.getByRole('dialog').getByRole('button',{name:copy.candidate,exact:true}).click();
      await page.getByRole('dialog').getByRole('textbox',{name:copy.name,exact:true}).fill('Synthetic Inbox candidate');
      await page.getByRole('dialog').getByRole('button',{name:copy.save,exact:true}).click();
      await page.getByRole('dialog').getByText('Synthetic Inbox candidate',{exact:true}).waitFor();
      assert.equal((await queryRows(db,'select status from reservation_private.inbox where id=$1',[inbox.inboxId]))[0].status,'linked');
      await page.getByRole('dialog').getByRole('button',{name:copy.close,exact:true}).click();
      await page.locator('select').selectOption('quarantined');
      await page.getByRole('button').filter({hasText:copy.inboxId+' #'+quarantined.inboxId}).click();
      await page.getByRole('dialog').getByText(JSON.stringify({unknownShape:'SYNTHETIC QUARANTINED ORIGINAL'}),{exact:true}).waitFor();
      await page.getByRole('dialog').getByRole('button',{name:copy.reprocess,exact:true}).click();
      await page.getByRole('dialog').getByText(copy.inboxStates.quarantined,{exact:true}).waitFor();
      await page.getByRole('dialog').getByRole('button',{name:copy.dismiss,exact:true}).click();
      await page.getByRole('dialog').getByText(copy.inboxStates.dismissed,{exact:true}).waitFor();
      await page.close();
    });
    await t.test('loading, empty list, recoverable error and calendar/list filters render in KO and VI',async()=>{
      for(const lang of ['ko','vi']) {
        const page=await session(lang);const copy=reservationText[lang];
        const real=await page.request.get(origin+'/api/tables/reservations');const model=await real.json();
        const empty=async route=>{await new Promise(resolve=>setTimeout(resolve,200));await route.fulfill({json:{...model,items:[]}});};
        await page.route('**/api/tables/reservations',empty);
        await page.getByRole('button',{name:copy.refresh,exact:true}).click();
        await page.getByRole('status').filter({hasText:copy.loading}).waitFor();
        await page.getByText(copy.empty,{exact:true}).waitFor();await page.unroute('**/api/tables/reservations',empty);
        const failed=route=>route.fulfill({status:503,json:{ok:false,code:'unavailable'}});
        await page.route('**/api/tables/reservations',failed);
        await page.getByRole('button',{name:copy.refresh,exact:true}).click();
        await page.getByRole('alert').waitFor();await page.unroute('**/api/tables/reservations',failed);
        await page.getByRole('button',{name:copy.retry,exact:true}).click();
        await page.getByRole('button',{name:copy.detail+' #'+sample.id,exact:true}).waitFor();
        await page.getByRole('button',{name:copy.schedule,exact:true}).click();
        await page.locator(`button[aria-label^="${today} ·"]`).click();
        await page.getByRole('button',{name:copy.clearDay,exact:true}).waitFor();
        await page.getByRole('button',{name:copy.list,exact:true}).click();
        await page.locator('select').selectOption('cancelled');
        await page.getByText(copy.empty,{exact:true}).waitFor();await page.close();
      }
    });
    await t.test('Staff KO/VI minimum UI, Inbox denial, full-contact denial, confirmation and revocation of an active session',async()=>{
      const pending=await create(db,{reservedAt:`${today}T21:00:00+07:00`});
      for(const lang of ['ko','vi']) {
        const page=await session(lang,'staff',320);const copy=reservationText[lang];
        assert.ok(await page.getByRole('button',{name:copy.create,exact:true}).isDisabled());
        assert.ok(!(await page.locator('body').innerText()).includes('SYNTHETIC PRIVATE'));
        await page.getByRole('button',{name:copy.inbox,exact:true}).click();await page.getByText(copy.denied,{exact:true}).waitFor();
        const forbidden=await page.request.get(origin+`/api/tables/reservations/${pending.id}?reveal=1`);assert.equal(forbidden.status(),403);
        await page.getByRole('button',{name:copy.today,exact:true}).click();
        await page.getByRole('button',{name:copy.detail+' #'+pending.id,exact:true}).click();
        await page.getByRole('dialog').getByRole('heading',{name:copy.history,exact:true}).waitFor();
        assert.equal(await page.getByRole('dialog').getByRole('button',{name:copy.edit,exact:true}).count(),0);
        await fit(page,'staff-'+lang);await page.screenshot({path:path.join(work,`staff-${lang}-320.png`),fullPage:true});
        if(lang==='vi') {
          await page.getByRole('dialog').getByRole('button',{name:copy.confirm,exact:true}).click();
          await page.getByRole('dialog').getByText(copy.states.confirmed,{exact:true}).first().waitFor();
          await db.exec('update public.users set app_login_enabled=false where id=5');
          await page.reload();await page.waitForURL('**/login');
        }
        await page.close();
      }
      assert.equal((await queryRows(db,'select confirmed_by::int actor from reservation_private.reservations where id=$1',[pending.id]))[0].actor,5);
    });
    assert.deepEqual(errors,[],'no browser exceptions');
    writeFileSync(path.join(work,'browser-rpc-evidence.json'),JSON.stringify({transport:'127.0.0.1 isolated PGlite',rpcCalls:rpcLog,exceptions:errors},null,2));
  } finally {
    for(const context of contexts)await context.close().catch(()=>{});await browser?.close();
    if(server && server.exitCode===null)server.kill();
    if(descriptor!==undefined)closeSync(descriptor);
    await new Promise(resolve=>transport.close(resolve));await queue;await db.close();
    if(oldSecret===undefined)delete process.env.BABA_SESSION_SECRET;else process.env.BABA_SESSION_SECRET=oldSecret;
    if(oldTemp===undefined)delete process.env.TEMP;else process.env.TEMP=oldTemp;
    if(oldTmp===undefined)delete process.env.TMP;else process.env.TMP=oldTmp;
  }
});
