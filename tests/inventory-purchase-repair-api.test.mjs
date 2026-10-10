
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
function client({candidates=[candidate],recommended=true,vi=false,postCode=null,supplier=null,previewResponse=null,postResponse=null,code="PURCHASE_CORRECTION_REFERENCE_REQUIRED"}={}){
 const states=[],refs=[],elements=[],requests=[];let cursor=0,refCursor=0,reloaded=0;
 const hooks={...React,useRef(initial){const n=refCursor++;if(!(n in refs))refs[n]={current:initial};return refs[n];},useState(initial){const n=cursor++;if(!(n in states))states[n]=initial;return [states[n],value=>{states[n]=value;}];}};
 const captured={...jsxRuntime,jsx(...args){const element=jsxRuntime.jsx(...args);elements.push(element);return element;},jsxs(...args){const element=jsxRuntime.jsxs(...args);elements.push(element);return element;}};
 const Component=load('components/ledger/InventoryProjectionResolution.tsx',{
  react:hooks,'react/jsx-runtime':captured,'next/link':{default:props=>React.createElement('a',{href:props.href},props.children)},
  '@/components/bar/keeping/KeepingUi':{BarSheet:props=>React.createElement('section',{role:'dialog'},props.children,props.footer),primaryButtonStyle:{},secondaryButtonStyle:{}},
  './InventoryProjectionResolution.module.css':{default:{decrease:'decrease'}},
  '@/lib/inventory/purchase-repair-contract':load('lib/inventory/purchase-repair-contract.ts',{}),
 }).default;
 const issue={inventoryLogId:12655,code,itemName:'배',itemNameVi:'Lê',supplier,businessDate:'2026-10-06',quantityDelta:-0.1,amountDelta:-3500,originalQuantity:null,resolution:{candidates,recommended}};
 const oldFetch=globalThis.fetch;
 globalThis.fetch=async(url,options={})=>{requests.push({url,options});if(options.method==='POST'&&postResponse)return postResponse();if(options.method!=='POST'&&previewResponse)return previewResponse();return Response.json(options.method==='POST'?{ok:!postCode,code:postCode}:{ok:true,candidates,recommended},{status:options.method==='POST'&&postCode?409:200});};
 return {
 render(){cursor=0;refCursor=0;elements.length=0;return renderToStaticMarkup(React.createElement(Component,{issue,vi,onResolved:async()=>{reloaded++;}}));},
 button(label){return elements.find(e=>e.type==='button'&&e.props.children===label);},
 select(){return elements.find(e=>e.type==='select');},
 checkbox(){return elements.find(e=>e.type==='input'&&e.props.type==='checkbox');},
 sheet(){return elements.find(e=>e.props.mobileCentered);},
 requests,reloaded:()=>reloaded,close(){globalThis.fetch=oldFetch;},
 };
}
test('actual resolution UI shows pear recommendation, preview and explicit save then reload',async()=>{
 const state=client();try{
 let html=state.render();assert.match(html,/해결하기/);assert.doesNotMatch(html,/49,700₫|46,200₫|원입고로 추정/);
 await state.button('해결하기').props.onClick();
 html=state.render();assert.match(html,/원입고에 연결하고 장부 수정/);assert.match(html,/-3,500₫/);
 assert.match(html,/49,700₫/);assert.match(html,/46,200₫/);assert.match(html,/1.42kg → <span class="decrease">1.32kg<[/]span>/);
 assert.equal((html.match(/class="decrease"/g) || []).length,3);
 assert.match(html,/<dd class="decrease">46,200₫<[/]dd>/);assert.match(html,/<dd class="decrease">-3,500₫<[/]dd>/);
 assert.match(html,/<dd>-0.1kg<[/]dd>/);assert.match(html,/<dd>49,700₫<[/]dd>/);
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
test('missing or unsafe candidates keep feedback and disable repair without a modal history link',async()=>{
 for(const options of [{candidates:[],recommended:false},{candidates:[{...candidate,safe:false,code:'PAYABLE_ALREADY_PAID'}],recommended:true}]){
 const state=client(options);try{
 state.render();await state.button('해결하기').props.onClick();const html=state.render();
 assert.equal(state.button('원입고에 연결하고 장부 수정').props.disabled,true);
 assert.doesNotMatch(html,/재고 이력 보기/);assert.ok(!html.includes('href="/inventory/logs"'));
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

test('selecting another root updates quantities, supplier and exact API amounts in both languages',async()=>{
 const other={...candidate,inventoryLogId:12580,supplier:'Other supplier',effectiveQuantity:2.5,oldAmount:98765,newAmount:87654,delta:-11111};
 for(const vi of [false,true]){
  const state=client({candidates:[candidate,other],recommended:false,vi,supplier:'Source supplier'});try{
   state.render();await state.button(vi?'Giải quyết':'해결하기').props.onClick();
   let html=state.render();assert.match(html,/Source supplier/);assert.doesNotMatch(html,/49,700₫|98,765₫/);
   state.select().props.onChange({target:{value:'12580'}});html=state.render();
   assert.match(html,/Other supplier/);assert.match(html,/2.5kg → <span class="decrease">2.4kg<[/]span>/);
   assert.match(html,/98,765₫/);assert.match(html,/87,654₫/);assert.match(html,/-11,111₫/);
   assert.doesNotMatch(html,/49,700₫|46,200₫/);
   assert.match(html,vi?/Nhà cung cấp.*Lê/:/거래처명.*배/);
   state.select().props.onChange({target:{value:''}});html=state.render();
   assert.doesNotMatch(html,/98,765₫|87,654₫/);
  }finally{state.close();}
 }
});
test('an unselected recommended supplier is never presented as a confirmed supplier',async()=>{
 const state=client({recommended:false});try{
  state.render();await state.button('해결하기').props.onClick();const html=state.render();
  assert.match(html,/거래처 미확정/);assert.doesNotMatch(html,/<dd>Ch\?<\/dd>/);
 }finally{state.close();}
});

const labels=vi=>({open:vi?'Giải quyết':'해결하기',save:vi?'Liên kết lô nhập gốc và sửa sổ':'원입고에 연결하고 장부 수정',result:vi?'Kết quả điều chỉnh':'수정 결과'});
test('unselected modal contains compact basics and selector without result headings or placeholders',async()=>{
 for(const vi of [false,true]){
  const state=client({vi,recommended:false});try{
   state.render();await state.button(labels(vi).open).props.onClick();const html=state.render();
   assert.match(html,/dateTime="2026-10-06">10\/06/);
   const dateLabel=vi?'Ngày sửa':'수정일',supplierLabel=vi?'Nhà cung cấp':'거래처명',itemLabel=vi?'Mặt hàng':'품목명';
   assert.ok(html.indexOf(dateLabel)<html.indexOf(supplierLabel));assert.ok(html.indexOf(supplierLabel)<html.indexOf(itemLabel));
   assert.doesNotMatch(html,/기본정보|수정 정보|Thông tin cơ bản|Thông tin thay đổi|—|href="\/inventory\/logs"/);
   assert.ok(!html.includes(labels(vi).result));assert.equal(state.button(labels(vi).save).props.disabled,true);
   state.select().props.onChange({target:{value:'12581'}});const selected=state.render();
   assert.ok(selected.includes(labels(vi).result));assert.match(selected,/49,700₫/);
   state.select().props.onChange({target:{value:''}});const cleared=state.render();
   assert.ok(!cleared.includes(labels(vi).result));assert.doesNotMatch(cleared,/49,700₫|46,200₫|—/);
  }finally{state.close();}
 }
});
test('reopening hides cached results and candidates while a fresh preview is pending or fails',async()=>{
 for(const vi of [false,true]){
  let response=Response.json({ok:true,candidates:[candidate],recommended:true});
  const state=client({vi,previewResponse:()=>response});try{
   state.render();await state.button(labels(vi).open).props.onClick();state.render();
   state.sheet().props.onClose();state.render();
   let finish;response=new Promise(resolve=>{finish=resolve;});
   const opening=state.button(labels(vi).open).props.onClick();let html=state.render();
   assert.ok(!html.includes(labels(vi).result));assert.doesNotMatch(html,/49,700₫|46,200₫|—/);assert.equal(state.select().props.disabled,true);
   finish(Response.json({ok:false,code:'PREVIEW_FAILED'},{status:500}));await opening;html=state.render();
   assert.match(html,vi?/Không thể tải thông tin liên kết/:/연결 정보를 불러오지 못했습니다/);
   assert.ok(!html.includes(labels(vi).result));assert.doesNotMatch(html,/49,700₫|46,200₫|—/);assert.equal(state.button(labels(vi).save).props.disabled,true);
  }finally{state.close();}
 }
});
test('network preview failure never displays cached economics',async()=>{
 const state=client({previewResponse:()=>{throw Error('offline');}});try{
  state.render();await state.button('해결하기').props.onClick();const html=state.render();
  assert.match(html,/연결 정보를 불러오지 못했습니다/);assert.doesNotMatch(html,/수정 결과|49,700₫|46,200₫|—/);
 }finally{state.close();}
});
test('incomplete preview economics are hidden instead of displaying empty normal results',async()=>{
 for(const field of ['effectiveQuantity','oldAmount','newAmount','delta']){
  const state=client({candidates:[{...candidate,[field]:null}]});try{
   state.render();await state.button('해결하기').props.onClick();const html=state.render();
   assert.doesNotMatch(html,/수정 결과|49,700₫|46,200₫|—/);
  }finally{state.close();}
 }
});
test('pending submission hides the previous preview; existing failure feedback is preserved',async()=>{
 for(const vi of [false,true]){
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const state=client({vi,postResponse:()=>pending});try{
   state.render();await state.button(labels(vi).open).props.onClick();state.render();
   const saving=state.button(labels(vi).save).props.onClick();const html=state.render();
   assert.ok(!html.includes(labels(vi).result));assert.doesNotMatch(html,/49,700₫|46,200₫/);assert.equal(state.select().props.disabled,true);
   finish(Response.json({ok:false,code:'MONTH_CLOSED'},{status:409}));await saving;const failed=state.render();
   assert.match(failed,vi?/Tháng liên quan đã chốt sổ/:/관련 월의 장부가 마감되었습니다/);assert.equal(state.reloaded(),0);
  }finally{state.close();}
 }
});

for(const vi of [false,true])test('four correction states render in '+(vi?'VI':'KO')+' with mobile sheet and cancellation preview',async()=>{
 const contract=load('lib/inventory/purchase-repair-contract.ts',{});
 const expected=vi?['Phiếu nhập gốc đã bị hủy','Cần xác nhận thay đổi số tiền','Cần xác nhận phiếu nhập gốc','Đã điều chỉnh sổ kế toán']:['원본 입고 취소됨','금액 변경 확인 필요','원본 입고 연결 확인 필요','장부 정정 완료'];
 for(const [i,code] of ['PURCHASE_ORIGINAL_CANCELLED','PURCHASE_AMOUNT_CONFIRMATION_REQUIRED','PURCHASE_CORRECTION_REFERENCE_REQUIRED','REBOOKED'].entries())assert.equal(contract.purchaseRepairState(code,vi),expected[i]);
 const state=client({vi,code:'PURCHASE_ORIGINAL_CANCELLED',candidates:[{...candidate,newAmount:0,delta:-49700}]});try{let html=state.render();assert.ok(html.includes(expected[0]));await state.button(labels(vi).open).props.onClick();html=state.render();assert.ok(html.includes(expected[0]));assert.equal(state.sheet().props.kind,'full');assert.equal(state.sheet().props.compact,true);assert.equal(state.sheet().props.mobileCentered,true);assert.match(html,/0₫/);}finally{state.close();}
});

test('price-only preview retains quantity and supplier-change preview shows both parties',async()=>{
 const state=client({code:'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED',candidates:[{...candidate,quantityDelta:0,newSupplier:'New supplier'}]});try{state.render();await state.button('해결하기').props.onClick();const html=state.render();assert.match(html,/1.42kg → <span class="decrease">1.42kg/);assert.ok(html.includes('Ch? → New supplier'));}finally{state.close();}
});
const supplierCandidate={...candidate,safe:false,code:'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED',quantityDelta:0,newAmount:49700,delta:0,supplier:'Chợ',newSupplier:'An Liên',supplierChange:{valid:true,requiresConfirmation:true,beforeSupplier:'Chợ',afterSupplier:'An Liên',beforePartnerId:'7',afterPartnerId:'27',confirmationFingerprint:'a'.repeat(64)}};

test('explicit supplier confirmation uses V2 and exactly the signed server actor',async()=>{
 for(const role of ['owner','master']){
  const state=api(role);const response=await state.post({purchaseLogId:12581,supplierConfirmation:{confirmed:true,fingerprint:'a'.repeat(64)},actorUserId:123});
  assert.equal(response.status,200);
  assert.deepEqual(state.calls,[{name:'ledger_resolve_inventory_purchase_correction_v2',args:{p_inventory_log_id:12655,p_purchase_log_id:12581,p_actor_user_id:7,p_supplier_confirmation:{confirmed:true,fingerprint:'a'.repeat(64)}}}]);
 }
});
test('invalid supplier approvals cannot execute any RPC',async()=>{
 const state=api();
 for(const supplierConfirmation of [null,[],{},true,{confirmed:'true',fingerprint:'a'.repeat(64)},{confirmed:false,fingerprint:'a'.repeat(64)},{confirmed:true,fingerprint:'stale'},{confirmed:true,fingerprint:'a'.repeat(64),actorUserId:1}]){
  const response=await state.post({purchaseLogId:12581,supplierConfirmation});assert.equal(response.status,400);assert.equal((await response.json()).code,'INVALID_SUPPLIER_CONFIRMATION');
 }
 assert.equal(state.calls.length,0);
 for(const purchaseLogId of [true,false,'',{},[]])assert.equal((await state.post({purchaseLogId})).status,400);
});
test('V2 block reasons remain concrete and no fallback RPC bypasses a rejection',async()=>{
 for(const code of ['SUPPLIER_CHANGE_CONFIRMATION_STALE','PAYABLE_ALREADY_PAID','MONTH_CLOSED','MANUAL_LEDGER_OVERRIDE','SUPPLIER_MISMATCH','SUPPLIER_CORRECTION_ORDER_REQUIRED']){
  const state=api('owner',{status:'blocked',code});const response=await state.post({purchaseLogId:12581,supplierConfirmation:{confirmed:true,fingerprint:'a'.repeat(64)}});
  assert.equal(response.status,409);assert.equal((await response.json()).code,code);assert.equal(state.calls.length,1);assert.equal(state.calls[0].name,'ledger_resolve_inventory_purchase_correction_v2');
 }
});
for(const vi of [false,true])test('zero amount difference supplier repair requires explicit approval in '+(vi?'VI':'KO'),async()=>{
 const state=client({vi,candidates:[supplierCandidate],recommended:false,code:'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED'});try{
  state.render();await state.button(labels(vi).open).props.onClick();state.render();state.select().props.onChange({target:{value:'12581'}});
  const html=state.render();assert.ok(html.includes('Chợ'));assert.ok(html.includes('An Liên'));assert.match(html,/49,700₫/);assert.match(html,/0₫/);
  assert.doesNotMatch(html,/금액 변경 확인 필요|Cần xác nhận thay đổi số tiền|0kg|수정 수량|Số lượng điều chỉnh/);
  assert.equal(state.button(labels(vi).save).props.disabled,true);
  await state.button(labels(vi).save).props.onClick();assert.equal(state.requests.length,1);
  state.checkbox().props.onChange({target:{checked:true}});state.render();assert.equal(state.button(labels(vi).save).props.disabled,false);
  await state.button(labels(vi).save).props.onClick();assert.equal(state.reloaded(),1);
  assert.deepEqual(JSON.parse(state.requests[1].options.body),{purchaseLogId:12581,supplierConfirmation:{confirmed:true,fingerprint:'a'.repeat(64)}});
 }finally{state.close();}
});
test('root changes and stale fingerprints reset explicit approval and block reuse',async()=>{
 const other={...supplierCandidate,inventoryLogId:12580,supplierChange:{...supplierCandidate.supplierChange,confirmationFingerprint:'b'.repeat(64)}};
 const state=client({candidates:[supplierCandidate,other],recommended:false,postCode:'SUPPLIER_CHANGE_CONFIRMATION_STALE'});try{
  state.render();await state.button(labels(false).open).props.onClick();state.render();state.select().props.onChange({target:{value:'12581'}});state.render();
  state.checkbox().props.onChange({target:{checked:true}});state.render();state.select().props.onChange({target:{value:'12580'}});state.render();
  assert.equal(state.checkbox().props.checked,false);assert.equal(state.button(labels(false).save).props.disabled,true);
  state.checkbox().props.onChange({target:{checked:true}});state.render();await state.button(labels(false).save).props.onClick();
  const html=state.render();assert.match(html,/확인 정보가 만료/);assert.equal(state.button(labels(false).save).props.disabled,true);assert.equal(state.checkbox(),undefined);assert.equal(state.reloaded(),0);
 }finally{state.close();}
});
test('unsafe supplier changes never expose an approval checkbox',async()=>{
 for(const code of ['PAYABLE_ALREADY_PAID','MONTH_CLOSED','MANUAL_LEDGER_OVERRIDE','SUPPLIER_MISMATCH','SUPPLIER_REFERENCE_REQUIRED']){
  const state=client({candidates:[{...supplierCandidate,code}],recommended:true});try{state.render();await state.button(labels(false).open).props.onClick();state.render();assert.equal(state.checkbox(),undefined);assert.equal(state.button(labels(false).save).props.disabled,true);}finally{state.close();}
 }
});
test('duplicate explicit approval sends only one request while response is pending',async()=>{
 let finish;const pending=new Promise(resolve=>{finish=resolve;});const state=client({candidates:[supplierCandidate],postResponse:()=>pending});try{
  state.render();await state.button(labels(false).open).props.onClick();state.render();state.checkbox().props.onChange({target:{checked:true}});state.render();
  const save=state.button(labels(false).save);const first=save.props.onClick();await save.props.onClick();assert.equal(state.requests.filter(row=>row.options.method==='POST').length,1);
  finish(Response.json({ok:true,status:'synced'}));await first;assert.equal(state.reloaded(),1);
 }finally{state.close();}
});


test('failed supplier approval releases the request lock for a fresh preview',async()=>{
 const state=client({candidates:[supplierCandidate],postCode:'SUPPLIER_CHANGE_CONFIRMATION_STALE'});try{
  state.render();await state.button(labels(false).open).props.onClick();state.render();state.checkbox().props.onChange({target:{checked:true}});state.render();await state.button(labels(false).save).props.onClick();state.render();
  await state.button('최신 정보 다시 조회').props.onClick();state.render();assert.equal(state.requests.filter(row=>!row.options.method).length,2);assert.equal(state.checkbox().props.checked,false);assert.equal(state.button(labels(false).save).props.disabled,true);
 }finally{state.close();}
});
