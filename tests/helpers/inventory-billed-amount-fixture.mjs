import {readFileSync} from 'node:fs';
import {receiptEditFixture} from './inventory-receipt-edit-fixture.mjs';
export const billedMigration='supabase/migrations/20261030150000_inventory_purchase_billed_amount.sql';
// Isolated database only: the receipt-edit fixture (store day 2026-10-11, receipt #100
// 10 cans x 20,000 from Won Mart, confirmed unpaid expense) plus the 실청구금액 migration.
export async function billedFixture(Database){
 const db=await receiptEditFixture(Database);
 await db.exec(readFileSync(billedMigration,'utf8'));
 return db;
}
