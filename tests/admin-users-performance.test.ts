import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node's native TypeScript test runner requires the source extension.
import { selectEmployeeLevelProgramVersionsForDates } from "../lib/employee-level/version-selection.ts";

const page = readFileSync("app/(protected)/admin/users/page.tsx", "utf8");
const route = readFileSync("app/api/admin/users/route.ts", "utf8");
const server = readFileSync("lib/employee-level/server.ts", "utf8");

const row = (overrides: Record<string, unknown>) => ({
  id: 1,
  user_id: 10,
  enabled: true,
  effective_from: "2026-08-01",
  effective_to: null,
  base_date: "2026-08-01",
  base_date_mode: "hire_date",
  revision: 1,
  ...overrides,
});

test("admin users fetch is independent of translated load errors", () => {
  assert.match(page, /const loadFailedTextRef = useRef\(text\.loadFailed\)/);
  assert.match(page, /loadFailedTextRef\.current = text\.loadFailed/);
  assert.match(page, /\}, \[canAccess, checked\]\);/);
  assert.doesNotMatch(page, /\[canAccess, checked, text\.loadFailed\]/);
  assert.match(page, /if \(!cancelled\) \{[\s\S]*?setUsers/);
  assert.match(page, /return \(\) => \{\s*cancelled = true;/);
  assert.match(page, /setUsers\(\(current\) =>[\s\S]*?result\.user/);
});

test("admin users GET uses one multi-date level query (unscoped prefetch variant) alongside meal eligibility, both started in parallel with the users query", () => {
  // Parallel-prefetch optimization: GET no longer waits for users/userIds
  // before starting the level-versions read — see
  // admin-users-parallel-prefetch.test.ts for full dependency-graph
  // coverage of that change. This test only re-confirms which loader
  // variant is used and that the date-bound semantics in server.ts are
  // unchanged.
  assert.match(route, /loadEmployeeLevelProgramVersionsForDatesUnscoped\(\[today, nextDate\]\)/);
  const getHandler = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PATCH"));
  assert.doesNotMatch(getHandler, /loadEmployeeLevelProgramVersions\(userIds/);
  assert.doesNotMatch(getHandler, /loadEmployeeLevelProgramVersionsForDates\(userIds/);
  assert.match(server, /\.lte\("effective_from", maxDate\)/);
  assert.match(server, /effective_to\.is\.null,effective_to\.gt\.\$\{minDate\}/);
});

test("multi-date selection preserves half-open dates, revisions and users", () => {
  const selected = selectEmployeeLevelProgramVersionsForDates(
    [
      row({ id: 1, revision: 1, effective_to: "2026-09-01" }),
      row({ id: 2, revision: 2, effective_from: "2026-09-01" }),
      row({ id: 3, revision: 3, effective_from: "2026-08-20", effective_to: "2026-08-25" }),
      row({ id: 4, user_id: 20, revision: 1, effective_from: "2026-09-02" }),
      row({ id: 5, user_id: 30, revision: 1, effective_from: "2026-08-13" }),
      row({ id: 6, user_id: 30, revision: 4, effective_from: "2026-08-13" }),
      row({ id: 7, user_id: 40, effective_to: "2026-09-01" }),
      row({ id: 8, user_id: 50, effective_from: "2026-09-01" }),
    ],
    ["2026-08-13", "2026-09-01"],
  );

  assert.equal(selected.get("2026-08-13")?.get(10)?.id, 1);
  assert.equal(selected.get("2026-09-01")?.get(10)?.id, 2);
  assert.equal(selected.get("2026-08-13")?.has(20), false);
  assert.equal(selected.get("2026-09-01")?.has(20), false);
  assert.equal(selected.get("2026-08-13")?.get(30)?.id, 6);
  assert.equal(selected.get("2026-09-01")?.get(30)?.id, 6);
  assert.equal(selected.get("2026-08-13")?.get(40)?.id, 7);
  assert.equal(selected.get("2026-09-01")?.has(40), false);
  assert.equal(selected.get("2026-08-13")?.has(50), false);
  assert.equal(selected.get("2026-09-01")?.get(50)?.id, 8);
  assert.equal(selected.get("2026-08-13")?.has(999), false);
});
