import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { compareAttendanceShadow, summarizeAttendanceShadow } from "../lib/attendance/shadow.ts";
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
    autoCloseAt: false,
  });

  const status = row(match.legacy, { status: "early_leave" });
  assert.equal(status.differences.status, true);
  const early = row(match.legacy, { earlyLeaveMinutes: 61 });
  assert.equal(early.differences.earlyLeaveMinutes, true);
  const unresolved = row(match.legacy, { unresolved: true });
  assert.equal(unresolved.differences.unresolved, true);
  const autoClose = row(
    { ...match.legacy, autoCloseAt: "2026-07-24T18:00:00.000Z" },
    { effectiveStoreCloseAt: "2026-07-24T16:00:00.000Z" }
  );
  assert.equal(autoClose.differences.autoCloseAt, true);

  assert.deepEqual(summarizeAttendanceShadow([match, status, early]), {
    total: 3,
    matched: 1,
    mismatched: 2,
    statusChanged: 1,
    lateChanged: 0,
    earlyLeaveChanged: 1,
    unresolvedChanged: 0,
    autoCloseChanged: 0,
  });
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
  assert.match(route, /getStoreBusinessDayOverride\(businessDate\)/);
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
