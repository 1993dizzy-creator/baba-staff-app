import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as monthly from '../lib/inventory/monthly-name-sync.ts';

// 일괄 동기화 (POST sync_month) on isolated data: the rows the user saw are re-checked against a
// fresh read of the month and each runs through the daily runItemSync (same ledger review paths).
function load(path,deps={}){const m={exports:{}};const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name];},m,m.exports);return m.exports;}

const base={source:'edit_form',part:'kitchen',category:'Fruit',category_vi:'Fruit',code:'P',unit:'kg',new_purchase_price:35000,new_supplier:'Chợ',purchase_supplier_partner_id:7,correction_of_inventory_log_id:null};
// Purchase + same-day zero-quantity edit; the master differs → one sync row for (date, item).
const receipt=(id,itemId,date,name,extra={})=>[
 {...base,id,item_id:itemId,business_date:date,created_at:date+'T04:00:00Z',reason:'purchase',change_quantity:1,prev_quantity:0,new_quantity:1,item_name:name,item_name_vi:name},
 {...base,id:id+1,item_id:itemId,business_date:date,created_at:date+'T04:05:00Z',reason:'other',change_quantity:0,prev_quantity:1,new_quantity:1,item_name:name,item_name_vi:name,...extra},
];
const master=(id,name,extra={})=>({id,item_name:name,item_name_vi:name,part:'kitchen',category:'Fruit',category_vi:'Fruit',code:'P',unit:'kg',purchase_price:35000,supplier:'Chợ',supplier_partner_id:7,quantity:2,is_active:true,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-20T00:00:00Z',...extra});
// October: 5 items over 4 dates (10/7, 10/9 ×2, 10/21, 10/23), plus a September row that must not run.
function fixture(){
 return {
  inventory:[master(1,'Pear v2'),master(2,'Oil v2'),master(3,'Salt v2'),master(4,'Rice v2'),master(5,'Tea v2'),master(6,'Sep v2')],
  inventory_logs:[...receipt(100,1,'2026-10-07','Pear'),...receipt(200,2,'2026-10-09','Oil'),...receipt(300,3,'2026-10-09','Salt'),...receipt(400,4,'2026-10-21','Rice'),
   ...receipt(500,5,'2026-10-23','Tea'),...receipt(600,6,'2026-09-25','Sep')],
  inventory_snapshot_batches:[{id:9,snapshot_date:'2026-10-09'}],
  inventory_snapshot_items:[{id:90,batch_id:9,item_id:2,item_name:'Oil',change_quantity:1,purchase_price:35000,supplier:'Chợ'}],
 };
}
const october=[['2026-10-07',1],['2026-10-09',2],['2026-10-09',3],['2026-10-21',4],['2026-10-23',5]].map(([businessDate,itemId])=>({businessDate,itemId}));

function setup({tables=fixture(),role='owner',economicItem=null,failLog=null}={}){
 const calls=[];
 const db={from(table){const filters=[];let payload,from=0,to=Infinity,single=false;const q={
  select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},in(k,v){filters.push(r=>v.includes(r[k]));return q;},not(k,op,v){filters.push(r=>r[k]!==v);return q;},
  gte(k,v){filters.push(r=>r[k]>=v);return q;},lt(k,v){filters.push(r=>r[k]<v);return q;},order(){return q;},range(a,b){from=a;to=b;return q;},limit(n){to=n-1;return q;},maybeSingle(){single=true;return q;},update(p){payload=p;return q;},
  then(resolve){const rows=tables[table].filter(r=>filters.every(f=>f(r))).slice(from,to+1);if(payload){calls.push({table,payload,ids:rows.map(r=>r.id)});rows.forEach(r=>Object.assign(r,payload));}
   return Promise.resolve({data:single?rows[0]||null:rows,error:null}).then(resolve);}};return q;}};
 const contract=load('lib/inventory/ledger-sync-contract.ts');
 const sync=load('lib/inventory/snapshot-name-sync.ts');
 const projection={
  projectInventoryPurchaseLogs:async(ids,actor)=>{calls.push({projection:ids,actor});return {status:'review_required',code:'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED',results:[{status:'review_required',code:'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED',inventoryLogId:ids[0],candidateId:null,transactionId:2944}]};},
  projectInventoryDisplaySyncLog:async(id,actor)=>{calls.push({displayProjection:id,actor});if(id===failLog)throw Error('ledger unavailable');return {status:'synced',code:'METADATA_SYNCED',inventoryLogId:id};},
 };
 const route=load('app/api/inventory/snapshot/name-sync/route.ts',{
  '@supabase/supabase-js':{createClient:()=>db},'next/server':{NextResponse:{json:(b,o)=>Response.json(b,o)}},
  '@/lib/auth/server-auth':{getAuthenticatedActor:async()=>({ok:true,actor:{id:2,role}})},
  '@/lib/inventory/log-sync-server':load('lib/inventory/log-sync-server.ts',{'server-only':{},'@/lib/inventory/ledger-sync-contract':contract}),
  '@/lib/inventory/snapshot-name-sync':sync,'@/lib/inventory/language-missing':load('lib/inventory/language-missing.ts'),
  '@/lib/inventory/monthly-name-sync':load('lib/inventory/monthly-name-sync.ts',{'./snapshot-name-sync.ts':sync}),
  '@/lib/inventory/daily-sync-result':load('lib/inventory/daily-sync-result.ts'),'@/lib/ledger/inventory-projection':projection,
 });
 if(economicItem){const master=tables.inventory.find(row=>row.id===economicItem);master.item_name=master.item_name.replace(' v2','');master.item_name_vi=master.item_name;
  const edit=tables.inventory_logs.find(row=>row.item_id===economicItem&&row.reason==='other');Object.assign(edit,{new_purchase_price:42000,new_supplier:'An Liên',purchase_supplier_partner_id:27});}
 process.env.NEXT_PUBLIC_SUPABASE_URL='http://isolated.test';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-key-not-a-credential';
 const post=body=>route.POST(new Request('http://test',{method:'POST',body:JSON.stringify(body)}));
 return {tables,calls,post,syncMonth:(targets,month='2026-10')=>post({action:'sync_month',month,targets}),get:q=>route.GET(new Request('http://test?'+q))};
}
const logsOf=(s,ids)=>s.tables.inventory_logs.filter(row=>ids.includes(row.id));

test('October, 5 items over 4 days: all display changes sync in date order with their own businessDate',async()=>{
 const s=setup();
 const listed=(await(await s.get('month=2026-10')).json()).monthlySyncItems.map(({businessDate,itemId})=>({businessDate,itemId}));
 assert.deepEqual(listed,october,'the list the user sees');
 assert.equal(s.calls.length,0,'reading never syncs');
 const body=await(await s.syncMonth([...listed].reverse())).json();
 assert.deepEqual([body.syncedCount,body.reviewRequiredCount,body.failedCount,body.skippedCount],[5,0,0,0]);
 assert.deepEqual(body.results.map(r=>[r.businessDate,r.itemId,r.status]),october.map(t=>[t.businessDate,t.itemId,'synced']));
 // Same segment policy as the daily sync: the original receipt takes the display name.
 assert.equal(logsOf(s,[100])[0].item_name,'Pear v2');
 // Display only: money and payee of the receipts are untouched; the 10/9 snapshot row follows the name only.
 for(const row of s.tables.inventory_logs.filter(r=>r.business_date.startsWith('2026-10')))assert.deepEqual([row.new_purchase_price,row.new_supplier,row.purchase_supplier_partner_id],[35000,'Chợ',7]);
 assert.deepEqual([s.tables.inventory_snapshot_items[0].item_name,s.tables.inventory_snapshot_items[0].purchase_price],['Oil v2',35000]);
 assert.equal(logsOf(s,[600])[0].item_name,'Sep','September untouched');
 assert.deepEqual(s.calls.filter(c=>'displayProjection' in c).map(c=>c.displayProjection),[100,200,300,400,500]);
});

test('re-running the same rows does nothing: every row is skipped, no write, no ledger call',async()=>{
 const s=setup();await s.syncMonth(october);const before=s.calls.length;
 const again=await(await s.syncMonth(october)).json();
 assert.deepEqual([again.syncedCount,again.reviewRequiredCount,again.failedCount,again.skippedCount],[0,0,0,5]);
 assert.equal(s.calls.length,before);
 assert.deepEqual((await(await s.get('month=2026-10')).json()).monthlySyncItems,[]);
});

test('a money/payee change keeps the existing ledger review: reported as 관리자 확인 필요, never confirmed here',async()=>{
 const s=setup({economicItem:3});
 const body=await(await s.syncMonth(october)).json();
 assert.deepEqual([body.syncedCount,body.reviewRequiredCount,body.failedCount],[4,1,0]);
 const salt=body.results.find(r=>r.itemId===3);
 // Supplier changed: the daily sync's own mapping to the supplier confirmation code.
 assert.equal(salt.status,'review_required');assert.equal(salt.targets[0].code,'SUPPLIER_CHANGE_CONFIRMATION_REQUIRED');assert.equal(salt.targets[0].ledgerMonth,'2026-10');
 // Same path as the daily sync: the full purchase projection decides; this API writes no ledger rows.
 assert.deepEqual(s.calls.filter(c=>'projection' in c).map(c=>c.projection),[[300]]);
 assert.ok(s.calls.every(c=>!c.table||['inventory_logs','inventory_snapshot_items'].includes(c.table)));
});

test('one failure does not stop the others; the failed row stays listed for a retry',async()=>{
 const s=setup({failLog:200});
 const body=await(await s.syncMonth(october)).json();
 assert.deepEqual([body.syncedCount,body.reviewRequiredCount,body.failedCount],[4,0,1]);
 assert.equal(body.results.find(r=>r.itemId===2).status,'failed');
 assert.deepEqual(body.results.filter(r=>r.status==='synced').map(r=>r.itemId),[1,3,4,5]);
});

test('only the requested rows of that month run; duplicates once; bad requests write nothing',async()=>{
 const s=setup();
 const body=await(await s.syncMonth([october[1],october[1],{businessDate:'2026-10-07',itemId:999}])).json();
 assert.deepEqual(body.results.map(r=>[r.businessDate,r.itemId]),[['2026-10-09',2]]);
 assert.deepEqual(body.skipped,[{businessDate:'2026-10-07',itemId:999}]);
 assert.equal(logsOf(s,[100])[0].item_name,'Pear','10/7 was not requested');
 const before=s.calls.length;
 for(const bad of [
  {action:'sync_month',month:'2026-10',targets:[{businessDate:'2026-09-25',itemId:6}]},     // other month
  {action:'sync_month',month:'2026-10',targets:[{businessDate:'2026-10-32',itemId:1}]},
  {action:'sync_month',month:'2026-13',targets:october},{action:'sync_month',month:'2026-10',targets:[]},
  {action:'sync_month',month:'2026-10',targets:Array.from({length:301},(_,i)=>({businessDate:'2026-10-07',itemId:i+1}))},
  {action:'sync_month',month:'2026-08',targets:[{businessDate:'2026-08-10',itemId:1}]},       // before the sync start date
 ]){const r=await s.post(bad);assert.equal(r.status,400,JSON.stringify(bad).slice(0,80));}
 assert.equal(s.calls.length,before);
 const staff=setup({role:'staff'});assert.equal((await staff.syncMonth(october)).status,403);assert.equal(staff.calls.length,0);
 // The daily item sync is unchanged.
 const daily=await(await setup().post({action:'sync_item',business_date:'2026-10-21',item_id:4})).json();
 assert.deepEqual([daily.syncedCount,daily.results[0].itemId],[1,4]);
});

test('parse helper: YYYY-MM, rows inside the month, de-duplicated, at most 300',()=>{
 assert.deepEqual(monthly.parseMonthlySyncTargets('2026-10',[october[0],{...october[0]},{businessDate:'2026-10-31',itemId:'4'}]),[october[0],{businessDate:'2026-10-31',itemId:4}]);
 assert.equal(monthly.parseMonthlySyncTargets('2026-10',[{businessDate:'2026-11-01',itemId:1}]),null);
 assert.equal(monthly.parseMonthlySyncTargets('2026-09',[{businessDate:'2026-09-22',itemId:1}]),null,'before 2026-09-23');
 assert.equal(monthly.MONTHLY_SYNC_MAX_TARGETS,300);
});

test('panel: 일괄 동기화 left of the title, no 이 날짜로 이동, confirm with counts, one request at a time',()=>{
 const panel=readFileSync('components/inventory/MonthlyNameSyncPanel.tsx','utf8');
 assert.ok(panel.indexOf('data-testid="monthly-name-sync-all"')<panel.indexOf('data-testid="monthly-name-sync-title"'));
 assert.doesNotMatch(panel,/goToDate|이 날짜로 이동|Đi tới ngày này/);
 assert.match(panel,/if \(!window\.confirm\(t\.confirmMonth\(requestMonth, targets\.length, days\)\)\) return;/);
 assert.match(panel,/JSON\.stringify\(\{ action: "sync_month", month: requestMonth, targets \}\)/);
 assert.match(panel,/if \(busyRef\.current \|\| !items\.length\) return;/);
 assert.match(panel,/\{canSync && items\.length \? <button type="button" data-testid="monthly-name-sync-all"/);
});
