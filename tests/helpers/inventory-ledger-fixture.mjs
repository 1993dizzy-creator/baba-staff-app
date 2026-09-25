import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(`supabase/migrations/${name}`, 'utf8');
export async function database(Database = PGlite, withPurchaseCorrections = true, withSamePartyMetadata = true) {
  const db = new Database();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.users(id bigint primary key,role text,is_active boolean,app_login_enabled boolean);
    insert into users values (1,'staff',true,true),(2,'owner',true,true),(3,'staff',false,false);
    create table public.inventory(id bigint primary key,supplier_partner_id bigint);
    create table public.inventory_logs(id bigint primary key,item_id bigint,item_name text,item_name_vi text,category text,category_vi text,unit text,
      change_quantity numeric,new_purchase_price numeric,new_supplier text,business_date date,created_at timestamptz default now(),source text,reason text,actor_username text);
  `);
  const foundation=read('202608210001_create_ledger_v1_foundation.sql');
  await db.exec(foundation.slice(0, foundation.indexOf('create or replace function')));
  await db.exec(`alter table ledger_transactions add column source_fingerprint text, add column source_synced_at timestamptz, add column economic_effect_sign integer default 1;
    alter table ledger_fund_accounts add column is_business_fund boolean default true;`);
  const candidates=read('202608210003_add_inventory_purchase_candidates.sql');
  await db.exec(candidates.slice(0,candidates.indexOf('create or replace function public.ledger_sync')));
  const resolver=candidates.slice(candidates.indexOf('create or replace function public.ledger_resolve'));
  await db.exec(resolver.slice(0,resolver.indexOf('end $$;')+8));
  await db.exec(`alter table ledger_candidates add column source_drift_snapshot jsonb, add column source_drift_fingerprint text, add column source_drift_detected_at timestamptz;
    create table business_partners(id bigint primary key,name text,is_active boolean,payment_mode text,default_fund_account_id bigint,default_payment_term_days integer);
    create table business_partner_ledger_parties(business_partner_id bigint,ledger_party_id bigint);
    create table business_partner_supplier_aliases(business_partner_id bigint,status text,normalized_name text);
    create table ledger_month_closures(month date primary key,status text default 'closed');
    create function business_partner_fund_account_is_eligible_v1(bigint) returns boolean language sql as $$select exists(select 1 from ledger_fund_accounts where id=$1 and is_business_fund and is_active and type<>'card_clearing')$$;
  `);
  // Use the actual month guard implementations and triggers for the tables under test.
  const month=read('202608210008_add_ledger_month_close_corrections.sql');
  await db.exec(month.slice(month.indexOf('create or replace function public.ledger_month_is_closed_v1'),month.indexOf('create or replace function public.ledger_dated_write_month_guard_v1')));
  await db.exec(month.slice(month.indexOf('create or replace function public.ledger_candidate_resolution_month_guard_v1'),month.indexOf('create or replace function public.ledger_confirmed_candidate_drift_v1')));
  await db.exec(read('202608250003_rebook_inventory_transaction.sql'));
  await db.exec(read('202608250002_auto_post_inventory_purchases.sql'));
  await db.exec(read('20260903154302_allow_inventory_metadata_drift.sql'));
  await db.exec(read('20260903155046_route_inventory_sync_through_metadata_guard.sql'));
  await db.exec(read('20260906114438_project_inventory_purchase_logs.sql'));
  await db.exec('create trigger ledger_confirmed_candidate_drift after update of source_drift_fingerprint on ledger_candidates for each row execute function ledger_confirmed_candidate_drift_v1()');
  await db.exec(`insert into ledger_parties(id,name,type) values(10,'Won Mart','supplier'),(11,'OK FOOD','supplier'),(12,'Postpaid','supplier');
    insert into business_partners values(10,'Won Mart',true,'immediate',1,null),(11,'OK FOOD',true,'immediate',2,null),(12,'Postpaid',true,'postpaid',null,7);
    insert into business_partner_ledger_parties values(10,10),(11,11),(12,12);
    insert into ledger_inventory_category_mappings(inventory_category,ledger_category_id) values('Drinks',4);
    insert into inventory values(1,11);
    insert into inventory_logs(id,item_id,item_name,item_name_vi,category,category_vi,unit,change_quantity,new_purchase_price,new_supplier,business_date,source,reason,actor_username,source_actor_user_id)
      values(100,1,'Coca','Cola','Drinks','Nuoc','can',10,20000,'Won Mart','2026-09-01','create','purchase','staff',1);
    update inventory_logs set created_at = '2026-09-01T10:00:00+00:00';
  `);
  await db.exec(`alter table inventory add column quantity numeric default 10, add column purchase_price numeric default 20000,
    add column item_name text default 'Coca',add column supplier text default 'Won Mart',add column unit text default 'can',
    add column updated_at timestamptz,add column updated_by_name text,add column updated_by_username text;`);
  await db.exec('create sequence fixture_inventory_log_id_seq start 1000; alter table inventory_logs alter column id set default nextval(\'fixture_inventory_log_id_seq\')');
  await db.exec('create table inventory_price_logs(item_id bigint,item_name text,item_code text,old_price numeric,new_price numeric,diff numeric,business_date date,source text,reason text,actor_username text,note text)');
  if(withPurchaseCorrections)await db.exec(read('20260914161954_link_inventory_purchase_corrections.sql'));
  if(withSamePartyMetadata)await db.exec(read('202609250001_allow_same_party_inventory_supplier_metadata_enrichment.sql'));
  return db;
}
