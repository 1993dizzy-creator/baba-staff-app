import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {database} from './helpers/inventory-ledger-fixture.mjs';
import * as periodFunctions from '../lib/ledger/payable-period-payment.ts';
import * as payables from '../lib/ledger/payables.ts';
import {planPartialPayablePayment} from '../lib/ledger/partial-payable-payment.ts';
import {groupPayableRows} from '../lib/ledger/payable-date-groups.ts';
import {groupPaymentsByDate} from '../lib/ledger/payable-display-groups.ts';
const read=p=>readFileSync(p,'utf8');
const path='app/(protected)/admin/ledger/entries/';
const source=read(path+'page.tsx');
const ast=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let found;function visit(node){if(!found&&predicate(node))found=node;if(!found)ts.forEachChild(node,visit)}visit(ast);assert.ok(found);return found}
function compile(text,bindings,returnName){const code=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;return new Function('exports','require',...Object.keys(bindings),code+';return '+returnName)({},name=>jsxRuntime,...Object.values(bindings))}
function moduleComponent(file,deps){const module={exports:{}};const code=ts.transpileModule(read(path+file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name]},module,module.exports);return module.exports.default}
const styles=new Proxy({},{get:(_,key)=>String(key)});
const Snapshot=moduleComponent('PayablePeriodSnapshot.tsx',{'react/jsx-runtime':jsxRuntime,'@/lib/ledger/payable-period-payment':periodFunctions,'@/lib/ledger/payables':payables,'./entries.module.css':{default:styles}});
function fixture(kind,detail,period,fetcher,mode='dates'){
 const values=[detail,new Set(),'1','2026-10-05','12:30','',false,'',mode,''];
 let index=0,paid=0;const calls=[];
 const hooks={useState(initial){const i=index++;if(values[i]===undefined)values[i]=typeof initial==='function'?initial():initial;return [values[i],value=>{values[i]=typeof value==='function'?value(values[i]):value}]},useEffect(){},useMemo:fn=>fn(),useCallback:fn=>fn};
 const fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return fetcher?fetcher(url,options):Response.json({ok:true,result:{status:'paid'}},{status:201})};
 const ui={BarField:({label,children})=>React.createElement('label',{},label,children({id:label})),BarSheet:({children,footer})=>React.createElement('section',{},children,footer),keepingInputStyle:{},primaryButtonStyle:{}};
 const DateGroups=({rows,onSelectDate})=>React.createElement('div',{},groupPayableRows(rows).map(group=>React.createElement('input',{key:group.businessDate,type:'checkbox',onChange:()=>onSelectDate(group.businessDate)})));
 const bindings={...hooks,...ui,fetch,PayablePeriodSnapshot:Snapshot,...periodFunctions,planPartialPayablePayment,groupPayableRows,groupPaymentsByDate,sumPayableAmounts:payables.sumPayableAmounts,styles,localTime:()=> '2026-10-05T12:30',money:value=>String(value),formatDate:value=>value,formatLedgerAmountInput:value=>value,sanitizeLedgerAmountInput:value=>value,parseLedgerAmount:value=>value?Number(value):null,secondaryButtonStyle:{},PayableDateGroups:DateGroups,AccountField:()=>null,payableItemLabel:row=>row.expense?.source_snapshot?.item_name??'-'};
 let Component;
 if(kind==='formal')Component=compile(find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='PayablePartySheet').getText(ast),bindings,'PayablePartySheet');
 const previousFetch=globalThis.fetch;
 function render(){index=0;const inputs=[],buttons=[];function expand(node){if(Array.isArray(node))return node.map((child,i)=>{const result=expand(child);return React.isValidElement(result)&&result.key==null?React.cloneElement(result,{key:i}):result});if(!React.isValidElement(node))return node;if(typeof node.type==='function')return expand(node.type(node.props));if(node.type==='input')inputs.push(node);if(node.type==='button')buttons.push(node);return React.cloneElement(node,{},expand(node.props.children))}
 const tree=expand(Component({lang:'ko',party:{partyId:detail.partyId,partyName:'Supplier',outstandingAmount:period?.closingOutstanding??detail.totalOutstanding},accounts:[{id:1,is_active:true,display_name:'Cash'}],period,onClose(){},onPaid:async()=>{paid++}}));return {inputs,buttons,html:renderToStaticMarkup(tree)}}
 async function submit(){const view=render();const button=view.buttons.find(node=>!('aria-pressed' in node.props)&&(node.props.style===ui.primaryButtonStyle||node.props.children==='선택 미납건 결제'||typeof node.props.children==='string'&&(/선택 일자|부분 지급/.test(node.props.children))));assert.ok(button);assert.equal(button.props.disabled,false);globalThis.fetch=fetch;try{button.props.onClick();await new Promise(resolve=>setTimeout(resolve,30));while(values[6])await new Promise(resolve=>setTimeout(resolve,10));}finally{globalThis.fetch=previousFetch}}
 return {render,submit,values,calls,get paid(){return paid}};
}
const row=(id,amount,date='2026-09-29')=>({id,outstandingAmount:amount,original_amount:2400000,expense:{business_date:date,memo:'냅킨 메모',source_snapshot:{item_name:'냅킨',item_name_vi:'Giấy ăn'}}});
test('actual page routes September directly to live sheets with September rows; future months remain snapshot-only',()=>{
 const node=find(node=>ts.isConditionalExpression(node)&&node.condition.getText(ast)==='month <= currentMonth()');
 for(const isRegular of [true]){
  const bindings={month:'2026-09',currentMonth:()=> '2026-10',payableParty:{partyId:12,closingOutstanding:2400000},payables:{historyPayables:[{...row(1,2400000),party_id:12},{...row(2,1),party_id:99}]},businessAccounts:[],lang:'ko',vi:false,setPayableParty(){},load:async()=>{},setNotice(){},PayablePartySheet:'formal',HistoricalPayablePartySheet:'historical'};
  const render=compile('function render(){return ('+node.getText(ast)+');}',bindings,'render');const element=render();assert.equal(element.type,isRegular?'formal':'formal');assert.equal(element.props.period.month,'2026-09');assert.equal(element.props.period.rows.length,1);
 }
});
test('historical scope uses current amounts, excludes October invoices and already-paid rows from allocation',()=>{
 const period={month:'2026-09',closingOutstanding:300,rows:[row(1,100),row(2,200)]};const current=[row(1,0),row(2,50),row(3,300,'2026-10-01')];
 assert.deepEqual(periodFunctions.currentPeriodPayables(current,period).map(row=>[row.id,row.outstandingAmount]),[[1,0],[2,50]]);
 assert.deepEqual(planPartialPayablePayment(periodFunctions.currentPeriodPayables(current,period).map(row=>({...row,businessDate:row.expense.business_date})),50).allocations,[{payableId:2,allocatedAmount:50}]);
 assert.deepEqual(periodFunctions.currentPeriodPayables(current),current);
});
for(const kind of ['formal']){
 test(kind+' September UI pays live residual, not historical amount; paid items have no checkbox',async()=>{
  const period={month:'2026-09',closingOutstanding:4800000,rows:[row(1,2400000),row(2,2400000)]};const detail={partyId:12,totalOutstanding:100,payables:[row(1,0),row(2,100),row(3,400,'2026-10-01')]};
  const ui=fixture(kind,detail,period);let view=ui.render();assert.ok(view.html.includes('선택월 월말 기준 미납'));assert.ok(view.html.includes('현재 남은 미납'));assert.ok(view.html.includes('4.800.000'));assert.ok(view.html.includes('현재 지급 대상 없음'));assert.equal(view.inputs.filter(node=>node.props.type==='checkbox').length,1);
  view.inputs.find(node=>node.props.type==='checkbox').props.onChange();await ui.submit();assert.equal(ui.paid,1);assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].body.occurredAt,'2026-10-05T12:30:00+07:00');assert.deepEqual(ui.calls[0].body.allocations,[{payableId:2,allocatedAmount:100}]);assert.equal(ui.calls[0].body.amount,100);
 });
 test(kind+' already settled historical items cannot be paid again',()=>{
  const period={month:'2026-09',closingOutstanding:2400000,rows:[row(1,2400000)]};const ui=fixture(kind,{partyId:12,totalOutstanding:0,payables:[row(1,0)]},period);const view=ui.render();assert.equal(view.inputs.filter(node=>node.props.type==='checkbox').length,0);assert.equal(ui.calls.length,0);
  const pay=view.buttons.find(node=>!('aria-pressed' in node.props)&&typeof node.props.children==='string'&&(/선택|부분 지급/.test(node.props.children)));assert.ok(pay);assert.equal(pay.props.disabled,true);
 });
}
async function dbFixture(kind){
 const db=await database();await db.exec(read('supabase/migrations/202608210004_add_ledger_payable_payments.sql'));
 const partyId=12;
 for(const [name,amount,date] of [['Napkin',2400000,'2026-09-29'],['Other vendor',400000,'2026-09-30'],['October new',100000,'2026-10-01']]){
  const tx=(await db.query("insert into ledger_transactions(operation_id,type,occurred_at,business_date,amount,party_id,status,source_type,source_snapshot,memo,recognition_month,category_id,created_by,confirmed_by) values(gen_random_uuid(),'expense',$1,$2,$3,$4,'confirmed','manual',$5,'Napkin memo',date_trunc('month',$2::date)::date,4,2,2) returning id",[date+'T12:00:00+07:00',date,amount,partyId,JSON.stringify({item_name:name})])).rows[0];await db.query("insert into ledger_payables(expense_transaction_id,party_id,original_amount,status) values($1,$2,$3,'unpaid')",[tx.id,partyId,amount]);
 }
 const month=read('supabase/migrations/202608210008_add_ledger_month_close_corrections.sql');await db.exec(month.slice(month.indexOf('create or replace function public.ledger_payable_allocation_month_guard_v1'),month.indexOf('create or replace function public.ledger_card_reconciliation_month_guard_v1')));
 await db.exec("alter table ledger_month_closures add column closing_snapshot jsonb;insert into ledger_month_closures(month,status,closing_snapshot) values('2026-09-01','closed','{\"payables\":2800000}');");
 const sources=(await db.query("select p.id,p.party_id,p.original_amount,p.status,jsonb_build_object('business_date',t.business_date,'status',t.status,'memo',t.memo,'source_snapshot',t.source_snapshot) as expense from ledger_payables p join ledger_transactions t on t.id=p.expense_transaction_id order by p.id")).rows;
 const periodRows=payables.calculatePayableBalances(sources,[],'2026-09').payables.map(row=>({...row,id:Number(row.id)}));
 const period={month:'2026-09',closingOutstanding:2800000,rows:periodRows};
 const detail={partyId,totalOutstanding:2900000,payables:sources.map(row=>({...row,id:Number(row.id),outstandingAmount:Number(row.original_amount)}))};
 const apiCode=ts.transpileModule(read('app/api/admin/ledger/payables/pay/route.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};const deps={'@/lib/ledger/server':{requireLedgerActor:async()=>({actor:{id:2}}),ledgerJson:(body,status=200)=>Response.json(body,{status})},'@/lib/supabase/server':{supabaseServer:{async rpc(name,args){assert.equal(name,'ledger_pay_payables_v1');const result=await db.query('select ledger_pay_payables_v1($1,$2,$3,$4,$5,$6,$7) as result',[args.p_party_id,args.p_fund_account_id,args.p_occurred_at,args.p_amount,JSON.stringify(args.p_allocations),args.p_memo,args.p_actor_user_id]);return {data:result.rows[0].result,error:null}}}}};new Function('require','module','exports',apiCode)(name=>deps[name],module,module.exports);
 const fetcher=(url,options)=>module.exports.POST(new Request('http://local'+url,options));return {db,period,detail,sources,fetcher};
}
for(const kind of ['formal'])test(kind+' September screen -> existing API/RPC creates October payment while closed September transactions and snapshot remain identical',async()=>{
 const {db,period,detail,sources,fetcher}=await dbFixture(kind);try{
  const original=(await db.query("select * from ledger_transactions where business_date<'2026-10-01' order by id")).rows;const closed=(await db.query('select * from ledger_month_closures')).rows;
  const ui=fixture(kind,detail,period,fetcher);ui.render().inputs.find(node=>node.props.type==='checkbox').props.onChange();await ui.submit();assert.equal(ui.paid,1);
  const payment=(await db.query("select * from ledger_transactions where type='payable_payment'")).rows;assert.equal(payment.length,1);assert.equal(payment[0].business_date.toISOString().slice(0,10),'2026-10-05');assert.equal(payment[0].occurred_at.toISOString(),'2026-10-05T05:30:00.000Z');
  const allocations=(await db.query('select payable_id,allocated_amount,payment_transaction_id from ledger_payable_allocations')).rows;assert.equal(allocations.length,1);assert.equal(Number(allocations[0].payable_id),Number(period.rows[0].id));assert.equal(Number(allocations[0].allocated_amount),2400000);
  assert.deepEqual((await db.query("select * from ledger_transactions where business_date<'2026-10-01' order by id")).rows,original);assert.deepEqual((await db.query('select * from ledger_month_closures')).rows,closed);
  const dated=allocations.map(row=>({...row,payment:{business_date:payment[0].business_date.toISOString().slice(0,10),status:'confirmed'}}));assert.equal(payables.calculatePayableBalances(sources,dated,'2026-09').totalOutstanding,2800000);assert.equal(payables.calculatePayableBalances(sources,dated,'2026-10').totalOutstanding,500000);
  const replay=await fetcher(ui.calls[0].url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ui.calls[0].body)});assert.equal(replay.status,400);assert.equal((await replay.json()).code,'INVALID_ALLOCATION');assert.equal((await db.query('select * from ledger_payable_allocations')).rows.length,1);
  const live={...detail,payables:detail.payables.map(row=>({...row,outstandingAmount:row.id===period.rows[0].id?0:row.outstandingAmount}))};const next=fixture(kind,live,period);assert.equal(next.render().inputs.filter(node=>node.props.type==='checkbox').length,1);
  await assert.rejects(db.query("update ledger_transactions set amount=1 where id=$1",[original[0].id]),/LEDGER_MONTH_CLOSED/);
 }finally{await db.close()}
});

test('formal historical partial-payment UI preserves FIFO and uses live balances only',async()=>{
 const period={month:'2026-09',closingOutstanding:500,rows:[row(1,200,'2026-09-01'),row(2,300,'2026-09-29')]};
 const detail={partyId:12,totalOutstanding:700,payables:[row(2,200,'2026-09-29'),row(1,100,'2026-09-01'),row(3,400,'2026-10-01')]};
 const ui=fixture('formal',detail,period,undefined,'partial');ui.values[9]='150';await ui.submit();assert.equal(ui.paid,1);assert.deepEqual(ui.calls[0].body.allocations,[{payableId:1,allocatedAmount:100},{payableId:2,allocatedAmount:50}]);
 const current=fixture('formal',detail,undefined,undefined,'partial');current.values[9]='350';await current.submit();assert.deepEqual(current.calls[0].body.allocations,[{payableId:1,allocatedAmount:100},{payableId:2,allocatedAmount:200},{payableId:3,allocatedAmount:50}]);
});
