-- Full group-B must be committed first. Metadata/private-ledger reads only.
with checks as (
 select
 exists(select 1 from pg_trigger where tgrelid='public.inventory_logs'::regclass and tgname='inventory_logs_pos_stock_check_boundary' and tgenabled='O') p0_enabled,
 (select count(*)=13 from inventory_writer_private.rpc_contracts) expected_writer_count,
 not exists(select 1 from inventory_writer_private.rpc_contracts c left join pg_proc p on p.oid=c.function_oid
  where p.oid is null or p.prosrc is distinct from pos_signed_private.current_rpc_body(c.function_oid)) writer_bodies_match,
 not has_column_privilege('service_role','public.inventory','quantity','UPDATE') direct_quantity_denied,
 not has_table_privilege('service_role','public.inventory','INSERT') direct_creation_denied,
 has_column_privilege('service_role','public.inventory','image_path','UPDATE') photo_metadata_allowed,
 not has_table_privilege('service_role','public.inventory_logs','DELETE') audit_delete_denied,
 not exists(select 1 from pos_signed_private.handoffs) no_handoffs,
 not exists(select 1 from pos_signed_private.sale_versions where source_complete) no_confirmation_promoted,
 not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('pos_inventory_shadow','pos_ingest_private','inventory_writer_private','pos_signed_private') and c.relkind='r' and not c.relrowsecurity) private_rls_enabled,
 not exists(select 1 from unnest(array['pos_inventory_shadow','pos_ingest_private','inventory_writer_private','pos_signed_private']) n
  where has_schema_privilege('anon',n,'USAGE') or has_schema_privilege('authenticated',n,'USAGE') or has_schema_privilege('service_role',n,'USAGE')) private_schemas_closed
)
select to_jsonb(checks) checks,
 not exists(select 1 from jsonb_each(to_jsonb(checks)) e where e.value<>'true'::jsonb) passed,
 -- A failed postflight must abort the caller-owned group-B transaction.
 1 / (not exists(select 1 from jsonb_each(to_jsonb(checks)) e where e.value<>'true'::jsonb))::integer assertion
from checks;
