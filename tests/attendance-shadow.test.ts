import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { compareAttendanceShadow, resolveDisplayStatus, summarizeAttendanceShadow } from "../lib/attendance/shadow.ts";
import type { AttendancePolicyResult } from "../lib/attendance/policy-engine.ts";

const read = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8");

const configured: AttendancePolicyResult = {
  businessDate: "2026-07-24",
  rawLateMinutes: 0,
  lateMinutes: 0,
  rawEarlyLeaveMinutes: 0,
  earlyLeaveMinutes: 0,
  status: "done",
  scheduledStartAt: null,
  scheduledEndAt: null,
  normalCheckoutThresholdAt: null,
  earlyLeaveThresholdAt: null,
  scheduledStoreCloseAt: "2026-07-24T18:00:00.000Z",
  overrideCloseAt: null,
  effectiveStoreCloseAt: "2026-07-24T18:00:00.000Z",
  unresolvedAt: "2026-07-24T19:00:00.000Z",
  unresolved: false,
  source: { settingsRevision: 3, close: "configured" },
};

function row(
  legacy: Parameters<typeof compareAttendanceShadow>[0]["legacy"],
  patch: Partial<AttendancePolicyResult> = {}
) {
  return compareAttendanceShadow({
    recordId: 1,
    userId: 2,
    userName: "Tester",
    businessDate: "2026-07-24",
    legacy,
    configured: { ...configured, ...patch },
  });
}

test("shadow reports matches and each independent difference", () => {
  const match = row({
    status: "done",
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    unresolved: false,
    autoCloseAt: null,
  });
  assert.deepEqual(match.differences, {
    status: false,
    lateMinutes: false,
    earlyLeaveMinutes: false,
    unresolved: false,
    unresolvedAt: false,
    autoCloseAt: false,
  });

  const status = row(match.legacy, { status: "early_leave" });
  assert.equal(status.differences.status, true);
  const early = row(match.legacy, { earlyLeaveMinutes: 61 });
  assert.equal(early.differences.earlyLeaveMinutes, true);
  const unresolved = row(match.legacy, { unresolved: true });
  assert.equal(unresolved.differences.unresolved, false);
  const unresolvedAt = compareAttendanceShadow({
    recordId: 2,
    userId: 2,
    userName: "Tester",
    businessDate: "2026-07-24",
    checkInAt: "2026-07-24T09:00:00.000Z",
    checkOutAt: null,
    legacy: {
      ...match.legacy,
      unresolvedAt: "2026-07-24T18:00:00.000Z",
      autoCloseAt: "2026-07-24T18:00:00.000Z",
    },
    configured: { ...configured, unresolvedAt: "2026-07-24T19:00:00.000Z" },
  });
  assert.equal(unresolvedAt.differences.unresolvedAt, true);
  assert.equal(unresolvedAt.differences.autoCloseAt, true);

  const manualLate = compareAttendanceShadow({
    recordId: 3,
    userId: 2,
    userName: "Tester",
    businessDate: "2026-07-24",
    checkInAt: "2026-07-24T09:00:00.000Z",
    checkOutAt: "2026-07-24T18:00:00.000Z",
    legacy: { ...match.legacy, status: "done", lateMinutes: 0 },
    configured: { ...configured, status: "late", lateMinutes: 6, earlyLeaveMinutes: 10 },
    manualLateNormalization: true,
  });
  assert.equal(manualLate.metricComparison.late.comparisonStatus, "excluded");
  assert.equal(manualLate.differences.lateMinutes, false);
  assert.equal(manualLate.differences.earlyLeaveMinutes, true);
  assert.equal(
    summarizeAttendanceShadow([manualLate]).manualLateExcluded,
    1
  );
  // manually-normalized late is excluded from the metric count, so the only
  // real change is early leave — status differs too but is folded in, not
  // double counted.
  assert.deepEqual(manualLate.summary, {
    primaryDifference: "early_leave",
    changedFieldCount: 1,
  });

  const summary = summarizeAttendanceShadow([match, status, early]);
  assert.equal(summary.total, 3);
  assert.equal(summary.matched, 1);
  assert.equal(summary.mismatched, 2);
  assert.equal(summary.statusChanged, 1);
  assert.equal(summary.earlyLeaveChanged, 1);
});

test("row summary picks a single primaryDifference without double-counting status", () => {
  const base = {
    status: "done",
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    unresolved: false,
    autoCloseAt: null,
  };

  const noDifference = row(base);
  assert.deepEqual(noDifference.summary, {
    primaryDifference: null,
    changedFieldCount: 0,
  });

  const lateOnly = row(base, { status: "late", lateMinutes: 7 });
  assert.deepEqual(lateOnly.summary, {
    primaryDifference: "late",
    changedFieldCount: 1,
  });

  const earlyOnly = row(base, { status: "early_leave", earlyLeaveMinutes: 15 });
  assert.deepEqual(earlyOnly.summary, {
    primaryDifference: "early_leave",
    changedFieldCount: 1,
  });

  const unresolvedOnly = compareAttendanceShadow({
    recordId: 4,
    userId: 2,
    userName: "Tester",
    businessDate: "2026-07-24",
    checkInAt: "2026-07-24T09:00:00.000Z",
    checkOutAt: null,
    legacy: { ...base, status: "working" },
    configured: { ...configured, status: "working", unresolved: true },
  });
  assert.deepEqual(unresolvedOnly.summary, {
    primaryDifference: "unresolved",
    changedFieldCount: 1,
  });

  // status differs but none of the three underlying metrics do — a rare
  // edge case, still surfaced as its own dimension rather than dropped.
  const statusOnly = row(base, { status: "working" });
  assert.deepEqual(statusOnly.summary, {
    primaryDifference: "status",
    changedFieldCount: 1,
  });

  // two metrics differ at once — "multiple", counting each changed metric
  // plus status (which also necessarily differs here).
  const multiple = row(base, {
    status: "early_leave",
    lateMinutes: 10,
    earlyLeaveMinutes: 15,
  });
  assert.deepEqual(multiple.summary, {
    primaryDifference: "multiple",
    changedFieldCount: 3,
  });
});

test("resolveDisplayStatus folds unresolved and combined late+early-leave into user-facing buckets", () => {
  assert.equal(
    resolveDisplayStatus({ status: "done", lateMinutes: 0, earlyLeaveMinutes: 0, unresolved: false }),
    "done"
  );
  assert.equal(
    resolveDisplayStatus({ status: "late", lateMinutes: 7, earlyLeaveMinutes: 0, unresolved: false }),
    "late"
  );
  assert.equal(
    resolveDisplayStatus({ status: "early_leave", lateMinutes: 0, earlyLeaveMinutes: 12, unresolved: false }),
    "early_leave"
  );
  assert.equal(
    resolveDisplayStatus({ status: "early_leave", lateMinutes: 5, earlyLeaveMinutes: 12, unresolved: false }),
    "late_and_early_leave"
  );
  assert.equal(
    resolveDisplayStatus({ status: "working", lateMinutes: 0, earlyLeaveMinutes: 0, unresolved: true }),
    "unresolved"
  );
  assert.equal(
    resolveDisplayStatus({ status: "working", lateMinutes: 0, earlyLeaveMinutes: 0, unresolved: false }),
    "working"
  );
  assert.equal(
    resolveDisplayStatus({ status: "leave", lateMinutes: 0, earlyLeaveMinutes: 0, unresolved: false }),
    "leave"
  );
  // unresolved overlay wins even if status also happens to look late/early.
  assert.equal(
    resolveDisplayStatus({ status: "late", lateMinutes: 7, earlyLeaveMinutes: 0, unresolved: true }),
    "unresolved"
  );
});

test("shadow route is read-only and uses the server session actor", () => {
  const route = read(
    "app/api/admin/store-settings/attendance-shadow/route.ts"
  );
  assert.match(route, /getStoreSettingsActor\(\)/);
  assert.match(route, /canMutateStoreSettings\(auth\.actor\)/);
  assert.doesNotMatch(route, /\.(insert|update|delete|upsert)\s*\(/);
  assert.doesNotMatch(route, /actor[_A-Z]?id.*body/i);
});

test("shadow supports special-close lookup and migration security", () => {
  const route = read(
    "app/api/admin/store-settings/attendance-shadow/route.ts"
  );
  const migration = read(
    "supabase/migrations/202607240001_create_attendance_policy_shadow_foundation.sql"
  );
  assert.match(route, /store_business_day_overrides/);
  for (const table of [
    "store_attendance_policies",
    "store_business_day_overrides",
    "attendance_record_audit_logs",
  ]) {
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security`, "i")
    );
    assert.match(
      migration,
      new RegExp(
        `revoke all on table public\\.${table}[\\s\\S]*?from public, anon, authenticated`,
        "i"
      )
    );
  }
  assert.match(
    migration,
    /where state = 'active'[\s\S]*store_business_day_overrides_active_date_unique|store_business_day_overrides_active_date_unique[\s\S]*where state = 'active'/i
  );
});
