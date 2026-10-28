import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as snapshotNameSync from '../lib/inventory/snapshot-name-sync.ts';
import * as languageMissing from '../lib/inventory/language-missing.ts';
import * as monthly from '../lib/inventory/monthly-name-sync.ts';

// Monthly 입고정보 동기화 view: one paged read of the month, the existing per-day detection on
// every date, one row per (businessDate, itemId). Read only; syncing stays on the daily POST.
function load(path,deps={}){const m={exports:{}};const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(name=>{assert.ok(name in deps,name);return deps[name];},m,m.exports);return m.exports;}

const base={reason:'purchase',source:'edit_form',change_quantity:1,prev_quantity:0,new_quantity:1,part:'kitchen',category:'Fruit',category_vi:'Fruit',code:'P',unit:'kg',new_purchase_price:35000,new_supplier:'Chợ',purchase_supplier_partner_id:7,correction_of_inventory_log_id:null};
// A purchase and a later zero-quantity edit on the same business date: a sync target when the master differs.
const receipt=(id,itemId,date,names)=>[
 {...base,id,item_id:itemId,business_date:date,created_at:date+'T04:00:00Z',item_name:names[0],item_name_vi:names[1]},
 {...base,id:id+1,item_id:itemId,business_date:date,created_at:date+'T04:05:00Z',reason:'other',change_quantity:0,prev_quantity:1,new_quantity:1,item_name:names[0],item_name_vi:names[1]},
];
const master=(id,name,nameVi,extra={})=>({id,item_name:name,item_name_vi:nameVi,part:'kitchen',category:'Fruit',category_vi:'Fruit',code:'P',unit:'kg',purchase_price:35000,supplier:'Chợ',supplier_partner_id:7,quantity:2,is_active:true,created_at:'2026-10-01T03:00:00Z',updated_at:'2026-10-20T03:00:00Z',...extra});

function fixture(){
 const inventory=[master(314,'Fresh pear','Lê'),master(624,'','Dầu ớt cay nóng 500ml'),master(700,'Old','Cũ',{is_active:false}),master(800,'Apple','Táo')];
 const logs=[
  ...receipt(12848,314,'2026-10-09',['Pear','Lê']),
  ...receipt(12900,314,'2026-10-21',['Pear','Lê']),
  ...receipt(13000,624,'2026-10-21',['','Dầu ớt']),          // vi name differs from master
  ...receipt(13100,700,'2026-10-15',['Old item','Cũ']),       // inactive item: never listed
  ...receipt(13200,314,'2026-09-30',['Pear','Lê']),           // previous month
  ...receipt(13300,314,'2026-11-01',['Pear','Lê']),           // next month
  ...receipt(13400,800,'2026-10-12',['Apple','Táo']),          // nothing changed: not listed
 ];
 // 1,200 stock-check rows earlier in the month push the receipts onto the second page.
 for(let i=0;i<1200;i++)logs.push({...base,id:20000+i,item_id:800,business_date:'2026-10-02',created_at:'2026-10-02T05:00:00Z',reason:'stock_check',change_quantity:0,item_name:'Apple',item_name_vi:'Táo'});
 return {inventory_logs:logs,inventory,inventory_snapshot_batches:[]};
}
function setup(tables=fixture(),role='owner'){
 const ranges=[];
 const db={from(table){const filters=[],orders=[];let from=0,to=Infinity,single=false;const q={
  select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},in(k,v){filters.push(r=>v.includes(r[k]));return q;},not(k,op,v){filters.push(r=>r[k]!==v);return q;},
  gte(k,v){filters.push(r=>r[k]>=v);return q;},lt(k,v){filters.push(r=>r[k]<v);return q;},order(k,o={}){orders.push([k,o.ascending!==false]);return q;},
  range(a,b){from=a;to=b;ranges.push({table,from:a,to:b});return q;},limit(n){to=n-1;return q;},maybeSingle(){single=true;return q;},
  then(resolve){const rows=tables[table].filter(r=>filters.every(f=>f(r))).sort((a,b)=>{for(const [k,asc] of orders){if(a[k]!==b[k])return (a[k]<b[k]?-1:1)*(asc?1:-1);}return 0;}).slice(from,to+1);
   return Promise.resolve({data:single?rows[0]||null:rows,error:null}).then(resolve);}};return q;}};
 const sync=load('lib/inventory/snapshot-name-sync.ts');
 const route=load('app/api/inventory/snapshot/name-sync/route.ts',{
  '@supabase/supabase-js':{createClient:()=>db},'next/server':{NextResponse:{json:(b,o)=>Response.json(b,o)}},
  '@/lib/auth/server-auth':{getAuthenticatedActor:async()=>({ok:true,actor:{id:2,role}})},
  '@/lib/inventory/log-sync-server':{},'@/lib/inventory/snapshot-name-sync':sync,
  '@/lib/inventory/language-missing':load('lib/inventory/language-missing.ts'),
  '@/lib/inventory/monthly-name-sync':load('lib/inventory/monthly-name-sync.ts',{'./snapshot-name-sync.ts':sync}),
  '@/lib/inventory/daily-sync-result':load('lib/inventory/daily-sync-result.ts'),'@/lib/ledger/inventory-projection':{},
 });
 process.env.NEXT_PUBLIC_SUPABASE_URL='http://isolated.test';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-key-not-a-credential';
 return {tables,ranges,get:query=>route.GET(new Request('http://test/api/inventory/snapshot/name-sync?'+query))};
}

test('month range: YYYY-MM only, clipped to the sync start date, December rolls over',()=>{
 assert.deepEqual(monthly.inventoryNameSyncMonthRange('2026-10'),{start:'2026-10-01',endExclusive:'2026-11-01'});
 assert.deepEqual(monthly.inventoryNameSyncMonthRange('2026-09'),{start:snapshotNameSync.INVENTORY_SNAPSHOT_NAME_SYNC_START_DATE,endExclusive:'2026-10-01'});
 assert.deepEqual(monthly.inventoryNameSyncMonthRange('2026-12'),{start:'2026-12-01',endExclusive:'2027-01-01'});
 assert.equal(monthly.inventoryNameSyncMonthRange('2026-08'),null,'before 2026-09-23');
 for(const bad of ['2026-13','2026-1','26-10','2026-10-01','',null])assert.equal(monthly.isInventoryNameSyncMonth(bad),false,String(bad));
});

test('every date of the month is checked: two dates of one item stay separate, each with its own businessDate',async()=>{
 const s=setup();const body=await(await s.get('month=2026-10')).json();
 assert.equal(body.ok,true);assert.equal(body.month,'2026-10');assert.equal(body.canSync,true);
 assert.deepEqual(body.monthlySyncItems.map(item=>[item.businessDate,item.itemId,item.logIds]),[['2026-10-09',314,[12848]],['2026-10-21',314,[12900]],['2026-10-21',624,[13000]]]);
 assert.deepEqual(body.monthlySyncItems[0].changes,[{field:'item_name',from:'Pear',to:'Fresh pear'}]);
 assert.deepEqual(body.monthlySyncItems[2].changes,[{field:'item_name_vi',from:'Dầu ớt',to:'Dầu ớt cay nóng 500ml'}]);
 // Every page of the month was read (1,214 rows → two pages), none from outside it.
 assert.deepEqual(s.ranges.filter(r=>r.table==='inventory_logs').map(r=>[r.from,r.to]),[[0,999],[1000,1999]]);
 // Language-missing covers all active items, independent of the month.
 assert.deepEqual(body.languageMissingItems.map(item=>[item.itemId,item.missingLanguages]),[[624,['ko']]]);
});

test('one row per date and item even when a log page repeats a row; the daily view equals the month row',async()=>{
 const tables=fixture();tables.inventory_logs.push({...tables.inventory_logs[0]});
 const body=await(await setup(tables).get('month=2026-10')).json();
 const day=body.monthlySyncItems.filter(item=>item.businessDate==='2026-10-09');
 assert.equal(day.length,1);assert.equal(day[0].targets.length,1);
 const daily=await(await setup().get('businessDate=2026-10-09')).json();
 const {businessDate,...rest}=day[0];assert.equal(businessDate,'2026-10-09');
 assert.deepEqual(daily.dailySyncItems,[rest],'same detection as the daily API');
});

test('invalid month is 400; a month before the start date reads no logs; staff can view but not sync',async()=>{
 for(const month of ['2026-13','2026-1','abc','']){const r=await setup().get('month='+month);assert.equal(r.status,400);assert.equal((await r.json()).error,'inventory_monthly_sync_invalid_month');}
 const early=setup();const body=await(await early.get('month=2026-08')).json();
 assert.deepEqual(body.monthlySyncItems,[]);assert.equal(early.ranges.some(r=>r.table==='inventory_logs'),false);
 assert.equal((await(await setup(fixture(),'staff').get('month=2026-10')).json()).canSync,false);
 // The daily mode is unchanged.
 assert.equal((await setup().get('businessDate=2026-10-32')).status,400);
});

test('monthly helper ignores logs outside the month and inactive items',()=>{
 const t=fixture();
 const items=monthly.findMonthlyInventoryNameSyncItems('2026-10',t.inventory_logs,t.inventory);
 assert.ok(items.every(item=>item.businessDate>='2026-10-01'&&item.businessDate<'2026-11-01'));
 assert.ok(!items.some(item=>item.itemId===700));
 assert.equal(languageMissing.findInventoryLanguageMissingItems(t.inventory).length,1);
});

test('snapshot page: monthly panel above the date content, language list labelled as all active items',()=>{
 const page=readFileSync('app/(protected)/inventory/snapshots/page.tsx','utf8');
 const panel=readFileSync('components/inventory/MonthlyNameSyncPanel.tsx','utf8');
 assert.match(page,/<MonthlyNameSyncPanel month=\{calendarMonth\} lang=\{lang\} reloadKey=\{monthlySyncReloadKey\}/);
 assert.ok(page.indexOf('<MonthlyNameSyncPanel ')<page.indexOf('testId="snapshot-date-content-loading"'));
 assert.match(page,/전체 활성 품목 중 품목명 언어 미설정/);
 // 동기화 uses the item's own business date and the daily POST; 일괄 동기화 is sync_month (never the daily sync_all).
 assert.match(panel,/JSON\.stringify\(\{ action: "sync_item", business_date: item\.businessDate, item_id: item\.itemId \}\)/);
 assert.doesNotMatch(panel,/sync_all/);assert.match(panel,/action: "sync_month"/);
 // A response for a month already left never replaces the list.
 assert.match(panel,/if \(sequence !== sequenceRef\.current\) return;/);
 assert.match(panel,/json\.month !== targetMonth/);
});
