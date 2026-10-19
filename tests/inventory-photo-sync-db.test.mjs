import assert from 'node:assert/strict';import test from 'node:test';import {readFileSync} from 'node:fs';
import {database} from './helpers/inventory-ledger-fixture.mjs';
import {findInventoryLogNameSyncItems} from '../lib/inventory/snapshot-name-sync.ts';
import {photoSync622} from './helpers/inventory-photo-sync-fixture.mjs';
const project=async(db,id)=>(await db.query('select ledger_project_inventory_purchase_log_v1($1,2) as result',[id])).rows[0].result;
async function money(db){return {transactions:(await db.query('select id,amount,party_id,status,economic_effect_sign from ledger_transactions order by id')).rows,payables:(await db.query('select id,expense_transaction_id,original_amount,status from ledger_payables order by id')).rows};}
test('actual projector keeps 900000 expense/payable after legacy photos and display sync, but reviews a real supplier/price change',async()=>{
 const db=await database();try{
  for(const name of ["20261007182027_resolve_inventory_purchase_projection.sql","20261009080243_detect_inventory_purchase_economic_corrections.sql"])await db.exec(readFileSync("supabase/migrations/"+name,"utf8"));
  await db.exec("update business_partners set name='Shopee',payment_mode='postpaid',default_fund_account_id=null where id=10; update inventory_logs set change_quantity=3,new_purchase_price=300000,new_supplier='Shopee',purchase_supplier_partner_id=10,business_date='2026-10-19' where id=100; update inventory set quantity=4,purchase_price=300000,supplier='Shopee',supplier_partner_id=10 where id=1");
  assert.equal((await project(db,100)).status,'synced');const before=await money(db);assert.equal(Number(before.transactions[0].amount),900000);
  const f=photoSync622();f.root.id=100;f.root.item_id=1;f.root.purchase_supplier_partner_id=10;f.master.id=1;f.master.supplier_partner_id=10;f.logs=[f.root];
  for(let i=0;i<3;i++){const id=101+i;await db.query("insert into inventory_logs(id,item_id,change_quantity,new_purchase_price,new_supplier,purchase_supplier_partner_id,business_date,source,reason,source_actor_user_id) values($1,1,0,300000,'Shopee',null,'2026-10-19','photo','other',1)",[id]);f.logs.push({...f.photo,id,item_id:1,created_at:'2026-10-19T03:0'+(i+1)+':00Z'});assert.equal((await project(db,id)).code,'NOT_A_PURCHASE');}
  assert.deepEqual(findInventoryLogNameSyncItems(f.businessDate,f.logs,[f.master]),[]);assert.deepEqual(await money(db),before);
  f.master.item_name='Renamed display';const plan=findInventoryLogNameSyncItems(f.businessDate,f.logs,[f.master]);assert.deepEqual(plan[0].changes.map(c=>c.field),['item_name']);assert.equal(plan[0].targets[0].syncItem.supplier_partner_id,10);
  await db.query('update inventory_logs set item_name=$1 where id=100',[plan[0].targets[0].syncItem.item_name]);assert.equal((await project(db,100)).code,'METADATA_SYNCED');assert.deepEqual(await money(db),before);
  f.logs.push({...f.photo,id:104,item_id:1,source:'edit_form',created_at:'2026-10-19T04:00:00Z',new_supplier:'Postpaid',purchase_supplier_partner_id:12,new_purchase_price:350000},{...f.photo,id:105,item_id:1,created_at:'2026-10-19T04:01:00Z'});
  const target=findInventoryLogNameSyncItems(f.businessDate,f.logs,[f.master])[0].targets[0];assert.equal(target.syncItem.purchase_price,350000);assert.equal(target.syncItem.supplier_partner_id,12);
  await db.query('update inventory_logs set new_purchase_price=$1,new_supplier=$2,purchase_supplier_partner_id=$3 where id=100',[target.syncItem.purchase_price,target.syncItem.supplier,target.syncItem.supplier_partner_id]);const r=await project(db,100);assert.equal(r.status,'review_required');assert.equal(r.code,'PURCHASE_AMOUNT_CONFIRMATION_REQUIRED');assert.deepEqual(await money(db),before);
 }finally{await db.close();}
});
