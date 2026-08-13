import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/inventory/logs/page.tsx");
const route = read("app/api/inventory/logs/route.ts");

test("inventory logs initial load uses one page request while delete refresh stays logs-only", () => {
  const effect = page.slice(page.indexOf("// Fetch initial log data once"), page.indexOf("const currentUser"));
  assert.match(page, /fetch\("\/api\/inventory\/logs\?mode=page"/);
  assert.match(effect, /fetchPageData\(\);/);
  assert.doesNotMatch(effect, /fetchLogs\(\)|mode=logs|mode=notes/);
  assert.match(page, /alert\(c\.deleteSuccess\);\s*await fetchLogs\(\);/);
});

test("existing logs, notes, and recent modes remain available", () => {
  assert.match(route, /if \(mode === "logs"\)/);
  assert.match(route, /if \(mode === "notes"\)/);
  assert.match(route, /if \(mode === "recent"\)/);
  assert.match(route, /error: "invalid_item_id"[\s\S]*?status: 400/);
  assert.match(route, /\.eq\("business_date", options\.businessDate\)/);
  assert.match(route, /\.eq\("reason", normalizeInventoryReason\(options\.reason\)\)/);
});

test("page mode runs logs and notes together after authentication", () => {
  const getRoute = route.slice(route.indexOf("export async function GET"));
  const authIndex = getRoute.indexOf("await getAuthenticatedActor()");
  const pageIndex = getRoute.indexOf('if (mode === "page")');
  const readsIndex = getRoute.indexOf("await Promise.all([", pageIndex);
  assert.ok(authIndex >= 0 && pageIndex > authIndex && readsIndex > pageIndex);
  assert.match(
    getRoute.slice(pageIndex, getRoute.indexOf('if (mode === "logs")')),
    /asPageResult\(loadInventoryLogs\(\)\)[\s\S]*?asPageResult\(loadInventoryNotes\(\)\)/
  );
});

test("page mode preserves independent partial results", () => {
  assert.match(route, /return NextResponse\.json\(\{ ok: true, logsResult, notesResult \}\);/);
  assert.match(route, /const asPageResult = async[\s\S]*?catch \(error\)[\s\S]*?ok: false as const/);
  assert.match(page, /if \(result\.logsResult\?\.ok\)[\s\S]*?else \{\s*console\.error\(result\.logsResult\);/);
  assert.match(page, /if \(result\.notesResult\?\.ok\)[\s\S]*?else \{\s*console\.error\(result\.notesResult\);/);
});

test("logs retain Keg enrichment and notes retain their exact projection", () => {
  assert.match(route, /\.filter\(\(log\) => log\.source === "keg_replace"\)/);
  assert.match(route, /fetchPreviousKegSummariesByLogId\([\s\S]*?kegReplaceLogIds/);
  assert.match(route, /previousKegSummary: previousKegSummaryByLogId\.get\(log\.id\)/);
  assert.match(route, /\.select\("id, part, code, item_name, item_name_vi, note"\)/);
});

test("filtering and grouping are memoized without a redundant group sort", () => {
  const memo = page.slice(page.indexOf("const { filteredLogs, visibleGroups } = useMemo"), page.indexOf("type ChangeFieldType"));
  assert.match(memo, /\[logs, filterType, search, partFilter, lang\]/);
  assert.match(memo, /filterType === "all" \|\| log\.action === filterType/);
  assert.match(memo, /partFilter === "all" \|\| log\.part === partFilter/);
  assert.match(memo, /getInventoryLogGroupKey\(log\)/);
  assert.match(memo, /latest: items\[0\]/);
  assert.match(memo, /logs: items/);
  assert.equal((memo.match(/\.sort\(/g) || []).length, 1);
  assert.doesNotMatch(memo, /openGroupKey|inventoryNoteMap/);
});

test("globally sorted group subsequences preserve latest and tie ordering", () => {
  const rows = [
    { id: 1, group: "a", createdAt: null },
    { id: 2, group: "b", createdAt: "2026-08-14T10:00:00Z" },
    { id: 3, group: "a", createdAt: "2026-08-14T10:00:00Z" },
    { id: 4, group: "a", createdAt: "2026-08-14T10:00:00Z" },
    { id: 5, group: "b", createdAt: null },
  ];
  const time = (value: string | null) => value ? new Date(value).getTime() : 0;
  const globallySorted = [...rows].sort((a, b) => time(b.createdAt) - time(a.createdAt));
  const groups = new Map<string, typeof rows>();
  globallySorted.forEach((row) => groups.set(row.group, [...(groups.get(row.group) || []), row]));

  for (const items of groups.values()) {
    const oldGroupSort = [...items].sort((a, b) => time(b.createdAt) - time(a.createdAt));
    assert.deepEqual(items.map((row) => row.id), oldGroupSort.map((row) => row.id));
    assert.equal(items[0]?.id, oldGroupSort[0]?.id);
  }
});
