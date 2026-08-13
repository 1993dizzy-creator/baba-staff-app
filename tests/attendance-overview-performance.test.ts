import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const page = readFileSync(
  join(process.cwd(), "app/(protected)/admin/payroll/attendance/page.tsx"),
  "utf8",
);

test("monthly users and records requests start together and preserve all-or-nothing validation", () => {
  const fetcher = page.slice(
    page.indexOf("const fetchMonthlyOverview"),
    page.indexOf("useEffect(() =>", page.indexOf("const fetchMonthlyOverview")),
  );

  assert.match(fetcher, /const \[userRes, recordRes\] = await Promise\.all\(\[/);
  assert.match(fetcher, /attendance\/users\?mode=month&month=/);
  assert.match(fetcher, /attendance\/records\?scope=admin_overview&month=/);
  assert.match(fetcher, /const \[userResult, recordResult\] = await Promise\.all\(\[/);
  assert.ok(fetcher.indexOf("if (!userRes.ok") < fetcher.indexOf("setUsers("));
  assert.ok(fetcher.indexOf("if (!recordRes.ok") < fetcher.indexOf("setUsers("));
});

test("unresolved records load on entry only while monthly overview follows month changes", () => {
  const effects = page.slice(
    page.indexOf("useEffect(() =>", page.indexOf("const fetchMonthlyOverview")),
    page.indexOf("const handleAutoCorrect"),
  );

  assert.match(effects, /void fetchUnresolvedOpenRecords\(\);[\s\S]*?\}, \[fetchUnresolvedOpenRecords\]\);/);
  assert.match(effects, /void fetchMonthlyOverview\(\);[\s\S]*?\}, \[fetchMonthlyOverview\]\);/);
  assert.doesNotMatch(page, /attendance\/admin\?lang=/);
});

test("stale monthly responses cannot replace current state or clear its loading state", () => {
  assert.match(page, /const requestId = \+\+monthlyOverviewRequestRef\.current/);
  assert.match(page, /if \(requestId !== monthlyOverviewRequestRef\.current\) return/);
  assert.match(page, /if \(requestId === monthlyOverviewRequestRef\.current\) \{[\s\S]*?setIsLoading\(false\)/);
  assert.match(page, /return \(\) => \{[\s\S]*?monthlyOverviewRequestRef\.current \+= 1/);
});

test("unresolved mutations retain local removal and monthly refresh semantics", () => {
  const autoCorrect = page.slice(page.indexOf("const handleAutoCorrect"), page.indexOf("const handleDeleteOrphan"));
  const orphanDelete = page.slice(page.indexOf("const handleDeleteOrphan"), page.indexOf("const recordsByUser"));

  assert.match(autoCorrect, /setUnresolvedOpenRecords\([\s\S]*?filter\([\s\S]*?await fetchMonthlyOverview\(\)/);
  assert.match(orphanDelete, /setUnresolvedOpenRecords\([\s\S]*?filter/);
});
