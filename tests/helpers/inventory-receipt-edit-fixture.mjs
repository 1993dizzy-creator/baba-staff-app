import {readFileSync} from 'node:fs';
import {safeFixture} from './inventory-safe-correction-fixture.mjs';
const migration='supabase/migrations/20261029220000_inventory_purchase_receipt_edit.sql';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
// Isolated database only: the safe-correction fixture (store day 2026-10-11, receipt #100
// 10 cans x 20,000 from Won Mart, confirmed unpaid expense) plus the new receipt-edit RPC.
export async function receiptEditFixture(Database){
 const db=await safeFixture(Database);
 await db.exec(readFileSync(migration,'utf8'));
 return db;
}
export const item=async db=>(await one(db,'select to_jsonb(i) as item from inventory i where id=1')).item;
export const editReceipt=async(db,old,edit,actor=1,date='2026-10-11',root=100)=>(await one(db,
 'select inventory_apply_purchase_receipt_edit_v1(1,$1,$2,$3::jsonb,$4::jsonb,$5::date,$6) as result',
 [root,old.quantity,JSON.stringify(old),JSON.stringify({quantity:10,purchase_price:20000,supplier:'Won Mart',supplier_partner_id:10,reason:'QA',...edit}),date,actor])).result;
export async function state(db){
 const result={};
 for(const table of ['inventory','inventory_logs','inventory_price_logs','ledger_transactions','ledger_payables','ledger_movements','ledger_candidates','ledger_inventory_projection_status','ledger_audit_logs'])
  result[table]=(await db.query(`select to_jsonb(x) as row from ${table} x order by to_jsonb(x)::text`)).rows;
 return result;
}
