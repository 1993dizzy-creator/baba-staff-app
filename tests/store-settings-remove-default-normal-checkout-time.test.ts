import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  const absolute = join(process.cwd(), dir);
  for (const entry of readdirSync(absolute)) {
    const relative = `${dir}/${entry}`;
    const full = join(absolute, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      collectSourceFiles(relative, out);
    } else if ([".ts", ".tsx"].includes(extname(entry))) {
      out.push(relative);
    }
  }
  return out;
}

const MIGRATION_PATH = "supabase/migrations/202608070005_remove_default_normal_checkout_time.sql";
const migration = read(MIGRATION_PATH);

const typesFile = read("lib/store-settings/types.ts");
const attendanceServer = read("lib/store-settings/attendance-server.ts");
const settingsRoute = read("app/api/admin/store-settings/route.ts");
const settingsPage = read("app/(protected)/admin/settings/store/page.tsx");
const policyEngine = read("lib/attendance/policy-engine.ts");

// ---------------------------------------------------------------------------
// 1. application runtime 코드(app/lib/components)에서 완전히 사라졌는지.
// ---------------------------------------------------------------------------

test("default_normal_checkout_time / defaultNormalCheckoutTime / p_default_normal_checkout_time are gone from every app/lib/components source file", () => {
  const pattern = /default_normal_checkout_time|defaultNormalCheckoutTime|p_default_normal_checkout_time/i;
  const offenders: string[] = [];
  for (const dir of ["app", "lib", "components"]) {
    for (const file of collectSourceFiles(dir)) {
      if (pattern.test(read(file))) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

test("StoreAttendancePolicy type and its default carry exactly the 3 real grace fields — no defaultNormalCheckoutTime", () => {
  assert.match(
    typesFile,
    /export type StoreAttendancePolicy = \{\s*lateGraceMinutes: number;\s*earlyLeaveGraceMinutes: number;\s*missingCheckoutGraceMinutes: number;\s*\};/,
  );
  assert.match(
    typesFile,
    /export const DEFAULT_STORE_ATTENDANCE_POLICY: StoreAttendancePolicy = \{\s*lateGraceMinutes: 0,\s*earlyLeaveGraceMinutes: 0,\s*missingCheckoutGraceMinutes: 60,\s*\};/,
  );
  assert.doesNotMatch(typesFile, /defaultNormalCheckoutTime/);
});

test("attendance-server.ts no longer selects or maps default_normal_checkout_time, but still reads the 3 real grace columns", () => {
  assert.doesNotMatch(attendanceServer, /default_normal_checkout_time/);
  assert.match(attendanceServer, /late_grace_minutes,early_leave_grace_minutes,missing_checkout_grace_minutes/);
});

test("store-settings POST route no longer validates or forwards defaultNormalCheckoutTime, but still validates and forwards the 3 real grace fields", () => {
  assert.doesNotMatch(settingsRoute, /defaultNormalCheckoutTime/);
  assert.doesNotMatch(settingsRoute, /p_default_normal_checkout_time/);
  assert.match(settingsRoute, /attendancePolicy\.lateGraceMinutes/);
  assert.match(settingsRoute, /attendancePolicy\.earlyLeaveGraceMinutes/);
  assert.match(settingsRoute, /attendancePolicy\.missingCheckoutGraceMinutes/);
  assert.match(settingsRoute, /p_late_grace_minutes: attendancePolicy\.lateGraceMinutes/);
  assert.match(settingsRoute, /p_early_leave_grace_minutes: attendancePolicy\.earlyLeaveGraceMinutes/);
  assert.match(settingsRoute, /p_missing_checkout_grace_minutes:\s*\n\s*attendancePolicy\.missingCheckoutGraceMinutes/);
});

test("store settings page no longer carries defaultNormalCheckoutTime in the Shadow response type or the save() payload, and still preserves the 3 real grace fields", () => {
  assert.doesNotMatch(settingsPage, /defaultNormalCheckoutTime/);
  assert.match(settingsPage, /lateGraceMinutes: lateGrace,/);
  assert.match(settingsPage, /earlyLeaveGraceMinutes: earlyLeaveGrace,/);
  assert.match(settingsPage, /missingCheckoutGraceMinutes: missingCheckoutGrace,/);
});

test("policy-engine.ts (the real attendance calculation) has zero references, including its own now-stale explanatory comment about this field", () => {
  assert.doesNotMatch(policyEngine, /defaultNormalCheckoutTime/i);
});

// ---------------------------------------------------------------------------
// 2. cleanup migration 자체 검증.
// ---------------------------------------------------------------------------

test("cleanup migration file exists and is transactional", () => {
  assert.match(migration, /^begin;$/m);
  assert.match(migration.trimEnd(), /commit;$/);
});

test("cleanup migration never uses CASCADE as part of an actual DDL statement", () => {
  assert.doesNotMatch(migration, /\b(drop|alter)\b[^;\n]*\bcascade\b/i);
});

test("cleanup migration drops the old 10-arg store_schedule_settings_v1 (including p_default_normal_checkout_time) before recreating it", () => {
  const dropIndex = migration.indexOf("drop function public.store_schedule_settings_v1(");
  assert.ok(dropIndex > -1);
  const dropStatement = migration.slice(dropIndex, migration.indexOf(");", dropIndex) + 2);
  assert.match(dropStatement, /p_default_normal_checkout_time time without time zone/);
  assert.match(dropStatement, /p_late_grace_minutes integer/);
  assert.match(dropStatement, /p_early_leave_grace_minutes integer/);
  assert.match(dropStatement, /p_missing_checkout_grace_minutes integer/);
});

test("cleanup migration recreates store_schedule_settings_v1 under the same name (no new v2) with a 9-arg signature that has no p_default_normal_checkout_time", () => {
  const createIndex = migration.indexOf("create function public.store_schedule_settings_v1(");
  assert.ok(createIndex > -1);
  const signatureEnd = migration.indexOf(") returns jsonb", createIndex);
  const signature = migration.slice(createIndex, signatureEnd);
  assert.doesNotMatch(signature, /p_default_normal_checkout_time/);
  assert.match(signature, /p_late_grace_minutes integer,/);
  assert.match(signature, /p_early_leave_grace_minutes integer default 0,/);
  assert.match(signature, /p_missing_checkout_grace_minutes integer default 60/);
  assert.doesNotMatch(migration, /store_schedule_settings_v2/);
});

test("recreated store_schedule_settings_v1 body no longer validates or inserts default_normal_checkout_time, but keeps validating and inserting the 3 real grace values", () => {
  const createIndex = migration.indexOf("create function public.store_schedule_settings_v1(");
  const nextSectionIndex = migration.indexOf("-- 2. store_setting_snapshot_v1", createIndex);
  const body = migration.slice(createIndex, nextSectionIndex);
  assert.doesNotMatch(body, /default_normal_checkout_time/);
  assert.match(body, /p_late_grace_minutes not between 0 and 180/);
  assert.match(body, /p_early_leave_grace_minutes not between 0 and 180/);
  assert.match(body, /p_missing_checkout_grace_minutes not between 0 and 360/);
  assert.match(body, /insert into public\.store_attendance_policies \(\s*setting_version_id,\s*late_grace_minutes,\s*early_leave_grace_minutes,\s*missing_checkout_grace_minutes\s*\)/);
});

test("cleanup migration re-locks down the recreated 9-arg function exactly like the project's own precedent for this function (per-grantee revoke + service_role grant)", () => {
  assert.match(migration, /revoke all on function public\.store_schedule_settings_v1\(\s*date, bigint, text, time without time zone, jsonb, bigint, integer, integer, integer\s*\) from public;/);
  assert.match(migration, /revoke all on function public\.store_schedule_settings_v1\(\s*date, bigint, text, time without time zone, jsonb, bigint, integer, integer, integer\s*\) from anon;/);
  assert.match(migration, /revoke all on function public\.store_schedule_settings_v1\(\s*date, bigint, text, time without time zone, jsonb, bigint, integer, integer, integer\s*\) from authenticated;/);
  assert.match(migration, /grant execute on function public\.store_schedule_settings_v1\(\s*date, bigint, text, time without time zone, jsonb, bigint, integer, integer, integer\s*\) to service_role;/);
});

test("cleanup migration keeps store_setting_snapshot_v1's signature unchanged (CREATE OR REPLACE only, no DROP) — existing grants stay attached automatically", () => {
  assert.match(migration, /create or replace function public\.store_setting_snapshot_v1\(p_version_id bigint\)/);
  assert.doesNotMatch(migration, /drop function public\.store_setting_snapshot_v1/);
});

test("recreated store_setting_snapshot_v1 no longer emits defaultNormalCheckoutTime in its JSON, but still emits the 3 real grace fields and every other snapshot key unchanged", () => {
  const snapshotIndex = migration.indexOf("create or replace function public.store_setting_snapshot_v1");
  const snapshotBody = migration.slice(snapshotIndex);
  assert.doesNotMatch(snapshotBody, /defaultNormalCheckoutTime/);
  assert.match(snapshotBody, /'lateGraceMinutes', coalesce\(p\.late_grace_minutes, 0\)/);
  assert.match(snapshotBody, /'earlyLeaveGraceMinutes', coalesce\(p\.early_leave_grace_minutes, 0\)/);
  assert.match(snapshotBody, /'missingCheckoutGraceMinutes', coalesce\(p\.missing_checkout_grace_minutes, 60\)/);
  for (const key of ["'id'", "'timezone'", "'businessDayCutoffTime'", "'effectiveFromBusinessDate'", "'revision'", "'state'", "'createdBy'", "'createdAt'", "'cancelledBy'", "'cancelledAt'", "'hours'"]) {
    assert.match(snapshotBody, new RegExp(key.replace(/'/g, "'")));
  }
});

test("cleanup migration drops the default_normal_checkout_time column only after both functions that read/write it have already been redefined (ordering matters for safety)", () => {
  const scheduleFnIndex = migration.indexOf("create function public.store_schedule_settings_v1(");
  const snapshotFnIndex = migration.indexOf("create or replace function public.store_setting_snapshot_v1");
  const columnDropIndex = migration.indexOf("drop column default_normal_checkout_time");
  assert.ok(scheduleFnIndex > -1 && snapshotFnIndex > -1 && columnDropIndex > -1);
  assert.ok(scheduleFnIndex < columnDropIndex, "store_schedule_settings_v1 must be recreated before the column is dropped");
  assert.ok(snapshotFnIndex < columnDropIndex, "store_setting_snapshot_v1 must be recreated before the column is dropped");
});

test("cleanup migration drops exactly one column, on the correct table, with no other schema change", () => {
  const alterMatches = [...migration.matchAll(/alter table public\.(\w+)\s*\n\s*drop column (\w+);/g)];
  assert.equal(alterMatches.length, 1);
  assert.equal(alterMatches[0][1], "store_attendance_policies");
  assert.equal(alterMatches[0][2], "default_normal_checkout_time");
});

test("cleanup migration never touches other real attendance/store policy columns or tables (late/early/missing grace, business hours, cutoff, business day overrides, version/audit history)", () => {
  const protectedObjects = [
    "store_business_hours",
    "store_business_day_overrides",
    "store_setting_versions",
    "store_setting_audit_logs",
    "late_grace_minutes",
    "early_leave_grace_minutes",
    "missing_checkout_grace_minutes",
  ];
  for (const name of protectedObjects) {
    assert.doesNotMatch(migration, new RegExp(`(create|create or replace|alter|drop)\\s+(table|column)\\s+(public\\.)?${name}\\b`, "i"));
  }
});
