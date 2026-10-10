import {readFileSync} from 'node:fs';
import {database} from './inventory-ledger-fixture.mjs';
const migration='20261010140729_atomic_inventory_edit_and_versioned_correction.sql';
export async function atomicInventoryDatabase(Database){const db=await database(Database);await db.exec(`
 alter table users add column name text default 'Session actor',add column username text default 'qa';
 alter table inventory add column is_active boolean default true,add column item_name_vi text default 'Cola',add column part text default 'bar',add column category text default 'Drinks',add column category_vi text,add column code text,add column note text,add column low_stock_threshold numeric default 1,add column low_stock_enabled boolean default true,add column package_content_quantity numeric,add column package_content_unit text,add column image_path text;
 alter table inventory_logs add column action text,add column part text,add column code text,add column actor_name text,add column prev_quantity numeric,add column new_quantity numeric,add column prev_purchase_price numeric,add column prev_note text,add column new_note text,add column prev_supplier text,add column prev_code text,add column new_code text,add column prev_unit text,add column new_unit text,add column prev_category text,add column new_category text,add column prev_category_vi text,add column new_category_vi text,add column prev_part text,add column new_part text,add column prev_low_stock_threshold numeric,add column new_low_stock_threshold numeric;
 update inventory set updated_at='2026-10-10T03:00:00Z',supplier_partner_id=10;
 update business_partners set payment_mode='postpaid',default_fund_account_id=null where id=10;
 select ledger_project_inventory_purchase_log_v1(100,2);`);
 for(const name of ['20261007182027_resolve_inventory_purchase_projection.sql','20261009080243_detect_inventory_purchase_economic_corrections.sql'])await db.exec(readFileSync('supabase/migrations/'+name,'utf8'));
 await db.exec(readFileSync('supabase/migrations/'+migration,'utf8'));return db;}
