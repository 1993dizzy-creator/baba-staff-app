import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require=createRequire(import.meta.url);
const source=readFileSync('lib/ledger/owners.ts','utf8');
const page=readFileSync('app/(protected)/admin/ledger/owners/page.tsx','utf8');
const settings=readFileSync('app/(protected)/admin/ledger/settings/page.tsx','utf8');
function load(path,deps,jsx=false){
  const mod={exports:{}};
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:jsx?ts.JsxEmit.ReactJSX:undefined}}).outputText;
  new Function('require','module','exports',code)(name=>{assert.ok(name in deps,`Unexpected import ${name}`);return deps[name]},mod,mod.exports);
  return mod.exports;
}
function dashboardFixture(){
  const calls=[];
  const participant={id:20,user_id:7,is_eligible:true,effective_from:'2026-08-01',effective_to:null,sort_order:1};
  const investments=[
    {participant_id:10,signed_amount:100,entry_type:'opening',occurred_at:'2026-08-31T23:00:00+07:00'},
    {participant_id:10,signed_amount:40,entry_type:'contribution',occurred_at:'2026-09-01T02:30:00+07:00'},
    {participant_id:20,signed_amount:50,entry_type:'contribution',occurred_at:'2026-09-01T03:00:00+07:00'},
    {participant_id:20,signed_amount:500,entry_type:'contribution',occurred_at:'2026-09-10T12:00:00+07:00'},
  ];
  const settlements=[{id:1,through_month:'2026-08-01',status:'confirmed',confirmed_pool:30},{id:2,through_month:'2026-09-01',status:'confirmed',confirmed_pool:100}];
  const allocations=[{id:1,settlement_id:1,participant_id:10,assigned_amount:30,recovery_amount:30,recovery_paid_amount:30,pure_profit_amount:0,pure_profit_paid_amount:0,paid_amount:30},{id:2,settlement_id:2,participant_id:20,assigned_amount:100,recovery_amount:100,recovery_paid_amount:100,pure_profit_amount:0,pure_profit_paid_amount:0,paid_amount:100}];
  let participantReads=0;
  const tables={ledger_owner_investments:investments,ledger_owner_settlements:settlements,ledger_owner_settlement_allocations:allocations,ledger_owner_settlement_policies:[{id:1,effective_month:'2026-08-01',revision:1,lines:[{participant_id:20,settlement_rate:'1'}]}],ledger_fund_accounts:[],users:[{id:7,name:'Cho',username:'cho',role:'owner',is_active:true},{id:8,name:'HAN',username:'han',role:'master',is_active:true},{id:9,name:'Vuong',username:'vuong',role:'owner',is_active:true},{id:10,name:'POS',username:'pos',role:'master',is_active:true}],ledger_month_closures:[{month:'2026-08-01',status:'closed'}],ledger_owner_profit_settings:[{profit_tracking_start_month:'2026-08-01',opening_undistributed_profit:0}]};
  const db={rpc:async()=>({data:{recommendedMax:100},error:null}),from(table){
    const filters=[];
    const query={select(){return query},eq(key,value){filters.push(row=>row[key]===value);return query},neq(key,value){filters.push(row=>row[key]!==value);return query},lte(key,value){filters.push(row=>row[key]<=value);return query},lt(key,value){calls.push({table,key,value});filters.push(row=>key==='occurred_at'?new Date(row[key])<new Date(value):row[key]<value);return query},or(){return query},in(key,values){filters.push(row=>values.includes(row[key]));return query},order(){return query},limit(){return query},maybeSingle(){return Promise.resolve({data:rows()[0]??null,error:null})},then(resolve,reject){return Promise.resolve({data:rows(),error:null}).then(resolve,reject)}};
    function rows(){if(table==='ledger_owner_participants')return ++participantReads===1?[participant]:[{id:10,user_id:7},{id:20,user_id:7}];return(tables[table]??[]).filter(row=>filters.every(filter=>filter(row)))}
    return query;
  }};
  const ownerModule=load('lib/ledger/owners.ts',{'server-only':{},'@/lib/supabase/server':{supabaseServer:db},'@/lib/ledger/owner-allocation-core':require('../lib/ledger/owner-allocation-core.ts'),'@/lib/common/business-time':require('../lib/common/business-time.ts')});
  return {load:ownerModule.loadOwnerDashboard,calls};
}

test('historical investments use the shared 03:00 business-month cutoff',async()=>{
  const fixture=dashboardFixture();
  const result=await fixture.load('2026-08',{investmentView:'month_end'});
  const cutoff=fixture.calls.find(call=>call.table==='ledger_owner_investments').value;
  assert.equal(cutoff,'2026-09-01T03:00:00+07:00');
  assert.deepEqual(['2026-08-31T23:00:00+07:00','2026-09-01T02:30:00+07:00','2026-09-01T03:00:00+07:00','2026-09-10T12:00:00+07:00'].map(value=>new Date(value)<new Date(cutoff)),[true,true,false,false]);
  assert.equal(result.owners[0].cumulativeInvested,140);
  assert.equal(result.owners[0].recoveryPaid,30);
  assert.equal(result.owners[0].cashUnrecovered,110);
  assert.equal(result.settlements.length,1);
  assert.deepEqual(result.participantUser,{'10':7,'20':7});
});
test('current dashboard includes past investments and excludes a later investment in the same month',async()=>{
  const realNow=Date.now,fixedNow=new Date('2026-09-01T03:15:00+07:00').getTime();
  Date.now=()=>fixedNow;
  try{
    const fixture=dashboardFixture();
    const result=await fixture.load('2026-09',{investmentView:'current'});
    assert.equal(fixture.calls.find(call=>call.table==='ledger_owner_investments').value,new Date(fixedNow).toISOString());
    assert.equal(result.owners[0].cumulativeInvested,190);
    assert.equal(result.owners[0].recoveryPaid,130);
    assert.equal(result.owners[0].cashUnrecovered,60);
  }finally{Date.now=realNow}
});
test('month-end view includes the remaining September investment and keeps participant history together',async()=>{
  const result=await dashboardFixture().load('2026-09',{investmentView:'month_end'});
  assert.equal(result.owners[0].cumulativeInvested,690);
  assert.equal(result.owners[0].recoveryPaid,130);
});
test('owner candidates exclude POS username but retain HAN master and Vuong owner',async()=>{
  const result=await dashboardFixture().load('2026-09',{investmentView:'current'});
  assert.deepEqual(result.users.map(user=>user.name),['Cho','HAN','Vuong']);
  assert.match(source,/\.neq\("username","pos"\)/);
});
test('owners GET chooses explicit view while the settings request keeps month-end default',async()=>{
  const calls=[];
  const api=load('app/api/admin/ledger/owners/route.ts',{'@/lib/ledger/server':{requireLedgerActor:async()=>({actor:{id:1}}),ledgerJson:(body,status=200)=>Response.json(body,{status})},'@/lib/ledger/owners':{OWNER_MONTH:/^\d{4}-(0[1-9]|1[0-2])$/,loadOwnerDashboard:async(month,options)=>{calls.push({month,options});return {owners:[]}}},'@/lib/supabase/server':{supabaseServer:{}}});
  for(const query of ['throughMonth=2026-09&investmentView=current','throughMonth=2026-08&investmentView=month_end','throughMonth=2026-09'])assert.equal((await api.GET(new Request(`http://local/api/admin/ledger/owners?${query}`))).status,200);
  assert.deepEqual(calls,[{month:'2026-09',options:{investmentView:'current'}},{month:'2026-08',options:{investmentView:'month_end'}},{month:'2026-09',options:{investmentView:'month_end'}}]);
  assert.equal((await api.GET(new Request('http://local/api/admin/ledger/owners?throughMonth=2026-09&investmentView=other'))).status,400);
  assert.match(settings,/fetch\(`\/api\/admin\/ledger\/owners\?throughMonth=\$\{month\}`/);
});
test('owners operations remove duplicate settings UI and keep the settings page authoritative',()=>{
  for(const phrase of ['정산 대상 사장 3명','정산 비율 Policy','미분배이익 시작 설정','Requested pool','Allocation 선택','Policy r'])assert.ok(!page.includes(phrase),phrase);
  for(const phrase of ['초기 투자자 설정','투자자 구성 변경','정산 비율 수정','미분배이익 시작 기준'])assert.ok(settings.includes(phrase),phrase);
  for(const phrase of ['총 투자금','회수 완료','미회수 투자금','+ 투자금 등록','사장 정산','최근 정산 내역','/admin/ledger/settings'])assert.ok(page.includes(phrase),phrase);
  assert.match(page,/recovered:owners\.reduce\(\(sum,owner\)=>sum\+Number\(owner\.recoveryPaid\)/);
  assert.match(page,/unrecovered:owners\.reduce\(\(sum,owner\)=>sum\+Number\(owner\.cashUnrecovered\)/);
  assert.match(page,/sheet==="investment"/);
  assert.match(page,/sheet==="recent"&&selectedSettlement/);
  assert.match(page,/remaining>0&&paymentAllocationId!==allocation\.id/);
  assert.match(source,/\.lt\("occurred_at",cutoffAt\)/);
  assert.match(page,/readDashboard\(currentMonth\(\),"current",signal\)/);
  assert.match(page,/readDashboard\(settlementMonth,"month_end",controller\.signal\)/);
});
test('owners header is a compact navigation row and only settlement sheet is top aligned',()=>{
  const css=readFileSync('app/(protected)/admin/ledger/owners/owners.module.css','utf8');
  assert.doesNotMatch(page,/← 장부/);
  assert.match(page,/<Container noPaddingTop>/);
  assert.match(page,/<header className=\{styles\.header\}><Link href="\/admin\/ledger" className=\{styles\.back\} aria-label="장부로 돌아가기">/);
  assert.match(css,/\.header\{display:flex;align-items:center/);
  assert.match(css,/\.page\{display:grid;gap:18px;padding:10px 0 40px/);
  assert.match(page,/sheet==="settlement"\?<BarSheet kind="bottom" topAligned comfortableTop/);
  assert.doesNotMatch(page,/sheet==="investment"\?<BarSheet kind="bottom" topAligned/);
});
test('investor setup uses stored start month and separate participant and policy months',()=>{
  const css=readFileSync('app/(protected)/admin/ledger/ledger-settings.module.css','utf8');
  assert.match(settings,/const \[participantEffectiveMonth, setParticipantEffectiveMonth\] = useState\(""\)/);
  assert.match(settings,/const \[policyEffectiveMonth, setPolicyEffectiveMonth\] = useState\(month\)/);
  assert.doesNotMatch(settings,/\[effectiveMonth, setEffectiveMonth\]/);
  assert.doesNotMatch(settings,/<span>📅 적용 월<\/span>/);
  assert.match(settings,/owners\.participants\.length === 0\s*\? <section className=\{styles\.initialInvestors\}/);
  assert.match(settings,/aria-label="초기 투자자 설정"/);
  assert.match(settings,/<summary>투자자 구성 변경<\/summary><div className=\{styles\.detailBody\}>\{participantForm\}/);
  assert.match(settings,/row\.effective_from\?\.slice\(0, 7\)/);
  assert.match(settings,/투자자 구성 시작월/);
  assert.match(settings,/정산 비율 적용월/);
  assert.match(settings,/selectedUsers\.length !== 3 \|\| !participantEffectiveMonth/);
  assert.match(css,/\.ownerSummary\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/);
});
test('settlement month data stays separate from current investment cards',()=>{
  let slot=0;const updates=[],elements=[];
  const current={owners:[{participantId:20,userId:7,name:'Cho',cumulativeInvested:100,recoveryPaid:20,cashUnrecovered:80,recoveryAllocated:20,pureProfitAllocated:0,pureProfitPaid:0,unpaidSettlement:0}],policy:{lines:[{participant_id:20,settlement_rate:'1'}]},accounts:[],settlements:[],closedMonths:['2026-08'],capacity:{recommendedMax:200},participantUser:{'20':7}};
  const historical={...current,owners:[{...current.owners[0],cumulativeInvested:10}],capacity:{recommendedMax:50}};
  const states={0:current,1:{month:'2026-08',data:historical},2:'2026-08',3:'settlement'};
  const react={...React,useState(initial){const index=slot++;return[Object.hasOwn(states,index)?states[index]:typeof initial==='function'?initial():initial,value=>updates.push({index,value})]},useCallback:fn=>fn,useMemo:fn=>fn(),useEffect:()=>{}};
  const h=React.createElement;
  const jsx=require('react/jsx-runtime');
  const tracked={...jsx,...Object.fromEntries(['jsx','jsxs'].map(name=>[name,(type,props,...rest)=>{elements.push({type,props});return jsx[name](type,props,...rest)}]))};
  const pageModule=load('app/(protected)/admin/ledger/owners/page.tsx',{react,'react/jsx-runtime':tracked,'next/link':{default:({children,...props})=>h('a',props,children)},'@/components/Container':{default:({children})=>h('div',null,children)},'@/components/bar/keeping/KeepingUi':{BarSheet:({children,title,footer})=>h('section',{'aria-label':title},children,footer)},'@/lib/common/business-time':{getBusinessDate:()=> '2026-09-16'},'@/lib/ledger/owner-allocation-core':require('../lib/ledger/owner-allocation-core.ts'),'./owners.module.css':{default:new Proxy({},{get:(_,key)=>key})}},true);
  const html=renderToStaticMarkup(h(pageModule.default));
  assert.match(html,/총 투자금[^<]*<\/span><strong>100 ₫/);
  assert.match(html,/정산 가능 최대[^<]*<\/span><strong>50 ₫/);
  assert.doesNotMatch(html,/총 투자금[^<]*<\/span><strong>10 ₫/);
  const monthSelect=elements.find(item=>item.type==='select'&&item.props.value==='2026-08');
  monthSelect.props.onChange({target:{value:'2026-07'}});
  assert.ok(updates.some(item=>item.index===2&&item.value==='2026-07'));
  assert.ok(updates.some(item=>item.index===1&&item.value===null));
  assert.ok(!updates.some(item=>item.index===0));
});
