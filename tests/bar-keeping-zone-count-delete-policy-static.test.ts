import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("zone counts use one active keeping query and zone summaries are bounded thumbnail lists", () => {
  const zones = read("lib/bar/server-data.ts");
  const map = read("components/bar/BarZoneMap.tsx");
  const route = read("app/api/bar/keepings/zone/[code]/route.ts");
  const summary = read("components/bar/keeping/ZoneKeepingSummary.tsx");
  assert.match(zones, /from\("bar_keepings"\)\.select\("zone_code"\)\.eq\("status", "active"\)/);
  assert.match(route, /thumbnail_path/);
  assert.doesNotMatch(route, /image_path/);
  assert.match(route, /limit\(50\)/);
  assert.match(summary, /maxHeight: 198/);
  assert.match(summary, /overscrollBehavior: "contain"/);
  assert.match(map, /activeKeepingCount > 0 \? <g aria-label=\{countLabel\}/);
  assert.match(map, /activeKeepingCount > 99 \? 40 : 34/);
  assert.match(map, /activeKeepingCount > 0 \? `, \$\{countLabel\}` : ""/);
});

test("status tabs use unfiltered exact counts instead of page row lengths", () => {
  const counts = read("app/api/bar/keepings/counts/route.ts");
  const page = read("app/(protected)/bar/keeping/page.tsx");
  assert.equal((counts.match(/head: true/g) ?? []).length, 2);
  assert.match(counts, /eq\("status", "active"\)/);
  assert.match(counts, /eq\("status", "closed"\)/);
  assert.doesNotMatch(counts, /customer_name|image_path|thumbnail_path/);
  assert.match(page, /fetchBarApi\("\/api\/bar\/keepings\/counts"/);
  assert.match(page, /보관 중 키핑 \$\{counts\.active\}건/);
  assert.match(page, /종료 키핑 \$\{counts\.closed\}건/);
  assert.match(page, /aria-hidden="true"/);
});

test("inventory keepings expose only localized names and preserve external snapshots", () => {
  const server = read("lib/bar/keeping-server.ts");
  const types = read("lib/bar/keeping-types.ts");
  assert.match(server, /select\("id,item_name,item_name_vi"\)/);
  assert.match(types, /item\.liquorSource === "inventory"/);
  assert.match(types, /: item\.liquorName;/);
});

test("delete is owner or master only, versioned, supports active and closed, and cleans storage after RPC", () => {
  const permissions = read("lib/bar/permissions.ts");
  const route = read("app/api/bar/keepings/[id]/route.ts");
  const auth = read("lib/bar/server-auth.ts");
  const migration = read("supabase/migrations/202607180003_delete_bar_keeping_v2.sql");
  assert.match(permissions, /canDeleteBarKeeping/);
  assert.match(permissions, /isOwnerOrMaster/);
  assert.match(route, /canDeleteBarKeeping\(actor\)/);
  assert.match(route, /p_actor_user_id:actor\.id/);
  assert.doesNotMatch(route, /body\.actor|searchParams.*actor/);
  assert.doesNotMatch(auth, /readServerSession|baba_session/);
  assert.match(auth, /request\.headers\.get\("x-baba-actor-id"\)/);
  assert.match(auth, /request\.headers\.get\("x-baba-actor-username"\)/);
  assert.match(auth, /\.eq\("id", actorIdValue\)/);
  assert.match(auth, /\.eq\("username", actorUsername\)/);
  assert.match(auth, /data\.is_active !== true/);
  assert.match(route, /bar_delete_keeping_v2/);
  assert.ok(route.indexOf("bar_delete_keeping_v2") < route.indexOf("KEEPING_DELETE_STORAGE_CLEANUP"));
  assert.match(migration, /v_old\.version <> p_expected_version/);
  assert.match(migration, /v_old\.status not in \('active', 'closed'\)/);
  assert.match(migration, /u\.role::text/);
  assert.match(migration, /'#' \|\| u\.id::text/);
  assert.match(migration, /keeping_deleted/);
  assert.match(migration, /from public, anon, authenticated/);
  assert.match(migration, /to service_role/);
});

test("deleted keeping logs remain visible without a dead detail link or private snapshots", () => {
  const entry = read("components/bar/BarLogEntry.tsx");
  const formatter = read("lib/bar/log-format.ts");
  const logs = read("app/api/bar/logs/route.ts");
  const migration = read("supabase/migrations/202607180003_delete_bar_keeping_v2.sql");
  assert.match(entry, /actionType === "keeping_deleted"/);
  assert.match(entry, /&& !isDeletedKeeping \? <Link/);
  assert.match(formatter, /keeping_deleted:`\$\{prefix\}키핑을 삭제했습니다\.`/);
  assert.match(formatter, /keeping_deleted:`Đã xóa rượu giữ\$\{suffix\}\.`/);
  assert.match(logs, /"inventory_item_id", "status", "version"/);
  assert.match(logs, /KEEPING_LOG_ACTIONS[\s\S]*"keeping_deleted"/);
  assert.doesNotMatch(migration, /customer_name|customer_contact|customer_identifier|note/);
  assert.ok(migration.indexOf("delete from public.bar_keepings") < migration.indexOf("insert into public.bar_activity_logs"));
});
