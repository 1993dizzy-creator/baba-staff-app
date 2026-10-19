import {readFileSync} from 'node:fs';
import {atomicInventoryDatabase} from './inventory-atomic-fixture.mjs';
const migration='supabase/migrations/20261011165833_safe_same_day_inventory_correction.sql';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
export async function safeFixture(Database){
 const db=await atomicInventoryDatabase(Database);
 // Fixed store clock in the isolated fixture only. Production uses the existing
 // configured store date function; no operating database or credentials are read.
 await db.exec(`create function store_business_date_for_timestamp_v1(timestamptz) returns date language sql stable as $$select '2026-10-11'::date$$;
 update inventory_logs set business_date='2026-10-11',created_at='2026-10-11T03:00:00Z' where id=100;
 update ledger_transactions set business_date='2026-10-11',recognition_month='2026-10-01';
 update ledger_candidates set business_date='2026-10-11',proposed_recognition_month='2026-10-01',source_snapshot=source_snapshot||'{"business_date":"2026-10-11"}'::jsonb;
 update inventory set updated_at='2026-10-11T03:00:00Z';`);
 const verification=readFileSync('supabase/migrations/20260921170100_add_inventory_payment_verification.sql','utf8');
 // Real current payment-contract amendments, isolated from unrelated month preflight.
 await db.exec(verification.slice(0,verification.indexOf('  -- Keep the existing preflight'))+'end;\n$payment_verification$;');
 await db.exec(readFileSync(migration,'utf8'));return db;
}
export const snapshot=async db=>(await one(db,'select to_jsonb(i) as item from inventory i where id=1')).item;
export const correct=async(db,old,payload={quantity:9},actor=1,date='2026-10-11')=>(await one(db,'select inventory_apply_purchase_correction_v3(1,100,$1,$2::jsonb,$3::jsonb,$4::date,$5) as result',[old.quantity,JSON.stringify(old),JSON.stringify(payload),date,actor])).result;
