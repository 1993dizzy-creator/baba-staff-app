import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const routeFiles = [
  "app/api/bar/zones/route.ts",
  "app/api/bar/zones/[code]/route.ts",
  "app/api/bar/zones/[code]/photo/route.ts",
  "app/api/bar/staff/route.ts",
  "app/api/bar/logs/route.ts",
  "app/api/bar/keeping-products/route.ts",
  "app/api/bar/keepings/route.ts",
  "app/api/bar/keepings/counts/route.ts",
  "app/api/bar/keepings/zone/[code]/route.ts",
  "app/api/bar/keepings/[id]/route.ts",
  "app/api/bar/keepings/[id]/actions/route.ts",
];

test("BAR APIs identify the actor only from baba_session", () => {
  const auth = read("lib/bar/server-auth.ts");
  const client = read("lib/bar/client-auth.ts");
  const commonAuth = read("lib/auth/server-auth.ts");

  assert.match(auth, /getAuthenticatedActor\(\)/);
  assert.match(commonAuth, /readServerSession\(\)/);
  assert.match(commonAuth, /\.eq\("id", session\.uid\)/);
  assert.match(commonAuth, /data\.is_active !== true/);
  assert.doesNotMatch(auth, /request\.headers|x-baba-actor|actorIdValue|actorUsername/);
  assert.doesNotMatch(client, /localStorage|x-baba-actor|readBarClientActor|barActorHeaders/);
  assert.match(client, /return fetch\(input, init\)/);
  assert.match(client, /handleSessionUnauthorized\(response\)/);

  for (const path of routeFiles) {
    const route = read(path);
    assert.match(route, /getBarServerActor\(\)/, `${path} must verify the server session`);
    assert.doesNotMatch(route, /getBarServerActor\(request\)/, `${path} must not authenticate request headers`);
    assert.doesNotMatch(route, /x-baba-actor/, `${path} must ignore spoofed actor headers`);
  }
});

test("BAR permissions and server-derived audit actors remain in place", () => {
  const permissions = read("lib/bar/permissions.ts");
  const auth = read("lib/bar/server-auth.ts");
  const actions = read("app/api/bar/keepings/[id]/actions/route.ts");
  const zone = read("app/api/bar/zones/[code]/route.ts");

  assert.match(permissions, /canViewBar/);
  assert.match(permissions, /canEditBarZone/);
  assert.match(permissions, /canAssignBarZone/);
  assert.match(permissions, /canManageBarKeeping/);
  assert.match(permissions, /canDeleteBarKeeping/);
  assert.match(auth, /\.\.\.auth\.actor/);
  assert.match(auth, /is_active: true/);
  assert.match(auth, /confirming that the current DB row is active/);
  assert.match(actions, /p_actor_user_id:actor\.id/);
  assert.match(zone, /p_actor_user_id: actor\.id/);
  assert.match(zone, /p_actor_name: actor\.name/);
});

test("BAR permission matrix remains unchanged during session migration", () => {
  const permissions = read("lib/bar/permissions.ts");

  assert.match(permissions, /canViewBar[\s\S]*isActive\(user\)/);
  assert.match(permissions, /canViewBarLogs[\s\S]*isActive\(user\)/);
  assert.match(permissions, /canEditBarZone[\s\S]*isBarRole\(user, \["leader", "staff"\]\)/);
  assert.match(permissions, /canAssignBarZone[\s\S]*isBarRole\(user, \["leader"\]\)/);
  assert.match(permissions, /canManageBarKeeping[\s\S]*isBarRole\(user, \["leader", "staff"\]\)/);
  assert.match(permissions, /canReactivateBarKeeping[\s\S]*isBarRole\(user, \["leader"\]\)/);
  assert.match(permissions, /canDeleteBarKeeping[\s\S]*isOwnerOrMaster\(user\)/);
});

test("BAR client preserves JSON and FormData requests without adding credentials metadata", () => {
  const client = read("lib/bar/client-auth.ts");
  const keepingCreate = read("components/bar/keeping/KeepingForm.tsx");
  const keepingAction = read("components/bar/keeping/KeepingActionModal.tsx");
  const zonePhoto = read("components/bar/BarZoneEditModal.tsx");

  assert.doesNotMatch(client, /Content-Type|credentials:/);
  assert.match(keepingCreate, /new FormData\(\)/);
  assert.match(keepingCreate, /fetchBarApi\("\/api\/bar\/keepings",\{method:"POST",body:form\}\)/);
  assert.match(keepingAction, /method: "POST", body: form/);
  assert.match(zonePhoto, /method: "POST", body: form/);
});
