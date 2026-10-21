import {randomUUID} from 'node:crypto';
import {initializeWork,work,correct,correction} from './helpers/pos-resolution-work-fixture.mjs';
import {existsSync} from 'node:fs';
﻿import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve as resolvePath} from 'node:path';
import {mkdir} from 'node:fs/promises';
import net from 'node:net';
import pg from 'pg';
import {initializePosCloseDatabase} from './helpers/pos-business-day-close-fixture.mjs';
import {initializeResolutionSchema,seedPending,review,request,resolve} from './helpers/pos-pending-resolution-fixture.mjs';
const run=promisify(execFile);
const delay=ms=>new Promise(r=>setTimeout(r,ms));

test('phase2 PostgreSQL 17: five rounds of correction/sync and duplicate inventory approvals',{skip:!existsSync('.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/dist/index.js')},async()=>{
 const binaries=await import('../.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/dist/index.js');
 const dataDir=resolvePath('.qa-review/pos-resolution/pg17-work-'+Date.now());await mkdir(dataDir,{recursive:true});
 await run(binaries.initdb,['-D',dataDir,'--encoding=UTF8','--locale=C','-U','postgres','-A','trust'],{windowsHide:true,timeout:30000});
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const server=spawn(binaries.postgres,['-D',dataDir,'-h','127.0.0.1','-p',String(port),'-c','fsync=off','-c','full_page_writes=off','-c','synchronous_commit=off'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);
 const config={host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:1000};
 const clients=[];const connect=async()=>{const client=new pg.Client(config);await client.connect();clients.push(client);await client.query("set statement_timeout='15s'");return client};
 try{
  let ready=false;for(let i=0;i<100;i++){try{const c=await connect();await c.query('select 1');ready=true;break}catch{await delay(100)}}assert.ok(ready,logs.slice(-1000));
  const root=clients[0];const db={exec:sql=>root.query(sql),query:(sql,args)=>root.query(sql,args)};await initializePosCloseDatabase(db);await initializeResolutionSchema(db);await initializeWork(db);
  const a=await connect(),b=await connect();const aDb={query:(...args)=>a.query(...args)},bDb={query:(...args)=>b.query(...args)};

  await root.query("insert into inventory(id,quantity,item_name,unit) values(1,100,'Stock','unit');insert into pos_item_mappings values(1,'TEST','direct',true,1,1,1,false)");
  for(let round=0;round<5;round++){
   const id=10+round;await seedPending(db,{id,refNo:'work-'+round});
   await root.query("update pos_sales_receipt_lines set source='cukcuk',ref_detail_id='d-'||id,sort_order=1,final_amount=100000,amount=100000,discount_amount=0,tax_rate=0,tax_amount=0,is_option=false,is_excluded=false,mapping_status='direct',ref_detail_type=1 where receipt_id=$1",[id]);
   await resolve(db,request(await review(db,id),{requestId:randomUUID()}),id);
   const w=await work(db,id);const body=correction(w,{requestId:randomUUID()});await a.query('begin');await correct(aDb,body,id);
   const competing=correct(bDb,{...body,requestId:randomUUID()},id,7).then(()=>({ok:true}),error=>({error}));
   await delay(60);await a.query('commit');assert.match((await competing).error?.message||'',/STALE/);
   await assert.rejects(root.query('update pos_sales_receipt_lines set quantity=999 where receipt_id=$1',[id]),/POS_ADMIN_RESOLUTION_PROTECTED/);
   const state=await work(db,id);const l=state.state.lines[0];
   const plan={workflow:'initial_apply',activeCount:0,contentFingerprint:'content-'+round,inventoryHash:'hash-'+round,amountHash:'amount-'+round,hashVersion:2,lines:[{receiptLineId:l.id,refDetailId:l.ref_detail_id,posItemCode:'TEST',itemName:'Item',quantitySold:1,mappingType:'direct',mappingId:1,mappingSnapshot:{mappingVersion:1},deductions:[{inventoryItemId:1,recipeId:null,recipeVersion:null,deductQuantity:1,deductQuantityPerUnit:1,currentQuantity:100-round,afterQuantity:99-round}]}]};
   const preview=(await root.query("select sales_preview_admin_resolution_inventory_v2($1,1,$2,$3::jsonb,'[]'::jsonb) r",[id,state.contextFingerprint,JSON.stringify(plan)])).rows[0].r;
   const approval={requestId:randomUUID(),reviewId:preview.reviewId,reason:'independent physical stock check'};
   await a.query('begin');const approved=(await a.query('select sales_confirm_admin_resolution_inventory_v2($1,1,$2::jsonb) r',[id,JSON.stringify(approval)])).rows[0].r;
   assert.equal((await root.query('select inventory_deduction_processing_paused held from pos_sales_receipts where id=$1',[id])).rows[0].held,true);
   const replay=b.query('select sales_confirm_admin_resolution_inventory_v2($1,1,$2::jsonb) r',[id,JSON.stringify(approval)]);
   await delay(60);await a.query('commit');assert.deepEqual((await replay).rows[0].r,approved);
   assert.equal(Number((await root.query('select quantity from inventory where id=1')).rows[0].quantity),99-round);
   assert.equal((await root.query('select count(*)::int n from inventory_logs')).rows[0].n,round+1);
   assert.equal((await root.query('select count(*)::int n from pos_sales_receipt_inventory_approvals where receipt_id=$1',[id])).rows[0].n,1);
  }
  assert.equal((await root.query('select count(*)::int n from pos_resolution_private.capabilities')).rows[0].n,0);
 }finally{
  for(const c of clients){try{await c.end()}catch{}}
  try{await run(binaries.pg_ctl,['-D',dataDir,'-m','fast','stop'],{windowsHide:true,timeout:15000})}catch{server.kill()}
 }
});
