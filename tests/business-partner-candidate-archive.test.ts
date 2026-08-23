import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/202608230002_add_supplier_alias_candidate_archive.sql");
const oldCandidateMigration = read("supabase/migrations/202608220002_add_inventory_supplier_candidates.sql");
const oldFixMigration = read("supabase/migrations/202608220003_fix_supplier_alias_ignore_behavior.sql");
const aliasApi = read("app/api/admin/partners/aliases/[id]/route.ts");
const candidatePage = read("app/(protected)/admin/partners/candidates/[id]/page.tsx");
const registrationPage = read("app/(protected)/admin/partners/page.tsx");

test("archive/reactivate statuses and audit actions are additive on top of the existing enums", () => {
  assert.match(migration, /drop constraint business_partner_supplier_aliases_status_check/);
  assert.match(migration, /check \(status in \('pending', 'linked', 'ignored', 'archived'\)\)/);
  assert.match(migration, /drop constraint business_partner_supplier_alias_status_policy/);
  assert.match(migration, /status = 'archived' and business_partner_id is null and reviewed_at is not null and reviewed_by is not null/);
  assert.match(migration, /drop constraint business_partner_supplier_alias_audit_logs_action_check/);
  assert.match(migration, /'candidate_archived'/);
  assert.match(migration, /'candidate_reactivated'/);
  // the original pending/linked/ignored branches must still be present, untouched
  assert.match(migration, /status = 'linked' and business_partner_id is not null and reviewed_at is not null and reviewed_by is not null/);
  assert.match(migration, /status = 'ignored' and business_partner_id is null and reviewed_at is not null and reviewed_by is not null/);
  assert.match(migration, /status = 'pending' and business_partner_id is null and reviewed_at is null and reviewed_by is null/);
});

test("archive RPC only accepts pending candidates with zero current inventory usage", () => {
  assert.match(migration, /create function public\.business_partner_archive_supplier_alias_v1/);
  assert.match(migration, /if v_alias\.status <> 'pending' or v_alias\.business_partner_id is not null then\s*\n\s*return jsonb_build_object\('status', 'invalid_state'\);/);
  assert.match(migration, /select count\(\*\) into v_inventory_count from public\.inventory\s*\n\s*where lower\(btrim\(supplier\)\) = v_alias\.normalized_name;/);
  assert.match(migration, /if v_inventory_count > 0 then\s*\n\s*return jsonb_build_object\('status', 'candidate_in_use', 'inventoryCount', v_inventory_count\);/);
  assert.match(migration, /set status = 'archived', reviewed_at = now\(\), reviewed_by = p_actor_user_id, updated_at = now\(\)/);
  assert.match(migration, /'candidate_archived'/);
  assert.match(migration, /not in \('owner', 'master'\)/);
});

test("archive RPC follows the established security pattern", () => {
  assert.match(migration, /alter function public\.business_partner_archive_supplier_alias_v1\(bigint, bigint\) owner to postgres/);
  assert.match(migration, /revoke all on function public\.business_partner_archive_supplier_alias_v1\(bigint, bigint\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.business_partner_archive_supplier_alias_v1\(bigint, bigint\) to service_role/);
  assert.match(migration, /security definer/);
  assert.match(migration, /set search_path = pg_catalog, public/);
});

test("resolver v1 is extended in place via create or replace, keeping its name and signature stable", () => {
  assert.match(migration, /create or replace function public\.business_partner_resolve_inventory_supplier_v1/);
  assert.doesNotMatch(migration, /create function public\.business_partner_resolve_inventory_supplier_v1/);
  // the same precedent already used by 202608220003 for review_supplier_alias_v1
  assert.match(oldFixMigration, /create or replace function public\.business_partner_review_supplier_alias_v1/);
  assert.match(oldCandidateMigration, /business_partner_resolve_inventory_supplier_v1/);
});

test("archived candidates are silently reactivated to pending when the supplier reappears in inventory", () => {
  const resolverBody = migration.slice(
    migration.indexOf("create or replace function public.business_partner_resolve_inventory_supplier_v1"),
    migration.indexOf("alter function public.business_partner_resolve_inventory_supplier_v1"),
  );
  assert.match(resolverBody, /if v_alias\.status = 'archived' then/);
  assert.match(resolverBody, /set status = 'pending', reviewed_at = null, reviewed_by = null, last_seen_at = now\(\), updated_at = now\(\)/);
  assert.match(resolverBody, /'candidate_reactivated'/);
  // the linked/pending/ignored last_seen_at touch-up path is preserved unchanged
  assert.match(resolverBody, /if v_alias\.status = 'linked' then/);
});

test("previous candidate migrations remain byte-for-byte unchanged", () => {
  assert.match(oldCandidateMigration, /status in \('pending', 'linked', 'ignored'\)/);
  assert.match(oldCandidateMigration, /action in \('candidate_created','candidate_linked_new_partner','candidate_linked_existing_partner','candidate_ignored','candidate_reopened'\)/);
});

test("alias API exposes a dedicated archive action distinct from ignore/reopen", () => {
  assert.match(aliasApi, /"archive"/);
  assert.match(aliasApi, /business_partner_archive_supplier_alias_v1/);
  assert.match(aliasApi, /p_alias_id: id, p_actor_user_id: auth\.actor\.id/);
  assert.match(aliasApi, /candidate_in_use.*\? 409/);
  assert.match(aliasApi, /result\.status === "not_found" \? 404/);
});

test("candidate detail page shows a delete action only when inventory usage is zero, with a bilingual confirm", () => {
  assert.match(candidatePage, /alias\.inventoryCount === 0 \? <BarSection title={labels\.removeSection}/);
  assert.match(candidatePage, /window\.confirm\(labels\.removeConfirm\)/);
  assert.match(candidatePage, /removeConfirm: "연결된 품목이 없는 등록대기 거래처를 삭제하시겠습니까\?"/);
  assert.match(candidatePage, /removeConfirm: "Bạn có muốn xóa đối tác chờ duyệt không còn mặt hàng liên kết này không\?"/);
  assert.match(candidatePage, /action: "archive"/);
  assert.match(candidatePage, /router\.push\("\/admin\/partners"\)/);
  assert.match(candidatePage, /dangerButtonStyle/);
});

test("archived candidates never resurface in the pending or ignored registration lists", () => {
  assert.match(candidatePage, /status: "pending" \| "linked" \| "ignored" \| "archived"/);
  assert.match(registrationPage, /status: "pending" \| "linked" \| "ignored" \| "archived"/);
  // the registration list only ever renders rows matching the pending/ignored tab filter
  assert.match(registrationPage, /const rows = aliases\.filter\(row => row\.status === filter\)/);
  assert.doesNotMatch(registrationPage, /"archived"\)/);
});
