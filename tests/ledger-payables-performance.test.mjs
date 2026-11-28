import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import ts from 'typescript';
import {createClient} from '@supabase/supabase-js';
import * as payables from '../lib/ledger/payables.ts';
import * as verification from '../lib/ledger/payment-verification.ts';
import * as settlement from '../lib/ledger/settlement-periods.ts';
import * as businessTime from '../lib/common/business-time.ts';

// Execute the actual before/after handlers against the same isolated, paginated
// Data API double. No credentials/network. Timings exclude transpilation and are
// handler CPU + double overhead, NOT PostgreSQL or production latency.
const base='db4767af6d49d1c45c508494755b72e44ef3e224';
const path='app/api/admin/ledger/payables/route.ts';
const before=execFileSync('git',['show',`${base}:${path}`],{encoding:'utf8'});
const after=readFileSync(path,'utf8');
const oldVerification=execFileSync('git',['show',`${base}:lib/ledger/payment-verification.ts`],{encoding:'utf8'});
function compile(source,deps){
  const mod={exports:{}};
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name]},mod,mod.exports);
  return mod.exports;
}
// Split a PostgREST projection at its current nesting depth.
function fields(select){
  let depth=0,start=0;const result=[];
  for(let i=0;i<select.length;i++){if(select[i]==='(')depth++;if(select[i]===')')depth--;if(select[i]===','&&depth===0){result.push(select.slice(start,i));start=i+1}}
  result.push(select.slice(start));return result;
}
function project(row,select){
  const result={};
  for(const field of fields(select)){
    const open=field.indexOf('(');
    if(open<0){result[field]=row[field];continue}
    const alias=field.slice(0,open).split(':')[0],nested=field.slice(open+1,-1),value=row[alias];
    result[alias]=Array.isArray(value)?value.slice(0,alias==='allocations'?1000:Infinity).map(r=>project(r,nested)):value==null?null:project(value,nested);
  }
  return result;
}
function fixture(count=40,perParty=30){
  const tables={ledger_payables:[],ledger_payable_allocations:[],ledger_transactions:[],business_partner_ledger_parties:[],business_partners:[],ledger_payable_balance_anchors:[],ledger_payable_anchor_settlements:[]};
  let allocationId=0;
  for(let party=10;party<10+count;party++){
    tables.business_partner_ledger_parties.push({business_partner_id:party,ledger_party_id:party});
    tables.business_partners.push({id:party,partner_type:'goods_supplier',payment_mode:'postpaid',settlement_mode:'scheduled',settlement_rule:'monthly_once',settlement_days:[0],default_payment_term_days:null});
    for(let i=0;i<perParty;i++){
      const id=party*10000+i,date=i%3===0?'2026-10-20':'2026-11-10';
      const row={id,party_id:party,original_amount:'100.125',due_date:null,status:i%4===0?'paid':'unpaid',created_at:date+'T12:00:00Z',party:{name:`Party ${party}`},expense:{id:id+1000000,type:'expense',source_type:'manual',source_key:null,business_date:date,status:i===9?'draft':'confirmed',memo:null,source_snapshot:i===8?{paymentVerification:'pending',item_name:'verify'}:{item_name:'purchase',evidence:'x'.repeat(100)}}};
      if(i===7)row.status='cancelled';
      tables.ledger_payables.push(row);
      // Some payments belong to ANOTHER party, and are allocated across parties.
      for(let j=0;j<3;j++){
        const payment={id:900000+j,type:'payable_payment',party_id:999,business_date:['2026-10-25','2026-11-15','2026-12-02'][j],status:i===6?'draft':'confirmed',source_type:'manual',source_key:null,source_snapshot:i===5?{prepayment:true}:{},amount:100000,economic_effect_sign:1,memo:'manual allocation',movements:[{amount:-100000}]};
        tables.ledger_payable_allocations.push({id:++allocationId,payable_id:id,allocated_amount:i%4===0?'33.375':'10.125',created_at:payment.business_date+'T12:00:00Z',payment});
        if(party===10&&i===0)tables.ledger_transactions.push(payment);
      }
    }
  }
  return tables;
}
function app(source,tables,{denied=false,errorTable=null,errorPage=0,providedClient=null}={}){
  const metrics={requests:0,rows:0,bytes:0,reads:[]};
  const client=providedClient??{from(table){
    let select='',from=0,to=999,single=false;const filters=[],orders=[];
    const value=(r,k)=>k.split('.').reduce((v,key)=>v?.[key],r);
    const q={select(s){select=s;return q},range(a,b,options){if(!options?.referencedTable){from=a;to=b;}return q},maybeSingle(){single=true;return q},order(k,options){if(!options?.referencedTable)orders.push([k,options?.ascending!==false]);return q},
      eq(k,v){filters.push(r=>value(r,k)===v);return q},neq(k,v){filters.push(r=>value(r,k)!==v);return q},
      lt(k,v){filters.push(r=>value(r,k)<v);return q},in(k,v){filters.push(r=>v.includes(value(r,k)));return q},
      then(resolve,reject){
        const error=table===errorTable&&from===errorPage?{code:'TEST_READ_ERROR'}:null;
        const all=(tables[table]??[]).filter(r=>filters.every(f=>f(r))).sort((a,b)=>{for(const [k,asc] of orders){const av=value(a,k),bv=value(b,k);if(av!==bv)return (av<bv?-1:1)*(asc?1:-1)}return 0});
        const data=error?null:all.slice(from,to+1).map(r=>project(r,select));
        metrics.requests++;metrics.rows+=data?.length??0;metrics.bytes+=Buffer.byteLength(JSON.stringify(data));metrics.reads.push({table,from,rows:data?.length??0});
        return Promise.resolve({data:single?data?.[0]??null:data,error}).then(resolve,reject);
      }};return q;
  }};
  const anchors=compile(readFileSync('lib/ledger/payable-balance-anchor-data.ts','utf8'),{'@/lib/supabase/server':{supabaseServer:client}});
  const old=compile(oldVerification,{'./payables.ts':payables});
  const handler=compile(source,{'@/lib/supabase/server':{supabaseServer:client},'@/lib/ledger/server':{requireLedgerActor:async()=>denied?{response:Response.json({ok:false},{status:403})}:{actor:{id:2}},ledgerJson:(body,status=200)=>Response.json(body,{status})},'@/lib/ledger/payables':payables,'@/lib/ledger/payment-verification':source===before?old:verification,'@/lib/ledger/settlement-periods':settlement,'@/lib/common/business-time':businessTime,'@/lib/ledger/payable-balance-anchor-data':anchors,'@/lib/ledger/inventory-display':{withInventoryDisplay:async rows=>rows}});
  return {metrics,async run(query,partyId=10){const start=performance.now();const response=await handler.GET(new Request('http://isolated/payables'+query),{params:Promise.resolve({partyId:String(partyId)})});const body=await response.json();return {status:response.status,body,ms:performance.now()-start,responseBytes:Buffer.byteLength(JSON.stringify(body))}}};
}

for(const query of ['', '?month=2026-10','?month=2026-11','?month=2026-11&asOf=2026-11-14','?month=2026-11&historyPartyId=10','?month=2026-10&historyPartyId=10','?month=2026-11&historyPartyId=999'])test(`identical complete API result: ${query}`,async()=>{
  const tables=fixture(),a=app(before,tables),b=app(after,tables);
  const old=await a.run(query),next=await b.run(query);
  assert.equal(next.status,200);assert.deepEqual(next.body,old.body);assert.equal(next.responseBytes,old.responseBytes);
  if(query.includes('historyPartyId=10')){
    assert.ok(b.metrics.rows<a.metrics.rows/10);
    assert.equal(next.body.historyPayables.find(r=>r.id===100000).outstandingAmount,query.includes('2026-10')?66.75:33.375,'cross-party allocations retained');
  }
});

for(const count of [1000,1001])test(`payable page boundary and >1000 allocations in one ID batch: ${count}`,async()=>{
  const tables=fixture(1,count);
  for(const row of tables.ledger_payables){row.status="unpaid";row.expense.status="confirmed";}
  // More than 1000 allocations on a single payable, inside a single 200-ID batch.
  const seed=tables.ledger_payable_allocations[0];
  for(let i=0;i<1001;i++)tables.ledger_payable_allocations.push({...seed,id:100000+i,payable_id:100001,allocated_amount:'0.001'});
  const query='?month=2026-11&historyPartyId=10';
  const a=app(before,tables),b=app(after,tables),old=await a.run(query),next=await b.run(query);
  assert.deepEqual(next.body,old.body);assert.equal(next.status,200);
  assert.ok(b.metrics.reads.some(r=>r.table==='ledger_payable_allocations'&&r.from===1000));
  assert.ok(b.metrics.reads.some(r=>r.table==='ledger_payables'&&r.from===1000));
});

test('authorization, validation, first/later page errors preserve status and code',async()=>{
  for(const options of [{denied:true},{errorTable:'ledger_payables'},{errorTable:'ledger_payable_allocations'},{errorTable:'ledger_payable_allocations',errorPage:1000},{errorTable:'ledger_payable_balance_anchors'}]){
    const tables=fixture(1,400);
    const seed=tables.ledger_payable_allocations[0];
    for(let i=0;i<1001;i++)tables.ledger_payable_allocations.push({...seed,id:100000+i,allocated_amount:'0.001'});
    const query='?month=2026-11&historyPartyId=10';
    const a=app(before,tables,options),b=app(after,tables,options);
    const old=await a.run(query),next=await b.run(query);assert.equal(next.status,old.status);assert.deepEqual(next.body,old.body);
    if(options.denied)assert.equal(b.metrics.requests,0);
  }
  for(const query of ['?month=invalid','?historyPartyId=10','?month=2026-11&historyPartyId=-1','?asOf=2026-02-30']){
    const a=app(before,fixture()),b=app(after,fixture()),old=await a.run(query),next=await b.run(query);
    assert.equal(next.status,400);assert.deepEqual(next.body,old.body);assert.equal(b.metrics.requests,0);
  }
});

test('Coca-Cola frozen baseline and later application of old prepayment remain identical',async()=>{
  const tables=fixture(1,1),row=tables.ledger_payables[0];
  row.party_id=5;row.original_amount=4647952;row.party.name='Coca-Cola';row.expense.business_date='2026-11-14';
  tables.ledger_payable_balance_anchors=[{id:1,party_id:5,business_date:'2026-11-17',owner_balance:4982000,app_balance:4647952,adjustment_amount:334048,evidence_kind:'owner_confirmation',source_unverified:true,evidence_reference:'isolated fixture',created_at:'2026-11-19T07:00:00Z'}];
  const allocation=tables.ledger_payable_allocations[0];
  allocation.allocated_amount=100000;allocation.created_at='2026-11-20T07:00:00Z';
  allocation.payment.business_date='2026-11-10';allocation.payment.source_snapshot={prepayment:true};
  tables.ledger_payable_allocations=[allocation];
  for(const asOf of ['2026-11-17','2026-11-20']){
    const query=`?month=2026-11&historyPartyId=5&asOf=${asOf}`;
    const old=await app(before,tables).run(query),next=await app(after,tables).run(query);
    assert.equal(next.status,200);assert.deepEqual(next.body,old.body);
    assert.equal(next.body.totalOutstanding,asOf==='2026-11-17'?4982000:4882000);
  }
});

test('isolated before/after measurements with identical response and fixture',async()=>{
  const results=[];
  for(const query of ['?month=2026-11&historyPartyId=10','?month=2026-11']){
    const tables=fixture(60,40),a=app(before,tables),b=app(after,tables);
    // Warm up both versions; measure alternating order to reduce ordering bias.
    for(let i=0;i<3;i++){await a.run(query);await b.run(query)}
    const times=[[],[]];let old,next;
    for(let i=0;i<15;i++){
      if(i%2){next=await b.run(query);old=await a.run(query)}else{old=await a.run(query);next=await b.run(query)}
      assert.deepEqual(next.body,old.body);times[0].push(old.ms);times[1].push(next.ms);
    }
    const onceA=app(before,tables),onceB=app(after,tables);await onceA.run(query);await onceB.run(query);
    const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
    results.push({query,before:{...onceA.metrics,reads:undefined,handlerMedianMs:median(times[0]),responseBytes:old.responseBytes},after:{...onceB.metrics,reads:undefined,handlerMedianMs:median(times[1]),responseBytes:next.responseBytes}});
  }
  mkdirSync('.local/db-perf-02',{recursive:true});
  writeFileSync('.local/db-perf-02/measurements.json',JSON.stringify({baseline:base,kind:'in-memory Data API double; NOT database/production timing; inventory display stubbed',samples:15,results},null,2));
  console.log(JSON.stringify(results));
});

const detailPath='app/api/admin/ledger/payables/[partyId]/route.ts';
const detailBefore=execFileSync('git',['show',`${base}:${detailPath}`],{encoding:'utf8'});
const detailAfter=readFileSync(detailPath,'utf8');
function detailFixture(count){
  const tables=fixture(1,count);
  tables.ledger_parties=[{id:10,name:'Party 10',memo:null,default_payment_term_days:null}];
  for(const row of tables.ledger_payables){
    row.status='unpaid';row.expense.status='confirmed';row.expense.source_snapshot={};
    row.allocations=[];
  }
  tables.ledger_payable_allocations=[];tables.ledger_transactions=[];
  const first=tables.ledger_payables[0];first.original_amount=count*2;
  for(let i=0;i<count;i++){
    const payment={id:900000+i,party_id:10,type:'payable_payment',status:'confirmed',business_date:'2026-11-15',occurred_at:'2026-11-15T12:00:00Z',amount:1,memo:null,movements:[],allocations:[{payable_id:first.id,allocated_amount:1}]};
    const allocation={id:i+1,payable_id:first.id,payment_transaction_id:payment.id,allocated_amount:1,created_at:'2026-11-15T12:00:00Z',payment};
    first.allocations.push(allocation);tables.ledger_payable_allocations.push(allocation);tables.ledger_transactions.push(payment);
  }
  // One history payment spans >1000 payables, including another party's payable.
  const payment=tables.ledger_transactions[0];payment.allocations=[];
  for(let i=0;i<count;i++){
    const payableId=i===count-1?9999999:tables.ledger_payables[i].id;
    payment.allocations.push({payable_id:payableId,allocated_amount:1});
    if(i>0)tables.ledger_payable_allocations.push({id:count+i,payable_id:payableId,payment_transaction_id:payment.id,allocated_amount:1});
  }
  return tables;
}
for(const count of [999,1000,1001])test(`current detail parent AND embedded allocation cap: ${count}`,async()=>{
  const tables=detailFixture(count),a=app(detailBefore,tables),b=app(detailAfter,tables);
  const old=await a.run(''),next=await b.run('');assert.equal(next.status,200);
  assert.equal(next.body.payables.length,count);assert.equal(next.body.payments.length,count);
  assert.equal(next.body.payables[0].allocations.length,count);
  assert.equal(next.body.payments[0].allocations.length,count);
  assert.equal(next.body.payables[0].paidAmount,count);
  assert.equal(next.body.totalOutstanding,payables.calculatePayableBalances(tables.ledger_payables,tables.ledger_payable_allocations).totalOutstanding);
  if(count<=1000)assert.deepEqual(next.body,old.body);
  else {assert.equal(old.body.payables.length,1000);assert.equal(old.body.payables[0].paidAmount,1000);assert.notEqual(next.body.totalOutstanding,old.body.totalOutstanding);}
});
test('current detail saturated child read failures fail closed; not found and denied stay intact',async()=>{
  for(const options of [{errorTable:'ledger_payables',errorPage:1000},{errorTable:'ledger_transactions',errorPage:1000},{errorTable:'ledger_payable_allocations',errorPage:1000}]){
    const result=await app(detailAfter,detailFixture(1001),options).run('');assert.equal(result.status,500);assert.equal(result.body.code,'PAYABLE_DETAIL_LOAD_FAILED');
  }
  const denied=app(detailAfter,detailFixture(1),{denied:true});assert.equal((await denied.run('')).status,403);assert.equal(denied.metrics.requests,0);
  assert.equal((await app(detailAfter,detailFixture(1)).run('',999)).status,404);
  assert.equal((await app(detailAfter,detailFixture(1)).run('',0)).status,400);
});

test('installed Supabase SDK emits explicit child ranges and stable child order',async()=>{
  const urls=[],tables=detailFixture(1000);
  const client=createClient('http://isolated.invalid','isolated-fixture-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input)=>{
    const url=new URL(String(input));urls.push(url);
    const table=url.pathname.split('/').at(-1);
    let data=[];
    if(table==='ledger_parties')data=tables.ledger_parties[0];
    if(table==='ledger_payables'&&url.searchParams.get('offset')==='0')data=[tables.ledger_payables[0]];
    return Response.json(data);
  }}});
  const result=await app(detailAfter,tables,{providedClient:client}).run('');
  assert.equal(result.status,200);
  for(const table of ['ledger_payables','ledger_transactions']){
    const url=urls.find(u=>u.pathname.endsWith('/'+table));
    assert.equal(url.searchParams.get('allocations.limit'),'1000');
    assert.equal(url.searchParams.get('allocations.offset'),'0');
    assert.equal(url.searchParams.get('allocations.order'),'id.asc');
    assert.equal(url.searchParams.get('limit'),'1000');
  }
  const tail=urls.find(u=>u.pathname.endsWith('/ledger_payable_allocations'));
  assert.equal(tail.searchParams.get('offset'),'1000');
  assert.equal(tail.searchParams.get('payable_id'),'eq.100000');
});
