import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const kegReplace = read("app/api/inventory/keg-sessions/replace/route.ts");
const kegSession = read("app/api/inventory/keg-sessions/[id]/route.ts");
const directApply = read(
  "app/api/admin/sales/inventory-deductions/apply/route.ts"
);
const unifiedExecute = read(
  "app/api/admin/sales/inventory-deductions/unified-execute/route.ts"
);
const inventoryPage = read("app/(protected)/inventory/page.tsx");
const receiptsPage = read("app/(protected)/admin/sales/receipts/page.tsx");
const migration = read(
  "supabase/migrations/202607230002_lock_down_sales_inventory_keg_public_access.sql"
).toLowerCase();

test("keg mutations authenticate the server session and ignore spoofed actors", () => {
  for (const route of [kegReplace, kegSession]) {
    assert.match(route, /getAuthenticatedActor\(\)/);
    assert.match(route, /status: auth\.status/);
    assert.doesNotMatch(route, /body\??\.actorUsername|missing_actor|invalid_actor/);
    assert.doesNotMatch(route, /createClient/);
  }
  assert.match(kegReplace, /p_actor_username: auth\.actor\.username/);
  assert.match(kegReplace, /supabaseServer\.rpc\("replace_inventory_keg"/);
});

test("sales deduction mutations enforce server-session roles and actors", () => {
  assert.match(directApply, /requireRole\(\["owner", "master"\]\)/);
  assert.match(
    unifiedExecute,
    /requireRole\(\["owner", "master", "manager"\]\)/
  );
  for (const route of [directApply, unifiedExecute]) {
    assert.doesNotMatch(route, /getMappingAdminActor|body\.actorUsername/);
    assert.match(route, /status: auth\.status/);
  }
  assert.match(
    directApply,
    /p_actor_username: auth\.actor\.username/
  );
  assert.match(
    unifiedExecute,
    /actorUsername: auth\.actor\.username/
  );
});

test("target mutation clients no longer send actor usernames", () => {
  const editStartCall = inventoryPage.slice(
    inventoryPage.indexOf("`/api/inventory/keg-sessions/${sessionId}`"),
    inventoryPage.indexOf("const result =", inventoryPage.indexOf(
      "`/api/inventory/keg-sessions/${sessionId}`"
    ))
  );
  const replaceCall = inventoryPage.slice(
    inventoryPage.indexOf('"/api/inventory/keg-sessions/replace"'),
    inventoryPage.indexOf("const result =", inventoryPage.indexOf(
      '"/api/inventory/keg-sessions/replace"'
    ))
  );
  assert.ok(editStartCall.length > 0);
  assert.ok(replaceCall.length > 0);
  assert.doesNotMatch(editStartCall, /actorUsername/);
  assert.doesNotMatch(replaceCall, /actorUsername/);

  const unifiedExecuteCall = receiptsPage.slice(
    receiptsPage.indexOf('"/api/admin/sales/inventory-deductions/unified-execute"'),
    receiptsPage.indexOf("const result =", receiptsPage.indexOf(
      '"/api/admin/sales/inventory-deductions/unified-execute"'
    ))
  );
  assert.doesNotMatch(unifiedExecuteCall, /actorUsername/);
});

test("migration closes browser grants while preserving service-role access", () => {
  assert.match(
    migration,
    /alter table public\.pos_inventory_deduction_receipts\s+enable row level security/
  );
  assert.match(
    migration,
    /on table public\.pos_inventory_deduction_receipts\s+from public, anon, authenticated/
  );
  assert.match(
    migration,
    /on table public\.pos_inventory_deduction_receipts\s+to service_role/
  );
  for (const signature of [
    /apply_sales_inventory_deduction_batch\(\s*bigint,\s*text,\s*jsonb\s*\)/,
    /replace_inventory_keg\(\s*bigint,\s*text,\s*date,\s*numeric\s*\)/,
    /replace_inventory_keg\(\s*bigint,\s*text,\s*date,\s*numeric,\s*timestamp with time zone\s*\)/,
  ]) {
    assert.match(migration, signature);
  }
  assert.equal(
    (migration.match(/from public, anon, authenticated/g) || []).length,
    4
  );
  assert.equal((migration.match(/to service_role/g) || []).length, 4);
  assert.doesNotMatch(migration, /create policy|delete from|truncate/);
});
