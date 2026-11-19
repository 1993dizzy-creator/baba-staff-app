import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import * as crypto from 'node:crypto';
import ts from 'typescript';
import React from 'react';
import * as runtime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import * as payables from '../lib/ledger/payables.ts';
import * as verification from '../lib/ledger/payment-verification.ts';
import * as settlement from '../lib/ledger/settlement-periods.ts';
import * as businessTime from '../lib/common/business-time.ts';

function load(path,deps){
 const testModule={exports:{}};
 const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new Function('require','module','exports',code)(name=>{assert.ok(name in deps,'unexpected dependency '+name);return deps[name]},testModule,testModule.exports);
 return testModule.exports;
}
const anchor={id:1,party_id:5,business_date:'2026-11-17',owner_balance:4982000,app_balance:4647952,adjustment_amount:334048,evidence_kind:'owner_confirmation',source_unverified:true,evidence_reference:'Owner instruction; supplier statement unavailable',created_at:'2026-11-19T07:00:00Z'};

function app({missing=false,anchorError=null,later=false,backdated=false,denied=false}={}){
 const source=(id,party,amount,date)=>({id,party_id:party,original_amount:amount,status:'unpaid',created_at:date+'T12:00:00Z',due_date:null,party:{name:party===5?'Coca-Cola':'Other'},expense:{id:id+100,type:'expense',source_type:'inventory_purchase_candidate',business_date:date,status:'confirmed',source_snapshot:{},recognition_month:date.slice(0,7)+'-01',amount},allocations:[]});
 const rows=[source(1,5,backdated?4647953:4647952,'2026-11-14'),source(2,10,500000,'2026-11-10')];
 const payment={id:6000,type:'payable_payment',party_id:5,business_date:'2026-11-18',status:'confirmed',source_type:'manual',source_snapshot:{},amount:300000,allocations:[{payable_id:1,allocated_amount:300000}]};
 const allocations=later?[{id:1,payable_id:1,allocated_amount:300000,created_at:'2026-11-18T07:00:00Z',payment}]:[];
 if(later){rows.push(source(3,5,1000000,'2026-11-18'));rows[0].allocations=allocations;}
 const tables={ledger_payables:rows,ledger_parties:[{id:5,name:'Coca-Cola'},{id:10,name:'Other'}],ledger_payable_allocations:allocations,ledger_payable_balance_anchors:[anchor],ledger_transactions:[...rows.map(x=>x.expense),...(later?[payment]:[])]};
 const client={from(table){
  const filters=[];let from=0,to=999,single=false;
  const field=(row,key)=>key.split('.').reduce((v,k)=>v?.[k],row);
  const q={select(){return q},order(){return q},range(a,b){from=a;to=b;return q},maybeSingle(){single=true;return q},
   eq(k,v){filters.push(r=>field(r,k)===v);return q},neq(k,v){filters.push(r=>field(r,k)!==v);return q},
   lt(k,v){filters.push(r=>field(r,k)<v);return q},lte(k,v){filters.push(r=>field(r,k)<=v);return q},
   in(k,v){filters.push(r=>v.includes(field(r,k)));return q},or(){return q},
   then(resolve,reject){
    const error=table==='ledger_payable_balance_anchors'?(anchorError??(missing?{code:'PGRST205',message:"Could not find the table 'public.ledger_payable_balance_anchors' in schema cache"}:null)):null;
    const data=(tables[table]??[]).filter(r=>filters.every(f=>f(r))).slice(from,to+1);
    return Promise.resolve({data:error?null:single?data[0]??null:data,error}).then(resolve,reject);
   }};return q;
 },rpc:async()=>({data:{},error:null})};
 const anchorData=load('lib/ledger/payable-balance-anchor-data.ts',{'@/lib/supabase/server':{supabaseServer:client}});
 const deps={
  '@/lib/supabase/server':{supabaseServer:client},'@/lib/ledger/payables':payables,'@/lib/ledger/payment-verification':verification,
  '@/lib/ledger/settlement-periods':settlement,'@/lib/common/business-time':businessTime,
  '@/lib/ledger/payable-balance-anchor-data':anchorData,'@/lib/ledger/inventory-display':{withInventoryDisplay:async r=>r},
  '@/lib/ledger/server':{requireLedgerActor:async()=>denied?{response:Response.json({ok:false},{status:403})}:{actor:{id:2}},ledgerJson:(body,status=200)=>Response.json(body,{status})},
 };
 const list=load('app/api/admin/ledger/payables/route.ts',deps);
 const detail=load('app/api/admin/ledger/payables/[partyId]/route.ts',deps);
 const monthClose=load('lib/ledger/month-close.ts',{
  ...deps,'server-only':{},'node:crypto':crypto,
  '@/lib/ledger/month-close-card':{calculateMonthCloseCardSnapshot:()=>({})},
  '@/lib/ledger/month-close-operating':{calculateMonthCloseOperatingSummary:()=>({revenue:{total:0},expense:{total:0,attributedCardDifference:0},operatingResult:0})},
  '@/lib/ledger/fund-account-view':{fundMovementInScope:()=>true},
  '@/lib/ledger/card-settlement-data':{loadCardRows:async query=>(await query(0,999)).data},
  '@/lib/ledger/card-settlements':{cardFeeRowsAsAllocationLines:()=>[],cardMoney:Number},
 });
 return {anchorData,list:async query=>list.GET(new Request('http://local/api/admin/ledger/payables'+query)),detail:async party=>detail.GET(new Request('http://local'),{params:Promise.resolve({partyId:String(party)})}),snapshot:monthClose.buildMonthCloseSnapshot};
}

for(const later of [false,true])test(`actual dashboard/list, party detail, history and month-close share total (later=${later})`,async()=>{
 const a=app({later});
 const list=await (await a.list('?month=2026-11')).json(),detail=await (await a.detail(5)).json(),snapshot=await a.snapshot('2026-11');
 const expected=later?5682000:4982000;
 assert.equal(list.parties.find(p=>p.partyId===5).closingOutstanding,expected);
 assert.equal(detail.totalOutstanding,expected);assert.equal(snapshot.payables.byParty.find(p=>p.partyId===5).outstanding,expected);
 assert.equal(snapshot.payables.totalOutstanding,list.totalOutstanding);
 assert.equal(detail.payables.reduce((s,p)=>s+p.outstandingAmount,0),expected-334048);
 assert.equal(detail.balanceAnchors.length,1);assert.equal(snapshot.payables.balanceAnchors.length,1);
 assert.equal((await (await a.detail(10)).json()).totalOutstanding,500000);
 const history=await (await a.list('?month=2026-11&historyPartyId=5')).json();assert.equal(history.totalOutstanding,expected);assert.equal(history.balanceAnchors.length,1);
 const day=await (await a.list('?asOf=2026-11-17')).json();assert.equal(day.parties.find(p=>p.partyId===5).outstandingAmount,4982000);
 const prior=await (await a.list('?asOf=2026-11-16')).json();assert.equal(prior.parties.find(p=>p.partyId===5).outstandingAmount,4647952);
 const old=await a.snapshot('2026-10');assert.equal(old.payables.balanceAnchors,undefined);
});

test('missing structure is compatible on every read path; permission faults do not silently drop the anchor',async()=>{
 const old=app({missing:true});
 assert.equal((await old.list('?month=2026-11')).status,200);
 assert.equal((await (await old.detail(5)).json()).totalOutstanding,4647952);
 assert.equal((await old.snapshot('2026-11')).payables.totalOutstanding,5147952);
 assert.deepEqual(await old.anchorData.loadPayableBalanceAnchors(),{data:[],error:null});
 assert.equal(old.anchorData.isMissingPayableBalanceAnchorTable({code:'42P01',message:'relation public.other_table does not exist'}),false);
 assert.equal(old.anchorData.isMissingPayableBalanceAnchorTable({code:'42501',message:'permission denied for ledger_payable_balance_anchors'}),false);
 const denied=app({denied:true});assert.equal((await denied.list('')).status,403);assert.equal((await denied.detail(5)).status,403);
 const bad=app({anchorError:{code:'42501',message:'permission denied for ledger_payable_balance_anchors'}});
 assert.equal((await bad.list('?month=2026-11')).status,500);assert.equal((await bad.detail(5)).status,500);await assert.rejects(bad.snapshot('2026-11'),/ANCHOR_LOAD_FAILED/);
});

test('backdated drift is an explicit HOLD, never a misleading raw total',async()=>{
 const a=app({backdated:true});
 for(const response of [await a.list('?month=2026-11'),await a.detail(5)]){
  assert.equal(response.status,500);assert.equal((await response.json()).code,'PAYABLE_BALANCE_ANCHOR_BASELINE_DRIFT');
 }
 await assert.rejects(a.snapshot('2026-11'),/BASELINE_DRIFT/);
});

test('the actual note/totals render Owner basis separately from purchases and payment controls',()=>{
 const source=readFileSync('app/(protected)/admin/ledger/entries/page.tsx','utf8');
 const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const nodes=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&['PayableBalanceAnchorNote','PayableMonthTotals'].includes(n.name?.text));
 const code=ts.transpileModule(nodes.map(n=>n.getText(ast)).join('\n')+'\nexport {PayableBalanceAnchorNote,PayableMonthTotals}',{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
 const testModule={exports:{}};new Function('require','module','exports','styles','money',code)(()=>runtime,testModule,testModule.exports,{},String);
 const note=renderToStaticMarkup(React.createElement(testModule.exports.PayableBalanceAnchorNote,{anchors:[anchor],vi:false}));
 assert.match(note,/Owner 확인 기준잔액 조정/);assert.match(note,/334048/);assert.match(note,/4982000/);assert.match(note,/차이 원천 미확인/);
 assert.match(note,/결제 가능한 개별 채무에 포함되지 않습니다/);assert.doesNotMatch(note,/<input|<button|<select/);
 const totals=renderToStaticMarkup(React.createElement(testModule.exports.PayableMonthTotals,{summary:{openingOutstanding:4647952,periodPurchases:0,periodPayments:0,periodBalanceAdjustment:334048,closingOutstanding:4982000},vi:false}));
 assert.match(totals,/당월 외상 발생/);assert.match(totals,/Owner 확인 기준잔액 조정/);
});
