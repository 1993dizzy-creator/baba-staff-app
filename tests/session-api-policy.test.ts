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

test("session refresher rejects expired sessions without the legacy me fallback", () => {
  const refresher = read("components/UserSessionRefresher.tsx");
  const client = read("lib/auth/client-session.ts");

  assert.match(refresher, /fetch\("\/api\/session"/);
  assert.match(refresher, /sessionResponse\.status === 401/);
  assert.match(refresher, /handleSessionUnauthorized\(sessionResponse\)/);
  assert.doesNotMatch(refresher, /\/api\/me/);
  assert.match(refresher, /\.\.\.cachedUser,[\s\S]*\.\.\.sessionResult\.user/);
  assert.match(client, /let handlingUnauthorized = false/);
  assert.match(client, /response\.status !== 401 \|\| handlingUnauthorized/);
  assert.match(client, /localStorage\.removeItem\("baba_user"\)/);
});

test("common 401 foundation deduplicates handling and preserves a return path", () => {
  const client = read("lib/auth/client-session.ts");
  assert.match(client, /handlingUnauthorized/);
  assert.match(client, /response\.status !== 401/);
  assert.match(client, /saveAttendanceReturnPath\(window\.sessionStorage, returnPath\)/);
  assert.match(client, /localStorage\.removeItem\("baba_user"\)/);
  assert.match(client, /window\.dispatchEvent/);
  assert.match(client, /window\.location\.replace\("\/login"\)/);
});

test("me API is a no-store, cookie-only self endpoint with minimal fields", () => {
  const route = read("app/api/me/route.ts");
  const auth = read("lib/auth/server-auth.ts");

  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /getAuthenticatedActor\(\)/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.match(route, /authenticated: true/);
  assert.match(route, /user: auth\.actor/);
  assert.doesNotMatch(route, /searchParams|req\.json|username\?|id\?|supabaseServer/);
  assert.doesNotMatch(
    route,
    /full_name|birth_date|hire_date|gender|work_start_time|work_end_time|is_active/
  );

  assert.match(auth, /\.eq\("id", session\.uid\)/);
  assert.match(auth, /data\.is_active !== true/);
  assert.match(
    auth,
    /actor:\s*\{[\s\S]*id,[\s\S]*username:[\s\S]*name:[\s\S]*role:[\s\S]*part:[\s\S]*position:/
  );
});

test("me API returns 405 for POST and never exposes database error details", () => {
  const route = read("app/api/me/route.ts");

  assert.match(route, /export async function POST\(\)/);
  assert.match(route, /status: 405/);
  assert.match(route, /Allow: "GET"/);
  assert.match(route, /code: "ME_CHECK_FAILED"/);
  assert.doesNotMatch(route, /error\.message|Failed to fetch user|Postgres|service-role/);
});

test("session refresher preserves cached state on server and network errors", () => {
  const refresher = read("components/UserSessionRefresher.tsx");
  const unauthorizedIndex = refresher.indexOf("sessionResponse.status === 401");
  const errorResponseIndex = refresher.indexOf("!sessionResponse.ok");
  const catchIndex = refresher.indexOf("} catch (error)");

  assert.ok(unauthorizedIndex >= 0);
  assert.ok(errorResponseIndex > unauthorizedIndex);
  assert.ok(catchIndex > errorResponseIndex);
  assert.doesNotMatch(
    refresher.slice(errorResponseIndex),
    /localStorage\.removeItem|window\.location|handleSessionUnauthorized/
  );
});
