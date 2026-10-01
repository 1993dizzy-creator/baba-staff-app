import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import {database} from './helpers/inventory-ledger-fixture.mjs';
import * as adHoc from '../lib/ledger/ad-hoc-payable.ts';
import * as payableFunctions from '../lib/ledger/payables.ts';
import * as verificationFunctions from '../lib/ledger/payment-verification.ts';
const read=p=>readFileSync(p,'utf8');
const migration=read('supabase/migrations/20261001140419_add_ad_hoc_ledger_payable_party.sql');
const marker=adHoc.AD_HOC_PAYABLE_PARTY_MARKER;
function load(path,deps){const module={exports:{}};const code=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name]},module,module.exports);return module.exports}
async function setup(){
 const db=await database();await db.exec(read('supabase/migrations/202608210004_add_ledger_payable_payments.sql'));await db.exec(migration);
 const party=(await db.query('select id,name from ledger_parties where memo=$1',[marker])).rows[0];
 for(const [name,amount,partyId] of [['Napkin',2400000,party.id],['Other vendor',400000,party.id],['Formal A',100,12],['Formal B',200,12]]){
  const tx=(await db.query(`insert into ledger_transactions(operation_id,type,occurred_at,business_date,amount,party_id,status,source_type,source_snapshot,memo,recognition_month,category_id,created_by,confirmed_by) values(gen_random_uuid(),'expense','2026-09-29T12:00:00+07:00','2026-09-29',$1,$2,'confirmed','manual',$3,'Individual memo','2026-09-01',4,2,2) returning id`,[amount,partyId,JSON.stringify({item_name:name})])).rows[0];
  await db.query("insert into ledger_payables(expense_transaction_id,party_id,original_amount,status) values($1,$2,$3,'unpaid')",[tx.id,partyId,amount]);
 }return {db,party};
}
async function pay(db,partyId,amount,allocations){return (await db.query("select ledger_pay_payables_v1($1,1,'2026-10-01T12:00:00+07:00',$2,$3,'Payment',2) as result",[partyId,amount,allocations===null?null:JSON.stringify(allocations)])).rows[0].result}
test('repeatable system migration preserves partners, aliases, mappings and function permissions',async()=>{
 const {db,party}=await setup();try{
  const before=(await db.query('select * from business_partners order by id')).rows;
  const aclQuery="select proacl::text from pg_proc where oid='ledger_pay_payables_v1(bigint,bigint,timestamptz,numeric,jsonb,text,bigint)'::regprocedure";
  const acl=(await db.query(aclQuery)).rows;await db.exec(migration);await db.exec(migration);
  assert.equal((await db.query('select id from ledger_parties where memo=$1',[marker])).rows.length,1);
  assert.deepEqual((await db.query('select * from business_partners order by id')).rows,before);
  assert.equal((await db.query('select * from business_partner_supplier_aliases')).rows.length,0);
  assert.equal((await db.query('select * from ledger_supplier_party_mappings')).rows.length,0);
  assert.deepEqual((await db.query(aclQuery)).rows,acl);assert.equal(party.name,'기타 (khác)');
 }finally{await db.close()}
});
test('system party blocks implicit FIFO without financial changes; explicit partial payment leaves every unselected allocation zero',async()=>{
 const {db,party}=await setup();try{
  const rows=(await db.query('select id,original_amount from ledger_payables where party_id=$1 order by id',[party.id])).rows;
  const query='select (select count(*) from ledger_transactions) as tx,(select count(*) from ledger_movements) as movement';const before=(await db.query(query)).rows;
  assert.equal((await pay(db,party.id,300000,null)).status,'explicit_allocations_required');assert.deepEqual((await db.query(query)).rows,before);
  const plan=adHoc.planSelectedAdHocPayment(rows.map(row=>({id:Number(row.id),businessDate:'2026-09-29',outstandingAmount:Number(row.original_amount)})),new Set([Number(rows[1].id)]),300000);
  assert.deepEqual(plan.allocations,[{payableId:Number(rows[1].id),allocatedAmount:300000}]);assert.equal((await pay(db,party.id,plan.amount,plan.allocations)).status,'paid');
  const allocations=(await db.query('select payable_id,allocated_amount from ledger_payable_allocations')).rows;
  assert.equal(allocations.length,1);assert.equal(Number(allocations[0].payable_id),Number(rows[1].id));assert.equal(Number(allocations[0].allocated_amount),300000);
  assert.equal((await db.query('select * from ledger_payable_allocations where payable_id=$1',[rows[0].id])).rows.length,0);
  assert.equal((await db.query('select status from ledger_payables where id=$1',[rows[0].id])).rows[0].status,'unpaid');
  assert.equal((await db.query('select status from ledger_payables where id=$1',[rows[1].id])).rows[0].status,'partially_paid');
 }finally{await db.close()}
});
test('formal-party implicit FIFO and partial payments remain unchanged',async()=>{
 const {db}=await setup();try{
  assert.equal((await pay(db,12,150,null)).status,'paid');
  const rows=(await db.query('select p.original_amount,p.status,a.allocated_amount from ledger_payables p join ledger_payable_allocations a on a.payable_id=p.id where p.party_id=12 order by p.id')).rows;
  assert.deepEqual(rows.map(row=>[Number(row.original_amount),row.status,Number(row.allocated_amount)]),[[100,'paid',100],[200,'partially_paid',50]]);
 }finally{await db.close()}
});
function apiFixture(){
 const sources=[
  {id:1,party_id:987,original_amount:2400000,party:{name:'기타 (khác)',memo:marker},expense:{id:101,status:'confirmed',business_date:'2026-09-29',memo:'Napkin memo',source_snapshot:{item_name:'냅킨',item_name_vi:'Giấy ăn'}}},
  {id:2,party_id:987,original_amount:400000,party:{name:'기타 (khác)',memo:marker},expense:{id:102,status:'confirmed',business_date:'2026-09-30',memo:'Another vendor',source_snapshot:{item_name:'Other item',paymentVerification:'pending'}}},
  {id:3,party_id:12,original_amount:100,party:{name:'Formal',memo:null},expense:{id:103,status:'confirmed',business_date:'2026-09-29',source_snapshot:{paymentVerification:'pending'}}}
 ].map(row=>({...row,status:'unpaid',allocations:[]}));
 const tables={ledger_parties:[{id:987,name:'기타 (khác)',memo:marker}],ledger_payables:sources,ledger_transactions:[],ledger_payable_allocations:[],business_partner_ledger_parties:[],business_partners:[]};
 const supabase={from(table){let selected=tables[table];const query={select(){return query},eq(name,value){if(name==='party_id')selected=selected.filter(row=>row.party_id===value);return query},neq(){return query},lt(){return query},order(){return query},range(){return query},async maybeSingle(){return {data:selected[0],error:null}},then(resolve){return Promise.resolve({data:selected,error:null}).then(resolve)}};return query}};
 const deps={'@/lib/ledger/ad-hoc-payable':adHoc,'@/lib/ledger/payables':payableFunctions,'@/lib/ledger/payment-verification':verificationFunctions,'@/lib/ledger/inventory-display':{withInventoryDisplay:async rows=>rows},'@/lib/supabase/server':{supabaseServer:supabase},'@/lib/ledger/server':{requireLedgerActor:async()=>({}),ledgerJson:(body,status=200)=>Response.json(body,{status})}};
 return {deps,sources};
}
test('actual summary/detail APIs group ad hoc payables, including verification, while formal verification stays separate',async()=>{
 const {deps}=apiFixture();const api=load('app/api/admin/ledger/payables/route.ts',deps);
 const body=await(await api.GET(new Request('http://local/api/admin/ledger/payables?month=2026-09'))).json();
 assert.equal(body.totalOutstanding,2800000);assert.equal(body.parties.length,1);assert.equal(body.parties[0].partyName,'기타 (khác)');assert.equal(body.parties[0].isAdHocPayable,true);
 assert.equal(body.verification.totalPending,100);assert.equal(body.verification.pendingCount,1);
 const detail=load('app/api/admin/ledger/payables/[partyId]/route.ts',deps);const result=await(await detail.GET(new Request('http://local'),{params:Promise.resolve({partyId:'987'})})).json();
 assert.equal(result.totalOutstanding,2800000);assert.equal(result.payables.length,2);assert.equal(result.payables[0].expense.memo,'Napkin memo');assert.equal(result.payables[0].expense.source_snapshot.item_name,'냅킨');
});
function componentFixture(lang='ko'){
 const {sources}=apiFixture();const values=[{payables:sources.filter(row=>row.party_id===987).map(row=>({...row,outstandingAmount:row.original_amount}))},new Set(),'','1','2026-10-01T12:00','',false,''];let index=0,paid=0;
 const deps={react:{useEffect(){},useState(initial){const i=index++;if(values[i]===undefined)values[i]=typeof initial==='function'?initial():initial;return [values[i],value=>{values[i]=typeof value==='function'?value(values[i]):value}]}},'react/jsx-runtime':jsxRuntime,'@/lib/ledger/ad-hoc-payable':adHoc,'@/lib/ledger/payables':payableFunctions,'./entries.module.css':{default:{}},'@/components/bar/keeping/KeepingUi':{keepingInputStyle:{},primaryButtonStyle:{},BarField:({label,children})=>React.createElement('label',{},label,children({id:label})),BarSheet:({children,footer})=>React.createElement('section',{},children,footer)}};
 const Component=load('app/(protected)/admin/ledger/entries/AdHocPayableSheet.tsx',deps).default;
 function render(){index=0;const inputs=[],buttons=[];function expand(node){if(Array.isArray(node))return node.map((child,i)=>{const result=expand(child);return React.isValidElement(result)&&result.key==null?React.cloneElement(result,{key:i}):result});if(!React.isValidElement(node))return node;if(typeof node.type==='function')return expand(node.type(node.props));if(node.type==='input')inputs.push(node);if(node.type==='button')buttons.push(node);return React.cloneElement(node,{},expand(node.props.children))}const tree=expand(Component({lang,party:{partyId:987,partyName:'기타 (khác)'},accounts:[{id:1,display_name:'Cash',is_active:true}],onClose(){},onPaid:async()=>{paid++}}));return {inputs,buttons,html:renderToStaticMarkup(tree)}}
 return {render,values,get paid(){return paid}};
}
test('actual item UI shows date/item/amount/memo, blocks no selection, and posts only selected item allocations',async()=>{
 for(const lang of ['ko','vi']){
  const ui=componentFixture(lang);let view=ui.render();assert.ok(view.html.includes('2026-09-29'));assert.ok(view.html.includes(lang==='vi'?'Giấy ăn':'냅킨'));assert.ok(view.html.includes('Napkin memo'));assert.ok(view.html.includes('2.400.000'));assert.equal(view.buttons[0].props.disabled,true);
  view.inputs.filter(input=>input.props.type==='checkbox')[1].props.onChange();view=ui.render();assert.equal(view.buttons[0].props.disabled,false);
  view.inputs.find(input=>input.props.inputMode==='decimal').props.onChange({target:{value:'300000'}});view=ui.render();const before=globalThis.fetch,calls=[];
  try{globalThis.fetch=async(_url,options)=>{calls.push(JSON.parse(options.body));return {ok:true}};view.buttons[0].props.onClick();await new Promise(resolve=>setImmediate(resolve));assert.equal(ui.paid,1);assert.equal(ui.values[6],false);assert.deepEqual(calls[0].allocations,[{payableId:2,allocatedAmount:300000}]);assert.equal(calls[0].partyId,987)}finally{globalThis.fetch=before}
 }
});
