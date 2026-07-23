import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const itemsRoute = read("app/api/inventory/items/route.ts");
const photoRoute = read("app/api/inventory/items/[id]/photo/route.ts");
const inventoryPage = read("app/(protected)/inventory/page.tsx");
const inventoryClient = read("lib/inventory/client-auth.ts");
const snapshotRoute = read("app/api/inventory/snapshot/route.ts");

test("inventory item mutations authenticate only the signed server session", () => {
  assert.match(itemsRoute, /getAuthenticatedActor\(\)/);
  assert.match(itemsRoute, /\.{3}auth\.actor, is_active: true/);
  assert.match(
    itemsRoute,
    /getAuthenticatedActor already confirmed that the current users row is active/
  );
  assert.doesNotMatch(itemsRoute, /\.from\("users"\)/);
  assert.doesNotMatch(itemsRoute, /searchParams\.get\("actorUsername"\)/);
  assert.doesNotMatch(itemsRoute, /const\s*\{[^}]*actorUsername[^}]*\}\s*=\s*body/);
  assert.match(itemsRoute, /delete sanitized\.actorUsername/);
  assert.match(itemsRoute, /delete sanitized\.updated_by_username/);
  assert.match(itemsRoute, /updated_by_username: actor\.username/);
});

test("inventory item role policy remains unchanged after authentication migration", () => {
  assert.match(
    itemsRoute,
    /canDeleteInventoryItem[\s\S]*role === "owner" \|\| role === "master"/
  );
  assert.match(
    itemsRoute,
    /canToggleInventoryItemActiveStatus[\s\S]*role === "owner"[\s\S]*role === "master"[\s\S]*role === "manager"[\s\S]*role === "leader"/
  );
  assert.match(itemsRoute, /mode === "active-status"/);
  assert.match(itemsRoute, /inventory_item_active_status_forbidden/);
  assert.match(itemsRoute, /inventory_item_delete_forbidden/);
});

test("inventory photo mutations use the session actor and ignore request actor fields", () => {
  assert.match(photoRoute, /getAuthenticatedActor\(\)/);
  assert.match(photoRoute, /\.{3}auth\.actor, is_active: true/);
  assert.doesNotMatch(photoRoute, /\.from\("users"\)/);
  assert.doesNotMatch(photoRoute, /formData\.get\("actorUsername"\)/);
  assert.doesNotMatch(photoRoute, /body\.actorUsername/);
  assert.match(photoRoute, /export const PUT = POST/);
  assert.match(photoRoute, /actor_name: actor\.name/);
  assert.match(photoRoute, /actor_username: actor\.username/);
  assert.match(photoRoute, /updated_by_username: actor\.username/);
  assert.doesNotMatch(
    photoRoute,
    /,\s*(?:uploadError|updateError|removeError)\??\.message,\s*500/
  );
});

test("inventory mutation clients send no actor identity and share 401 handling", () => {
  assert.match(inventoryPage, /fetchInventoryApi\("\/api\/inventory\/items"/);
  assert.match(
    inventoryPage,
    /fetchInventoryApi\(`\/api\/inventory\/items\/\$\{itemId\}\/photo`/
  );
  assert.doesNotMatch(inventoryPage, /formData\.append\("actorUsername"/);
  assert.doesNotMatch(inventoryPage, /updated_by_username/);
  assert.doesNotMatch(inventoryPage, /params\.set\("actorUsername"/);

  const mutationSection = inventoryPage.slice(
    inventoryPage.indexOf("const handleEditReasonConfirm"),
    inventoryPage.indexOf("const canReplaceKeg")
  );
  assert.doesNotMatch(mutationSection, /\bactorUsername\b|\bactorName\b/);

  assert.match(inventoryClient, /const response = await fetch\(input, init\)/);
  assert.match(inventoryClient, /response\.status === 401/);
  assert.match(inventoryClient, /handleSessionUnauthorized\(response\)/);
  assert.doesNotMatch(inventoryClient, /status === 403|status === 500/);
  assert.doesNotMatch(inventoryClient, /localStorage|Content-Type|credentials:/);
});

test("snapshot creation requires the shared cron secret and never trusts user-agent", () => {
  assert.match(snapshotRoute, /authorizeCron\(request\)/);
  assert.match(snapshotRoute, /process\.env\.CRON_SECRET\?\.trim\(\)/);
  assert.doesNotMatch(snapshotRoute, /user-agent|vercel-cron|isCron/);
  assert.match(snapshotRoute, /status: 401/);
  assert.match(snapshotRoute, /mode === "latest"/);
  assert.match(snapshotRoute, /mode === "list"/);
  assert.match(snapshotRoute, /\.from\("inventory_snapshot_batches"\)/);
  assert.match(snapshotRoute, /\.insert\(snapshotRows\)/);
});
