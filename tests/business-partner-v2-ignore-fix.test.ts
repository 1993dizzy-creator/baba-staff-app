import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/202608220003_fix_supplier_alias_ignore_behavior.sql");
const previousMigration = read("supabase/migrations/202608220002_add_inventory_supplier_candidates.sql");
const ignoreStart = migration.indexOf("elsif p_action = 'ignore' then");
const reopenStart = migration.indexOf("elsif p_action = 'reopen' then");
const ignoreBranch = migration.slice(ignoreStart, reopenStart);

test("ignoring an alias never clears an existing inventory Partner FK or raw supplier", () => {
  assert.ok(ignoreStart >= 0 && reopenStart > ignoreStart);
  assert.doesNotMatch(ignoreBranch, /update public\.inventory/i);
  assert.doesNotMatch(ignoreBranch, /supplier_partner_id\s*=\s*null/i);
  assert.doesNotMatch(migration, /set\s+supplier\s*=/i);
});

test("ignore still marks only the alias ignored with no linked Partner", () => {
  assert.match(ignoreBranch, /status='ignored'/);
  assert.match(ignoreBranch, /business_partner_id=null/);
  assert.match(ignoreBranch, /v_audit_action := 'candidate_ignored'/);
});

test("linked create and reopen behavior remains present", () => {
  assert.match(migration, /p_action = 'create_partner'/);
  assert.match(migration, /p_action = 'link_existing'/);
  assert.match(migration, /p_action = 'reopen'/);
  assert.match(migration, /update public\.inventory set supplier_partner_id=v_partner_id[\s\S]*supplier_partner_id is null/);
  assert.match(migration, /status='pending', business_partner_id=null, reviewed_at=null, reviewed_by=null/);
});

test("function contract and security remain unchanged", () => {
  assert.match(migration, /create or replace function public\.business_partner_review_supplier_alias_v1\([\s\S]*p_actor_user_id bigint[\s\S]*\) returns jsonb/);
  assert.match(migration, /security definer[\s\S]*set search_path = pg_catalog, public/);
  assert.match(migration, /owner to postgres/);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/);
  assert.match(migration, /return jsonb_build_object\('status', 'reviewed', 'partnerId', v_partner_id, 'inventoryLinkedCount', v_inventory_count\)/);
});

test("the replacement function differs from 202608220002 only by the unsafe ignore update", () => {
  const signature = "function public.business_partner_review_supplier_alias_v1(";
  const previousStart = previousMigration.indexOf(signature);
  const previousEnd = previousMigration.indexOf("\n$$;", previousStart) + 4;
  const replacementStart = migration.indexOf(signature);
  const replacementEnd = migration.indexOf("\n$$;", replacementStart) + 4;
  const unsafeUpdate = "    update public.inventory set supplier_partner_id=null where lower(btrim(supplier))=v_alias.normalized_name and supplier_partner_id is not null;\n";
  const previousFunction = previousMigration.slice(previousStart, previousEnd).replace(unsafeUpdate, "");
  const replacementFunction = migration.slice(replacementStart, replacementEnd);
  assert.equal(replacementFunction, previousFunction);
});
