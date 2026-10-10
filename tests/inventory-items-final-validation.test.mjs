import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {atomicInventoryDatabase} from './helpers/inventory-atomic-fixture.mjs';
const load=(file,deps={})=>{const m={exports:{}};const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(name=>{assert.ok(name in deps,'unexpected dependency '+name);return deps[name];},m,m.exports);return m.exports;};
const version='2026-10-10T03:00:00.000Z';
function setup({role='owner',authenticated=true,inactive=false,race=false,closed=false,quantity=2,postCommitFailure=false,rpcHandler=null}={}) {
 const calls=[],writes=[],projections=[];
 const item={id:1,item_name:'Oil',item_name_vi:'Dau',part:'kitchen',quantity,purchase_price:30000,supplier:'QA',supplier_partner_id:null,unit:'bottle',code:'QA',is_active:!inactive,updated_at:version};
 const root={id:12407,item_id:1,reason:'purchase',change_quantity:2,correction_of_inventory_log_id:null,business_date:'2026-10-03',created_at:'2026-10-03T03:00:00Z',unit:'bottle',new_supplier:'QA',new_purchase_price:30000,purchase_supplier_partner_id:null};
 const db={from(table){calls.push(table);let update,insert,single=false,filters=[];const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},is(k,v){filters.push([k,v]);return q;},neq(k,v){filters.push(['!'+k,v]);return q;},in(){return q;},order(){return q;},gt(){return q;},lte(){return q;},limit(){return q;},update(v){update=v;return q;},insert(v){insert=v;return q;},single(){single=true;return q;},maybeSingle(){single=true;return q;},then(resolve,reject){let data=null;
 if(table==='inventory'){
  if(update){if(race)item.updated_at='2026-10-10T04:00:00.000Z';if(filters.every(([k,v])=>k.startsWith('!')?item[k.slice(1)]!==v:item[k]===v)){Object.assign(item,update);writes.push({table,update});data={...item};}}
  else data=filters.some(([k])=>k==='!id')?[]:{...item};
 }else if(table==='inventory_logs'){if(insert){if(postCommitFailure)throw Error('audit transport unavailable');writes.push({table,insert});data={id:101,...insert};}else if(filters.some(([k,v])=>k==='correction_of_inventory_log_id' && v!==null))data=[];else data=[root];}
 else if(table==='business_partners')data=[{id:10,name:'QA'}];
 else if(table==='business_partner_supplier_aliases')data=[{id:20,supplier_name:'Alias',status:'linked',business_partner_id:10}];
 else if(table==='ledger_month_closures')data=closed?{month:'2026-10-01'}:null;
 else if(table==='ledger_candidates')data=null;
 else throw Error('Unexpected table '+table);
 return Promise.resolve({data,error:null}).then(resolve,reject);}};return q;},rpc:async(name,args)=>{calls.push(name);if(rpcHandler)return rpcHandler(name,args);if(name==='inventory_update_with_audit_v1'){
 if(race)item.updated_at='2026-10-10T04:00:00.000Z';
 if(JSON.stringify(item)!==JSON.stringify(args.p_expected_item))return {data:{status:'inventory_conflict'},error:null};
 if(postCommitFailure)return {data:null,error:{message:'audit transaction aborted'}};
 Object.assign(item,args.p_payload,{updated_at:'2026-10-10T05:00:00.000Z'});
 writes.push({table:'inventory',update:args.p_payload},{table:'inventory_logs',insert:{source_actor_user_id:args.p_actor_user_id}});
 return {data:{status:'ok',inventoryLogId:101},error:null};}
 if(name==='inventory_apply_purchase_correction_v2'){writes.push({rpc:name,args});return {data:{status:'ok',inventoryLogId:101},error:null};}throw Error('Unexpected RPC '+name);}};
 const auth=authenticated?{ok:true,actor:{id:7,name:'Session actor',username:'qa',role}}:{ok:false,code:'RELOGIN_REQUIRED',status:401};
 const route=load('app/api/inventory/items/route.ts',{
 'next/server':{NextResponse:{json:Response.json}},'@supabase/supabase-js':{createClient:()=>db},
 '@/lib/auth/server-auth':{getAuthenticatedActor:async()=>auth},'@/lib/inventory/number':load('lib/inventory/number.ts'),
 '@/lib/inventory/keg-progress':{fetchKegProgressByItemId:async()=>new Map()},
 '@/lib/inventory/items-server':{canToggleInventoryItemActiveStatus:r=>['owner','master','manager','leader'].includes(r),fetchInventoryItems:()=>{throw Error('bulk read forbidden in selected route');},fetchActiveKegTrackingMappings:()=>[],getInventoryKegCandidateIds:()=>[],buildInventoryItemsResponse:({items})=>items},
 '@/lib/inventory/normalize':load('lib/inventory/normalize.ts'),
 '@/lib/inventory/inventory-business-time':{resolveInventoryBusinessDate:async()=>({businessDate:'2026-10-10'})},
 '@/lib/inventory/purchase-correction-policy':load('lib/inventory/purchase-correction-policy.ts'),
 '@/lib/inventory/price-logs':{insertInventoryPriceLog:async()=>{}},
 '@/lib/ledger/inventory-projection':{projectInventoryPurchaseLog:async(id,actor)=>{projections.push({id,actor});return {status:'synced',code:'REBOOKED',inventoryLogId:id};}},
 '@/lib/inventory/supplier-partners-server':{resolveInventorySupplier:async()=>{calls.push('supplier-resolve');return null;},applyResolvedInventorySupplier:p=>p},
 '@/lib/inventory/reasons':load('lib/inventory/reasons.ts'),
 '@/lib/inventory/parts':load('lib/inventory/parts.ts'),
 });
 return {item,calls,writes,projections,get:(id=1)=>route.GET(new Request('http://test/api/inventory/items?itemId='+id)),patch:body=>route.PATCH(new Request('http://test/api/inventory/items',{method:'PATCH',body:JSON.stringify(body)}))};
}
const edit=overrides=>({id:1,payload:{item_name:'Renamed'},source:'edit_form',reason:'other',expectedQuantity:2,expectedUpdatedAt:version,...overrides});
test('selected item GET rejects unauthenticated/invalid IDs before table reads',async()=>{const a=setup({authenticated:false});assert.equal((await a.get()).status,401);assert.equal(a.calls.length,0);const b=setup();for(const id of ['abc',0,-1,1.5])assert.equal((await b.get(id)).status,400);assert.equal(b.calls.length,0);});
test('selected GET actual response is a one-item array with mapped supplier aliases',async()=>{const s=setup();const r=await s.get();assert.equal(r.status,200);const body=await r.json();assert.equal(body.data.length,1);assert.equal(body.data[0].updated_at,version);assert.deepEqual(body.supplierAliases,[{id:20,supplierName:'Alias',status:'linked',businessPartnerId:10}]);assert.equal(s.calls.filter(t=>t==='inventory').length,1);});
test('inactive selected GET/PATCH require leader permission; active staff edit remains allowed',async()=>{for(const role of ['staff','manager','leader','owner','master']){const s=setup({role,inactive:true});const status=role==='staff'?403:200;assert.equal((await s.get()).status,status);assert.equal((await s.patch(edit())).status,status);if(status===403)assert.equal(s.writes.length,0);}assert.equal((await setup({role:'staff'}).patch(edit())).status,200);});
test('PATCH 401 and active-status bypass cannot write',async()=>{const a=setup({authenticated:false});assert.equal((await a.patch(edit())).status,401);assert.equal(a.writes.length,0);const b=setup({role:'staff'});assert.equal((await b.patch(edit({payload:{is_active:false}}))).status,400);assert.equal(b.writes.length,0);});
test('stale metadata/quantity rejects before supplier resolution and all source writes',async()=>{for(const body of [edit({expectedUpdatedAt:'2026-10-09T00:00:00Z'}),edit({expectedQuantity:1})]){const s=setup();const r=await s.patch(body);assert.equal(r.status,409);assert.equal(s.writes.length,0);assert.ok(!s.calls.includes('supplier-resolve'));}});
test('compare-and-set rejects a concurrent change after the initial read, without an audit or price write',async()=>{const s=setup({race:true});const r=await s.patch(edit());assert.equal(r.status,409);assert.equal((await r.json()).error,'INVENTORY_CONFLICT');assert.equal(s.writes.length,0);assert.equal(s.item.item_name,'Oil');});
test('actual PATCH success has ok/mode/ledgerSync, no data; actor identity is server-controlled',async()=>{const s=setup();const body=await (await s.patch(edit({payload:{item_name:'Renamed',updated_by_name:'Spoof'}}))).json();assert.equal(body.ok,true);assert.ok(!('data' in body));assert.equal(s.item.updated_by_name,'Session actor');assert.equal(s.writes.filter(w=>w.table==='inventory_logs').length,1);assert.equal(s.item.quantity,2);assert.equal(s.item.purchase_price,30000);assert.equal(s.projections.length,0);});
test('replayed stale edit is rejected, producing one source log only',async()=>{const s=setup();assert.equal((await s.patch(edit())).status,200);assert.equal((await s.patch(edit())).status,409);assert.equal(s.writes.filter(w=>w.table==='inventory_logs').length,1);});
test('purchase reduction requires root confirmation; closed month rejects before source/RPC/ledger writes',async()=>{const body=edit({payload:{quantity:1,unit:'bottle',supplier:'QA',purchase_price:30000},reason:'purchase'});const s=setup();let r=await s.patch(body);assert.equal(r.status,409);const rejected=await r.json();assert.equal(rejected.error,'purchase_correction_selection_required');assert.equal(rejected.candidates[0].id,12407);assert.equal(s.writes.length,0);
 const closed=setup({closed:true});r=await closed.patch({...body,selectedPurchaseRootId:12407});assert.equal(r.status,409);assert.equal(closed.writes.length,0);assert.equal(closed.projections.length,0);
 const open=setup();r=await open.patch({...body,selectedPurchaseRootId:12407});assert.equal(r.status,200);assert.equal(open.writes[0].rpc,'inventory_apply_purchase_correction_v2');assert.equal(open.writes[0].args.p_expected_quantity,2);assert.deepEqual(open.projections,[{id:101,actor:7}]);
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
 const s=setup({rpcHandler:async(name,args)=>{assert.equal(name,'inventory_apply_purchase_correction_v2');assert.deepEqual(args.p_expected_item,s.item);return {data:{status:'inventory_conflict'},error:null};}});
 const r=await s.patch(edit({payload:{quantity:1,unit:'bottle',supplier:'QA',purchase_price:30000},reason:'purchase',selectedPurchaseRootId:12407}));assert.equal(r.status,409);assert.equal((await r.json()).ok,false);assert.equal(s.writes.length,0);assert.equal(s.projections.length,0);
});

test('ordinary RPC correction guard returns 409 without success, source fallback or projection',async()=>{
 const s=setup({rpcHandler:async(name)=>{assert.equal(name,'inventory_update_with_audit_v1');return {data:{status:'purchase_correction_required'},error:null};}});const r=await s.patch(edit());assert.equal(r.status,409);const body=await r.json();assert.equal(body.ok,false);assert.equal(body.error,'purchase_correction_required');assert.equal(s.writes.length,0);assert.equal(s.projections.length,0);
});
for(const [dbStatus,httpStatus] of [['not_found',404],['forbidden',403],['quantity_conflict',409],['invalid_payload',400]])test('correction RPC '+dbStatus+' maps to HTTP '+httpStatus+' without success or projection',async()=>{
 const s=setup({rpcHandler:async(name)=>{assert.equal(name,'inventory_apply_purchase_correction_v2');return {data:{status:dbStatus},error:null};}});const r=await s.patch(edit({payload:{quantity:1,unit:'bottle',supplier:'QA',purchase_price:30000},reason:'purchase',selectedPurchaseRootId:12407}));assert.equal(r.status,httpStatus);assert.equal((await r.json()).ok,false);assert.equal(s.projections.length,0);assert.equal(s.writes.length,0);
});
