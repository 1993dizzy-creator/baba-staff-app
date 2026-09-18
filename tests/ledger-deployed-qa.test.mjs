import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { calculatePayableBalances } = require('../lib/ledger/payables.ts');
const h = React.createElement;
const entriesPath='app/(protected)/admin/ledger/entries/page.tsx';
const cardPath='app/(protected)/admin/ledger/card-settlements/page.tsx';
const nowMonth=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit'}).format(new Date()).slice(0,7);

// Render the actual TSX components with state fixtures. Effects are captured,
// never automatically run. Tests use only local response doubles.
function pageFixture(path, states, fetcher=()=>{throw Error('Unexpected network request');}) {
  let index=0;const effects=[],requests=[],updates=[],elements=[],calls=[];
  const entries=path===entriesPath;
  // Slot 0 in older fixtures was the month state. The page now reads that month
  // from the URL, so preserve the remaining fixture slots through this adapter.
  const react={...React,useState(initial){const slot=index+++(entries?1:0);return [Object.hasOwn(states,slot)?states[slot]:typeof initial==='function'?initial():initial,value=>updates.push({slot,value})];},useEffect(callback){effects.push(callback);}};
  const box=({children})=>h('div',null,children);
  const keeping={BarSheet:({children,footer,title})=>h('section',{role:'dialog','aria-label':title},h('h2',null,title),children,footer),BarField:({children,label})=>h('label',null,label,typeof children==='function'?children({id:'field'}):children),keepingInputStyle:{},primaryButtonStyle:{},secondaryButtonStyle:{}};
  const runtime=require('react/jsx-runtime');
  const trackedRuntime={...runtime,...Object.fromEntries(['jsx','jsxs'].map(name=>[name,(type,props,...rest)=>{elements.push({type,props});return runtime[name](type,props,...rest);}]))};
  const deps={
    react,'react/jsx-runtime':trackedRuntime,'next/link':{default:({children,...props})=>h('a',props,children)},
    'next/navigation':{useRouter:()=>({push:()=>{}}),usePathname:()=>'/admin/ledger/entries',useSearchParams:()=>new URLSearchParams(entries?`month=${states[0]}`:'')},
    '@/components/Container':{default:box},'@/lib/language-context':{useLanguage:()=>({lang:'ko'})},'@/lib/styles/ui':{ui:{}},
    '@/components/bar/keeping/KeepingUi':keeping,
    '@/lib/ledger/entries':require('../lib/ledger/entries.ts'),
    '@/lib/ledger/month-query':require('../lib/ledger/month-query.ts'),
    '@/lib/ledger/payable-date-groups':require('../lib/ledger/payable-date-groups.ts'),
    '@/lib/ledger/manual-entry-amount':require('../lib/ledger/manual-entry-amount.ts'),
    '@/lib/ledger/manual-entry-policy':require('../lib/ledger/manual-entry-policy.ts'),
    '@/lib/common/business-time':require('../lib/common/business-time.ts'),
    './entries.module.css':{default:new Proxy({},{get:(_,key)=>String(key)})},
    './card-settlements.module.css':{default:new Proxy({},{get:(_,key)=>String(key)})},'@/lib/ledger/card-settlements':require('../lib/ledger/card-settlements.ts'),
  };
  const testModule={exports:{}};
  const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  new Function('require','module','exports','fetch',code)(name=>{assert.ok(name in deps,`Unexpected dependency ${name}`);return deps[name];},testModule,testModule.exports,(url,options)=>{requests.push(String(url));calls.push({url:String(url),options});return fetcher(String(url),options);});
  const html=renderToStaticMarkup(h(testModule.exports.default));
  return {html,effects,requests,updates,elements,calls};
}
function payableFixture(month) {
  const source=(id,date,amount)=>({id,party_id:10,original_amount:amount,status:'partially_paid',expense:{business_date:date,status:'confirmed',source_snapshot:{item_name:'Demo purchase'}}});
  const rows=[source(1,'2026-08-10',1000),source(2,'2026-09-10',500)];
  const result=calculatePayableBalances(rows,[{payable_id:1,allocated_amount:400,payment:{business_date:'2026-08-20',status:'confirmed'}}],month);
  const party={...result.partySummaries[0],partyName:'Demo supplier',partnerType:null,outstandingAmount:result.summary.closingOutstanding,partialPaidAmount:400,totalOpenAmount:1500,openCount:result.payables.length};
  return {...result,month,parties:[party],historyPayables:result.payables};
}
const ledgerFixture=month=>({month,fundsView:{month,mode:'provisional',asOf:`${month}-01`,businessDateExclusive:null},summary:{income:9999,receivedIncome:8888,expense:7777,operatingProfit:2222,paidExpense:6666,displayedExpense:6666,cardGrossSales:500,monthlySettledGross:500,actualCardDeposits:0,unsettledCardGross:500},accounts:[],categories:[],partners:[],entries:[]});
function entriesFixture(month,{selected=false,payables=payableFixture(month),fetcher,payableExpanded=true,cardExpanded=false,cardSummary=null,ledgerSummary=null,closeState=null,reopenOpen=false,reopenReason=''}={}) {
  const ledger=ledgerFixture(month);
  if(ledgerSummary)ledger.summary={...ledger.summary,...ledgerSummary};
  return pageFixture(entriesPath,{0:month,1:ledger,2:false,5:closeState,14:payableExpanded,15:payables,16:selected?{...payables.parties[0],viewMonth:month}:null,22:cardExpanded,23:cardSummary,28:reopenOpen,29:reopenReason},fetcher);
}

test('closed month shows a compact reopen entry point and keeps ledger writes disabled',()=>{
  const state=entriesFixture('2026-08',{closeState:{month:'2026-08',state:'closed',revision:1}});
  assert.match(state.html,/8월 장부 마감됨/);
  assert.match(state.html,/1차 마감/);
  const add=state.elements.find(item=>item.type==='button'&&item.props.children==='장부 내역 추가');
  assert.equal(add?.props.disabled,true);
  const reopen=state.elements.find(item=>item.type==='button'&&item.props.children==='마감 다시 열기');
  assert.ok(reopen);
  reopen.props.onClick();
  assert.equal(state.calls.length,0,'first click only opens confirmation');
  assert.ok(state.updates.some(update=>update.slot===28&&update.value===true));

  const sheet=entriesFixture('2026-08',{closeState:{month:'2026-08',state:'closed',revision:1},reopenOpen:true});
  assert.match(sheet.html,/8월 마감 다시 열기/);
  assert.match(sheet.html,/기존 마감본은 이력으로 안전하게 보존됩니다/);
  const confirm=sheet.elements.find(item=>item.type==='button'&&item.props.children==='재검토 위해 마감 열기');
  assert.equal(confirm?.props.disabled,true);
  assert.equal(sheet.calls.length,0);
});

test('reopen confirmation posts reason, reloads all selected-month data and unlocks writes',async()=>{
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    if(options?.method==='POST')return Response.json({ok:true,result:{status:'reopened'}});
    if(url.includes('month-close'))return Response.json({month:'2026-08',state:'reopened',closure:{revision:1}});
    if(url.includes('/payables'))return Response.json(payableFixture('2026-08'));
    if(url.includes('/investments'))return Response.json({month:'2026-08',configured:false,summary:{openingCumulative:0,periodOpening:0,periodContribution:0,periodAdjustment:0,periodNetChange:0,closingCumulative:0},events:[]});
    return Response.json(ledgerFixture('2026-08'));
  };
  const state=entriesFixture('2026-08',{closeState:{month:'2026-08',state:'closed',revision:1},reopenOpen:true,reopenReason:' 회계 재검토 ',fetcher});
  const confirm=state.elements.find(item=>item.type==='button'&&item.props.children==='재검토 위해 마감 열기');
  assert.equal(confirm?.props.disabled,false);
  confirm.props.onClick();
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  const post=calls.find(call=>call.options?.method==='POST');
  assert.equal(post?.url,'/api/admin/ledger/month-close');
  assert.deepEqual(JSON.parse(post.options.body),{action:'reopen',month:'2026-08',reason:'회계 재검토'});
  for(const path of ['/api/admin/ledger?month=2026-08','/api/admin/ledger/month-close?month=2026-08','/api/admin/ledger/payables?month=2026-08','/api/admin/ledger/investments?month=2026-08']){
    assert.ok(calls.some(call=>call.url===path&&call.options?.method!=='POST'),path);
  }
  assert.ok(state.updates.some(update=>update.slot===28&&update.value===false),'sheet closes');
  assert.ok(state.updates.some(update=>update.slot===5&&update.value.state==='reopened'),'state refreshes');
  assert.ok(state.updates.some(update=>update.slot===1&&update.value.month==='2026-08'),'ledger reloads');
  assert.ok(state.updates.some(update=>update.slot===15),'payables reload');
  assert.ok(state.updates.some(update=>update.slot===26),'investments reload');
  assert.ok(state.updates.some(update=>update.slot===4&&update.value.includes('월마감을 다시 열었습니다')),'success notice');

  const reopened=entriesFixture('2026-08',{closeState:{month:'2026-08',state:'reopened',revision:1}});
  const add=reopened.elements.find(item=>item.type==='button'&&item.props.children==='장부 내역 추가');
  assert.equal(add?.props.disabled,false);
  assert.match(reopened.html,/8월 재검토 중/);
  assert.match(reopened.html,/href="\/admin\/ledger\/month-close\?month=2026-08"/);
  assert.doesNotMatch(reopened.html,/마감 다시 열기/);
});

test('open month keeps existing behavior; opening amounts inherit the app font',()=>{
  const open=entriesFixture('2026-08',{closeState:{month:'2026-08',state:'open',revision:null}});
  assert.doesNotMatch(open.html,/장부 마감됨|재검토 중|마감 다시 열기/);
  const add=open.elements.find(item=>item.type==='button'&&item.props.children==='장부 내역 추가');
  assert.equal(add?.props.disabled,false);
  const css=readFileSync('app/(protected)/admin/ledger/entries/entries.module.css','utf8');
  assert.match(css,/\.openingToggle\{[^}]*font:inherit;color:inherit/);
  assert.match(css,/\.openingGrid strong\{[^}]*font-family:inherit;font-size:14px;font-weight:900;line-height:1\.2/);
  const monthPage=readFileSync('app/(protected)/admin/ledger/month-close/page.tsx','utf8');
  assert.match(monthPage,/searchParams\.get\("month"\)/);
  assert.match(monthPage,/<MonthClosePanel key=\{month\} month=\{month\}/);
});
test('entries month loading actually sends selected month to payables API',async()=>{
  for(const month of ['2026-08','2026-09']){
    const state=entriesFixture(month,{fetcher:async(url)=>Response.json(url.includes('month-close')?{state:'open'}:url.includes('payables')?payableFixture(month):ledgerFixture(month))});
    const cleanup=state.effects[0]();await new Promise(resolve=>setImmediate(resolve));cleanup();
    assert.ok(state.requests.includes(`/api/admin/ledger/payables?month=${month}`));assert.ok(!state.requests.includes('/api/admin/ledger/payables'));
  }
});
test('August and September render different closing with month-only payments and preserved accounting totals',()=>{
  const august=entriesFixture('2026-08').html,september=entriesFixture('2026-09').html;
  assert.match(august,/월말 미납<\/dt><dd>600 ₫/);assert.match(september,/월말 미납<\/dt><dd>1\.100 ₫/);
  assert.match(august,/당월 지급<\/dt><dd>400 ₫/);assert.match(september,/당월 지급<\/dt><dd>0 ₫/);
  assert.match(september,/9월 지급[^<]*: 0/);
  for(const html of [august,september]) {
    assert.doesNotMatch(html,/누적 부분결제|class="payablePartialPayment"/);
    assert.match(html,/(8|9)월 외상[^<]*:/);
    assert.match(html,/aria-label="월말 미납"/);
  }
  assert.match(september,/9\.999 ₫/);assert.match(september,/6\.666 ₫/);
});
test('historical drilldown renders month-end sources with no current payment controls or current detail read',()=>{
  const state=entriesFixture('2026-08',{selected:true});
  assert.match(state.html,/선택월 말 기준 잔액입니다\. 과거 내역은 결제할 수 없습니다/);assert.match(state.html,/8월 10일/);assert.match(state.html,/월말 미납 상세/);
  assert.doesNotMatch(state.html,/출금 계정|선택 일자 .*건 결제|현재 결제|type="checkbox"/);assert.equal(state.requests.length,0);
});
test('a drilldown selected in another month cannot expose payment controls after month navigation',()=>{
  const month=nowMonth(),payables=payableFixture('2026-09');payables.month=month;
  const state=pageFixture(entriesPath,{0:month,1:ledgerFixture(month),2:false,14:true,15:payables,16:{...payables.parties[0],viewMonth:'2026-08'}});
  assert.doesNotMatch(state.html,/선택 일자 .*건 결제|출금 계정/);
});
test('current-month operational detail retains its payment form',()=>{
  const month=nowMonth(),payables=payableFixture('2026-09');payables.month=month;
  const state=entriesFixture(month,{selected:true,payables});assert.match(state.html,/선택 일자 0건 결제/);assert.match(state.html,/출금 계정/);
});
test('zero reconciliations retain compact collapsed sales and entry button without displaying a deposit form',()=>{
  const sale=(id,date,amount)=>({id,business_date:date,amount,allocatedGrossAmount:0,outstandingGrossAmount:amount});
  const monthly=[sale(2,'2026-09-03',500)],prior=[sale(1,'2026-08-02',1000)];
  const data={accounts:[],sales:[...prior,...monthly],monthlySales:monthly,priorUnreconciledSales:prior,totalReconciliationCount:0,reconciliations:[],summary:{monthlyCardGross:500,monthlyReconciledGross:0,monthlySettledGross:0,monthlyUnreconciledGross:500,totalUnreconciledGross:1500,cardPendingBalance:1500,actualCardDeposits:0,monthlyUnmatchedDeposits:0,monthlyCompletedGross:0,monthlyCompletedDeposit:0,monthlyCompletedDifference:0,actualDifferenceRate:null}};
  const state=pageFixture(cardPath,{0:'2026-09',1:data});
  assert.match(state.html,/dateTime="2026-09-03"/);assert.match(state.html,/dateTime="2026-08-02"/);assert.match(state.html,/POS 상세/);
  assert.match(state.html,/등록된 카드 입금이 없습니다/);assert.match(state.html,/카드 현황 \(9월\)/);
  assert.equal((state.html.match(/<details class="card">/g)||[]).length,2);
  assert.doesNotMatch(state.html,/<details[^>]*open|datetime-local|Gross|card_clearing|카드미정산 계정/);
  assert.ok(state.html.indexOf('미정산 카드매출')<state.html.indexOf('＋ 카드 입금 등록'));
  assert.ok(state.html.indexOf('＋ 카드 입금 등록')<state.html.indexOf('카드 입금 내역'));
  assert.equal(state.requests.length,0);
});

test('payable accordion keeps its closing total visible but puts all four monthly cards inside expansion',()=>{
  for(const month of ['2026-08','2026-09']) {
    const collapsed=entriesFixture(month,{payableExpanded:false}).html;
    assert.match(collapsed,/aria-expanded="false" aria-controls="payable-summary-body"/);
    assert.doesNotMatch(collapsed,/id="payable-summary-body"|전월 이월 미납|당월 외상 발생|당월 지급/);
    assert.match(collapsed,month==='2026-08'?/600 ₫/:/1\.100 ₫/);
    const monthNumber=Number(month.slice(5));
    assert.ok(collapsed.includes(`미납금 현황 (${monthNumber}월)`));
    assert.ok(collapsed.includes(`카드 정산 현황 (${monthNumber}월)`));
    assert.doesNotMatch(collapsed,/class="statusMonth"/);
    const expanded=entriesFixture(month).html;
    assert.match(expanded,/id="payable-summary-body"/);
    for(const label of ['↪️ 전월 이월 미납','📦 당월 외상 발생','💸 당월 지급','🧾 월말 미납']) assert.ok(expanded.includes(label));
  }
  const empty={month:'2026-08',parties:[],payables:[],summary:{openingOutstanding:0,periodPurchases:0,periodPayments:0,closingOutstanding:0,totalOutstanding:0}};
  assert.match(entriesFixture('2026-08',{payables:empty}).html,/id="payable-summary-body"/);
});

const cardSummary={monthlyCardGross:1000,monthlySettledGross:200,monthlyUnreconciledGross:600,monthlySettlementDifference:18,totalUnreconciledGross:1600,cardPendingBalance:1582};
test('card status accordion shows four API metrics and a detail link without internal accounting labels',()=>{
  const collapsed=entriesFixture('2026-09',{payableExpanded:false}).html;
  assert.match(collapsed,/카드 정산 현황/);assert.doesNotMatch(collapsed,/id="card-settlement-body"|href="\/admin\/ledger\/card-settlements"/);
  const expanded=entriesFixture('2026-09',{cardExpanded:true,cardSummary:{month:'2026-09',summary:cardSummary}}).html;
  const body=expanded.slice(expanded.indexOf('id="card-settlement-body"'),expanded.indexOf('id="card-settlement-body"')+2200);
  for(const value of ['1.000 ₫','200 ₫','600 ₫','18 ₫']) assert.ok(body.includes(value));
  assert.match(expanded,/aria-label="선택월 정산 완료율">100%/);
  assert.match(body,/수수료\/차액/);
  assert.doesNotMatch(body,/전체 미정산/);
  assert.doesNotMatch(expanded,/Gross|card_clearing|카드미정산 계정 잔액|1\.582 ₫/);
  assert.match(body,/href="\/admin\/ledger\/card-settlements"/);assert.match(body,/상세 보기/);
  assert.doesNotMatch(body,/datetime-local|부분 저장|정산 확정/);
  const stale=entriesFixture('2026-09',{cardExpanded:true,cardSummary:{month:'2026-08',summary:cardSummary}}).html;
  assert.match(stale,/카드 정산 현황을 불러오는 중/);assert.doesNotMatch(stale,/1\.582 ₫/);
});
test('August reference summary keeps month-end outstanding distinct from sale-month settlement difference',()=>{
  // The old .326 fixture was synthetic precision input; the confirmed August
  // sale-month attribution is .327 and is independent of the month-end cutoff.
  const html=entriesFixture('2026-08',{cardExpanded:true,ledgerSummary:{income:734686553,paidExpense:448445598.5,displayedExpense:448445598.5,cardGrossSales:225925720,monthlySettledGross:197992160},cardSummary:{month:'2026-08',summary:{...cardSummary,monthlyCardGross:225925720,monthlySettledGross:197992160,monthlyUnreconciledGross:27933560,monthlySettlementDifference:4860925.327}}}).html;
  assert.match(html,/734\.686\.553 ₫/);
  assert.match(html,/448\.445\.599 ₫/);
  assert.match(html,/선택월 정산 완료율">87\.6%/);
  assert.match(html,/197\.992\.160 ₫/);
  assert.match(html,/27\.933\.560 ₫/);
  assert.match(html,/4\.860\.925 ₫/);
  assert.match(html,/실제 입금은 입금월 기준, 수수료\/차액은 매출월 귀속 기준입니다/);
  assert.doesNotMatch(html,/전체 미정산/);
});
test('zero card sales show a dash in the settlement-rate header',()=>{
  const html=entriesFixture('2026-08',{ledgerSummary:{cardGrossSales:0,monthlySettledGross:0}}).html;
  assert.match(html,/선택월 정산 완료율">-/);
});

test('expanded card status reads the selected month and collapsed status does not request extra data',async()=>{
  for(const month of ['2026-08','2026-09']) {
    const state=entriesFixture(month,{cardExpanded:true,fetcher:async()=>Response.json({summary:cardSummary})});
    const cleanup=state.effects[1]();await new Promise(resolve=>setImmediate(resolve));cleanup();
    assert.deepEqual(state.requests,[`/api/admin/ledger/card-settlements?month=${month}`]);
    assert.ok(state.updates.some(update=>update.slot===23&&update.value.month===month));
  }
  const state=entriesFixture('2026-09');state.effects[1]();assert.equal(state.requests.length,0);
});

test('opening account cards render readable cash, corporate and personal emojis while preserving clearing exclusion',()=>{
  const data=ledgerFixture('2026-09');
  data.accounts=['store_cash','baba_corporate_bank','vuong_personal_custody','cho_personal_custody','card_clearing'].map((code,id)=>({id,code,type:code==='card_clearing'?'card_clearing':'cash',is_active:true,is_business_fund:true,display_name:code,openingBalance:100,balance:100}));
  const state=pageFixture(entriesPath,{0:'2026-09',1:data,2:false,11:true});
  for(const emoji of ['💵','🏦','👤']) assert.ok(state.html.includes(emoji));
  assert.match(state.html,/class="accountEmoji" aria-hidden="true"/);
  assert.doesNotMatch(state.html,/card_clearing/);
});

test('selected deposit keeps fee recommendation, editable allocation, POS detail and settlement previews',()=>{
  const sale={id:1,business_date:'2026-08-02',amount:1000,allocatedGrossAmount:0,outstandingGrossAmount:1000};
  const rec={id:10,deposit_date:'2026-09-03',deposit_amount:982,matched_gross_amount:0,difference_amount:0,status:'unmatched',memo:null,destination:null};
  const data={accounts:[],sales:[sale],monthlySales:[],priorUnreconciledSales:[sale],totalReconciliationCount:1,reconciliations:[rec],summary:{...cardSummary,monthlyReconciledGross:400,actualCardDeposits:982,monthlyUnmatchedDeposits:982,monthlyCompletedGross:0,monthlyCompletedDeposit:0,monthlyCompletedDifference:0,actualDifferenceRate:null}};
  const state=pageFixture(cardPath,{0:'2026-09',1:data,9:10,10:{1:'1000'},11:[sale]});
  assert.match(state.html,/value="1.8"/);assert.match(state.html,/오래된 매출부터 추천/);
  assert.match(state.html,/role="dialog" aria-label="09\/03 매출 연결"/);assert.match(state.html,/정산 대상/);
  assert.match(state.html,/max="1000" step="0.001" class="input" value="1000"/);
  assert.match(state.html,/1\.800%/);assert.match(state.html,/POS 상세/);
  assert.match(state.html,/class="secondary">부분 저장<\/button>/);assert.match(state.html,/class="primary">정산 확정<\/button>/);
  assert.doesNotMatch(state.html,/Gross|card_clearing/);
  assert.equal(state.requests.length,0);
});

test('opening a deposit excludes only future-day card sales from editable and recommendation candidates',async()=>{
  const sales=[
    {id:1,business_date:'2026-08-19',amount:1000,allocatedGrossAmount:0,outstandingGrossAmount:1000},
    {id:2,business_date:'2026-08-20',amount:1000,allocatedGrossAmount:0,outstandingGrossAmount:1000},
    {id:3,business_date:'2026-08-21',amount:1000,allocatedGrossAmount:0,outstandingGrossAmount:1000},
  ];
  const rec={id:10,deposit_date:'2026-08-20',deposit_amount:982,matched_gross_amount:0,difference_amount:0,status:'unmatched',memo:null,destination:null};
  const data={accounts:[],sales,monthlySales:sales,priorUnreconciledSales:[],totalReconciliationCount:1,reconciliations:[rec],summary:{...cardSummary,monthlyUnreconciledGross:3000,actualCardDeposits:982,monthlyUnmatchedDeposits:982}};
  const state=pageFixture(cardPath,{0:'2026-08',1:data},async url=>Response.json(url.endsWith('/10')?{reconciliation:{...rec,lines:[]}}:data));
  const link=state.elements.find(element=>element.type==='button'&&String(element.props.children).includes('매출 연결'));
  link.props.onClick({currentTarget:{}});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(state.updates.findLast(update=>update.slot===11).value.map(row=>row.id),[1,2]);
  assert.ok(!Object.hasOwn(state.updates.findLast(update=>update.slot===10).value,3));
});

test('a DB future-card-sale rejection renders a clear date-aware message',async()=>{
  const sale={id:3,business_date:'2026-08-21',amount:1000,allocatedGrossAmount:0,outstandingGrossAmount:1000};
  const rec={id:10,deposit_date:'2026-08-20',deposit_amount:500,matched_gross_amount:0,difference_amount:0,status:'unmatched',memo:null,destination:null};
  const data={accounts:[],sales:[sale],monthlySales:[sale],priorUnreconciledSales:[],reconciliations:[rec],summary:{...cardSummary}};
  const state=pageFixture(cardPath,{0:'2026-08',1:data,9:10,10:{3:'500'},11:[sale]},async()=>Response.json({ok:false,code:'FUTURE_CARD_SALE',result:{transactionId:3,saleBusinessDate:'2026-08-21',depositDate:'2026-08-20'}},{status:409}));
  state.elements.find(element=>element.type==='button'&&element.props.children==='부분 저장').props.onClick();await new Promise(resolve=>setImmediate(resolve));
  const message=state.updates.findLast(update=>update.slot===2).value;
  assert.match(message,/입금일 이후의 카드매출은 이 입금에 연결할 수 없습니다/);assert.match(message,/2026-08-21/);assert.match(message,/2026-08-20/);
});

test('deposit registration lives in a sheet with the same required form fields and submit target',()=>{
  const data={accounts:[{id:1,code:'store_cash',display_name:'현금'},{id:2,code:'card_clearing',display_name:'card_clearing'}],sales:[],monthlySales:[],priorUnreconciledSales:[],reconciliations:[],summary:{...cardSummary,actualCardDeposits:0,monthlyCompletedDifference:0}};
  const state=pageFixture(cardPath,{0:'2026-08',1:data,14:true});
  assert.match(state.html,/role="dialog" aria-label="카드 입금 등록"/);
  for(const label of ['입금일','실제 입금액','입금계정','Reference','메모']) assert.ok(state.html.includes(label));
  assert.match(state.html,/<form id="card-deposit-form"/);assert.match(state.html,/form="card-deposit-form" type="submit"/);
  assert.match(state.html,/<option value="1">현금/);assert.doesNotMatch(state.html,/card_clearing|Gross/);
  assert.equal(state.requests.length,0);
});

test('completed deposit row opens read-only details and cannot expose matching controls',()=>{
  const rec={id:10,deposit_date:'2026-09-03',deposit_amount:982,matched_gross_amount:1000,difference_amount:18,status:'matched',memo:'Memo',destination:{display_name:'법인'}};
  const data={accounts:[],sales:[],monthlySales:[],priorUnreconciledSales:[],reconciliations:[rec],summary:{...cardSummary,actualCardDeposits:982,monthlyCompletedDifference:18}};
  const plain=pageFixture(cardPath,{0:'2026-09',1:data}).html;
  assert.doesNotMatch(plain,/정산연결|Memo|매출 연결/);
  const state=pageFixture(cardPath,{0:'2026-09',1:data,15:rec});
  assert.match(state.html,/role="dialog" aria-label="2026-09-03 카드 입금"/);assert.match(state.html,/18 ₫/);assert.match(state.html,/Memo/);
  assert.doesNotMatch(state.html.slice(state.html.indexOf('role="dialog"')),/매출 연결|정산 확정|부분 저장|Gross|card_clearing/);
});

test('matched cancellation uses reason confirmation and posts the guarded endpoint',async()=>{
  const rec={id:10,deposit_date:'2026-09-03',deposit_amount:980,matched_gross_amount:1000,difference_amount:20,status:'matched',memo:null,destination:{display_name:'법인'}};
  const data={accounts:[],sales:[],monthlySales:[],priorUnreconciledSales:[],reconciliations:[rec],summary:{...cardSummary,actualCardDeposits:980,monthlyCompletedDifference:20}};
  const initial=pageFixture(cardPath,{0:'2026-09',1:data,15:rec});
  assert.match(initial.html,/정산 취소/);assert.doesNotMatch(initial.html,/취소 사유|취소 확정/);
  const state=pageFixture(cardPath,{0:'2026-09',1:data,15:rec,16:true,17:'  중복 입금  '},async()=>Response.json({ok:true,result:{status:'cancelled'}}));
  assert.match(state.html,/카드 입금 이동과 정산 차액을 역분개하고 연결된 카드매출을 다시 미정산 상태로 돌립니다/);
  assert.match(state.html,/취소 사유/);assert.match(state.html,/취소 확정/);
  state.elements.find(element=>element.type==='button'&&element.props.children==='취소 확정').props.onClick();
  await new Promise(resolve=>setImmediate(resolve));
  const post=state.calls.find(call=>call.options?.method==='POST');
  assert.equal(post.url,'/api/admin/ledger/card-settlements/10/cancel');
  assert.deepEqual(JSON.parse(post.options.body),{reason:'중복 입금'});
});

test('cancelled reconciliation remains visible with audit detail and no link or cancel action',()=>{
  const rec={id:10,deposit_date:'2026-09-03',deposit_amount:980,matched_gross_amount:1000,difference_amount:20,status:'cancelled',cancel_reason:'중복 입금',cancelled_at:'2026-09-15T03:00:00Z',memo:null,destination:{display_name:'법인'}};
  const data={accounts:[],sales:[],monthlySales:[],priorUnreconciledSales:[],reconciliations:[rec],summary:{...cardSummary,actualCardDeposits:0,monthlyCompletedDifference:0}};
  const list=pageFixture(cardPath,{0:'2026-09',1:data}).html;
  assert.match(list,/취소/);
  const detail=pageFixture(cardPath,{0:'2026-09',1:data,15:rec}).html;
  assert.match(detail,/취소 기록/);assert.match(detail,/중복 입금/);
  assert.doesNotMatch(detail,/정산 취소|매출 연결|취소 확정/);
});

test('sheet submit preserves card deposit POST fields and closes only after local successful response',async()=>{
  const data={accounts:[],sales:[],monthlySales:[],priorUnreconciledSales:[],reconciliations:[],summary:{...cardSummary,actualCardDeposits:0,monthlyCompletedDifference:0}};
  const state=pageFixture(cardPath,{0:'2026-09',1:data,4:'2026-09-14T12:30',5:'982',6:'1',7:'REF',8:'Memo',14:true},async(url,options)=>Response.json(options?.method==='POST'?{result:{}}:data));
  let prevented=false;await state.elements.find(element=>element.type==='form').props.onSubmit({preventDefault(){prevented=true;}});
  assert.ok(prevented);
  const post=state.calls.find(call=>call.options?.method==='POST');
  assert.equal(post.url,'/api/admin/ledger/card-settlements');
  assert.deepEqual(JSON.parse(post.options.body),{depositAt:'2026-09-14T12:30:00+07:00',amount:982,destinationAccountId:1,reference:'REF',memo:'Memo'});
  assert.ok(state.updates.some(update=>update.slot===14&&update.value===false));
});

// ---------------------------------------------------------------------------
// Month-transition stale-data regression (entries page)
// ---------------------------------------------------------------------------

test('a previous month\'s ledger/payables payload never paints under the newly selected month — the loading placeholder shows instead',()=>{
  // Simulates the one render that exists between the user picking a new month and that
  // month's fetch resolving: month has already moved to '2026-09' but data/payables are
  // still whatever the (now stale) '2026-08' load last produced, and loading is true
  // (set synchronously alongside setMonth, before any effect runs).
  const state=pageFixture(entriesPath,{0:'2026-09',1:ledgerFixture('2026-08'),2:true,14:true,15:payableFixture('2026-08')});
  assert.doesNotMatch(state.html,/class="summaryGrid"|class="payableSummary"|class="statusCard"|class="book"/);
  assert.match(state.html,/class="empty">장부를 불러오는 중입니다\./);
  // The add-transaction button must not accept new entries while the shown data
  // doesn't yet belong to the selected month.
  assert.match(state.html,/<button type="button" disabled="" class="addButton">/);
});

test('once the new month\'s data arrives (data.month matches the selected month again) the content renders normally',()=>{
  const state=entriesFixture('2026-09').html;
  assert.match(state,/class="summaryGrid"/);
  assert.doesNotMatch(state,/class="empty">장부를 불러오는 중입니다\./);
  assert.match(state,/<button type="button" class="addButton">/);
});

// ---------------------------------------------------------------------------
// Investment status card (entries page). slot 25 = investmentExpanded,
// 26 = investments, 27 = investmentsError.
// ---------------------------------------------------------------------------
const zeroInvestmentSummary={openingCumulative:0,periodOpening:0,periodContribution:0,periodAdjustment:0,periodNetChange:0,closingCumulative:0};

test('investment card sends the selected month to the investments API as part of the main load()',async()=>{
  for(const month of ['2026-08','2026-09']){
    const state=entriesFixture(month,{fetcher:async(url)=>Response.json(
      url.includes('month-close')?{state:'open'}:
      url.includes('/investments')?{month,configured:false,summary:zeroInvestmentSummary,events:[]}:
      url.includes('/payables')?payableFixture(month):ledgerFixture(month),
    )});
    const cleanup=state.effects[0]();await new Promise(resolve=>setImmediate(resolve));cleanup();
    assert.ok(state.requests.includes(`/api/admin/ledger/investments?month=${month}`));
    assert.ok(state.updates.some(update=>update.slot===26&&update.value.month===month));
  }
});

test('investment card distinguishes "not configured" from "configured with zero period activity" — never a misleading 0 ₫ either way',()=>{
  const unconfigured=pageFixture(entriesPath,{
    0:'2026-09',1:ledgerFixture('2026-09'),2:false,25:true,
    26:{month:'2026-09',configured:false,summary:zeroInvestmentSummary,events:[]},
  }).html;
  assert.match(unconfigured,/투자금 기준이 아직 설정되지 않았습니다/);
  assert.doesNotMatch(unconfigured,/이번 달 투자금 변동이 없습니다/);
  assert.match(unconfigured,/href="\/admin\/ledger\/owners"/);
  const header=unconfigured.slice(unconfigured.indexOf('id="investment-title"'),unconfigured.indexOf('id="investment-title"')+400);
  assert.match(header,/미설정/);
  assert.doesNotMatch(header,/0 ₫/);

  const configuredZero=pageFixture(entriesPath,{
    0:'2026-09',1:ledgerFixture('2026-09'),2:false,25:true,
    26:{month:'2026-09',configured:true,summary:{...zeroInvestmentSummary,openingCumulative:12_000_000,closingCumulative:12_000_000},events:[]},
  }).html;
  assert.match(configuredZero,/이번 달 투자금 변동이 없습니다/);
  assert.doesNotMatch(configuredZero,/투자금 기준이 아직 설정되지 않았습니다/);
  assert.match(configuredZero,/12\.000\.000 ₫/); // a real cumulative figure, not hidden behind an "unconfigured" message
});

test('investment card never paints a stale month\'s numbers — it falls back to the loading hint until investments.month matches the selected month',()=>{
  const stale=pageFixture(entriesPath,{
    0:'2026-09',1:ledgerFixture('2026-09'),2:false,25:true,
    26:{month:'2026-08',configured:true,summary:{...zeroInvestmentSummary,periodContribution:5_000_000,periodNetChange:5_000_000,closingCumulative:5_000_000},events:[]},
  }).html;
  assert.doesNotMatch(stale,/5\.000\.000 ₫/);
  assert.match(stale,/투자금 현황을 불러오는 중입니다/);
  const header=stale.slice(stale.indexOf('id="investment-title"'),stale.indexOf('id="investment-title"')+400);
  assert.doesNotMatch(header,/5\.000\.000/);
});

test('an investments fetch failure for the current month shows its own error, never stale or empty-looking numbers',()=>{
  const state=pageFixture(entriesPath,{
    0:'2026-09',1:ledgerFixture('2026-09'),2:false,25:true,
    26:null,27:{month:'2026-09',message:'투자금 현황을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.'},
  }).html;
  assert.match(state,/투자금 현황을 불러오지 못했습니다/);
  assert.doesNotMatch(state,/이번 달 투자금 변동이 없습니다|투자금 기준이 아직 설정되지 않았습니다/);
});

test('investment events render entry-type label, contribution account or "no fund movement", and +/- colored amounts',()=>{
  const state=pageFixture(entriesPath,{
    0:'2026-09',1:ledgerFixture('2026-09'),2:false,25:true,
    26:{month:'2026-09',configured:true,summary:{...zeroInvestmentSummary,periodContribution:10_000_000,periodAdjustment:-2_000_000,periodNetChange:8_000_000,closingCumulative:8_000_000},events:[
      {investmentId:1,participantId:1,participantName:'HAN',entryType:'contribution',amount:10_000_000,businessDate:'2026-09-05',occurredAt:'2026-09-05T08:00:00Z',fundAccountId:4,fundAccountName:'BABA 법인계좌',reason:null},
      {investmentId:2,participantId:2,participantName:'Vuong',entryType:'adjustment',amount:-2_000_000,businessDate:'2026-09-12',occurredAt:'2026-09-12T08:00:00Z',fundAccountId:null,fundAccountName:null,reason:'정정'},
    ]},
  }).html;
  assert.match(state,/HAN/);assert.match(state,/추가 투자/);assert.match(state,/법인/);assert.match(state,/\+10\.000\.000 ₫/);
  assert.match(state,/Vuong/);assert.match(state,/투자금 조정/);assert.match(state,/자금이동 없음/);assert.match(state,/정정/);assert.match(state,/-2\.000\.000 ₫/);
});

test('investment card shows a nonzero period opening and explains contribution as capital rather than profit',()=>{
  const state=pageFixture(entriesPath,{
    0:'2026-09',1:ledgerFixture('2026-09'),2:false,25:true,
    26:{month:'2026-09',configured:true,summary:{openingCumulative:100,periodOpening:20,periodContribution:50,periodAdjustment:-10,periodNetChange:60,closingCumulative:160},events:[]},
  }).html;
  assert.match(state,/당월 기준투자금<\/dt><dd>\+20 ₫/);
  assert.match(state,/월초 누적<\/dt><dd>100 ₫/);
  assert.match(state,/당월 추가투자<\/dt><dd>\+50 ₫/);
  assert.match(state,/당월 조정<\/dt><dd>-10 ₫/);
  assert.match(state,/월말 누적<\/dt><dd>160 ₫/);
  assert.match(state,/추가투자는 자본유입으로 보유금에 포함되며, 영업수입·영업이익에는 포함되지 않습니다/);
});

test('a load() call superseded by a newer one can never write state, even if its response resolves later (stale-response sequence guard)',async()=>{
  const deferreds=[];
  let fetchIndex=0;
  const fetcher=async(url)=>{
    const record={url};
    record.promise=new Promise(resolve=>{record.resolve=resolve;});
    record.batch=fetchIndex<4?'first':'second'; // 4 parallel fetches per load(): ledger, month-close, payables, investments
    fetchIndex++;
    deferreds.push(record);
    return record.promise;
  };
  const respond=url=>{
    if(url.includes('month-close'))return{state:'open'};
    if(url.includes('/investments'))return{month:'2026-09',configured:false,summary:{openingCumulative:0,periodOpening:0,periodContribution:0,periodAdjustment:0,periodNetChange:0,closingCumulative:0},events:[]};
    if(url.includes('/payables'))return payableFixture('2026-09');
    return ledgerFixture('2026-09');
  };
  const state=entriesFixture('2026-09',{fetcher});
  // Fire load() twice back-to-back without an intervening cleanup/abort — the harness's
  // useRef-backed sequence counter is the only thing standing between this and a stale write.
  const cleanupFirst=state.effects[0]();
  const cleanupSecond=state.effects[0]();
  assert.equal(deferreds.length,8);
  // Resolve the SECOND (latest) call's four requests first...
  for(const record of deferreds.filter(r=>r.batch==='second')) record.resolve(Response.json(respond(record.url)));
  await new Promise(resolve=>setImmediate(resolve));
  // ...then resolve the FIRST (now-superseded) call's four requests, arriving last.
  for(const record of deferreds.filter(r=>r.batch==='first')) record.resolve(Response.json(respond(record.url)));
  await new Promise(resolve=>setImmediate(resolve));
  cleanupFirst();cleanupSecond();
  // Only the later-started call is ever allowed to reach setData/setPayables/setClosed/setInvestments,
  // regardless of which one's network response actually completed first.
  assert.equal(state.updates.filter(update=>update.slot===1).length,1);
  assert.equal(state.updates.filter(update=>update.slot===15).length,1);
  assert.equal(state.updates.filter(update=>update.slot===5).length,1);
  assert.equal(state.updates.filter(update=>update.slot===26).length,1);
});

test('a card-settlement response for a month the user has already navigated away from is dropped even without abort (body.month guard)',async()=>{
  const state=entriesFixture('2026-09',{cardExpanded:true,fetcher:async()=>Response.json({month:'2026-08',summary:cardSummary})});
  state.effects[1]();
  await new Promise(resolve=>setImmediate(resolve));
  // slot 23 is cardSettlement — a body whose own month disagrees with the requested
  // month must never be written, independent of the AbortController.
  assert.equal(state.updates.filter(update=>update.slot===23).length,0);
});

// load()'s catch/finally must respect the same sequence guard as its success path — a
// stale (superseded) call must not flip loading off or surface its own error while a
// newer call is still in flight. Both calls below go through the same AbortController
// path (effects[0]), but neither cleanup is invoked before the assertions run, so
// signal.aborted stays false throughout — exactly like a signal-less manual reload
// (onSaved/resolveCandidate/onPaid) racing a newer load(): only loadRequestSequenceRef
// distinguishes them.
function raceLoadFetcher(makeError) {
  const deferreds = []; let fetchIndex = 0;
  const fetcher = async (url) => {
    const record = { url, batch: fetchIndex < 4 ? 'A' : 'B' }; // 4 parallel fetches per load(): ledger, month-close, payables, investments
    fetchIndex++;
    record.promise = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
    deferreds.push(record);
    return record.promise;
  };
  const respondOk = url => url.includes('month-close') ? { state: 'open' } : url.includes('/investments') ? { month: '2026-09', configured: false, summary: { openingCumulative: 0, periodOpening: 0, periodContribution: 0, periodAdjustment: 0, periodNetChange: 0, closingCumulative: 0 }, events: [] } : url.includes('/payables') ? payableFixture('2026-09') : ledgerFixture('2026-09');
  const settleBatch = (letter, ok) => {
    for (const record of deferreds.filter(r => r.batch === letter)) {
      if (ok) record.resolve(Response.json(respondOk(record.url)));
      else record.reject(makeError ? makeError() : new Error('network down'));
    }
  };
  return { fetcher, settleBatch };
}

test('Case A — a stale successful response cannot end loading or write data/payables/closed while a newer request is still pending', async () => {
  const { fetcher, settleBatch } = raceLoadFetcher();
  const state = entriesFixture('2026-09', { fetcher });
  const cleanupA = state.effects[0](); // request A
  const cleanupB = state.effects[0](); // request B, started after A — A is now stale
  settleBatch('A', true); // A completes (success) first, while B is still pending
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.updates.filter(u => u.slot === 1).length, 0, 'stale A must not call setData');
  assert.equal(state.updates.filter(u => u.slot === 15).length, 0, 'stale A must not call setPayables');
  assert.equal(state.updates.filter(u => u.slot === 5).length, 0, 'stale A must not call setClosed');
  assert.equal(state.updates.filter(u => u.slot === 2 && u.value === false).length, 0, 'stale A must not end loading — B is still pending');
  settleBatch('B', true); // now B (the latest request) completes
  await new Promise(resolve => setImmediate(resolve));
  cleanupA(); cleanupB();
  assert.equal(state.updates.filter(u => u.slot === 1).length, 1, 'only B writes data');
  assert.equal(state.updates.filter(u => u.slot === 15).length, 1, 'only B writes payables');
  assert.equal(state.updates.filter(u => u.slot === 5).length, 1, 'only B writes closed');
  assert.equal(state.updates.filter(u => u.slot === 2 && u.value === false).length, 1, 'loading ends exactly once, by B');
});

test('Case B — a stale failed response cannot surface its error or end loading while a newer request is still pending', async () => {
  const { fetcher, settleBatch } = raceLoadFetcher();
  const state = entriesFixture('2026-09', { fetcher });
  const cleanupA = state.effects[0](); // request A
  const cleanupB = state.effects[0](); // request B, started after A — A is now stale
  settleBatch('A', false); // A fails first, while B is still pending
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.updates.filter(u => u.slot === 3 && u.value !== '').length, 0, 'stale A\'s failure must not set an error message');
  assert.equal(state.updates.filter(u => u.slot === 2 && u.value === false).length, 0, 'stale A must not end loading — B is still pending');
  settleBatch('B', true); // B (the latest request) then succeeds normally
  await new Promise(resolve => setImmediate(resolve));
  cleanupA(); cleanupB();
  assert.equal(state.updates.filter(u => u.slot === 3 && u.value !== '').length, 0, 'no error ever surfaces from the stale failure');
  assert.equal(state.updates.filter(u => u.slot === 2 && u.value === false).length, 1, 'loading ends exactly once, by B\'s success');
  assert.equal(state.updates.filter(u => u.slot === 1).length, 1, 'B still writes data normally');
});

test('Case C — when the latest (non-stale) request itself fails, the error banner is set and loading ends normally', async () => {
  const state = entriesFixture('2026-09', { fetcher: async () => { throw new Error('network down'); } });
  const cleanup = state.effects[0]();
  await new Promise(resolve => setImmediate(resolve));
  cleanup();
  assert.ok(state.updates.some(u => u.slot === 3 && u.value !== ''), 'a genuinely-latest failure must still show the error message');
  assert.ok(state.updates.some(u => u.slot === 2 && u.value === false), 'loading must still end after a genuinely-latest failure');
  assert.equal(state.updates.filter(u => u.slot === 1).length, 0, 'no stale/partial data is written on failure');
});

test('sheet recommendation, manual allocation and partial/confirm actions retain their contracts',async()=>{
  const sale={id:1,business_date:'2026-08-02',amount:1000,allocatedGrossAmount:0,outstandingGrossAmount:1000};
  const rec={id:10,deposit_date:'2026-09-03',deposit_amount:982,matched_gross_amount:0,difference_amount:0,status:'partial',memo:null,destination:null};
  const data={accounts:[],sales:[sale],monthlySales:[],priorUnreconciledSales:[],reconciliations:[rec],summary:{...cardSummary,actualCardDeposits:982,monthlyCompletedDifference:0}};
  for(const [label,confirm] of [['부분 저장',false],['정산 확정',true]]){
    const state=pageFixture(cardPath,{0:'2026-09',1:data,9:10,10:{1:'1000'},11:[sale]},async(url,options)=>Response.json(options?.method==='POST'?{result:{differenceAmount:18}}:data));
    const button=text=>state.elements.find(element=>element.type==='button'&&element.props.children===text);
    button('오래된 매출부터 추천').props.onClick();
    assert.ok(state.updates.some(update=>update.slot===10&&update.value[1]==='1000'));
    const input=state.elements.find(element=>element.type==='input'&&element.props['aria-label']==='2026-08-02 연결액');
    input.props.onChange({target:{value:'400'}});
    assert.deepEqual(state.updates.findLast(update=>update.slot===10).value({1:'1000'}),{1:'400'});
    button(label).props.onClick();await new Promise(resolve=>setImmediate(resolve));
    const post=state.calls.find(call=>call.options?.method==='POST');
    assert.equal(post.url,'/api/admin/ledger/card-settlements/10/match');
    assert.deepEqual(JSON.parse(post.options.body),{allocations:[{transactionId:1,allocatedGrossAmount:1000}],confirm});
  }
});
