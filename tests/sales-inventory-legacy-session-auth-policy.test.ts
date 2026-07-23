import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const roleRoutes = [
  {
    path: "app/api/admin/sales/inventory-deductions/preview/route.ts",
    roles: '["owner", "master", "manager", "leader"]',
  },
  {
    path: "app/api/admin/sales/inventory-deductions/unified-preview/route.ts",
    roles: '["owner", "master", "manager", "leader"]',
  },
  {
    path: "app/api/admin/sales/inventory-deductions/reprocess/route.ts",
    roles: '["owner", "master", "manager"]',
  },
  {
    path: "app/api/admin/sales/inventory-deductions/batches/route.ts",
    roles: '["owner", "master", "manager", "leader"]',
  },
  {
    path: "app/api/admin/sales/inventory-deductions/batches/[id]/route.ts",
    roles: '["owner", "master", "manager", "leader"]',
  },
  {
    path: "app/api/admin/sales/inventory-deductions/batches/[id]/validate/route.ts",
    roles: '["owner", "master", "manager", "leader"]',
  },
  {
    path: "app/api/admin/sales/inventory-deductions/batches/[id]/receipts/route.ts",
    roles: '["owner", "master", "manager", "leader"]',
  },
  {
    path: "app/api/admin/sales/inventory-deductions/batches/[id]/apply/route.ts",
    roles: '["owner", "master"]',
  },
] as const;

test("all legacy sales-inventory routes authenticate session roles before request input", () => {
  for (const { path, roles } of roleRoutes) {
    const source = read(path);
    const handlerIndex = source.search(/export async function (?:GET|POST|PATCH)/);
    const route = source.slice(handlerIndex);
    const authIndex = route.indexOf(`requireRole(${roles})`);
    const inputIndex = Math.min(
      ...[
        route.indexOf("req.json()"),
        route.indexOf("new URL("),
        route.indexOf("context.params"),
        route.indexOf(".from("),
        route.indexOf(".rpc("),
      ].filter((index) => index >= 0)
    );

    assert.ok(authIndex >= 0, `${path} must preserve its role policy`);
    assert.ok(authIndex < inputIndex, `${path} must authenticate before request-driven work`);
    assert.match(source, /status: auth\.status/);
    assert.doesNotMatch(source, /getMappingAdminActor/);
    assert.doesNotMatch(
      route,
      /searchParams\.get\("actorUsername"\)|body\.actorUsername/
    );
  }
});

test("session actor is used by legacy routes that record or execute changes", () => {
  const reprocess = read(roleRoutes[2].path);
  const validate = read(roleRoutes[5].path);
  const receipts = read(roleRoutes[6].path);
  const apply = read(roleRoutes[7].path);

  assert.match(reprocess, /actorUsername: auth\.actor\.username/);
  assert.match(validate, /validatedBy: auth\.actor\.username/);
  assert.match(receipts, /updatedBy: auth\.actor\.username/);
  assert.match(apply, /p_actor_username: auth\.actor\.username/);
});

test("classic preview remains read-only and rejects hidden batch saving", () => {
  const preview = read(roleRoutes[0].path);
  const saveBatchGuard = preview.indexOf("body.saveBatch === true");
  const previewBuild = preview.indexOf("buildInventoryDeductionPreview({");

  assert.ok(saveBatchGuard >= 0 && saveBatchGuard < previewBuild);
  assert.match(preview, /Batch saving through preview is no longer supported/);
  assert.doesNotMatch(preview, /saveInventoryDeductionPreviewBatch/);
  assert.doesNotMatch(preview, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
  assert.match(preview, /ok: true,\s*preview,\s*batch: null/);
});

test("modified legacy routes do not expose database error text", () => {
  for (const { path } of roleRoutes) {
    const source = read(path);
    assert.doesNotMatch(source, /error:\s*error\.message/);
    assert.doesNotMatch(source, /error:\s*error instanceof Error/);
    assert.doesNotMatch(source, /code:\s*error\.code/);
  }
});

test("sales deduction browser calls use shared 401 handling without actor spoof fields", () => {
  const page = read("app/(protected)/admin/sales/receipts/page.tsx");
  const client = read("lib/sales/client-auth.ts");

  for (const endpoint of [
    "/api/admin/sales/inventory-deductions/preview",
    "/api/admin/sales/inventory-deductions/unified-preview",
    "/api/admin/sales/inventory-deductions/unified-execute",
  ]) {
    let endpointIndex = page.indexOf(endpoint);
    assert.ok(endpointIndex >= 0, `${endpoint} must remain in the operating UI`);
    while (endpointIndex >= 0) {
      const callStart = page.lastIndexOf("fetchSalesApi(", endpointIndex);
      assert.ok(callStart >= 0 && endpointIndex > callStart, `${endpoint} must use fetchSalesApi`);
      const callEnd = page.indexOf(");", endpointIndex);
      assert.doesNotMatch(page.slice(callStart, callEnd), /actorUsername/);
      endpointIndex = page.indexOf(endpoint, endpointIndex + endpoint.length);
    }
  }

  assert.match(client, /response\.status === 401/);
  assert.match(client, /handleSessionUnauthorized\(response\)/);
  assert.doesNotMatch(client, /status === 403|status === 500|localStorage/);
});

test("cron continues to call shared unified functions without browser routes", () => {
  const cron = read("lib/sales/sales-deduction-cron-shared.ts");
  assert.match(cron, /buildUnifiedInventoryDeductionPreview/);
  assert.match(cron, /executeUnifiedInventoryDeductions/);
  assert.match(cron, /CRON_SECRET/);
  assert.match(cron, /SALES_DEDUCTION_CRON_ACTOR_USERNAME/);
  assert.doesNotMatch(cron, /\/api\/admin\/sales\/inventory-deductions/);
});
