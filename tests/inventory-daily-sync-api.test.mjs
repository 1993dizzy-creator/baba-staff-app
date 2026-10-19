import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {photoSync622} from './helpers/inventory-photo-sync-fixture.mjs';
function load(path,deps={}){const m={exports:{}};const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name];},m,m.exports);return m.exports;}
function setup({rename=false,economic=false,code='PURCHASE_AMOUNT_CONFIRMATION_REQUIRED',role='owner',linked=false,photoFixture=null,category=null,part=null,display={status:'synced',code:'METADATA_SYNCED'}}={}){
 const root={id:12848,item_id:314,business_date:'2026-10-09',created_at:'2026-10-09T04:00:00Z',reason:'purchase',change_quantity:1,prev_quantity:0,new_quantity:1,item_name:'Pear',item_name_vi:'Lê',part:'kitchen',category:'Fruit',category_vi:'Fruit',code:'P',unit:'kg',new_purchase_price:35000,new_supplier:'Chợ',purchase_supplier_partner_id:7,correction_of_inventory_log_id:null};
 const correction={...root,id:12849,created_at:'2026-10-09T04:01:00Z',reason:'other',change_quantity:0,prev_quantity:1,new_quantity:1,...(economic?{new_supplier:'An Liên',purchase_supplier_partner_id:27}:{}),...(linked?{correction_of_inventory_log_id:12848,reason:'purchase'}:{})};
 const next={...root,id:12900,business_date:'2026-10-10',created_at:'2026-10-10T04:00:00Z',new_purchase_price:40000,new_supplier:'An Liên',purchase_supplier_partner_id:27};
 const master={id:314,item_name:rename?'Fresh pear':'Pear',item_name_vi:'Lê',part:part??'kitchen',category:category??'Fruit',category_vi:category??'Fruit',code:'P',unit:'kg',quantity:2,purchase_price:40000,supplier:'An Liên',supplier_partner_id:27,is_active:true};
 const snapshot={id:1,batch_id:9,item_id:314,item_name:'Pear',quantity:1,prev_quantity:0,change_quantity:1,purchase_price:35000,supplier:'Chợ',total_purchase_price:35000};
 const tables=photoFixture?{inventory_logs:photoFixture.logs,inventory:[photoFixture.master],inventory_snapshot_batches:[],inventory_snapshot_items:[]}:{inventory_logs:[root,correction,next],inventory:[master],inventory_snapshot_batches:[{id:9,snapshot_date:'2026-10-09'}],inventory_snapshot_items:[snapshot]};const calls=[],selects=[];const date=photoFixture?.businessDate??'2026-10-09';
 const db={from(table){const filters=[];let payload,from=0,to=Infinity,single=false;const q={select(fields){selects.push({table,fields});return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},in(k,v){filters.push(r=>v.includes(r[k]));return q;},not(k,op,v){filters.push(r=>r[k]!==v);return q;},order(){return q;},range(a,b){from=a;to=b;return q;},limit(n){to=n-1;return q;},maybeSingle(){single=true;return q;},update(p){payload=p;return q;},then(resolve){let rows=tables[table].filter(r=>filters.every(f=>f(r))).slice(from,to+1);if(payload){calls.push({table,payload,ids:rows.map(r=>r.id)});rows.forEach(r=>Object.assign(r,payload));}return Promise.resolve({data:single?rows[0]||null:rows,error:null}).then(resolve);}};return q;}};
 const contract=load('lib/inventory/ledger-sync-contract.ts');
 const route=load('app/api/inventory/snapshot/name-sync/route.ts',{
 '@supabase/supabase-js':{createClient:()=>db},'next/server':{NextResponse:{json:(b,o)=>Response.json(b,o)}},
 '@/lib/auth/server-auth':{getAuthenticatedActor:async()=>({ok:true,actor:{id:2,role}})},
 '@/lib/inventory/log-sync-server':load('lib/inventory/log-sync-server.ts',{'server-only':{},'@/lib/inventory/ledger-sync-contract':contract}),
 '@/lib/inventory/snapshot-name-sync':load('lib/inventory/snapshot-name-sync.ts'),
 '@/lib/inventory/language-missing':load('lib/inventory/language-missing.ts'),
 '@/lib/inventory/daily-sync-result':load('lib/inventory/daily-sync-result.ts'),
 '@/lib/ledger/inventory-projection':{projectInventoryPurchaseLogs:async(ids,actor)=>{calls.push({projection:ids,actor});assert.equal(actor,2);return {status:economic?'review_required':'synced',code:economic?code:'METADATA_SYNCED',results:[{status:economic?'review_required':'synced',code:economic?code:'METADATA_SYNCED',inventoryLogId:ids[0],candidateId:null,transactionId:2944}]};},
  projectInventoryDisplaySyncLog:async(id,actor)=>{calls.push({displayProjection:id,actor});assert.equal(actor,2);return {...display,inventoryLogId:id};}},
 });
 process.env.NEXT_PUBLIC_SUPABASE_URL='http://isolated.test';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-key-not-a-credential';
 return {root,correction,next,master,snapshot,calls,selects,get:()=>route.GET(new Request('http://test?businessDate='+date)),post:()=>route.POST(new Request('http://test',{method:'POST',body:JSON.stringify({action:'sync_all',business_date:date})}))};
}
test('historical pear root is not a target merely because tomorrow changes the master',async()=>{
 const s=setup();const get=await(await s.get()).json();assert.deepEqual(get.dailySyncItems,[]);const post=await(await s.post()).json();assert.equal(post.syncedCount,0);assert.equal(post.reviewRequiredCount,0);assert.deepEqual(s.calls,[]);assert.equal(s.root.new_supplier,'Chợ');assert.equal(s.next.new_supplier,'An Liên');assert.equal(s.snapshot.supplier,'Chợ');
});
test('display-only same-day synchronization has no economic confirmation and preserves old purchase and snapshot money',async()=>{
 const s=setup({rename:true});const post=await(await s.post()).json();assert.equal(post.syncedCount,1);assert.equal(post.reviewRequiredCount,0);assert.equal(post.results[0].currentItemName,'Fresh pear');assert.equal(post.results[0].targets[0].purchaseLogId,12848);assert.equal(post.results[0].targets[0].code,'METADATA_SYNCED');
 assert.equal(s.root.item_name,'Fresh pear');assert.equal(s.root.new_purchase_price,35000);assert.equal(s.root.new_supplier,'Chợ');assert.equal(s.root.purchase_supplier_partner_id,7);assert.equal(s.next.new_supplier,'An Liên');assert.equal(s.snapshot.item_name,'Fresh pear');assert.equal(s.snapshot.purchase_price,35000);assert.equal(s.snapshot.total_purchase_price,35000);assert.equal(s.snapshot.supplier,'Chợ');assert.equal(s.snapshot.quantity,1);
});
for(const code of ['PURCHASE_AMOUNT_CONFIRMATION_REQUIRED','PAYABLE_ALREADY_PAID','MONTH_CLOSED','MANUAL_LEDGER_OVERRIDE'])test('economic sync reports target identity and concrete protection: '+code,async()=>{
 const s=setup({economic:true,code});const body=await(await s.post()).json();assert.equal(body.reviewRequiredCount,1);assert.equal(body.results[0].currentItemName,'Pear');assert.equal(body.results[0].targets[0].purchaseLogId,12848);assert.equal(body.results[0].targets[0].correctionLogId,12849);assert.equal(body.results[0].targets[0].code,code==='PURCHASE_AMOUNT_CONFIRMATION_REQUIRED'?'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED':code);assert.equal(s.snapshot.supplier,'Chợ');assert.equal(s.snapshot.total_purchase_price,35000);
});
test('daily sync keeps owner/master authorization and rejects staff before writes',async()=>{const s=setup({rename:true,role:'staff'});assert.equal((await s.post()).status,403);assert.deepEqual(s.calls,[]);});


test('display sync reaches linked corrections read by Ledger while preserving their historical economics',async()=>{
 const s=setup({rename:true,linked:true});const body=await(await s.post()).json();assert.equal(body.syncedCount,1);assert.equal(s.root.item_name,'Fresh pear');assert.equal(s.correction.item_name,'Fresh pear');assert.equal(s.correction.new_supplier,'Chợ');assert.equal(s.correction.new_purchase_price,35000);assert.equal(s.correction.purchase_supplier_partner_id,7);assert.equal(s.correction.change_quantity,0);
});

test('#622 GET and POST recompute from source-tagged rows and do not mutate a normal receipt',async()=>{
 const f=photoSync622(),s=setup({photoFixture:f}),before=JSON.stringify(f);const get=await(await s.get()).json();assert.deepEqual(get.dailySyncItems,[]);assert.ok(s.selects.some(r=>r.table==='inventory_logs'&&/\bsource\b/.test(r.fields)));const body=await(await s.post()).json();assert.equal(body.syncedCount,0);assert.deepEqual(s.calls,[]);assert.equal(JSON.stringify(f),before);
});
test('photo-driven display sync cannot overwrite a normal purchase with null partner/price/supplier',async()=>{
 const f=photoSync622();f.master.item_name='새 화분 표시명';const s=setup({photoFixture:f});const body=await(await s.post()).json();assert.equal(body.syncedCount,1);assert.equal(f.root.item_name,'새 화분 표시명');assert.equal(f.root.purchase_supplier_partner_id,7);assert.equal(f.root.new_supplier,'Shopee');assert.equal(f.root.new_purchase_price,300000);assert.equal(f.master.quantity,4);
 for(const call of s.calls.filter(c=>c.table==='inventory_logs'))for(const field of ['purchase_supplier_partner_id','new_supplier','new_purchase_price','change_quantity','quantity'])assert.equal(field in call.payload,false);assert.equal(f.photo.purchase_supplier_partner_id,null);
});
for(const code of ['PURCHASE_AMOUNT_CONFIRMATION_REQUIRED','PAYABLE_ALREADY_PAID','MONTH_CLOSED','MANUAL_LEDGER_OVERRIDE'])test('real economic edit followed by a stale photo preserves existing Ledger review: '+code,async()=>{
 const f=photoSync622();f.logs.push({...f.photo,id:13629,source:'edit_form',created_at:f.businessDate+'T04:00:00Z',new_supplier:'Other Shop',purchase_supplier_partner_id:27,new_purchase_price:350000},{...f.photo,id:13630,created_at:f.businessDate+'T04:01:00Z'});const s=setup({photoFixture:f,economic:true,code});const body=await(await s.post()).json();assert.equal(body.reviewRequiredCount,1);assert.equal(f.root.purchase_supplier_partner_id,27);assert.equal(f.root.new_supplier,'Other Shop');assert.equal(f.root.new_purchase_price,350000);assert.equal(body.results[0].targets[0].correctionLogId,13629);assert.equal(body.results[0].targets[0].code,code==='PURCHASE_AMOUNT_CONFIRMATION_REQUIRED'?'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED':code);assert.equal(f.master.quantity,4);
});

test('same-part category/category_vi change uses the scoped display projection and returns the exact Ledger location',async()=>{
 const s=setup({category:'Processed',display:{status:'pending',code:'RESOLUTION_REQUIRED',candidateId:1900,transactionId:null}});
 const body=await(await s.post()).json();
 assert.deepEqual(s.calls.filter(c=>'displayProjection' in c||'projection' in c),[{displayProjection:12848,actor:2}]);
 assert.equal(body.reviewRequiredCount,1);
 assert.deepEqual(body.results[0].targets[0],{purchaseLogId:12848,correctionLogId:12849,status:'review_required',code:'RESOLUTION_REQUIRED',ledgerMonth:'2026-10',sourceKey:'inventory-log:12848',candidateId:1900,transactionId:null});
 // Display-only payload: category follows, money/payee/quantity stay untouched.
 assert.equal(s.root.category,'Processed');assert.equal(s.root.new_category,'Processed');assert.equal(s.root.new_purchase_price,35000);assert.equal(s.root.new_supplier,'Chợ');assert.equal(s.root.purchase_supplier_partner_id,7);
 for(const call of s.calls.filter(c=>c.table==='inventory_logs'))for(const field of ['new_purchase_price','new_supplier','purchase_supplier_partner_id','change_quantity'])assert.equal(field in call.payload,false);
 // Repeated sync after the logs caught up has no target and no projection call.
 const again=await(await s.post()).json();assert.equal(again.results.length,0);assert.equal(s.calls.filter(c=>'displayProjection' in c).length,1);
});
test('part change and real economic changes keep the existing unscoped projection path',async()=>{
 const part=setup({category:'Processed',part:'bar'});await part.post();
 assert.deepEqual(part.calls.filter(c=>'displayProjection' in c||'projection' in c),[{projection:[12848],actor:2}]);
 const economic=setup({economic:true});const body=await(await economic.post()).json();
 assert.deepEqual(economic.calls.filter(c=>'displayProjection' in c||'projection' in c),[{projection:[12848],actor:2}]);
 assert.equal(body.results[0].targets[0].sourceKey,'inventory-log:12848');assert.equal(body.results[0].targets[0].transactionId,2944);
});
