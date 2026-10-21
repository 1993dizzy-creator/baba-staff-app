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

test('isolated PostgreSQL 17 multi-connection resolution/sync/month-close races are atomic',{skip:!existsSync('.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/dist/index.js')},async()=>{
 const binaries=await import('../.qa-review/pos-tools/node_modules/@embedded-postgres/windows-x64/dist/index.js');
 const dataDir=resolvePath('.qa-review/pos-resolution/pg17-'+Date.now());await mkdir(dataDir,{recursive:true});
 await run(binaries.initdb,['-D',dataDir,'--encoding=UTF8','--locale=C','-U','postgres','-A','trust'],{windowsHide:true,timeout:30000});
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const server=spawn(binaries.postgres,['-D',dataDir,'-h','127.0.0.1','-p',String(port),'-c','fsync=off','-c','full_page_writes=off','-c','synchronous_commit=off'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';server.stdout.on('data',v=>logs+=v);server.stderr.on('data',v=>logs+=v);
 const config={host:'127.0.0.1',port,user:'postgres',database:'postgres',connectionTimeoutMillis:1000};
 const clients=[];const connect=async()=>{const client=new pg.Client(config);await client.connect();clients.push(client);await client.query("set statement_timeout='15s'");return client};
 try{
  let ready=false;for(let i=0;i<100;i++){try{const c=await connect();await c.query('select 1');ready=true;break}catch{await delay(100)}}assert.ok(ready,logs.slice(-1000));
  const root=clients[0];const db={exec:sql=>root.query(sql),query:(sql,args)=>root.query(sql,args)};await initializePosCloseDatabase(db);await initializeResolutionSchema(db);
  const a=await connect(),b=await connect();const aDb={query:(...args)=>a.query(...args)},bDb={query:(...args)=>b.query(...args)};
  await seedPending(db);const body=request(await review(db));await a.query('begin');assert.equal((await resolve(aDb,body)).status,'resolved');await b.query('begin');let settled=false;const replay=resolve(bDb,body).finally(()=>settled=true);await delay(100);assert.equal(settled,false);await a.query('commit');assert.equal((await replay).status,'resolved');await b.query('commit');assert.equal((await root.query('select count(*)::int n from pos_sales_receipt_resolution_history where receipt_id=10')).rows[0].n,1);
  await seedPending(db,{id:11,refNo:'stale-write'});const state=await review(db,11);await a.query('begin');await resolve(aDb,request(state,{requestId:'22222222-2222-4222-8222-222222222222'}),11);await b.query('begin');const stale=b.query('insert into pos_sales_receipt_lines(receipt_id,quantity) values(11,99)').then(()=>({ok:true}),error=>({error}));await delay(100);await a.query('commit');assert.match((await stale).error?.message||'',/POS_ADMIN_RESOLUTION_PROTECTED/);await b.query('rollback');
  await seedPending(db,{id:12,refNo:'before-write'});const earlier=await review(db,12);await b.query('begin');await b.query('update pos_sales_receipt_lines set quantity=2 where receipt_id=12');await a.query('begin');const pending=resolve(aDb,request(earlier,{requestId:'33333333-3333-4333-8333-333333333333'}),12);await delay(100);await b.query('commit');assert.equal((await pending).status,'source_changed');await a.query('commit');
  await seedPending(db,{id:13,refNo:'month-race'});const monthState=await review(db,13);await b.query('begin');await b.query("select pg_advisory_xact_lock(hashtext('ledger_month_close_serial'))");await b.query("select pg_advisory_xact_lock(hashtext('ledger_month_close'),hashtext('2026-10-01'))");await b.query("insert into ledger_month_closures(month,status) values('2026-10-01','closed')");await a.query('begin');const blocked=resolve(aDb,request(monthState,{requestId:'44444444-4444-4444-8444-444444444444'}),13);await delay(100);await b.query('commit');assert.equal((await blocked).status,'month_closed');await a.query('commit');
  assert.equal((await root.query('select count(*)::int n from pos_resolution_private.capabilities')).rows[0].n,0);
 }finally{
  for(const c of clients){try{await c.end()}catch{}}
  try{await run(binaries.pg_ctl,['-D',dataDir,'-m','fast','stop'],{windowsHide:true,timeout:15000})}catch{server.kill()}
 }
});
