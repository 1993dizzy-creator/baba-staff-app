import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guard = readFileSync(
  "supabase/migrations/20260903154302_allow_inventory_metadata_drift.sql",
  "utf8"
);
const route = readFileSync(
  "supabase/migrations/20260903155046_route_inventory_sync_through_metadata_guard.sql",
  "utf8"
);
const predecessor = readFileSync(
  "supabase/migrations/202608250002_auto_post_inventory_purchases.sql",
  "utf8"
);
const samePartyMetadata = readFileSync(
  "supabase/migrations/202609250001_allow_same_party_inventory_supplier_metadata_enrichment.sql",
  "utf8"
);

test("the existing inventory sync body is preserved as core before v2 is created", () => {
  const rename = guard.indexOf("rename to ledger_sync_inventory_candidates_core_v1");
  const createV2 = guard.indexOf("function public.ledger_sync_inventory_candidates_v2");
  assert.ok(rename >= 0 && createV2 > rename);
  assert.match(guard, /ledger_sync_inventory_candidates_core_v1\(\s*v_forward_rows,\s*p_actor_user_id\s*\)/);
  assert.match(predecessor, /function public\.ledger_sync_inventory_candidates_v1\([\s\S]*security definer\s+set search_path = pg_catalog, public/);
  assert.match(predecessor, /comment on function public\.ledger_sync_inventory_candidates_v1\(jsonb, bigint\) is[\s\S]*Synchronizes Inventory purchase candidates/);
});

test("v2 acknowledges only display-metadata-only drift and preserves economic fields", () => {
  assert.match(guard, /v_latest\.proposed_amount = v_amount/);
  assert.match(guard, /array\['item_name','category','category_vi'\]::text\[\]/);
  assert.match(guard, /inventory_metadata_drift_acknowledged/);
  assert.match(guard, /source_drift_fingerprint = v_fingerprint/);
  assert.match(guard, /source_drift_snapshot = v_snapshot/);
  assert.match(guard, /metadataDriftCount/);
  assert.match(guard, /metadataDriftUnchangedCount/);
  assert.match(guard, /forwardedCount/);
});

test("the public v1 contract routes only through v2", () => {
  assert.match(route, /return public\.ledger_sync_inventory_candidates_v2\(\s*p_rows,\s*p_actor_user_id\s*\)/);
  assert.doesNotMatch(route, /ledger_sync_inventory_candidates_core_v1/);
});

test("all three functions retain the production security contract", () => {
  for (const [sql, name] of [
    [guard, "ledger_sync_inventory_candidates_v2"],
    [route, "ledger_sync_inventory_candidates_v1"],
  ] as const) {
    assert.match(sql, /security definer/);
    assert.match(sql, /set search_path = pg_catalog, public/);
    assert.match(sql, new RegExp(`alter function public\\.${name}\\(jsonb, bigint\\)\\s+owner to postgres`));
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\(jsonb, bigint\\)[\\s\\S]*from public, anon, authenticated, service_role`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\(jsonb, bigint\\)[\\s\\S]*to postgres, service_role`));
  }
  assert.match(guard, /alter function public\.ledger_sync_inventory_candidates_core_v1\(jsonb, bigint\)\s+owner to postgres/);
  assert.match(guard, /revoke all on function public\.ledger_sync_inventory_candidates_core_v1\(jsonb, bigint\)[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(guard, /grant execute on function public\.ledger_sync_inventory_candidates_core_v1\(jsonb, bigint\)[\s\S]*to postgres, service_role/);
});

test("same-party supplier linkage is a narrow projection-only metadata exception", () => {
  assert.match(samePartyMetadata, /pg_get_functiondef\(v_oid\)/);
  assert.match(samePartyMetadata, /inventory_ledger_private\.economics\(v_candidate\.source_snapshot\) - 'purchase_supplier_partner_id'/);
  assert.match(samePartyMetadata, /inventory_ledger_private\.economics\(v_snapshot\) - 'purchase_supplier_partner_id'/);
  assert.match(samePartyMetadata, /source_snapshot->>'purchase_supplier_partner_id' is null/);
  assert.match(samePartyMetadata, /v_log\.purchase_supplier_partner_id is not null/);
  assert.match(samePartyMetadata, /source_snapshot->'supplier' is not distinct from v_snapshot->'supplier'/);
  assert.match(samePartyMetadata, /business_partner_ledger_parties bridge/);
  assert.match(samePartyMetadata, /bridge\.ledger_party_id = v_tx\.party_id/);
  assert.doesNotMatch(samePartyMetadata, /create or replace function inventory_ledger_private\.economics/);
});

test("same-party projection patch preserves the production function security contract", () => {
  assert.match(samePartyMetadata, /alter function public\.ledger_project_inventory_purchase_log_v1\(bigint,bigint\) owner to postgres/);
  assert.match(samePartyMetadata, /revoke all on function public\.ledger_project_inventory_purchase_log_v1\(bigint,bigint\)[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(samePartyMetadata, /grant execute on function public\.ledger_project_inventory_purchase_log_v1\(bigint,bigint\)[\s\S]*to service_role/);
});
