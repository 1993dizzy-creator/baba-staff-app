import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolutionDatabase,seedPending} from './helpers/pos-pending-resolution-fixture.mjs';
import {authHarness,loadTs,nextMock} from './helpers/pos-resolution-auth-harness.mjs';
const require=createRequire(import.meta.url);
const available=existsSync('.qa-review/pos-tools/node_modules/playwright')&&existsSync('.qa-review/pos-tools/node_modules/esbuild')&&existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');
const {chromium}=available?require('../.qa-review/pos-tools/node_modules/playwright'):{};
const {build}=available?require('../.qa-review/pos-tools/node_modules/esbuild'):{};

test('KO/VI desktop/mobile: browser -> signed API -> atomic PGlite -> reload, no double counting',{skip:!available},async()=>{
 const originalSecret=process.env.BABA_SESSION_SECRET;process.env.BABA_SESSION_SECRET='local-fixture-session-secret-never-production-2026';
 const db=await resolutionDatabase();const h=authHarness();const token=h.sign();
 const policy=loadTs('lib/sales/pending-resolution-policy.ts');
 let postCount=0;let loseResponse=false;let schemaEnabled=true;
 const dbBridge={rpc:async(name,args)=>{
  const query=name==='sales_get_pending_resolution_v1'?'select sales_get_pending_resolution_v1($1,$2) result':'select sales_resolve_pending_receipt_v1($1,$2,$3::jsonb) result';
  try{return {data:(await db.query(query,[args.p_receipt_id,args.p_actor_user_id,...(name==='sales_get_pending_resolution_v1'?[]:[JSON.stringify(args.p_request)])])).rows[0].result,error:null}}catch{return {data:null,error:{message:'fixture_error'}}}
 }};
 const route=loadTs('app/api/admin/sales/receipts/[id]/resolution/route.ts',{'next/server':nextMock,'@/lib/auth/server-auth':h.auth,'@/lib/sales/admin-resolution-server':{resolutionSchemaReady:()=>true,resolutionWritesEnabled:()=>schemaEnabled},'@/lib/sales/pending-resolution-policy':policy,'@/lib/supabase/server':{supabaseServer:dbBridge}});
 const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import Panel from './components/PendingReceiptResolution.tsx';createRoot(document.getElementById('root')).render(<Panel {...window.fixtureProps}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',plugins:[{name:'fixture-mocks',setup(b){b.onResolve({filter:/^@\//},args=>{
  if(args.path==='@/lib/language-context'||args.path==='@/lib/sales/client-auth')return {path:args.path,namespace:'fixture'};
  return {path:process.cwd()+'/'+args.path.slice(2)+'.ts'};
 });b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.includes('language')?'export function useLanguage(){return {lang:window.fixtureLanguage}}':'export const fetchSalesApi=(...args)=>fetch(...args);',loader:'js'}));}}]});
 const script=bundle.outputFiles[0].text;
 const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(script);return}
  const match=url.pathname.match(/^\/api\/admin\/sales\/receipts\/(\d+)\/resolution$/);
  if(match){h.setToken(req.headers.cookie?.match(/baba_session=([^;]+)/)?.[1]);const chunks=[];for await(const c of req)chunks.push(c);
   if(req.method==='POST')postCount++;
   const webReq=new Request('http://localhost'+req.url,{method:req.method,...(req.method==='GET'?{}:{body:Buffer.concat(chunks).toString()})});
   const response=await route[req.method](webReq,{params:Promise.resolve({id:match[1]})});
   if(req.method==='POST'&&loseResponse){loseResponse=false;res.writeHead(200,{"Content-Type":"application/json"});res.end("fixture_lost_response");return}
   res.writeHead(response.status,{'Content-Type':'application/json'});res.end(await response.text());return;
  }
  const id=Number(url.searchParams.get('id')||10);const lang=url.searchParams.get('lang')||'ko';
  const props={receiptId:id,pending:url.searchParams.get('paid')!=='true',originalAmount:1910800,duplicateCount:1,eligibleAt:url.searchParams.get('young')==='true'?new Date(Date.now()+600000).toISOString():new Date(Date.now()-600000).toISOString()};
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px sans-serif;margin:12px}#root{max-width:1000px;margin:auto}button,input,textarea{font:inherit}button{min-height:44px}p{margin:0;overflow-wrap:anywhere}</style><div id="root"></div><script>window.fixtureLanguage=${JSON.stringify(lang)};window.fixtureProps=${JSON.stringify(props)}</script><script src="/bundle.js"></script>`);
 }catch(e){res.statusCode=500;res.end('fixture_server_error');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{
  let id=10;
  for(const lang of ['ko','vi'])for(const mobile of [false,true]){
   await seedPending(db,{id,refNo:String(id),duplicate:true,amount:1910800});const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1365,height:1000}});await context.addCookies([{name:'baba_session',value:token,url:base}]);const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+`/?id=${id}&lang=${lang}`);
   const amountLabel=lang==='ko'?'실제 확인한 수금액 (정수 VND)':'Số tiền thực thu đã xác minh (VND nguyên)';const paid=lang==='ko'?'결제완료 확정':'Xác nhận đã thanh toán';
   await assert.equal(await page.getByLabel(amountLabel,{exact:true}).inputValue(),'');await page.getByLabel(amountLabel,{exact:true}).fill('1100800');await page.getByLabel(lang==='ko'?'현금':'Tiền mặt',{exact:true}).fill('1100800');await page.getByLabel(lang==='ko'?'필수 처리 사유':'Lý do bắt buộc',{exact:true}).fill('Counted at cashier');await page.getByLabel(lang==='ko'?'필수 증빙 참조 (수금/취소/환불 기록)':'Tham chiếu chứng từ bắt buộc (thu/hủy/hoàn tiền)',{exact:true}).fill('Fixture cash reference');
   await page.getByRole('button',{name:paid,exact:true}).waitFor({state:'visible'});await page.waitForFunction(label=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent===label)?.disabled,paid);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await mkdir('.qa-review/pos-resolution',{recursive:true});await page.screenshot({path:`.qa-review/pos-resolution/${lang}-${mobile?'mobile':'desktop'}-form.png`,fullPage:true});
   const beforePosts=postCount;
   // The first run loses the response AFTER commit. Retry must reuse requestId.
   if(id===10){loseResponse=true;await page.getByRole('button',{name:paid,exact:true}).click();await page.getByRole('status').filter({hasText:'처리에 실패'}).waitFor();await page.getByRole('button',{name:paid,exact:true}).click();}
   else await page.evaluate(label=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent===label);b.click();b.click()},paid);
   await page.getByText(lang==='ko'?'관리자 판정이 보호 중입니다.':'Quyết định quản lý được bảo vệ.',{exact:false}).waitFor();
   assert.equal(postCount-beforePosts,id===10?2:1);assert.equal((await db.query('select count(*)::int n from pos_sales_receipt_resolution_history where receipt_id=$1',[id])).rows[0].n,1);assert.equal((await db.query('select count(*)::int n from pos_sales_receipt_lines where receipt_id=$1',[id])).rows[0].n,2);assert.equal(errors.length,0);await context.close();id++;
  }
  const context=await browser.newContext();await context.addCookies([{name:'baba_session',value:token,url:base}]);const page=await context.newPage();let apiGets=0;page.on('request',r=>{if(r.url().includes('/resolution'))apiGets++});await page.goto(base+'/?id=99&young=true');await page.waitForTimeout(300);assert.equal(apiGets,0);await page.goto(base+'/?id=99&paid=true');await page.waitForTimeout(300);assert.equal(apiGets,0);await context.close();
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));await db.close();if(originalSecret===undefined)delete process.env.BABA_SESSION_SECRET;else process.env.BABA_SESSION_SECRET=originalSecret}
});
