import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const readRoutes = [
  "app/api/inventory/items/route.ts",
  "app/api/inventory/items/status/route.ts",
  "app/api/inventory/keg-progress/route.ts",
  "app/api/inventory/monthly/route.ts",
  "app/api/inventory/snapshot/latest/route.ts",
  "app/api/inventory/snapshot/list/route.ts",
  "app/api/inventory/snapshot/[id]/route.ts",
];

test("all inventory read APIs require the active signed session before data access", () => {
  for (const path of readRoutes) {
    const source = read(path);
    const handlerMarker = path.endsWith("/status/route.ts")
      ? "export async function POST"
      : "export async function GET";
    const route = source.slice(source.indexOf(handlerMarker));
    const authCall = path.endsWith("/items/route.ts")
      ? "authenticatedActorResponse()"
      : "getAuthenticatedActor()";
    const authIndex = route.indexOf(authCall);
    const requestDataIndex = Math.min(
      ...[
        route.indexOf("req.json()"),
        route.indexOf("new URL("),
        route.indexOf(".from("),
        route.indexOf("resolveInventoryBusinessDate()"),
      ].filter((index) => index >= 0)
    );

    assert.ok(authIndex >= 0, `${path} must authenticate the server session`);
    assert.ok(
      authIndex < requestDataIndex,
      `${path} must authenticate before request-driven database work`
    );
    assert.match(source, /error: auth\.code, code: auth\.code/);
    assert.match(source, /status: auth\.status/);
    assert.doesNotMatch(
      route,
      /searchParams\.get\("(?:actor|username|userId)|body\??\.(?:actor|username|userId)/
    );
  }
});

test("inventory reads preserve the existing all-active-user policy", () => {
  for (const path of readRoutes.slice(1)) {
    const route = read(path);
    assert.doesNotMatch(route, /requireRole\(/, `${path} must not add a role gate`);
  }

  const items = read(readRoutes[0]);
  assert.match(items, /includeInactive/);
  assert.match(items, /canToggleInventoryItemActiveStatus\(actor\.role\)/);
  assert.doesNotMatch(items, /searchParams\.get\("actorUsername"\)/);
});

test("snapshot read modes use sessions while creation remains cron-only", () => {
  const route = read("app/api/inventory/snapshot/route.ts");
  const latestIndex = route.indexOf('mode === "latest"');
  const listIndex = route.indexOf('mode === "list"');
  const cronIndex = route.indexOf("authorizeCron(request)");

  assert.ok(latestIndex >= 0 && listIndex >= 0 && cronIndex >= 0);
  assert.match(
    route.slice(latestIndex, listIndex),
    /getAuthenticatedActor\(\)[\s\S]*getLatestSnapshotResponse\(\)/
  );
  assert.match(
    route.slice(listIndex, cronIndex),
    /getAuthenticatedActor\(\)[\s\S]*getSnapshotListResponse\(\)/
  );
  assert.ok(cronIndex > listIndex);
  assert.doesNotMatch(route, /user-agent|vercel-cron|isCron/);
  assert.match(route, /process\.env\.CRON_SECRET\?\.trim\(\)/);
  assert.match(route, /\.from\("inventory_snapshot_batches"\)/);
  assert.match(route, /\.insert\(snapshotRows\)/);
});

test("inventory read errors do not expose database error messages", () => {
  for (const path of readRoutes.slice(1)) {
    const route = read(path);
    assert.doesNotMatch(route, /message:\s*(?:error|\\w+Error)\??\.message/);
    assert.doesNotMatch(route, /message:\s*getErrorMessage\(error\)/);
    assert.doesNotMatch(route, /message:\s*String\(error\)/);
  }

  const snapshot = read("app/api/inventory/snapshot/route.ts");
  assert.doesNotMatch(snapshot, /message:\s*(?:error|\\w+Error)\??\.message/);
  assert.doesNotMatch(
    snapshot,
    /error:\s*error instanceof Error \? error\.message/
  );
});

test("all browser callers use the shared inventory 401 wrapper", () => {
  const inventoryPage = read("app/(protected)/inventory/page.tsx");
  const monthlyPage = read("app/(protected)/inventory/monthly/page.tsx");
  const snapshotsPage = read("app/(protected)/inventory/snapshots/page.tsx");
  const mappingsPage = read("app/(protected)/admin/pos/mappings/page.tsx");
  const client = read("lib/inventory/client-auth.ts");

  for (const endpoint of [
    "/api/inventory/keg-progress",
    "/api/inventory/items/status",
    "/api/inventory/snapshot/latest",
  ]) {
    const endpointIndex = inventoryPage.indexOf(endpoint);
    const callStart = inventoryPage.lastIndexOf("fetchInventoryApi(", endpointIndex);
    assert.ok(callStart >= 0 && endpointIndex > callStart, `${endpoint} must use the wrapper`);
  }

  assert.match(monthlyPage, /fetchInventoryApi\(`\/api\/inventory\/monthly/);
  assert.match(snapshotsPage, /fetchInventoryApi\(url/);
  assert.match(
    mappingsPage,
    /fetchInventoryApi\("\/api\/inventory\/items"/
  );
  assert.match(client, /response\.status === 401/);
  assert.match(client, /handleSessionUnauthorized\(response\)/);
  assert.doesNotMatch(client, /status === 403|status === 500|localStorage/);
});
