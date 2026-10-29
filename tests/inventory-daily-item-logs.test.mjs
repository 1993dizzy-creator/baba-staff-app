import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {database,route,call} from './helpers/inventory-item-logs-fixture.mjs';
import {buildDailyItemLogEntries} from '../lib/inventory/daily-item-log-entries.ts';

// Synthetic rows only. business_date is the stored 03:00 store business day.
const DAY='2026-10-28';
const base={item_id:1,unit:'kg',new_supplier:'Chợ A',purchase_supplier_partner_id:7,new_purchase_price:30000,source:'edit_form',action:'update'};
const log=(id,o)=>({...base,id,reason:'purchase',correction_of_inventory_log_id:null,business_date:DAY,created_at:`${DAY}T0${id%10}:00:00Z`,...o});
const rows=[
 log(100,{change_quantity:10,created_at:'2026-10-27T20:00:00Z'}),                       // 03:00 local on DAY
 log(101,{change_quantity:-1,correction_of_inventory_log_id:100,created_at:'2026-10-28T01:00:00Z'}),
 log(102,{change_quantity:-1,correction_of_inventory_log_id:100,created_at:'2026-10-28T02:00:00Z'}),
 log(103,{change_quantity:-2,correction_of_inventory_log_id:100,created_at:'2026-10-28T03:00:00Z',new_purchase_price:31000}),
 log(110,{change_quantity:5,created_at:'2026-10-28T04:00:00Z'}),                        // separate receipt, same item/day
 log(90,{change_quantity:4,business_date:'2026-10-27',created_at:'2026-10-27T05:00:00Z'}),
 log(120,{change_quantity:-1,correction_of_inventory_log_id:90,created_at:'2026-10-28T05:00:00Z'}),
 log(130,{change_quantity:3,created_at:'2026-10-28T06:00:00Z'}),
 log(131,{change_quantity:-1,correction_of_inventory_log_id:130,business_date:'2026-10-29',created_at:'2026-10-29T01:00:00Z'}),
 log(160,{change_quantity:2,created_at:'2026-10-28T07:00:00Z'}),
 log(161,{change_quantity:-2,correction_of_inventory_log_id:160,created_at:'2026-10-28T08:00:00Z'}),
 log(140,{reason:'stock_check',change_quantity:-3,created_at:'2026-10-28T09:00:00Z'}),
 log(150,{reason:'stock_check',change_quantity:1,business_date:'2026-10-27',created_at:'2026-10-27T19:30:00Z'}), // 02:30 local: previous day
 log(170,{reason:'stock_check',change_quantity:1,business_date:'2026-10-26',created_at:'2026-10-26T05:00:00Z'}),
 {...log(200,{change_quantity:9}),item_id:2},
];

test('business-day item logs: day rows plus the linked family of every receipt touched that day',async()=>{
 const tables={inventory_logs:rows},original=JSON.stringify(tables),db=database(tables);
 const r=await call(route(db),1,'?businessDate='+DAY);
 assert.equal(r.status,200);assert.equal(r.body.businessDate,DAY);
 assert.deepEqual(r.body.data.map(row=>row.id).sort((a,b)=>a-b),[90,100,101,102,103,110,120,130,131,140,160,161]);
 assert.ok(r.body.data.every(row=>row.item_id===1));
 assert.equal(JSON.stringify(tables),original);
 assert.ok(db.reads.every(read=>['inventory_logs','inventory_keg_sessions','ledger_inventory_projection_status'].includes(read.table)));
 for(const bad of ['2026-13-01','2026-02-30','28-10-2026','','x'])assert.equal((await call(route(database(tables)),1,'?businessDate='+encodeURIComponent(bad))).status,400,bad);
 // Without businessDate the existing latest-50 read is unchanged.
 const legacy=await call(route(database(tables)),1);assert.equal(legacy.status,200);assert.equal(legacy.body.businessDate,undefined);assert.equal(legacy.body.data.length,14);
});

test('daily entries: one final card per original receipt, separate receipts kept, source rows untouched',()=>{
 const input=rows.filter(row=>row.item_id===1&&row.id!==170),snapshot=JSON.stringify(input);
 const entries=buildDailyItemLogEntries(input,DAY);
 assert.equal(JSON.stringify(input),snapshot);
 const purchases=Object.fromEntries(entries.filter(e=>e.kind==='purchase').map(e=>[e.root.id,e]));
 assert.deepEqual(Object.keys(purchases).map(Number).sort((a,b)=>a-b),[90,100,110,130,160]);
 // Three repeated corrections of one receipt: one card, latest price, full history kept.
 assert.equal(purchases[100].effectiveQuantity,6);assert.equal(purchases[100].final.change_quantity,6);
 assert.equal(purchases[100].final.new_purchase_price,31000);assert.deepEqual(purchases[100].corrections.map(r=>r.id),[101,102,103]);
 assert.equal(purchases[100].root.change_quantity,10);
 // Same item, same day, separate receipt stays separate and unchanged.
 assert.equal(purchases[110].effectiveQuantity,5);assert.deepEqual(purchases[110].corrections,[]);
 // An earlier receipt corrected today shows in its final state, marked with its own date.
 assert.equal(purchases[90].rootOutsideDay,true);assert.equal(purchases[90].effectiveQuantity,3);
 // A later-day correction is reflected in the receipt day's card.
 assert.equal(purchases[130].effectiveQuantity,2);assert.equal(purchases[130].rootOutsideDay,false);
 assert.equal(purchases[160].cancelled,true);assert.equal(purchases[160].effectiveQuantity,0);
 const logs=entries.filter(e=>e.kind==='log').map(e=>e.log.id);
 assert.deepEqual(logs,[140]);  // 02:30 local row (business day 10-27) and other days excluded
 assert.equal(entries.length,6);
 // Earlier receipt viewed on its own day: today's correction folds into it.
 const previous=buildDailyItemLogEntries(input,'2026-10-27');
 assert.deepEqual(previous.map(e=>e.kind==='purchase'?'p'+e.root.id:'l'+e.log.id),['p90','l150']);
 assert.equal(previous[0].effectiveQuantity,3);assert.equal(previous[0].rootOutsideDay,false);
});

test('daily entries: invalid families need review and are not editable states',()=>{
 const broken=buildDailyItemLogEntries([log(1,{change_quantity:2}),log(2,{change_quantity:-3,correction_of_inventory_log_id:1})],DAY);
 assert.equal(broken[0].invalid,true);assert.equal(broken[0].cancelled,false);
 const unlinked=buildDailyItemLogEntries([log(3,{change_quantity:-1})],DAY);
 assert.equal(unlinked[0].kind,'log');
});

test('snapshot modal: 당일 로그, per-receipt 입고 수정 through the receipt-edit mode, no item edit button',()=>{
 const page=readFileSync('app/(protected)/inventory/snapshots/page.tsx','utf8');
 assert.ok(page.includes('"당일 로그"')&&page.includes('"Nhật ký trong ngày"'));
 assert.ok(!page.includes('"전체 로그"'));
 assert.ok(!page.includes('openInventoryEdit(logModalItem)'));
 assert.match(page,/mode: "purchase-receipt-edit",\s*id: purchaseEdit\.itemId,\s*purchaseLogId: purchaseEdit\.rootId/);
 assert.match(page,/payload: \{ quantity, purchase_price: price, \.\.\.supplier, note: note \|\| null, reason \}/);
 assert.match(page,/expectedUpdatedAt: current\.updated_at \?\? null/);
 assert.ok(!page.includes('selectedPurchaseRootId'));
 // Reason is required; the supplier select is shown to owner/master only (the RPC enforces it).
 assert.match(page,/if \(!reason \|\| reason\.length > 200\)/);
 assert.match(page,/canChangeReceiptSupplier = \["owner", "master"\]/);
 assert.ok(!/\.rpc\(|\/api\/ledger\//.test(page));
 // Mobile: supplier/price-change tags wrap instead of being clipped.
 assert.match(page,/data-testid="daily-log-group-tabs"[\s\S]{0,500}flexWrap: "wrap"/);
});

test('business-day logs carry the Ledger state; an inventory-only edit is not a completed card',async()=>{
 const tables={inventory_logs:rows,ledger_inventory_projection_status:[{inventory_log_id:120,status:'review_required',code:'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED'},{inventory_log_id:103,status:'synced',code:'REBOOKED'},{inventory_log_id:140,status:'review_required',code:'X'}]};
 const r=await call(route(database(tables)),1,'?businessDate='+DAY);assert.equal(r.status,200);
 const byId=Object.fromEntries(r.body.data.map(row=>[row.id,row]));
 assert.equal(byId[120].ledger_projection_status,'review_required');assert.equal(byId[103].ledger_projection_status,'synced');
 assert.equal(byId[140].ledger_projection_status,undefined);   // stock checks are not purchase-family rows
 const entries=Object.fromEntries(buildDailyItemLogEntries(r.body.data,DAY).filter(e=>e.kind==='purchase').map(e=>[e.root.id,e]));
 assert.equal(entries[90].ledgerReviewPending,true);assert.equal(entries[100].ledgerReviewPending,false);assert.equal(entries[110].ledgerReviewPending,false);
 const page=readFileSync('app/(protected)/inventory/snapshots/page.tsx','utf8');
 assert.match(page,/const editable = !entry\.cancelled && !entry\.invalid && !entry\.ledgerReviewPending/);
 assert.ok(!/if \(ledgerNotice\) alert\(ledgerNotice\);\s*setMonthlySyncReloadKey/.test(page.slice(page.indexOf('const savePurchaseEdit'))));
});

test('browser QA base: only a loopback offline build, never the original dev server on 3000',async()=>{
 const {offlineUiBase}=await import('./helpers/offline-ui-base.mjs');
 assert.equal(offlineUiBase(''),'');assert.equal(offlineUiBase('http://127.0.0.1:3002/'),'http://127.0.0.1:3002');
 for(const bad of ['http://localhost:3000','http://127.0.0.1:3000/inventory','https://baba.example.com'])assert.throws(()=>offlineUiBase(bad),bad);
 for(const file of ['tests/inventory-snapshots-browser.test.mjs','tests/inventory-receipt-edit-browser.test.mjs']){
  const source=readFileSync(file,'utf8');assert.ok(source.includes('offlineUiBase()'),file);assert.ok(!source.includes('localhost:3000'),file);
 }
});
