import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {billedFixture} from './helpers/inventory-billed-amount-fixture.mjs';
import {createInventoryRegistration} from '../lib/inventory/registration-recovery.ts';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];

test('photo failures and lost create responses leave one item, first receipt, Ledger booking and payable in the real atomic RPC fixture',async t=>{
 const db=await billedFixture();try{
  await db.exec("create sequence registration_test_item_ids start 500;alter table inventory alter column id set default nextval('registration_test_item_ids')");
  await db.exec(readFileSync('supabase/migrations/20261030170000_inventory_create_with_receipt.sql','utf8'));
  for(const scenario of ['photo-ok','photo-failed','photo-threw','response-lost'])await t.test(scenario,async()=>{
   const attempt=createInventoryRegistration();let creates=0,photos=0,committed;
   const payload={item_name:'Fryer '+scenario,item_name_vi:'Bep '+scenario,part:'kitchen',category:'Drinks',unit:'can',quantity:1,purchase_price:300000,supplier:'Won Mart',supplier_partner_id:10,code:scenario,billed_amount_mode:'auto'};
   const args={
    create:async()=>{creates++;const result=(await one(db,"select inventory_create_with_receipt_v1($1::jsonb,'purchase','2026-10-11',2) as r",[JSON.stringify(payload)])).r;assert.equal(result.status,'ok');committed=result;if(scenario==='response-lost')throw Error('response lost after commit');return Response.json({ok:true,data:result.item,ledgerSync:result.ledgerSync});},
    recover:async()=>committed?.item??null,onConfirmed:()=>{},refresh:async()=>{},
    upload:async id=>{assert.equal(id,Number(committed.item.id));photos++;if(scenario==='photo-threw')throw Error('photo network failure');return scenario==='photo-ok';},
   };
   const result=await attempt.submit(args);assert.equal(result.kind,scenario==='response-lost'?'existing':'saved');
   for(let i=0;i<3;i++)await attempt.submit(args);
   assert.equal(creates,1);assert.equal(photos,scenario==='response-lost'?0:1);
   const id=Number(committed.item.id),logId=Number(committed.inventoryLogId);
   const counts=await one(db,`select
    (select count(*) from inventory where id=$1) as items,
    (select count(*) from inventory_logs where item_id=$1 and action='create' and reason='purchase') as receipts,
    (select count(*) from ledger_candidates where source_key='inventory-log:'||$2::text) as candidates,
    (select count(*) from ledger_transactions t join ledger_candidates c on c.resolved_transaction_id=t.id where c.source_key='inventory-log:'||$2::text) as bookings,
    (select count(*) from ledger_payables p join ledger_candidates c on c.resolved_transaction_id=p.expense_transaction_id where c.source_key='inventory-log:'||$2::text) as payables`,[id,logId]);
   assert.deepEqual(Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,Number(v)])),{items:1,receipts:1,candidates:1,bookings:1,payables:1});
  });
 }finally{await db.close();}
});
