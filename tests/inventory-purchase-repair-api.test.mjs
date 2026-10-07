
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
function load(path,deps){
 const testModule={exports:{}};
 const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 new Function('require','module','exports',code)(name=>{assert.ok(name in deps,'unexpected '+name);return deps[name];},testModule,testModule.exports);
 return testModule.exports;
}
function api(role='owner',result={status:'synced',code:'REBOOKED'}){
 const calls=[];
 const json=(body,options)=>Response.json(body,options);
 const server=load('lib/ledger/server.ts',{
  'server-only':{},'next/server':{NextResponse:{json}},
  '@/lib/auth/server-auth':{getAuthenticatedActor:async()=>({ok:true,actor:{id:7,role}})},
  './authorization':load('lib/ledger/authorization.ts',{}),
 });
 const route=load('app/api/admin/ledger/inventory-projection/[inventoryLogId]/resolve/route.ts',{
  '@/lib/ledger/server':server,
  '@/lib/supabase/server':{supabaseServer:{rpc:async(name,args)=>{calls.push({name,args});return {data:result,error:null};}}},
  '@/lib/ledger/inventory-repair':{loadInventoryRepairPreview:async(id,actor)=>{calls.push({id,actor});return {status:'ok',candidates:[],recommended:false};}},
 });
 const context={params:Promise.resolve({inventoryLogId:'12655'})};
 return {calls,post:body=>route.POST(new Request('http://test',{method:'POST',body:JSON.stringify(body)}),context),get:()=>route.GET(new Request('http://test'),context)};
}
test('resolve uses session actor and a single atomic RPC; concrete rejection code is preserved',async()=>{
 const state=api();assert.equal((await state.post({purchaseLogId:12581,actorUserId:123})).status,200);
 assert.deepEqual(state.calls,[{name:'ledger_resolve_inventory_purchase_correction_v1',args:{p_inventory_log_id:12655,p_purchase_log_id:12581,p_actor_user_id:7}}]);
 const blocked=api('owner',{status:'blocked',code:'PAYABLE_ALREADY_PAID'});const response=await blocked.post({purchaseLogId:12581});
 assert.equal(response.status,409);assert.equal((await response.json()).code,'PAYABLE_ALREADY_PAID');
});
test('server rejects non-owner/master before querying or repairing',async()=>{
 for(const role of ['staff','manager','leader']){
 const state=api(role);assert.equal((await state.post({purchaseLogId:12581})).status,403);
 assert.equal((await state.get()).status,403);assert.equal(state.calls.length,0);
 }
 assert.equal((await api('master').get()).status,200);
});
test('missing root ID never executes a repair',async()=>{
 const state=api();for(const purchaseLogId of [null,0,-1,1.2,'wrong']){
 assert.equal((await state.post({purchaseLogId})).status,400);
 }assert.equal(state.calls.length,0);
});
const candidate={safe:true,code:'READY',inventoryLogId:12581,businessDate:'2026-10-05',quantity:1.42,effectiveQuantity:1.42,unit:'kg',price:35000,supplier:'Ch?',oldAmount:49700,newAmount:46200,delta:-3500};
function client({candidates=[candidate],recommended=true,vi=false,postCode=null}={}){
 const states=[],elements=[],requests=[];let cursor=0,reloaded=0;
 const hooks={...React,useState(initial){const n=cursor++;if(!(n in states))states[n]=initial;return [states[n],value=>{states[n]=value;}];}};
 const captured={...jsxRuntime,jsx(...args){const element=jsxRuntime.jsx(...args);elements.push(element);return element;},jsxs(...args){const element=jsxRuntime.jsxs(...args);elements.push(element);return element;}};
 const Component=load('components/ledger/InventoryProjectionResolution.tsx',{
  react:hooks,'react/jsx-runtime':captured,'next/link':{default:props=>React.createElement('a',{href:props.href},props.children)},
  '@/components/bar/keeping/KeepingUi':{BarSheet:props=>React.createElement('section',{role:'dialog'},props.children,props.footer),primaryButtonStyle:{}},
  '@/lib/inventory/purchase-repair-contract':load('lib/inventory/purchase-repair-contract.ts',{}),
 }).default;
 const issue={inventoryLogId:12655,code:'PURCHASE_CORRECTION_REFERENCE_REQUIRED',itemName:'배',businessDate:'2026-10-06',quantityDelta:-0.1,amountDelta:-3500,originalQuantity:null,resolution:{candidates,recommended}};
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async(url,options={})=>{requests.push({url,options});return Response.json(options.method==='POST'?{ok:!postCode,code:postCode}:{ok:true,candidates,recommended},{status:options.method==='POST'&&postCode?409:200});};
 return {
 render(){cursor=0;elements.length=0;return renderToStaticMarkup(React.createElement(Component,{issue,vi,onResolved:async()=>{reloaded++;}}));},
 button(label){return elements.find(e=>e.type==='button'&&e.props.children===label);},
 select(){return elements.find(e=>e.type==='select');},
 requests,reloaded:()=>reloaded,close(){globalThis.fetch=oldFetch;},
 };
}
test('actual resolution UI shows pear recommendation, preview and explicit save then reload',async()=>{
 const state=client();try{
 let html=state.render();assert.match(html,/해결하기/);assert.match(html,/49,700₫.*46,200₫/);
 await state.button('해결하기').props.onClick();
 html=state.render();assert.match(html,/원입고에 연결하고 장부 수정/);assert.match(html,/-3,500₫/);
 const save=state.button('원입고에 연결하고 장부 수정');assert.equal(save.props.disabled,false);
 await save.props.onClick();assert.equal(state.reloaded(),1);
 assert.equal(state.requests[1].url,'/api/admin/ledger/inventory-projection/12655/resolve');
 assert.deepEqual(JSON.parse(state.requests[1].options.body),{purchaseLogId:12581});
 }finally{state.close();}
});
test('multiple roots require UI selection before repair',async()=>{
 const state=client({candidates:[candidate,{...candidate,inventoryLogId:12580}],recommended:false});try{
 state.render();await state.button('해결하기').props.onClick();state.render();
 assert.equal(state.button('원입고에 연결하고 장부 수정').props.disabled,true);
 state.select().props.onChange({target:{value:'12580'}});state.render();
 assert.equal(state.button('원입고에 연결하고 장부 수정').props.disabled,false);
 }finally{state.close();}
});
test('no candidate gives history action; unsafe payable disables repair',async()=>{
 for(const options of [{candidates:[],recommended:false},{candidates:[{...candidate,safe:false,code:'PAYABLE_ALREADY_PAID'}],recommended:true}]){
 const state=client(options);try{
 state.render();await state.button('해결하기').props.onClick();const html=state.render();
 assert.equal(state.button('원입고에 연결하고 장부 수정').props.disabled,true);
 assert.match(html,/재고 이력 보기/);
 assert.match(html,options.candidates.length?/지급 또는 배분/:/연결 가능한 원입고를 찾지 못했습니다/);
 }finally{state.close();}
 }
});
test('Vietnamese actions and failed repair feedback remain actionable',async()=>{
 const state=client({vi:true,postCode:'MONTH_CLOSED'});try{
 state.render();await state.button('Giải quyết').props.onClick();state.render();
 await state.button('Liên kết lô nhập gốc và sửa sổ').props.onClick();const html=state.render();
 assert.match(html,/Tháng liên quan đã chốt sổ/);assert.equal(state.reloaded(),0);
 }finally{state.close();}
});
