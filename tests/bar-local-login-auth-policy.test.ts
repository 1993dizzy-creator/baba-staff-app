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

test("BAR APIs identify the local login actor without baba_session", () => {
  const auth = read("lib/bar/server-auth.ts");
  const client = read("lib/bar/client-auth.ts");

  assert.doesNotMatch(auth, /readServerSession|baba_session/);
  assert.match(client, /localStorage\.getItem\("baba_user"\)/);
  assert.match(client, /x-baba-actor-id/);
  assert.match(client, /x-baba-actor-username/);
  assert.match(auth, /\.eq\("id", actorIdValue\)/);
  assert.match(auth, /\.eq\("username", actorUsername\)/);
  assert.match(auth, /data\.is_active !== true/);

  for (const path of routeFiles) {
    const route = read(path);
    assert.match(route, /getBarServerActor\(request\)/, `${path} must verify the request actor`);
    assert.doesNotMatch(route, /getBarServerActor\(\)/, `${path} must not use cookie-only auth`);
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
  assert.match(auth, /name: data\.name \|\| data\.full_name \|\| data\.username/);
  assert.match(actions, /p_actor_user_id:actor\.id/);
  assert.match(zone, /p_actor_user_id: actor\.id/);
  assert.match(zone, /p_actor_name: actor\.name/);
});
