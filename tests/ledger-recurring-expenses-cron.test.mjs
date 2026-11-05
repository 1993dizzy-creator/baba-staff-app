import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as recurring from '../lib/ledger/recurring-expenses.ts';
import {getBusinessDate} from '../lib/common/business-time.ts';

// No database: the route runs against an in-memory fake of the three reads and the sync RPC.
function load(path,deps){const mod={exports:{}};const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',code)(name=>{if(!(name in deps))throw Error('Unexpected import '+name);return deps[name];},mod,mod.exports);return mod.exports;}

const plan={id:3,name:'매장 임대료 (현 계약)',category_id:9,amount:'50000000.000',recognition_day:1,effective_from:'2026-08-01',effective_to:null,is_active:true,source_key_prefix:'store-rent'};
const recognized=month=>({id:Number(month.replace('-','')),source_key:`recurring:3:${month}`,status:'confirmed',amount:'50000000.000',recognition_month:`${month}-01`});

function harness({businessDate='2026-11-05',recognitions=[recognized('2026-08'),recognized('2026-09'),recognized('2026-10')],closures=[],rpc,deny=false}={}){
 const state={recognitions:[...recognitions],rpcCalls:[],reads:[]};
 const table=name=>{const filters=[];const q={select(){return q;},eq(){return q;},order(){return q;},
  in(column,values){filters.push([column,values]);return q;},
  then(resolve,reject){state.reads.push(name);let data;
   if(name==='ledger_recurring_expense_plans')data=[plan];
   else if(name==='ledger_transactions')data=state.recognitions.filter(r=>filters.every(([c,v])=>v.includes(r[c])));
   else if(name==='ledger_month_closures')data=closures;
   else if(name==='users')data=[{id:7,role:'owner'}];
   return Promise.resolve({data,error:null}).then(resolve,reject);}};return q;};
 const supabaseServer={from:table,rpc:async(fn,args)=>{state.rpcCalls.push([fn,args]);
  if(rpc)return rpc(args,state);
  const month=args.p_month.slice(0,7);
  if(!state.recognitions.some(r=>r.source_key===`recurring:3:${month}`))state.recognitions.push(recognized(month));
  return {data:{status:'ok',createdCount:1},error:null};}};
 const route=load('app/api/cron/ledger-recurring-expenses/route.ts',{
  'next/server':{NextResponse:{json:(body,init)=>Response.json(body,init)}},
  '@/lib/common/business-time':{getBusinessDate:()=>businessDate},
  '@/lib/ledger/recurring-expenses':recurring,
  '@/lib/pos/cukcuk/sales-sync-cron-shared':{authorizeCron:()=>deny?Response.json({ok:false},{status:401}):null},
  '@/lib/supabase/server':{supabaseServer},
 });
 return {state,run:async()=>{const res=await route.GET(new Request('http://localhost/api/cron/ledger-recurring-expenses'));return {status:res.status,body:await res.json()};}};
}

test('November rent is recognized once by the existing sync RPC; reruns are no-ops',async()=>{
 const h=harness();
 const first=await h.run();
 assert.equal(first.status,200);assert.deepEqual(first.body.checked,['2026-10','2026-11']);
 assert.deepEqual(h.state.rpcCalls,[['ledger_sync_recurring_expenses_v2',{p_month:'2026-11-01',p_actor_user_id:7}]]);
 for(let i=0;i<3;i++){const again=await h.run();assert.deepEqual(again.body.synced,[]);}
 assert.equal(h.state.rpcCalls.length,1);
 assert.equal(h.state.recognitions.filter(r=>r.source_key==='recurring:3:2026-11').length,1);
});

test('recognized, cancelled or closed months are never sent to the RPC; Aug–Sep are outside the window',async()=>{
 const all=harness({recognitions:[recognized('2026-10'),recognized('2026-11')]});
 assert.deepEqual((await all.run()).body.synced,[]);assert.equal(all.state.rpcCalls.length,0);assert.ok(!all.state.reads.includes('users'));
 const cancelled=harness({recognitions:[recognized('2026-10'),{...recognized('2026-11'),status:'cancelled'}]});
 await cancelled.run();assert.equal(cancelled.state.rpcCalls.length,0);
 const closed=harness({recognitions:[],closures:[{month:'2026-10-01',status:'closed'},{month:'2026-11-01',status:'closed'}]});
 await closed.run();assert.equal(closed.state.rpcCalls.length,0);
 // October missing and open (e.g. a missed run on Oct 31): caught up together with November.
 const catchUp=harness({recognitions:[]});
 await catchUp.run();assert.deepEqual(catchUp.state.rpcCalls.map(([,a])=>a.p_month),['2026-10-01','2026-11-01']);
});

test('03:00 business-day boundary: 02:59 on Nov 1 is still October, 03:00 is November',()=>{
 assert.equal(getBusinessDate(new Date('2026-10-31T19:59:00Z')),'2026-10-31');
 assert.equal(getBusinessDate(new Date('2026-10-31T20:00:00Z')),'2026-11-01');
 assert.deepEqual(recurring.recurringAutoSyncMonths('2026-10-31'),['2026-09','2026-10']);
 assert.deepEqual(recurring.recurringAutoSyncMonths('2026-11-01'),['2026-10','2026-11']);
 assert.deepEqual(recurring.recurringAutoSyncMonths('2027-01-01'),['2026-12','2027-01']);
});

test('a failed run returns 500 without partial state; the next run retries',async()=>{
 let fail=true;
 const h=harness({rpc:(args,state)=>{if(fail)return {data:null,error:{message:'boom'}};state.recognitions.push(recognized(args.p_month.slice(0,7)));return {data:{status:'ok'},error:null};}});
 const failed=await h.run();assert.equal(failed.status,500);assert.equal(failed.body.code,'LEDGER_RECURRING_CRON_FAILED');assert.doesNotMatch(JSON.stringify(failed.body),/boom/);
 fail=false;const retried=await h.run();assert.equal(retried.status,200);assert.equal(retried.body.synced.length,1);
 const notOk=harness({rpc:()=>({data:{status:'forbidden'},error:null})});
 assert.equal((await notOk.run()).status,500);
});

test('cron secret is checked before any read',async()=>{
 const h=harness({deny:true});assert.equal((await h.run()).status,401);assert.deepEqual(h.state.reads,[]);assert.equal(h.state.rpcCalls.length,0);
});

test('scheduled daily at 20:25 UTC (03:25 Vietnam); the route books only via the deployed RPC, never cash',()=>{
 const crons=JSON.parse(readFileSync('vercel.json','utf8')).crons;
 assert.deepEqual(crons.find(c=>c.path==='/api/cron/ledger-recurring-expenses'),{path:'/api/cron/ledger-recurring-expenses',schedule:'25 20 * * *'});
 const route=readFileSync('app/api/cron/ledger-recurring-expenses/route.ts','utf8');
 assert.doesNotMatch(route,/ledger_movements|ledger_payables|\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
 assert.match(route,/rpc\("ledger_sync_recurring_expenses_v2"/);
});
