// Shared isolated-PostgreSQL fixture for the open-orders merge evidence (native, loopback only).
// Mirrors the production objects the migrations touch: roles, receipt columns/types and
// Supabase migration history. No hosted credentials, CUKCUK calls or production data.
import { readFileSync } from 'node:fs';

const file = name => readFileSync(new URL(`../../supabase/${'migrations'}/${name}`, import.meta.url), 'utf8');
export const BASE = file('20261109210000_pos_open_orders_v1.sql');
export const RECEIPT_EVIDENCE = file('20261110170329_pos_open_orders_vanished_receipt_evidence.sql');
export const MERGED = file('20261114161500_pos_open_orders_merged_receipt_evidence.sql');
export const doc = name => readFileSync(new URL(`../../docs/sql/pos-open-orders-merged-receipt-evidence-${name}.sql`, import.meta.url), 'utf8');

export const PREREQUISITES = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create table public.pos_sales_receipts(id bigint primary key, source text not null, branch_id text, business_date date not null,
  payment_status integer, is_canceled boolean not null default false, total_amount numeric not null, discount_amount numeric not null default 0,
  raw_json jsonb not null);
create schema supabase_migrations;
create table supabase_migrations.schema_migrations(version text primary key, statements text[], name text);`;

/** Prerequisites plus the two migrations production already has, with their history rows. */
export async function installProductionBaseline(client) {
  await client.query(PREREQUISITES);
  await client.query(BASE);
  await client.query(RECEIPT_EVIDENCE);
  await client.query(`insert into supabase_migrations.schema_migrations(version, name) values
    ('20261109210000', 'pos_open_orders_v1'), ('20261110170329', 'pos_open_orders_vanished_receipt_evidence')`);
}

/** CLI-equivalent apply: one transaction for the file and its history row. */
export async function applyMerged(client) {
  await client.query('begin');
  try {
    await client.query(MERGED);
    await client.query("insert into supabase_migrations.schema_migrations(version, name) values ('20261114161500', 'pos_open_orders_merged_receipt_evidence')");
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
}

export const FUNCTION_HASHES = `select p.oid::regprocedure::text sig, md5(p.prosrc) md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'pos_open_orders_private' or (n.nspname = 'public' and p.proname like 'pos\\_open\\_orders\\_%') order by 1`;
