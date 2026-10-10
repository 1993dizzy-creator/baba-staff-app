import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function load(path,deps={}){const m={exports:{}};const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name];},m,m.exports);return m.exports;}
function setup({rename=false,economic=false,code='PURCHASE_AMOUNT_CONFIRMATION_REQUIRED',role='owner',linked=false}={}){
 const root={id:12848,item_id:314,business_date:'2026-10-09',created_at:'2026-10-09T04:00:00Z',reason:'purchase',change_quantity:1,prev_quantity:0,new_quantity:1,item_name:'Pear',item_name_vi:'Lê',part:'kitchen',category:'Fruit',category_vi:'Fruit',code:'P',unit:'kg',new_purchase_price:35000,new_supplier:'Chợ',purchase_supplier_partner_id:7,correction_of_inventory_log_id:null};
 const correction={...root,id:12849,created_at:'2026-10-09T04:01:00Z',reason:'other',change_quantity:0,prev_quantity:1,new_quantity:1,...(economic?{new_supplier:'An Liên',purchase_supplier_partner_id:27}:{}),...(linked?{correction_of_inventory_log_id:12848,reason:'purchase'}:{})};
 const next={...root,id:12900,business_date:'2026-10-10',created_at:'2026-10-10T04:00:00Z',new_purchase_price:40000,new_supplier:'An Liên',purchase_supplier_partner_id:27};
 const master={id:314,item_name:rename?'Fresh pear':'Pear',item_name_vi:'Lê',part:'kitchen',category:'Fruit',category_vi:'Fruit',code:'P',unit:'kg',quantity:2,purchase_price:40000,supplier:'An Liên',supplier_partner_id:27,is_active:true};
 const snapshot={id:1,batch_id:9,item_id:314,item_name:'Pear',quantity:1,prev_quantity:0,change_quantity:1,purchase_price:35000,supplier:'Chợ',total_purchase_price:35000};
 const tables={inventory_logs:[root,correction,next],inventory:[master],inventory_snapshot_batches:[{id:9,snapshot_date:'2026-10-09'}],inventory_snapshot_items:[snapshot]};const calls=[];
 const db={from(table){const filters=[];let payload,from=0,to=Infinity,single=false;const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},in(k,v){filters.push(r=>v.includes(r[k]));return q;},not(k,op,v){filters.push(r=>r[k]!==v);return q;},order(){return q;},range(a,b){from=a;to=b;return q;},limit(n){to=n-1;return q;},maybeSingle(){single=true;return q;},update(p){payload=p;return q;},then(resolve){let rows=tables[table].filter(r=>filters.every(f=>f(r))).slice(from,to+1);if(payload){calls.push({table,payload,ids:rows.map(r=>r.id)});rows.forEach(r=>Object.assign(r,payload));}return Promise.resolve({data:single?rows[0]||null:rows,error:null}).then(resolve);}};return q;}};
 const contract=load('lib/inventory/ledger-sync-contract.ts');
 const route=load('app/api/inventory/snapshot/name-sync/route.ts',{
 '@supabase/supabase-js':{createClient:()=>db},'next/server':{NextResponse:{json:(b,o)=>Response.json(b,o)}},
 '@/lib/auth/server-auth':{getAuthenticatedActor:async()=>({ok:true,actor:{id:2,role}})},
 '@/lib/inventory/log-sync-server':load('lib/inventory/log-sync-server.ts',{'server-only':{},'@/lib/inventory/ledger-sync-contract':contract}),
 '@/lib/inventory/snapshot-name-sync':load('lib/inventory/snapshot-name-sync.ts'),
 '@/lib/inventory/language-missing':load('lib/inventory/language-missing.ts'),
 '@/lib/ledger/inventory-projection':{projectInventoryPurchaseLogs:async(ids,actor)=>{calls.push({projection:ids,actor});assert.equal(actor,2);return {status:economic?'review_required':'synced',code:economic?code:'METADATA_SYNCED',results:[]};}},
 });
 process.env.NEXT_PUBLIC_SUPABASE_URL='http://isolated.test';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-key-not-a-credential';
 return {root,correction,next,master,snapshot,calls,get:()=>route.GET(new Request('http://test?businessDate=2026-10-09')),post:()=>route.POST(new Request('http://test',{method:'POST',body:JSON.stringify({action:'sync_all',business_date:'2026-10-09'})}))};
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
