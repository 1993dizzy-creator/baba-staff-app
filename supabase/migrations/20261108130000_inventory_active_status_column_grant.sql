-- Inventory item activate/deactivate ("비활성"/"활성" on /inventory). Applied to production by the owner
-- on 2026-11-08 as direct SQL (verified read-only: service_role has UPDATE on is_active only). It is not
-- recorded in supabase_migrations.schema_migrations; record it there if the history must list it.
--
-- P1-2F (20261102144000) revoked direct UPDATE on public.inventory from service_role and granted back
-- only the photo metadata columns (image_path, updated_at, updated_by_name, updated_by_username).
-- The active-status PATCH (/api/inventory/items, mode "active-status") writes is_active together with
-- updated_by_name/updated_by_username, so it failed with 42501 for EVERY role (owner, master, manager,
-- leader) and the UI showed "권한이 없습니다". Role permission in the app was never the cause.
--
-- is_active is item metadata like the photo columns: quantity, unit and package content stay writer-RPC
-- only (inventory_writer_private.capture_change still fences them, and no table-level UPDATE is
-- restored). The route keeps its own role check (owner/master/manager/leader) and the active keg
-- session guard.
begin;
grant update(is_active) on public.inventory to service_role;
commit;
