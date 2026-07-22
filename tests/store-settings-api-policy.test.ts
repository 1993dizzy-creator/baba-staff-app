import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/admin/store-settings/route.ts");
const server = read("lib/store-settings/server.ts");
const types = read("lib/store-settings/types.ts");
const page = read("app/(protected)/admin/settings/store/page.tsx");
const login = read("app/api/login/route.ts");
const logout = read("app/api/logout/route.ts");
const session = read("lib/auth/server-session.ts");
const token = read("lib/auth/session-token.ts");
const sessionRoute = read("app/api/session/route.ts");
const commonAuth = read("lib/auth/server-auth.ts");
const barAuth = read("lib/bar/server-auth.ts");

test("store settings actor comes only from the HttpOnly server session", () => {
  assert.match(server, /readServerSession\(\)/);
  assert.match(server, /\.eq\("id", session\.uid\)/);
  assert.doesNotMatch(route, /actorUserId|actorUsername|p_actor_user_id:\s*body/);
  assert.match(route, /p_actor_user_id: auth\.actor\.id/);
});

test("owner and master mutate while manager and leader are read-only", () => {
  assert.match(server, /\["owner", "master", "manager", "leader"\]/);
  assert.match(server, /\["owner", "master"\]\.includes\(actor\.role\)/);
  assert.match(route, /if \(!canMutateStoreSettings\(auth\.actor\)\).*403/);
});

test("request contracts reject unexpected fields and use no-store reads", () => {
  assert.match(route, /Object\.keys\(body\)\.some\(\(key\) => !allowedKeys\.has\(key\)\)/);
  assert.match(route, /"Cache-Control": "no-store"/);
});

test("empty database bootstraps through fallback revision zero", () => {
  assert.match(server, /revision: 0/);
  assert.match(server, /fallbackUsed: true/);
  assert.match(page, /expectedRevision:data\.overview\.latestRevision/);
  assert.match(page, /data\.capabilities\.mutate&&!data\.overview\.scheduled/);
});

test("fallback and reservation form share the all-week 16:00 default policy", () => {
  assert.match(types, /Array\.from\(\{ length: 7 \}, \(_, weekday\)/);
  assert.match(types, /openTime: "16:00"/);
  assert.match(types, /closeTime: "01:00"/);
  assert.match(server, /hours: DEFAULT_STORE_HOURS/);
  assert.match(page, /useState<StoreBusinessHour\[\]>\(DEFAULT_STORE_HOURS\.map/);
  assert.match(page, /const defaults=DEFAULT_STORE_HOURS\[h\.weekday\]/);
  assert.match(page, /summaryWeekdayLabel\(group,lang\)/);
  assert.match(page, /weekday===0\?"#dc2626":weekday===6\?"#2563eb"/);
  assert.match(page, /expectedRevision:data\.overview\.latestRevision/);
});

test("login issues and logout clears the shared HttpOnly session", () => {
  assert.match(login, /setServerSessionCookie\(response, data\.id\)/);
  assert.match(logout, /clearServerSessionCookie\(response\)/);
  assert.match(session, /BABA_SESSION_COOKIE = "baba_session"/);
  assert.match(session, /httpOnly: true/);
  assert.match(session, /sameSite: "lax"/);
  assert.match(session, /path: "\/"/);
  assert.match(session, /secure: process\.env\.NODE_ENV === "production"/);
  assert.match(token, /BABA_SESSION_IDLE_SECONDS = 60 \* 60 \* 24 \* 30/);
  assert.match(token, /BABA_SESSION_ABSOLUTE_SECONDS = 60 \* 60 \* 24 \* 180/);
  assert.match(session, /if \(!isServerSessionConfigured\(\)\)/);
  assert.match(session, /createServerSessionPayload\(userId, now\)/);
  assert.match(session, /setServerSessionPayloadCookie\(response, payload, now\)/);
  assert.match(sessionRoute, /refreshServerSessionCookie\(response, auth\.session\)/);
  assert.match(commonAuth, /\.eq\("id", session\.uid\)/);
  assert.match(commonAuth, /data\.is_active !== true/);
  assert.match(session, /sessionCookieOptions\(0\)/);
  assert.match(page, /requireFreshServerSession\(res\)/);
  assert.doesNotMatch(barAuth, /readServerSession|baba_session/);
});
