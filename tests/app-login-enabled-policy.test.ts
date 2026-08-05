import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("login API requires an active, credential-matching, login-enabled account", () => {
  const route = read("app/api/login/route.ts");
  assert.match(route, /\.eq\("username", username\)/);
  assert.match(route, /\.eq\("password", password\)/);
  assert.match(route, /\.eq\("is_active", true\)/);
  assert.match(route, /\.eq\("app_login_enabled", true\)/);
  // app_login_enabled 필터가 is_active와 같은 조회 체인에 있어야 자격 오류와 동일하게
  // 처리되고 계정 존재 여부가 노출되지 않는다.
  const isActiveIndex = route.indexOf('.eq("is_active", true)');
  const appLoginIndex = route.indexOf('.eq("app_login_enabled", true)');
  const maybeSingleIndex = route.indexOf(".maybeSingle()");
  assert.ok(isActiveIndex >= 0 && appLoginIndex > isActiveIndex && maybeSingleIndex > appLoginIndex);
});

test("server session re-verification rechecks app_login_enabled on every request and returns RELOGIN_REQUIRED", () => {
  const auth = read("lib/auth/server-auth.ts");
  assert.match(auth, /\.eq\("id", session\.uid\)/);
  assert.match(auth, /app_login_enabled/);
  assert.match(auth, /data\.is_active !== true \|\| data\.app_login_enabled !== true/);
  assert.match(auth, /status: 401, code: "RELOGIN_REQUIRED"/);
});

test("app_login_enabled is not exposed on the public authenticated-actor shape (me/session responses stay minimal)", () => {
  const auth = read("lib/auth/server-auth.ts");
  const actorTypeStart = auth.indexOf("export type AuthenticatedActor");
  const actorTypeEnd = auth.indexOf("};", actorTypeStart);
  const actorType = auth.slice(actorTypeStart, actorTypeEnd);
  assert.doesNotMatch(actorType, /app_login_enabled/);
});

test("owner/master and other existing accounts keep working via the shared default (true) with no per-role carve-out", () => {
  const auth = read("lib/auth/server-auth.ts");
  assert.doesNotMatch(auth, /role\s*===\s*"owner"[\s\S]*app_login_enabled/);
  assert.doesNotMatch(auth, /is_system_account[\s\S]*app_login_enabled/);
});

test("client 401 handling already forces relogin for any RELOGIN_REQUIRED-style response, so no new client wiring is needed", () => {
  const client = read("lib/auth/client-session.ts");
  assert.match(client, /response\.status !== 401 \|\| handlingUnauthorized/);
  assert.match(client, /window\.location\.replace\("\/login"\)/);
});
