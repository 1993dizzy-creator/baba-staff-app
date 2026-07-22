import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("session API authenticates only the signed cookie actor and returns minimal data", () => {
  const route = read("app/api/session/route.ts");
  const auth = read("lib/auth/server-auth.ts");

  assert.match(route, /getAuthenticatedActor\(\)/);
  assert.match(route, /refreshServerSessionCookie\(response, auth\.session\)/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(route, /searchParams|req\.json|user_id|username\s*:/);
  assert.match(auth, /readServerSession\(\)/);
  assert.match(auth, /\.eq\("id", session\.uid\)/);
  assert.match(auth, /data\.is_active !== true/);
  assert.doesNotMatch(auth, /localStorage|x-baba-actor|actorUsername/);
});

test("transitional client migrates valid cookies without blocking legacy attendance", () => {
  const refresher = read("components/UserSessionRefresher.tsx");
  assert.match(refresher, /fetch\("\/api\/session"/);
  assert.match(refresher, /sessionResponse\.status === 401/);
  assert.match(refresher, /`\/api\/me\?username=/);
  assert.match(refresher, /\.\.\.cachedUser,[\s\S]*\.\.\.result\.user/);
});

test("common 401 foundation deduplicates handling and preserves a return path", () => {
  const client = read("lib/auth/client-session.ts");
  assert.match(client, /handlingUnauthorized/);
  assert.match(client, /response\.status !== 401/);
  assert.match(client, /sessionStorage\.setItem\(BABA_SESSION_RETURN_PATH_KEY/);
  assert.match(client, /localStorage\.removeItem\("baba_user"\)/);
  assert.match(client, /window\.dispatchEvent/);
  assert.match(client, /window\.location\.replace\("\/login"\)/);
});
