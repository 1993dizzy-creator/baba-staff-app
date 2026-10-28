import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {atomicInventoryDatabase} from './helpers/inventory-atomic-fixture.mjs';
import {safeFixture,snapshot as safeSnapshot} from './helpers/inventory-safe-correction-fixture.mjs';
import * as partnerSelectOptionsModule from '../lib/partners/select-options.ts';
const load=(file,deps={})=>{const m={exports:{}};const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(name=>{assert.ok(name in deps,'unexpected dependency '+name);return deps[name];},m,m.exports);return m.exports;};
const version='2026-10-10T03:00:00.000Z';
function setup({role='owner',authenticated=true,inactive=false,race=false,closed=false,quantity=2,postCommitFailure=false,rpcHandler=null,correctionRows=[],stockCheck=null,paid=false,rootDate="2026-10-03",extraRoots=[],rootOverrides={},itemOverrides={},businessDate="2026-10-10",candidateOverride=undefined,transactionOverride=undefined,payableOverride=undefined,allocations=[]}={}) {
 const calls=[],writes=[],projections=[];
 const item={id:1,item_name:'Oil',item_name_vi:'Dau',part:'kitchen',quantity,purchase_price:30000,supplier:'QA',supplier_partner_id:null,unit:'bottle',code:'QA',is_active:!inactive,updated_at:version,...itemOverrides};
 const root={id:12407,item_id:1,reason:'purchase',change_quantity:2,correction_of_inventory_log_id:null,business_date:rootDate,created_at:rootDate+'T03:00:00Z',unit:'bottle',new_supplier:'QA',new_purchase_price:30000,purchase_supplier_partner_id:null,...rootOverrides};
 const db={from(table){calls.push(table);let update,insert,filters=[];const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},is(k,v){filters.push([k,v]);return q;},neq(k,v){filters.push(['!'+k,v]);return q;},in(k,v){filters.push(['in:'+k,v]);return q;},order(){return q;},gt(){return q;},lte(){return q;},limit(){return q;},update(v){update=v;return q;},insert(v){insert=v;return q;},single(){return q;},maybeSingle(){return q;},then(resolve,reject){let data=null;
 if(table==='inventory'){
  if(update){if(race)item.updated_at='2026-10-10T04:00:00.000Z';if(filters.every(([k,v])=>k.startsWith('!')?item[k.slice(1)]!==v:item[k]===v)){Object.assign(item,update);writes.push({table,update});data={...item};}}
  else data=filters.some(([k])=>k==='!id')?[]:{...item};
 }else if(table==='inventory_logs'){if(insert){if(postCommitFailure)throw Error('audit transport unavailable');writes.push({table,insert});data={id:101,...insert};}else if(filters.some(([k,v])=>k==='reason'&&v==='stock_check'))data=stockCheck;else if(filters.some(([k,v])=>(k==='correction_of_inventory_log_id'&&v!==null)||k==='in:correction_of_inventory_log_id'))data=correctionRows;else data=[root,...extraRoots];}
 else if(table==='business_partners')data=[{id:10,name:'QA',partner_type:'food',partner_subtype_id:3,is_active:true}];
 else if(table==='business_partner_subtypes')data=[{id:3,emoji:'🥩'}];
 else if(table==='business_partner_supplier_aliases')data=[{id:20,supplier_name:'Alias',status:'linked',business_partner_id:10}];
 else if(table==='ledger_month_closures')data=closed?{month:'2026-10-01'}:null;
 else if(table==='ledger_candidates')data=candidateOverride!==undefined?candidateOverride:paid?{status:'confirmed',proposed_amount:60000,resolved_transaction_id:1}:null;
 else if(table==='ledger_transactions')data=transactionOverride!==undefined?transactionOverride:{id:1,status:'confirmed',type:'expense',source_type:'inventory_purchase_candidate',amount:60000,business_date:'2026-10-03',recognition_month:'2026-10-01'};
 else if(table==='ledger_payables')data=payableOverride!==undefined?payableOverride:paid?{id:1,status:'paid'}:null;
 else if(table==='ledger_payable_allocations')data=allocations;
 else throw Error('Unexpected table '+table);
 return Promise.resolve({data,error:null}).then(resolve,reject);}};return q;},rpc:async(name,args)=>{calls.push(name);if(rpcHandler)return rpcHandler(name,args);if(name==='inventory_update_with_audit_v1'){
 if(race)item.updated_at='2026-10-10T04:00:00.000Z';
 if(JSON.stringify(item)!==JSON.stringify(args.p_expected_item))return {data:{status:'inventory_conflict'},error:null};
 if(postCommitFailure)return {data:null,error:{message:'audit transaction aborted'}};
 Object.assign(item,args.p_payload,{updated_at:'2026-10-10T05:00:00.000Z'});
 writes.push({table:'inventory',update:args.p_payload},{table:'inventory_logs',insert:{source_actor_user_id:args.p_actor_user_id}});
 return {data:{status:'ok',inventoryLogId:101},error:null};}
 if(name==='inventory_apply_purchase_correction_v3'){writes.push({rpc:name,args});return {data:{status:'ok',inventoryLogId:101,ledgerSync:{status:'synced',code:'REBOOKED',inventoryLogId:101}},error:null};}throw Error('Unexpected RPC '+name);}};
 const auth=authenticated?{ok:true,actor:{id:7,name:'Session actor',username:'qa',role}}:{ok:false,code:'RELOGIN_REQUIRED',status:401};
 const route=load('app/api/inventory/items/route.ts',{
 'next/server':{NextResponse:{json:Response.json}},'@supabase/supabase-js':{createClient:()=>db},
 '@/lib/auth/server-auth':{getAuthenticatedActor:async()=>auth},'@/lib/inventory/number':load('lib/inventory/number.ts'),
 '@/lib/inventory/keg-progress':{fetchKegProgressByItemId:async()=>new Map()},
 '@/lib/inventory/items-server':{canToggleInventoryItemActiveStatus:r=>['owner','master','manager','leader'].includes(r),fetchInventoryItems:()=>{throw Error('bulk read forbidden in selected route');},fetchActiveKegTrackingMappings:()=>[],getInventoryKegCandidateIds:()=>[],buildInventoryItemsResponse:({items})=>items},
 '@/lib/inventory/normalize':load('lib/inventory/normalize.ts'),
 '@/lib/inventory/inventory-business-time':{resolveInventoryBusinessDate:async()=>({businessDate})},
 '@/lib/inventory/purchase-correction-policy':load('lib/inventory/purchase-correction-policy.ts'),
 '@/lib/inventory/price-logs':{insertInventoryPriceLog:async()=>{}},
 '@/lib/ledger/inventory-projection':{projectInventoryPurchaseLog:async(id,actor)=>{projections.push({id,actor});return {status:'synced',code:'REBOOKED',inventoryLogId:id};}},
 '@/lib/inventory/supplier-partners-server':{resolveInventorySupplier:async()=>{calls.push('supplier-resolve');return null;},applyResolvedInventorySupplier:p=>p},
 '@/lib/partners/select-options':partnerSelectOptionsModule,
 '@/lib/inventory/reasons':load('lib/inventory/reasons.ts'),
 '@/lib/inventory/parts':load('lib/inventory/parts.ts'),
 });
 return {item,calls,writes,projections,get:(id=1)=>route.GET(new Request('http://test/api/inventory/items?itemId='+id)),patch:body=>route.PATCH(new Request('http://test/api/inventory/items',{method:'PATCH',body:JSON.stringify(body)}))};
}
const edit=overrides=>({id:1,payload:{item_name:'Renamed'},source:'edit_form',reason:'other',expectedQuantity:2,expectedUpdatedAt:version,...overrides});
test('selected item GET rejects unauthenticated/invalid IDs before table reads',async()=>{const a=setup({authenticated:false});assert.equal((await a.get()).status,401);assert.equal(a.calls.length,0);const b=setup();for(const id of ['abc',0,-1,1.5])assert.equal((await b.get(id)).status,400);assert.equal(b.calls.length,0);});
test('selected GET actual response is a one-item array with mapped supplier aliases',async()=>{const s=setup();const r=await s.get();assert.equal(r.status,200);const body=await r.json();assert.equal(body.data.length,1);assert.equal(body.data[0].updated_at,version);assert.deepEqual(body.supplierAliases,[{id:20,supplierName:'Alias',status:'linked',businessPartnerId:10}]);assert.equal(s.calls.filter(t=>t==='inventory').length,1);
 // Same partner option shape as the bootstrap stream: type, effective emoji, active flag.
 assert.deepEqual(body.supplierPartners,[{id:10,name:'QA',partnerType:'food',emoji:'🥩',isActive:true}]);assert.equal(s.calls.filter(t=>t==='business_partner_subtypes').length,1);});
test('inactive selected GET/PATCH require leader permission; active staff edit remains allowed',async()=>{for(const role of ['staff','manager','leader','owner','master']){const s=setup({role,inactive:true});const status=role==='staff'?403:200;assert.equal((await s.get()).status,status);assert.equal((await s.patch(edit())).status,status);if(status===403)assert.equal(s.writes.length,0);}assert.equal((await setup({role:'staff'}).patch(edit())).status,200);});
test('PATCH 401 and active-status bypass cannot write',async()=>{const a=setup({authenticated:false});assert.equal((await a.patch(edit())).status,401);assert.equal(a.writes.length,0);const b=setup({role:'staff'});assert.equal((await b.patch(edit({payload:{is_active:false}}))).status,400);assert.equal(b.writes.length,0);});
test('stale metadata/quantity rejects before supplier resolution and all source writes',async()=>{for(const body of [edit({expectedUpdatedAt:'2026-10-09T00:00:00Z'}),edit({expectedQuantity:1})]){const s=setup();const r=await s.patch(body);assert.equal(r.status,409);assert.equal(s.writes.length,0);assert.ok(!s.calls.includes('supplier-resolve'));}});
test('compare-and-set rejects a concurrent change after the initial read, without an audit or price write',async()=>{const s=setup({race:true});const r=await s.patch(edit());assert.equal(r.status,409);assert.equal((await r.json()).error,'INVENTORY_CONFLICT');assert.equal(s.writes.length,0);assert.equal(s.item.item_name,'Oil');});
test('actual PATCH success has ok/mode/ledgerSync, no data; actor identity is server-controlled',async()=>{const s=setup();const body=await (await s.patch(edit({payload:{item_name:'Renamed',updated_by_name:'Spoof'}}))).json();assert.equal(body.ok,true);assert.ok(!('data' in body));assert.equal(s.item.updated_by_name,'Session actor');assert.equal(s.writes.filter(w=>w.table==='inventory_logs').length,1);assert.equal(s.item.quantity,2);assert.equal(s.item.purchase_price,30000);assert.equal(s.projections.length,0);});
test('replayed stale edit is rejected, producing one source log only',async()=>{const s=setup();assert.equal((await s.patch(edit())).status,200);assert.equal((await s.patch(edit())).status,409);assert.equal(s.writes.filter(w=>w.table==='inventory_logs').length,1);});
test('purchase reduction requires root confirmation; closed month rejects before source/RPC/ledger writes',async()=>{const body=edit({payload:{quantity:1,unit:'bottle',supplier:'QA',purchase_price:30000},reason:'purchase'});const s=setup();let r=await s.patch(body);assert.equal(r.status,409);const rejected=await r.json();assert.equal(rejected.error,'purchase_correction_selection_required');assert.equal(rejected.candidates[0].id,12407);assert.equal(s.writes.length,0);
 const closed=setup({closed:true});r=await closed.patch({...body,selectedPurchaseRootId:12407});assert.equal(r.status,409);assert.equal(closed.writes.length,0);assert.equal(closed.projections.length,0);
 const open=setup();r=await open.patch({...body,selectedPurchaseRootId:12407});assert.equal(r.status,200);assert.equal(open.writes[0].rpc,'inventory_apply_purchase_correction_v3');assert.equal(open.writes[0].args.p_expected_quantity,2);assert.deepEqual(open.projections,[]);assert.equal((await r.json()).ledgerSync.status,'synced');
});


test('real log GET omits cancelled #613, retains inactive history, and leaves raw audit roots unchanged',async()=>{
 const rows=[{id:12407,item_id:613,item_name:'Cancelled oil',reason:'purchase',change_quantity:2,business_date:'2026-10-03',created_at:'2026-10-03T03:00:00Z',correction_of_inventory_log_id:null},
 {id:12883,item_id:613,reason:'purchase',change_quantity:-2,business_date:'2026-10-10',created_at:'2026-10-10T03:00:00Z',correction_of_inventory_log_id:12407},
 {id:800,item_id:999,item_name:'Inactive historical purchase',is_active:false,reason:'purchase',change_quantity:3,business_date:'2026-10-03',created_at:'2026-10-03T03:00:00Z',correction_of_inventory_log_id:null}];
 const original=JSON.stringify(rows),selects=[];
 const db={from(table){assert.equal(table,'inventory_logs');let filters=[];const q={select(fields){selects.push(fields);return q;},eq(k,v){filters.push(row=>row[k]===v);return q;},in(k,values){filters.push(row=>values.includes(row[k]));return q;},order(){return q;},limit(){return q;},range(){return q;},returns(){return q;},then(resolve,reject){return Promise.resolve({data:rows.filter(row=>filters.every(f=>f(row))),error:null}).then(resolve,reject);}};return q;}};
 const route=load('app/api/inventory/logs/route.ts',{
 'next/server':{NextResponse:{json:Response.json}},'@/lib/inventory/daily-effective-purchases':load('lib/inventory/daily-effective-purchases.ts'),
 '@/lib/auth/server-auth':{getAuthenticatedActor:async()=>({ok:true,actor:{id:7,role:'owner'}})},
 '@/lib/inventory/reasons':load('lib/inventory/reasons.ts'),
 '@/lib/inventory/keg-replacement-summary':{fetchPreviousKegSessionSummariesByLogId:async()=>new Map(),fetchPreviousKegSummariesByLogId:async()=>new Map()},
 '@/lib/supabase/server':{supabaseServer:db},'@/lib/inventory/log-sync-server':{},'@/lib/ledger/inventory-projection':{},'@/lib/inventory/supplier-partners-server':{},'@/lib/inventory/price-logs':{},
 });
 for(const view of ['', '&view=cards']){
 const response=await route.GET(new Request('http://test/api/inventory/logs?mode=logs&businessDate=2026-10-03&effectivePurchases=true'+view));
 assert.equal(response.status,200);const body=await response.json();assert.deepEqual(body.data.map(row=>row.id),[800]);assert.equal(body.data[0].change_quantity,3);
 }
 const raw=await (await route.GET(new Request('http://test/api/inventory/logs?mode=logs&businessDate=2026-10-03'))).json();assert.deepEqual(raw.data.map(row=>row.id),[12407,800]);assert.equal(JSON.stringify(rows),original);
 assert.ok(selects.some(fields=>fields.includes('correction_of_inventory_log_id')));
});


test('ordinary audit failure returns 500 and preserves the item, with no nontransactional fallback',async()=>{
 const s=setup({postCommitFailure:true});const r=await s.patch(edit());assert.equal(r.status,500);
 assert.equal(s.item.item_name,'Oil');assert.equal(s.writes.length,0);assert.equal((await r.json()).ok,false);
 const replay=await s.patch(edit());assert.equal(replay.status,500);assert.equal(s.writes.length,0);
});

async function actualRpcSetup(){
 const db=await atomicInventoryDatabase();await db.exec(`insert into users(id,role,is_active,app_login_enabled,name,username) values(7,'owner',true,true,'Session actor','qa');
 update inventory set quantity=2,purchase_price=30000,item_name='Oil',item_name_vi='Dau',part='kitchen',supplier='QA',supplier_partner_id=null,unit='bottle',code='QA',updated_at='2026-10-10T03:00:00Z' where id=1;`);
 const s=setup({rpcHandler:async(name,args)=>{try{
  const entries=Object.entries(args);const sql='select '+name+'('+entries.map(([key],i)=>key+'=> $'+(i+1)).join(',')+') as result';
  const data=(await db.query(sql,entries.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v))).rows[0].result;return {data,error:null};
 }catch(error){return {data:null,error};}}});return {db,s};
}
test('actual API -> actual DB RPC: audit failure is 500/ok:false, all data rolls back; retry succeeds',async()=>{
 const {db,s}=await actualRpcSetup();try{
  const before=(await db.query('select to_jsonb(i) as item from inventory i where id=1')).rows[0].item;
  await db.exec(`create function qa_api_fail() returns trigger language plpgsql as $$begin raise exception 'QA_REQUIRED_AUDIT_FAILURE';end$$;
    create trigger qa_api_fail before insert on inventory_logs for each row execute function qa_api_fail()`);
  const r=await s.patch(edit());assert.equal(r.status,500);assert.equal((await r.json()).ok,false);
  assert.deepEqual((await db.query('select to_jsonb(i) as item from inventory i where id=1')).rows[0].item,before);
  assert.equal(s.writes.length,0);assert.equal(s.projections.length,0);
  await db.exec('drop trigger qa_api_fail on inventory_logs');const success=await s.patch(edit());assert.equal(success.status,200);assert.equal((await success.json()).ok,true);
  assert.equal((await db.query('select item_name from inventory where id=1')).rows[0].item_name,'Renamed');
  assert.equal((await s.patch(edit())).status,409);
 }finally{await db.close();}
});
test('actual API -> actual DB RPC: change between read and write is 409 and preserves other admin data',async()=>{
 const {db,s}=await actualRpcSetup();try{
  await db.exec("update inventory set item_name='Other admin' where id=1");
  const r=await s.patch(edit());assert.equal(r.status,409);assert.equal((await r.json()).error,'INVENTORY_CONFLICT');
  assert.equal((await db.query('select item_name from inventory where id=1')).rows[0].item_name,'Other admin');
  assert.equal((await db.query('select * from inventory_logs where id<>100')).rows.length,0);assert.equal(s.writes.length,0);
 }finally{await db.close();}
});
test('missing transaction RPC never falls back to separate writes or displays success',async()=>{
 const s=setup({rpcHandler:async()=>({data:null,error:{code:'PGRST202'}})});const r=await s.patch(edit());assert.equal(r.status,500);assert.equal((await r.json()).ok,false);assert.equal(s.writes.length,0);assert.equal(s.item.item_name,'Oil');
});
test('correction passes complete read snapshot and maps DB metadata conflict to 409 without projection',async()=>{
 const s=setup({rpcHandler:async(name,args)=>{assert.equal(name,'inventory_apply_purchase_correction_v3');assert.deepEqual(args.p_expected_item,s.item);return {data:{status:'inventory_conflict'},error:null};}});
 const r=await s.patch(edit({payload:{quantity:1,unit:'bottle',supplier:'QA',purchase_price:30000},reason:'purchase',selectedPurchaseRootId:12407}));assert.equal(r.status,409);assert.equal((await r.json()).ok,false);assert.equal(s.writes.length,0);assert.equal(s.projections.length,0);
});

test('ordinary RPC correction guard returns 409 without success, source fallback or projection',async()=>{
 const s=setup({rpcHandler:async(name)=>{assert.equal(name,'inventory_update_with_audit_v1');return {data:{status:'purchase_correction_required'},error:null};}});const r=await s.patch(edit());assert.equal(r.status,409);const body=await r.json();assert.equal(body.ok,false);assert.equal(body.error,'purchase_correction_required');assert.equal(s.writes.length,0);assert.equal(s.projections.length,0);
});
for(const [dbStatus,httpStatus] of [['not_found',404],['forbidden',403],['quantity_conflict',409],['invalid_payload',400]])test('correction RPC '+dbStatus+' maps to HTTP '+httpStatus+' without success or projection',async()=>{
 const s=setup({rpcHandler:async(name)=>{assert.equal(name,'inventory_apply_purchase_correction_v3');return {data:{status:dbStatus},error:null};}});const r=await s.patch(edit({payload:{quantity:1,unit:'bottle',supplier:'QA',purchase_price:30000},reason:'purchase',selectedPurchaseRootId:12407}));assert.equal(r.status,httpStatus);assert.equal((await r.json()).ok,false);assert.equal(s.projections.length,0);assert.equal(s.writes.length,0);
});

test('missing atomic correction v3 fails without legacy or post-commit projection fallback',async()=>{
 const s=setup({rpcHandler:async(name)=>{assert.equal(name,'inventory_apply_purchase_correction_v3');return {data:null,error:{code:'PGRST202'}};}});
 const r=await s.patch(edit({payload:{quantity:1,unit:'bottle',supplier:'QA',purchase_price:30000},reason:'purchase',selectedPurchaseRootId:12407}));assert.equal(r.status,500);assert.equal((await r.json()).ok,false);assert.equal(s.writes.length,0);assert.equal(s.projections.length,0);
});
test('quick-save automatically links one receipt from today and calls the existing atomic RPC once',async()=>{
 const s=setup({role:'staff',rootDate:'2026-10-10',correctionRows:[{id:10,correction_of_inventory_log_id:12407,change_quantity:-0.5}]});
 const body=edit({mode:'quick-save',source:'quick_save',payload:{quantity:1,unit:'bottle',supplier:'QA',purchase_price:30000},reason:'purchase'});
 const saved=await s.patch(body);assert.equal(saved.status,200);assert.equal(s.writes.length,1);assert.equal(s.writes[0].rpc,'inventory_apply_purchase_correction_v3');assert.equal(s.writes[0].args.p_purchase_log_id,12407);assert.deepEqual(s.projections,[]);
});
test('automatic quick-save cannot overcorrect a partially corrected receipt',async()=>{
 const s=setup({rootDate:'2026-10-10',correctionRows:[{correction_of_inventory_log_id:12407,change_quantity:-1.5}]});const r=await s.patch(edit({mode:'quick-save',source:'quick_save',payload:{quantity:1},reason:'purchase'}));assert.equal(r.status,409);assert.equal((await r.json()).error,'purchase_correction_exceeds_purchase');assert.deepEqual(s.writes,[]);
});
test('fully cancelled receipts are not proposed for another negative correction',async()=>{
 const s=setup({rootDate:"2026-10-10",correctionRows:[{correction_of_inventory_log_id:12407,change_quantity:-2}]});const r=await s.patch(edit({mode:'quick-save',source:'quick_save',payload:{quantity:1},reason:'purchase'}));assert.equal((await r.json()).error,'purchase_correction_root_not_found');assert.deepEqual(s.writes,[]);
});
test('both purchase editors preserve later physical stock, including a zero-delta count',async()=>{
 for(const mode of ['quick-save','edit']){const s=setup({rootDate:"2026-10-10",stockCheck:{id:13000,reason:'stock_check',created_at:'2026-10-11T00:00:00Z',change_quantity:0}});const r=await s.patch(edit({mode,source:mode==='quick-save'?'quick_save':'edit_form',payload:{quantity:1},reason:'purchase',autoSelectPurchaseRoot:true}));assert.equal(r.status,409);assert.equal((await r.json()).error,'purchase_correction_later_stock_check');assert.deepEqual(s.writes,[]);}
});
test('quick correction retains paid and closed-month protections with no writes',async()=>{
 for(const option of [{paid:true},{closed:true}]){const s=setup({...option,rootDate:"2026-10-10"});const r=await s.patch(edit({mode:'quick-save',source:'quick_save',payload:{quantity:1},reason:'purchase'}));assert.equal(r.status,409);assert.equal((await r.json()).error,'purchase_correction_review_required');assert.deepEqual(s.writes,[]);}
});
test('an automatic quick correction preserves the atomic RPC conflict result and never falls back',async()=>{
 const s=setup({rootDate:"2026-10-10",rpcHandler:async()=>({data:{status:'inventory_conflict'},error:null})});const r=await s.patch(edit({mode:'quick-save',source:'quick_save',payload:{quantity:1},reason:'purchase'}));assert.equal(r.status,409);assert.deepEqual(s.writes,[]);assert.deepEqual(s.projections,[]);
});

test('privileged emergency corrections also preserve later physical counts',async()=>{
 const s=setup({stockCheck:{id:13000,reason:'stock_check',created_at:'2026-10-04T00:00:00Z',change_quantity:0}});const response=await s.patch(edit({payload:{quantity:1},reason:'purchase',correction_of_inventory_log_id:12407}));assert.equal(response.status,409);assert.equal((await response.json()).error,'purchase_correction_later_stock_check');assert.deepEqual(s.writes,[]);
});
test('unknown physical-count chronology fails closed instead of changing stock',async()=>{
 const s=setup({stockCheck:{id:13000,reason:'stock_check',created_at:'invalid'}});const response=await s.patch(edit({payload:{quantity:1},reason:'purchase',selectedPurchaseRootId:12407}));assert.equal(response.status,409);assert.equal((await response.json()).error,'purchase_correction_review_required');assert.deepEqual(s.writes,[]);
});

test('automatic resolution rejects previous-day, wrong-price, missing and ambiguous receipts without any writes',async()=>{
 for(const options of [{},{rootDate:'2026-10-10',rootOverrides:{new_purchase_price:29000}},{rootDate:'2026-10-10',rootOverrides:{unit:'kg'}},{rootDate:'2026-10-10',rootOverrides:{new_supplier:'Another supplier'}},{rootDate:'2026-10-10',extraRoots:[{id:12408,item_id:1,reason:'purchase',change_quantity:1,correction_of_inventory_log_id:null,business_date:'2026-10-10',created_at:'2026-10-10T04:00:00Z',unit:'bottle',new_supplier:'QA',new_purchase_price:30000,purchase_supplier_partner_id:null}]}]){
  for(const mode of ['quick-save','edit']){const s=setup(options);const r=await s.patch(edit({mode,reason:'purchase',autoSelectPurchaseRoot:true,payload:{quantity:1}}));assert.equal(r.status,409);assert.ok(['purchase_correction_root_not_found','purchase_correction_ambiguous'].includes((await r.json()).error));assert.deepEqual(s.writes,[]);assert.deepEqual(s.projections,[]);}
 }
});
test('caller cannot force a chosen quick-save root or bypass the expected-quantity requirement',async()=>{
 for(const body of [edit({mode:'quick-save',reason:'purchase',payload:{quantity:1},selectedPurchaseRootId:12407}),edit({mode:'quick-save',reason:'purchase',payload:{quantity:1},expectedQuantity:undefined})]){const s=setup({rootDate:'2026-10-10'});const r=await s.patch(body);assert.equal(r.status,400);assert.deepEqual(s.writes,[]);}
});
test('edit form automatically links today without returning candidate selectors',async()=>{
 const s=setup({rootDate:'2026-10-10',role:'staff'});const r=await s.patch(edit({reason:'purchase',autoSelectPurchaseRoot:true,payload:{quantity:1}}));assert.equal(r.status,200);const b=await r.json();assert.equal(b.candidates,undefined);assert.equal(s.writes[0].args.p_purchase_log_id,12407);
});
test('automatic same-day API -> actual v3 SQL rebooks one expense and preserves audit and unpaid links',async()=>{
 const db=await safeFixture();try{
  await db.exec("insert into users(id,role,is_active,app_login_enabled,name,username) values(7,'staff',true,true,'Session actor','qa')");
  const old=await safeSnapshot(db);const row=(await db.query('select * from inventory_logs where id=100')).rows[0];const root={...row,business_date:row.business_date.toISOString().slice(0,10),created_at:row.created_at.toISOString()};
  const s=setup({role:'staff',quantity:Number(old.quantity),itemOverrides:old,rootOverrides:root,businessDate:'2026-10-11',rpcHandler:async(name,args)=>{try{const entries=Object.entries(args),data=(await db.query('select '+name+'('+entries.map(([key],i)=>key+'=> $'+(i+1)).join(',')+') as result',entries.map(([,v])=>v!==null&&typeof v==='object'?JSON.stringify(v):v))).rows[0].result;return {data,error:null};}catch(error){return {data:null,error};}}});
  const response=await s.patch(edit({mode:'quick-save',reason:'purchase',expectedQuantity:Number(old.quantity),expectedUpdatedAt:old.updated_at,payload:{quantity:9}}));
  assert.equal(response.status,200,JSON.stringify(await response.clone().json()));assert.equal((await response.json()).ledgerSync.code,'REBOOKED');assert.equal(Number((await db.query('select quantity from inventory where id=1')).rows[0].quantity),9);
  assert.equal(Number((await db.query('select sum(amount*economic_effect_sign) as n from ledger_transactions')).rows[0].n),180000);
  assert.equal(Number((await db.query("select count(*) as n from ledger_transactions where source_type='inventory_purchase_reversal'")).rows[0].n),1);
  assert.equal(Number((await db.query('select correction_of_inventory_log_id as id from inventory_logs where correction_of_inventory_log_id=100')).rows[0].id),100);
  assert.equal(Number((await db.query("select count(*) as n from ledger_audit_logs where action='inventory_purchase_auto_corrected'")).rows[0].n),1);
  assert.equal(Number((await db.query("select count(*) as n from ledger_payables where status='unpaid' and original_amount=180000")).rows[0].n),1);
 }finally{await db.close();}
});

const alertRoot=id=>({id,item_id:1,reason:'purchase',change_quantity:2,correction_of_inventory_log_id:null,business_date:'2026-10-10',created_at:'2026-10-10T03:00:00Z',unit:'bottle',new_supplier:'QA',new_purchase_price:30000,purchase_supplier_partner_id:null});
test('ambiguous error keeps its code and reports exactly the compatible effective candidate count',async()=>{
 const s=setup({rootDate:'2026-10-10',extraRoots:[alertRoot(12408),alertRoot(12409),{...alertRoot(12410),unit:'kg'},alertRoot(12411)],correctionRows:[{correction_of_inventory_log_id:12411,change_quantity:-2}]});
 const response=await s.patch(edit({mode:'quick-save',reason:'purchase',payload:{quantity:1}}));assert.equal(response.status,409);const b=await response.json();assert.equal(b.error,'purchase_correction_ambiguous');assert.equal(b.blockReason,'multiple_candidates');assert.equal(b.candidateCount,3);assert.equal(b.candidateCountExact,true);assert.equal(b.candidates,undefined);assert.deepEqual(s.writes,[]);assert.deepEqual(s.projections,[]);
});
test('candidate truncation never claims an exact count or chooses a receipt',async()=>{
 const s=setup({rootDate:'2026-10-10',extraRoots:Array.from({length:1000},(_,i)=>alertRoot(20000+i))});const r=await s.patch(edit({mode:'quick-save',reason:'purchase',payload:{quantity:1}}));assert.equal(r.status,409);const b=await r.json();assert.equal(b.error,'purchase_correction_ambiguous');assert.equal(b.blockReason,'candidate_limit');assert.equal(b.candidateCountExact,false);assert.deepEqual(s.writes,[]);
});
for(const [name,options,code,blockReason] of [
 ['paid',{paid:true},'purchase_correction_review_required','payment_completed'],
 ['allocated',{paid:true,payableOverride:{id:1,status:'unpaid'},allocations:[{allocated_amount:100}]},'purchase_correction_review_required','payment_allocated'],
 ['other payment state',{paid:true,payableOverride:{id:1,status:'cancelled'}},'purchase_correction_review_required','payment_state'],
 ['closed month',{closed:true},'purchase_correction_review_required','month_closed'],
 ['missing ledger transaction',{paid:true,transactionOverride:null},'purchase_correction_review_required','ledger_transaction_missing'],
 ['changed ledger amount',{paid:true,transactionOverride:{amount:50000}},'purchase_correction_review_required','ledger_amount_changed'],
 ['dismissed source',{candidateOverride:{status:'dismissed'}},'purchase_correction_review_required','purchase_dismissed'],
 ['unknown physical check',{stockCheck:{id:13000,reason:'stock_check',created_at:'invalid'}},'purchase_correction_review_required','physical_count_unverified'],
 ['later physical check',{stockCheck:{id:13000,reason:'stock_check',created_at:'2026-10-11T00:00:00Z'}},'purchase_correction_later_stock_check',undefined],
 ['overcorrection',{correctionRows:[{correction_of_inventory_log_id:12407,change_quantity:-1.5}]},'purchase_correction_exceeds_purchase',undefined],
 ['quantity conflict',{},'QUANTITY_CONFLICT',undefined],
])test('server reports '+name+' from the actual guard without source or ledger writes',async()=>{
 const s=setup({rootDate:'2026-10-10',...options});const r=await s.patch(edit({mode:'quick-save',reason:'purchase',payload:{quantity:1},...(name==='quantity conflict'?{expectedQuantity:1}:{})}));assert.equal(r.status,409);const b=await r.json();assert.equal(b.error,code);assert.equal(b.blockReason,blockReason);assert.deepEqual(s.writes,[]);assert.deepEqual(s.projections,[]);
});
