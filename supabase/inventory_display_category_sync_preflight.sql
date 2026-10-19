-- READ-ONLY preflight for 20261020093000_sync_inventory_display_category_to_ledger.sql.
-- Every statement is SELECT-only. Run before applying the migration.

-- 1) Migration history and absence of the new objects.
select version, name from supabase_migrations.schema_migrations where version >= '20261018000000' order by version;
select to_regprocedure('public.ledger_project_inventory_display_sync_v1(bigint,bigint)') as display_rpc,
       to_regprocedure('inventory_ledger_private.display_sync_category_v1(text,bigint,jsonb)') as category_helper,
       to_regprocedure('inventory_ledger_private.sync_confirmed_display_category_v1(bigint,jsonb,text,bigint)') as confirmed_helper,
       to_regprocedure('inventory_ledger_private.purchase_category_for_new_source_v1(jsonb,bigint)') as gas_rule_helper_required;

-- 2) Exactly one occurrence of each anchor in the deployed bodies (expect 1 / 1 / 1, already_patched=false).
with f as (
  select 'sync_candidate' fn, pg_get_functiondef('inventory_ledger_private.sync_candidate(jsonb,bigint)'::regprocedure) d
  union all select 'projection', pg_get_functiondef('public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure)
), n as (select fn, replace(d, chr(13)||chr(10), chr(10)) d, position(chr(13)||chr(10) in d) > 0 crlf, md5(d) body_md5 from f)
select fn, crlf, body_md5, position('baba.inventory_display_sync' in d) > 0 already_patched,
  (length(d) - length(replace(d, 'if v_pending.id is not null and v_pending.source_fingerprint = v_fingerprint then', ''))) / length('if v_pending.id is not null and v_pending.source_fingerprint = v_fingerprint then') pending_anchor,
  (length(d) - length(replace(d, E'v_code := ''METADATA_SYNCED'';\n          end if;', ''))) / length(E'v_code := ''METADATA_SYNCED'';\n          end if;') metadata_anchor,
  (length(d) - length(replace(d, '  v_corrections bigint[];', ''))) / length('  v_corrections bigint[];') declare_anchor
from n;

-- 3) Reported production state (expect 1872/1873 superseded, 1900/1901 pending on #66).
select c.id, c.status, c.source_key, c.proposed_category_id, c.proposed_party_id, c.proposed_amount,
       c.source_snapshot->>'category' snapshot_category, c.business_date, c.resolved_transaction_id
from public.ledger_candidates c
where c.source_type = 'inventory_purchase_log' and c.source_key in ('inventory-log:13561','inventory-log:13563')
order by c.id;
select id, item_id, part, new_part, category, new_category, category_vi, change_quantity, new_purchase_price,
       new_supplier, purchase_supplier_partner_id, business_date
from public.inventory_logs where id in (13561,13563) order by id;
select m.id, m.inventory_category, m.ledger_category_id, m.is_active, c.name, c.kind, c.is_active category_active
from public.ledger_inventory_category_mappings m join public.ledger_categories c on c.id = m.ledger_category_id
where lower(btrim(m.inventory_category)) in ('기타','가공식품') order by m.id;
select id, name, payment_mode, is_active from public.business_partners where id = 33;
select inventory_log_id, status, code, updated_at from public.ledger_inventory_projection_status
where inventory_log_id in (13561,13563) order by 1;
-- MONTH cannot be a bare column label (interval syntax); expect 0 rows while October is open.
select to_char(c.month,'YYYY-MM') as month_label, c.status from public.ledger_month_closures c where c.month = '2026-10-01';
select i.id, i.part item_part, l.id log_id, l.part log_part, l.new_part log_new_part,
       (i.part = coalesce(nullif(btrim(l.part),''), l.new_part) and i.part = coalesce(nullif(btrim(l.new_part),''), l.part)) same_part
from public.inventory_logs l join public.inventory i on i.id = l.item_id
where l.id in (13561,13563) order by l.id;

-- 3b) Confirmed October inventory expenses. display_snapshot = {} is the column default
--     (Production: 421 of 421); only a non-empty display_snapshot, an amount drift, a linked
--     correction or a non-rebook transaction audit row is treated as a manual Ledger edit.
select count(*) confirmed_expenses,
       count(*) filter (where t.display_snapshot = '{}'::jsonb) default_display_snapshot,
       count(*) filter (where t.display_snapshot <> '{}'::jsonb) display_override,
       count(*) filter (where t.amount is distinct from c.proposed_amount) amount_override,
       count(*) filter (where exists (select 1 from public.ledger_transactions x where x.correction_of_id = t.id)) corrected,
       count(*) filter (where exists (select 1 from public.ledger_audit_logs a where a.entity_type = 'transaction'
         and a.entity_id = t.id and a.action <> 'inventory_source_rebooked')) manual_audit_history
from public.ledger_candidates c join public.ledger_transactions t on t.id = c.resolved_transaction_id
where c.source_type = 'inventory_purchase_log' and c.status = 'confirmed' and t.status = 'confirmed'
  and t.business_date >= '2026-10-01' and t.business_date < '2026-11-01';

-- 4) Privileges before (expect only service_role / postgres on the public projection RPC).
select p.oid::regprocedure, r.rolname, has_function_privilege(r.rolname, p.oid, 'execute') can_execute
from pg_proc p cross join (values ('public'),('anon'),('authenticated'),('service_role')) r(rolname)
where p.oid in ('public.ledger_project_inventory_purchase_log_v1(bigint,bigint)'::regprocedure,
                'inventory_ledger_private.sync_candidate(jsonb,bigint)'::regprocedure)
  and r.rolname <> 'public'
order by 1, 2;
