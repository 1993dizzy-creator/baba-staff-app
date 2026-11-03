import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {inventoryDisplayName,isNameOnlyInventoryEdit} from '../lib/inventory/current-item-names.ts';
function load(path,deps={}){const m={exports:{}};const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name]},m,m.exports);return m.exports}
const {withCurrentInventoryNames}=load('lib/inventory/current-item-names-server.ts',{'server-only':{}});
function database(masters=[],source=[],fail=false){const reads=[];return{reads,from(table){reads.push(table);assert.ok(['inventory','inventory_snapshot_items'].includes(table));let ids=[],active=false;const q={select(){return q},in(field,values){assert.equal(field,'id');ids=values;return q},eq(field,value){if(field==='is_active')active=value;return q},order(){return q},then(resolve){return Promise.resolve(table==='inventory'?{data:masters.filter(m=>ids.includes(m.id)&&(!active||m.is_active)),error:fail?{code:'READ_FAILED'}:null}:{data:source,error:null}).then(resolve)}};return q}}}
const names=['칼갈이 숫돌 받침대','제빵용 이스트 (효모)','스테이크용 철판과 나무 받침대','산타루치아 링귀네 8번','사포코 푸실리 200g','펜네 지티 파스타'];

test('six reported receipt identities display master KO/VI after next-day rename without mutating historical/economic/audit fields',async()=>{
 const ids=[14655,14722,14726,14732,14733,14734];
 const rows=ids.map((id,i)=>Object.freeze({id,item_id:i+1,item_name:'Stored '+i,item_name_vi:'Gốc '+i,business_date:i<3?'2026-11-01':'2026-11-02',quantity:5,change_quantity:2,purchase_price:45000,supplier:'Original supplier',total_purchase_price:90000,prev_item_name:'Audit before',new_item_name:'Audit after'}));
 const masters=names.map((name,i)=>({id:i+1,item_name:name,item_name_vi:i===4?'Fusilli mới':'VI '+i,is_active:true,updated_at:'2026-11-03T03:00:00Z'}));
 const db=database(masters),before=JSON.stringify(rows),out=await withCurrentInventoryNames(db,rows);
 assert.deepEqual(db.reads,['inventory']);assert.equal(JSON.stringify(rows),before);
 out.forEach((r,i)=>{assert.equal(inventoryDisplayName(r,'ko'),names[i]);assert.equal(inventoryDisplayName(r,'vi'),masters[i].item_name_vi);const{currentItemNames,...original}=r;assert.deepEqual(original,rows[i]);assert.ok(currentItemNames)});
});

test('missing language uses current other-language fallback, inactive/missing/failed master uses stored names',async()=>{
 const rows=[1,2,3].map(item_id=>({item_id,item_name:'Stored KO',item_name_vi:'Stored VI'}));
 const db=database([{id:1,item_name:null,item_name_vi:'Tên mới',is_active:true},{id:2,item_name:'Inactive',item_name_vi:'Inactive',is_active:false}]);
 const out=await withCurrentInventoryNames(db,rows);assert.equal(inventoryDisplayName(out[0],'ko'),'Tên mới');assert.equal(inventoryDisplayName(out[1],'ko'),'Stored KO');assert.equal(inventoryDisplayName(out[2],'vi'),'Stored VI');
 assert.deepEqual(await withCurrentInventoryNames(database([],[],true),rows),rows);
 assert.equal(inventoryDisplayName({item_name:'KO',item_name_vi:null},'vi'),'KO');
});

test('bulk enrichment de-duplicates item ids and chunks requests instead of N+1',async()=>{
 const db=database();const rows=Array.from({length:802},(_,i)=>({item_id:i%401+1}));await withCurrentInventoryNames(db,rows);assert.equal(db.reads.length,3);
 const empty=database();await withCurrentInventoryNames(empty,[{item_id:null}]);assert.equal(empty.reads.length,0);
});

test('snapshot API combines names after auth without updating the original snapshot',async()=>{
 const original=[{id:10,item_id:1,item_name:'Old',item_name_vi:'Cũ',quantity:2,purchase_price:45000,total_purchase_price:90000,supplier:'Old supplier'}];const before=JSON.stringify(original);
 const db=database([{id:1,item_name:'New',item_name_vi:'Mới',is_active:true}],original);
 const route=load('app/api/inventory/snapshot/[id]/route.ts',{'next/server':{NextResponse:{json:Response.json}},'@supabase/supabase-js':{createClient:()=>db},'@/lib/auth/server-auth':{getAuthenticatedActor:async()=>({ok:true})},'@/lib/inventory/current-item-names-server':{withCurrentInventoryNames}});
 const body=await(await route.GET(new Request('http://offline/snapshot/1'),{params:Promise.resolve({id:'1'})})).json();assert.equal(inventoryDisplayName(body.items[0],'vi'),'Mới');assert.equal(JSON.stringify(original),before);assert.deepEqual(db.reads,['inventory_snapshot_items','inventory']);
});

test('successful name-only edit needs no economic reload and saved names take precedence over an older response',()=>{
 assert.equal(isNameOnlyInventoryEdit({item_name:'old',category:'A',note:null},{item_name:'new',category:'A',note:'',updated_at:'new'}),true);
 for(const payload of [{quantity:4},{category:'B'},{purchase_price:200},{supplierPartnerId:8}])assert.equal(isNameOnlyInventoryEdit({quantity:3,category:'A',purchase_price:100,supplier_partner_id:7},payload),false);
 const stale={item_id:1,item_name:'stored',item_name_vi:'gốc',currentItemNames:{item_name:'older response',item_name_vi:'cũ'}};
 assert.equal(inventoryDisplayName(stale,'ko',{item_name:'Latest saved',item_name_vi:null}),'Latest saved');
 const saved={item_name:'Saved',item_name_vi:null,beforeUpdatedAt:'2026-11-03T03:00:00Z'};
 assert.equal(inventoryDisplayName({...stale,currentItemNames:{item_name:'Old response',item_name_vi:null,updated_at:saved.beforeUpdatedAt}},'ko',saved),'Saved');
 assert.equal(inventoryDisplayName({...stale,currentItemNames:{item_name:'Newer master',item_name_vi:null,updated_at:'2026-11-03T03:01:00Z'}},'ko',saved),'Newer master');
 assert.equal(inventoryDisplayName({...stale,currentItemNames:null},'ko',saved),'stored');
 const page=readFileSync('app/(protected)/inventory/snapshots/page.tsx','utf8');assert.match(page,/if \(change\?\.namesOnly\) return;/);assert.match(page,/savedItemNames\[Number\(item\.item_id\)\]/);
});
