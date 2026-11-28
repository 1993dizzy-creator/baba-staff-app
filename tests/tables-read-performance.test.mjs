import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import ts from 'typescript';
import {PGlite} from '@electric-sql/pglite';
import {babaTableCatalog} from '../lib/sales/baba-table-catalog.ts';
import {DEFAULT_STORE_HOURS} from '../lib/store-settings/types.ts';
import {order} from './helpers/table-overview-fixture.mjs';
import {installCleaningFixture,scope as sqlScope} from './helpers/tables-cleaning-fixture.mjs';

// Actual service/adapter/paging/projection modules, with an in-memory Data API
// transport only. No env files, POS calls, credentials, network or production DB.
const baseline='abb159f091171e0f55f29f3d3df7745c788b3212';
const changed=['lib/sales/table-overview-server.ts','lib/sales/table-cleaning-server.ts','lib/sales/table-detail-server.ts','lib/store-settings/business-time-adapter.ts'];
const oldSources=new Map(changed.map(p=>[resolve(p),execFileSync('git',['show',`${baseline}:${p}`],{encoding:'utf8'})]));
const require=createRequire(import.meta.url), stamp='2026-11-13T13:30:00Z',day='2026-11-13';
const dateRpc='store_business_date_for_timestamp_v1',settingsRpc='store_get_settings_overview_v1';
const tableId=babaTableCatalog().tables.find(t=>t.name==='BAR4').id;
const activation='00000000-0000-4000-8000-000000000abc';
const setting=(revision=7)=>({id:1,timezone:'Asia/Ho_Chi_Minh',businessDayCutoffTime:'03:00',effectiveFromBusinessDate:day,revision,hours:DEFAULT_STORE_HOURS});
function fixtureData(receiptCount=3,lineCount=12){
  const orders=[order('paid','BAR4',{orderDate:'2026-11-13T12:00:00Z',status:4}),order('open','BAR5'),
    order('quarantined','BAR6',{orderDate:'2026-11-13T12:00:00Z',providerObservedAt:'2026-11-13T12:40:00Z',quarantinedAt:'2026-11-13T12:45:00Z',quarantineReason:'vanished_unconfirmed'})];
  const sync={businessDate:day,lastSuccessAt:stamp,lastAttemptAt:stamp,lastErrorCode:null};
  const receipts=Array.from({length:receiptCount},(_,i)=>({id:i+1,source:'cukcuk',ref_no:`fixture-${i+1}`,final_amount:'100000',payment_status:i===2?4:3,is_canceled:i===2,business_date:i===1?'2026-11-14':day,ref_date:'2026-11-13T13:00:00Z',status_changed_at:'2026-11-13T13:00:01Z',order_id:i===0?'paid':`history-${i}`,table_name:i<20?'BAR4':'Unmapped',version:`version-${i+1}`}));
  const lines=Array.from({length:lineCount},(_,i)=>({id:i+1,source:'cukcuk',receipt_id:i%Math.min(receiptCount,20)+1,item_name:`menu-${i}`,quantity:'2',final_amount:'50000',is_canceled:i%5===0}));
  const key={receiptId:1,evidenceKey:'a'.repeat(32),autoKey:'b'.repeat(32)};
  const context={enabled:true,manualEnabled:true,serverNow:stamp,snapshot:{orders,sync},receipts:receipts.map(r=>({...r,status_changed_at:null})),keys:{[tableId]:key},cleanedTableIds:[],observations:{},reviewTableIds:[]};
  return {orders,sync,receipts,lines,context};
}
function runtime(before=false,options={}){
  const data=options.data??fixtureData(),cache=new Map(),calls=[],logs=[];
  const clock={now:Date.parse(options.now??stamp)},counts={};let lineReceiptIdReads=0;
  class RequestDate extends Date {constructor(...args){super(...(args.length?args:[clock.now]));}static now(){return clock.now;}}
  const record=(name,args,result,signal)=>{
    counts[name]=(counts[name]??0)+1;
    clock.now+=options.advance?.[name]??0;
    calls.push({name,args,rows:Array.isArray(result.data)?result.data.length:result.data==null?0:1,bytes:Buffer.byteLength(JSON.stringify(result.data)),signal});
    const output=structuredClone(result);
    if(options.countLineVisits&&name==='pos_sales_receipt_lines')for(const row of output.data??[]){
      const id=row.receipt_id;Object.defineProperty(row,'receipt_id',{enumerable:true,get(){lineReceiptIdReads++;return id;}});
    }
    return output;
  };
  const db={rpc(name,args){
    let signal;
    const q={abortSignal(s){signal=s;return q},then(ok,bad){return Promise.resolve().then(async()=>{
      if(options.reject?.includes(name)){record(name,args,{data:null,error:null},signal);throw new DOMException('timed out','TimeoutError');}
      let result={data:null,error:null};
      const answer=options.answers?.[name];
      if(answer)result=typeof answer==='function'?answer({calls,counts,clock,args,data}):answer;
      else if(options.rpcBackend)result=await options.rpcBackend(name,args);
      else if(name===dateRpc)result.data=options.days?.[counts[name]??0]??day;
      else if(name===settingsRpc)result.data={current:setting(options.revisions?.[counts[name]??0]??7)};
      else if(name==='pos_open_orders_read')result.data={orders:data.orders,sync:{...data.sync,businessDate:args.p_business_date}};
      else if(['tables_auto_context_v1','tables_cleaning_context_v1'].includes(name))result.data=data.context;
      else assert.fail('unexpected RPC '+name);
      const resultWithTrace=record(name,args,result,signal);
      if(options.afterRpc)options.afterRpc(name,counts[name],data);
      return resultWithTrace;
    }).then(ok,bad)}};return q;
  },from(table){
    let from=0,to=499,select='',count=null,signal;const filters=[];
    const q={select(s,options){select=s;count=options?.count;return q},eq(k,v){filters.push(r=>r[k]===v);return q},gte(k,v){filters.push(r=>r[k]>=v);return q},lte(k,v){filters.push(r=>r[k]<=v);return q},in(k,values){filters.push(r=>values.includes(r[k]));return q},order(){return q},abortSignal(s){signal=s;return q},range(a,b){from=a;to=b;return q},then(ok,bad){return Promise.resolve().then(()=>{
      assert.equal(count,'exact');assert.ok(signal instanceof AbortSignal);
      const rows=(table==='pos_sales_receipts'?data.receipts:data.lines).filter(r=>filters.every(f=>f(r)));
      const result=options.answers?.[table]??{data:rows.slice(from,Math.min(to+1,from+(options.cap??500))).map(row=>Object.fromEntries(select.split(',').map(column=>{const key=column.split(':')[0];return [key,row[key]]}))),error:null,count:rows.length};
      return record(table,{from,to,select,count},result,signal);
    }).then(ok,bad)}};return q;
  }};
  function load(file){
    const path=resolve(file);if(cache.has(path))return cache.get(path).exports;
    const mod={exports:{}};cache.set(path,mod);
    const source=before&&oldSources.has(path)?oldSources.get(path):readFileSync(path,'utf8');
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
    const localRequire=name=>{
      if(name==='server-only')return {};
      if(name==='@/lib/supabase/server')return {supabaseServer:db};
      if(name==='@/lib/pos/cukcuk/open-orders-scope')return {openOrdersScope:()=> options.scope??'a'.repeat(64)+':fixture',openOrdersBranchId:()=> 'fixture'};
      if(name.startsWith('.')||name.startsWith('@/')){
        let child=name.startsWith('@/')?resolve(name.slice(2)):resolve(dirname(path),name);
        if(!existsSync(child))child+='.ts';return load(child);
      }
      return require(name);
    };
    new Function('require','module','exports','Date','console',code)(localRequire,mod,mod.exports,RequestDate,{...console,error:(...args)=>logs.push(args)});
    return mod.exports;
  }
  const services={overview:load('lib/sales/table-overview-server.ts'),detail:load('lib/sales/table-detail-server.ts'),adapter:load('lib/store-settings/business-time-adapter.ts')};
  const summary=()=>({requests:calls.length,timeRpcs:calls.filter(c=>[dateRpc,settingsRpc].includes(c.name)).length,returnedRecords:calls.reduce((s,c)=>s+c.rows,0),returnedJsonBytes:calls.reduce((s,c)=>s+c.bytes,0),...(options.countLineVisits?{lineReceiptIdReads}:{})});
  return {data,calls,counts,logs,clock,services,summary,async run(kind='overview'){
    const start=performance.now();
    try{return {ok:true,value:await (kind==='overview'?services.overview.readTableOverview(new RequestDate(options.now??stamp)):services.detail.readTableDetail(tableId,new RequestDate(options.now??stamp))),ms:performance.now()-start};}
    catch(error){return {ok:false,error:{name:error.name,message:error.message,detailStage:error.detailStage},ms:performance.now()-start};}
  }};
}
async function flags(options,fn){
  const env={POS_OPEN_ORDERS_READ_ENABLED:'true',BABA_TABLE_CLEANING_ENABLED:'false',BABA_TABLE_AUTO_NORMAL_ENABLED:'false',BABA_TABLE_AUTO_NORMAL_ACTIVATION:activation,...options};
  const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
  try{return await fn()}finally{for(const [k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;}
}
const scenarios=[
  {name:'flags off',flags:{}},
  {name:'manual on',flags:{BABA_TABLE_CLEANING_ENABLED:'true'}},
  {name:'auto only',flags:{BABA_TABLE_AUTO_NORMAL_ENABLED:'true'}},
  {name:'auto and manual',flags:{BABA_TABLE_AUTO_NORMAL_ENABLED:'true',BABA_TABLE_CLEANING_ENABLED:'true'}},
  {name:'DB feature disabled',flags:{BABA_TABLE_CLEANING_ENABLED:'true'},options:{answers:{tables_cleaning_context_v1:{data:{enabled:false},error:null}}}},
  {name:'non-timeout fallback',flags:{BABA_TABLE_CLEANING_ENABLED:'true'},options:{answers:{tables_cleaning_context_v1:{data:null,error:{code:'42501'}}}}},
  {name:'auto failure preserves manual',flags:{BABA_TABLE_AUTO_NORMAL_ENABLED:'true',BABA_TABLE_CLEANING_ENABLED:'true'},options:{answers:{tables_auto_context_v1:{data:null,error:{code:'42883'}}}}},
  {name:'both contexts fail',flags:{BABA_TABLE_AUTO_NORMAL_ENABLED:'true',BABA_TABLE_CLEANING_ENABLED:'true'},options:{answers:{tables_auto_context_v1:{data:null,error:{code:'42883'}},tables_cleaning_context_v1:{data:null,error:{code:'42501'}}}}},
  {name:'statement timeout',flags:{BABA_TABLE_AUTO_NORMAL_ENABLED:'true',BABA_TABLE_CLEANING_ENABLED:'true'},options:{answers:{tables_auto_context_v1:{data:null,error:{code:'57014'}}}}},
  {name:'pool timeout',flags:{BABA_TABLE_CLEANING_ENABLED:'true'},options:{answers:{tables_cleaning_context_v1:{data:null,error:{code:'PGRST003'}}}}},
];
for(const scenario of scenarios)for(const kind of ['overview','detail'])test(`${kind}: same business response and trace, ${scenario.name}`,()=>flags(scenario.flags,async()=>{
  const old=runtime(true,scenario.options),next=runtime(false,scenario.options),a=await old.run(kind),b=await next.run(kind);
  assert.equal(b.ok,true);assert.deepEqual(b.value,a.value);
  assert.deepEqual(next.calls.filter(c=>![dateRpc,settingsRpc].includes(c.name)).map(c=>[c.name,c.args]),old.calls.filter(c=>![dateRpc,settingsRpc].includes(c.name)).map(c=>[c.name,c.args]));
  if(kind==='detail')assert.equal(next.summary().timeRpcs,old.summary().timeRpcs,'latest detail settings are deliberately refreshed');
  if(kind==='overview'&&['DB feature disabled','non-timeout fallback','both contexts fail','statement timeout','pool timeout'].includes(scenario.name))assert.equal(next.summary().timeRpcs,old.summary().timeRpcs-2);
}));

test('1201 receipts and 1201 lines keep exact paging/count and identical detail lines',()=>flags({},async()=>{
  const data=fixtureData(1201,1201),a=runtime(true,{data,cap:137,countLineVisits:true}),b=runtime(false,{data,cap:137,countLineVisits:true});
  const old=await a.run('detail'),next=await b.run('detail');
  assert.deepEqual(next.value,old.value);
  for(const [r,result] of [[a,old],[b,next]]){
    assert.ok(r.calls.filter(c=>c.name==='pos_sales_receipts').length>3);
    assert.ok(r.calls.filter(c=>c.name==='pos_sales_receipt_lines').length>3);
    const relevantIds=new Set(result.value.current.map(row=>row.id));
    assert.equal(r.calls.filter(c=>c.name==='pos_sales_receipt_lines').reduce((s,c)=>s+c.rows,0),data.lines.filter(line=>relevantIds.has(line.receipt_id)).length);
  }
  assert.equal(a.summary().lineReceiptIdReads,old.value.current.length*b.summary().lineReceiptIdReads);
  assert.ok(b.summary().lineReceiptIdReads>1000);
  mkdirSync('.local/db-perf-03a',{recursive:true});
  writeFileSync('.local/db-perf-03a/line-grouping.json',JSON.stringify({receipts:1201,lines:1201,relevantReceipts:next.value.current.length,before:a.summary(),after:b.summary(),equivalent:true},null,2));
  const corrupt=runtime(false,{answers:{pos_sales_receipts:{data:[],error:null,count:1}}});
  assert.equal((await corrupt.run('detail')).error.detailStage,'receipts');
}));

test('new atomic context still wins over earlier detail, without losing receipt lines',()=>flags({BABA_TABLE_CLEANING_ENABLED:'true'},async()=>{
  const options={afterRpc(name,_n,data){if(name==='pos_open_orders_read')data.context.snapshot.orders.push(order('new-customer','BAR4'));}};
  for(const before of [true,false]){
    const r=runtime(before,options),result=await r.run('detail');assert.equal(result.ok,true);
    assert.equal(result.value.table.state,'occupied');assert.equal(result.value.cleaning.enabled,false);
    assert.ok(result.value.current.find(row=>row.id===1).lines.length);
    assert.equal(r.counts[dateRpc],2);assert.equal(r.counts.tables_cleaning_context_v1,1);
  }
}));

test('detail rechecks changed settings revision and a changed business day at 03:00',()=>flags({BABA_TABLE_CLEANING_ENABLED:'true'},async()=>{
  for(const before of [true,false]){
    const r=runtime(before,{days:[day,'2026-11-14'],revisions:[7,8],now:'2026-11-14T02:59:59+07:00',answers:{tables_cleaning_context_v1:({args,data})=>({data:{...data.context,snapshot:{orders:[],sync:{...data.sync,businessDate:args.p_day}}},error:null})}});
    const result=await r.run('detail');assert.equal(result.ok,true);assert.equal(result.value.businessDate,day);
    assert.equal(result.value.cleaning.enabled,false);assert.equal(r.calls.find(c=>c.name==='tables_cleaning_context_v1').args.p_day,'2026-11-14');
  }
}));

test('stale-day 40001 refreshes the configured revision rather than reusing rejected context',()=>flags({BABA_TABLE_CLEANING_ENABLED:'true'},async()=>{
  const options={days:[day,'2026-11-14'],revisions:[7,8],answers:{tables_cleaning_context_v1:{data:null,error:{code:'40001'}}}};
  const a=runtime(true,options),b=runtime(false,options),old=await a.run(),next=await b.run();
  assert.deepEqual(next.value,old.value);assert.equal(next.value.businessDate,'2026-11-14');
  assert.equal(b.calls.filter(c=>c.name===settingsRpc).at(-1).args.p_business_date,'2026-11-14');
  assert.equal(b.counts[dateRpc],2);
}));

test('settings consume the same 12s budget: stop before context/snapshot if only 500ms remains',()=>flags({BABA_TABLE_CLEANING_ENABLED:'true'},async()=>{
  const r=runtime(false,{advance:{[dateRpc]:5500,[settingsRpc]:6000}}),result=await r.run();
  assert.equal(result.ok,true);assert.equal(result.value.collection.health,'read_failed');
  assert.deepEqual(r.calls.map(c=>c.name),[dateRpc,settingsRpc]);
  assert.ok(r.calls.every(c=>c.signal instanceof AbortSignal));
}));

test('non-timeout settings failures keep the existing fallback retry; only successful full settings are reused',()=>flags({BABA_TABLE_CLEANING_ENABLED:'true'},async()=>{
  for(const name of [dateRpc,settingsRpc]){
    const options={answers:{[name]:({counts})=>(counts[name]??0)===0?{data:null,error:{message:'transient unavailable'}}:{data:name===dateRpc?day:{current:setting()},error:null}}};
    const a=runtime(true,options),b=runtime(false,options),old=await a.run(),next=await b.run();
    assert.equal(next.ok,true);assert.deepEqual(next.value,old.value);
    assert.deepEqual(b.calls.map(c=>c.name),a.calls.map(c=>c.name));
  }
  const options={answers:{[settingsRpc]:{data:null,error:{message:'persistent unavailable'}}}};
  const a=runtime(true,options),b=runtime(false,options),old=await a.run(),next=await b.run();
  assert.equal(next.ok,false);assert.deepEqual(next.error,old.error);
  assert.deepEqual(b.calls.map(c=>c.name),a.calls.map(c=>c.name));
}));

test('aborted settings do not start the next RPC; date-only and unsignaled callers retain their API',async()=>{
  const r=runtime(false),controller=new AbortController();controller.abort();
  await assert.rejects(r.services.adapter.loadBusinessTimeAdapter(stamp,{signal:controller.signal}),{name:'AbortError'});assert.equal(r.calls.length,0);
  const result=await r.services.adapter.loadBusinessTimeAdapter(stamp);assert.equal(result.databaseBusinessDate,day);
  assert.equal(await r.services.adapter.resolveConfiguredBusinessDate(stamp),day);
  assert.equal(r.counts[dateRpc],2);assert.equal(r.counts[settingsRpc],1);
});

test('settings deadline shared across both RPCs, and exhausted context budget never starts fallback',()=>flags({BABA_TABLE_CLEANING_ENABLED:'true'},async()=>{
  const controller=new AbortController();
  const r=runtime(false,{afterRpc(name){if(name===dateRpc)controller.abort();}});
  await assert.rejects(r.services.adapter.loadBusinessTimeAdapter(stamp,{signal:controller.signal}),{name:'AbortError'});
  assert.deepEqual(r.calls.map(c=>c.name),[dateRpc]);
  const exhausted=runtime(false,{advance:{tables_cleaning_context_v1:11500},answers:{tables_cleaning_context_v1:{data:null,error:{code:'42501'}}}});
  const result=await exhausted.run();assert.equal(result.value.collection.health,'read_failed');
  assert.deepEqual(exhausted.calls.map(c=>c.name),[dateRpc,settingsRpc,'tables_cleaning_context_v1']);
}));

test('rejected context timeout uses the existing no-retry guard for both context RPCs',()=>flags({BABA_TABLE_AUTO_NORMAL_ENABLED:'true',BABA_TABLE_CLEANING_ENABLED:'true'},async()=>{
  for(const name of ['tables_auto_context_v1','tables_cleaning_context_v1']){
    const options={reject:[name],...(name==='tables_cleaning_context_v1'?{answers:{tables_auto_context_v1:{data:{enabled:false},error:null}}}:{})};
    const a=runtime(true,options),b=runtime(false,options),old=await a.run(),next=await b.run();
    assert.equal(next.ok,true);assert.equal(next.value.collection.health,'read_failed');
    assert.ok(a.calls.some(c=>c.name==='pos_open_orders_read'),'baseline previously retried the snapshot on a rejected timeout');
    assert.ok(!b.calls.some(c=>c.name==='pos_open_orders_read'));
    assert.ok(!b.calls.some(c=>c.name==='pos_sales_receipts'));
    assert.notEqual(next.value.collection.health,old.value.collection.health);
    assert.equal(a.calls.length,name==='tables_auto_context_v1'?7:8);
    assert.equal(b.calls.length,name==='tables_auto_context_v1'?3:4);
    assert.equal(b.logs.length,1);assert.match(b.logs[0][1],/"code":"timeout"/);
  }
}));

test('isolated PostgreSQL (PGlite): actual atomic context SQL, fewer settings SQL calls on fallback',()=>flags({BABA_TABLE_CLEANING_ENABLED:'true'},async()=>{
  const db=new PGlite(),results=[];
  try{
    const sqlDay=await installCleaningFixture(db);
    await db.exec("create function public.store_get_settings_overview_v1(p_business_date date) returns jsonb language sql stable as $$select jsonb_build_object('current',null)$$;");
    const rpcBackend=async(name,args)=>{
      const values=Object.values(args),names=Object.keys(args);
      const expression=`public.${name}(${names.map((key,i)=>`${key} => $${i+1}`).join(',')})`;
      const sql=name===dateRpc?`select ${expression}::text r`:`select ${expression} r`;
      return {data:(await db.query(sql,values)).rows[0].r,error:null};
    };
    // Failure after a real SQL context read: both versions then perform the same
    // legacy snapshot/receipt reads. Empty legacy receipts are deliberate here;
    // SQL-backed measurement below isolates settings + context SQL, not REST SQL.
    for(const enabled of [true,false]){
      await db.exec(`update table_operations_private.config set enabled=${enabled}`);
      const options={scope:sqlScope,now:new Date().toISOString(),rpcBackend,data:{...fixtureData(),receipts:[]}};
      const a=runtime(true,options),b=runtime(false,options);await a.run();await b.run();
      const times=[[],[]];let old,next;
      for(let i=0;i<5;i++){
        if(i%2){next=await b.run();old=await a.run()}else{old=await a.run();next=await b.run()}
        assert.equal(next.ok,true);assert.deepEqual(next.value,old.value);assert.equal(next.value.businessDate,sqlDay);
        times[0].push(old.ms);times[1].push(next.ms);
      }
      const x=runtime(true,options),y=runtime(false,options);await x.run();await y.run();
      const sqlCount=r=>r.calls.filter(c=>c.name!=='pos_sales_receipts').length;
      assert.equal(sqlCount(y),enabled?3:4);assert.equal(sqlCount(x),enabled?3:6);
      results.push({enabled,before:{...x.summary(),sqlQueries:sqlCount(x),handlerMedianMs:times[0].sort((a,b)=>a-b)[2]},after:{...y.summary(),sqlQueries:sqlCount(y),handlerMedianMs:times[1].sort((a,b)=>a-b)[2]},equivalent:true});
    }
    assert.equal((await db.query('select count(*)::int n from table_operations_private.cleaning_events')).rows[0].n,0);
    mkdirSync('.local/db-perf-03a',{recursive:true});
    writeFileSync('.local/db-perf-03a/pglite-measurements.json',JSON.stringify({baseline,kind:'PGlite actual migration context/date SQL; fixture settings SQL; fallback receipt transport stubbed; NOT hosted PostgreSQL/PostgREST latency',samples:5,results},null,2));
  }finally{await db.close()}
}));

test('isolated transport measurements: same fixtures/flags, alternating 9 samples, no PostgreSQL timing claim',async()=>{
  const results=[];
  for(const kind of ['overview','detail'])for(const scenario of scenarios){
    await flags(scenario.flags,async()=>{
      const a=runtime(true,scenario.options),b=runtime(false,scenario.options);
      await a.run(kind);await b.run(kind);const times=[[],[]];let old,next;
      for(let i=0;i<9;i++){
        if(i%2){next=await b.run(kind);old=await a.run(kind)}else{old=await a.run(kind);next=await b.run(kind)}
        assert.deepEqual(next.value,old.value);times[0].push(old.ms);times[1].push(next.ms);
      }
      const x=runtime(true,scenario.options),y=runtime(false,scenario.options);await x.run(kind);await y.run(kind);
      const median=values=>values.sort((a,b)=>a-b)[4];
      results.push({kind,scenario:scenario.name,before:{...x.summary(),handlerMedianMs:median(times[0])},after:{...y.summary(),handlerMedianMs:median(times[1])},responseBytes:Buffer.byteLength(JSON.stringify(next.value)),equivalent:true});
    });
  }
  mkdirSync('.local/db-perf-03a',{recursive:true});
  writeFileSync('.local/db-perf-03a/measurements.json',JSON.stringify({baseline,kind:'memory Data API transport; actual service/adapter/paging modules; NOT PostgreSQL or production timing',samples:9,results},null,2));
  console.log(JSON.stringify(results));
});
