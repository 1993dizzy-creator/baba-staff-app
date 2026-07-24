import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { getCompletedBusinessDateRange, parseAttendanceShadowRange } from "../lib/attendance/shadow-period.ts";

const read = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8");

test("period parser preserves single-day requests and limits ranges to 31 days", () => {
  assert.deepEqual(parseAttendanceShadowRange({ businessDate: "2026-07-23" }), {
    startBusinessDate: "2026-07-23",
    endBusinessDate: "2026-07-23",
    businessDates: ["2026-07-23"],
    singleDate: true,
  });
  assert.equal(
    parseAttendanceShadowRange({
      startBusinessDate: "2026-07-24",
      endBusinessDate: "2026-07-23",
    }),
    null
  );
  assert.equal(
    parseAttendanceShadowRange({
      startBusinessDate: "2026-06-01",
      endBusinessDate: "2026-07-23",
    }),
    null
  );
});

test("default range excludes the current business day", () => {
  assert.deepEqual(getCompletedBusinessDateRange("2026-07-24"), {
    startBusinessDate: "2026-07-17",
    endBusinessDate: "2026-07-23",
  });
});

test("manual normalization migration is atomic and does not infer history", () => {
  const migration = read(
    "supabase/migrations/202607240005_add_attendance_manual_override_marker.sql"
  );
  assert.match(migration, /attendance_record_manual_overrides/);
  assert.match(migration, /override_metric in \('late', 'early_leave'\)/);
  assert.match(migration, /for update/i);
  assert.match(
    migration,
    /update public\.attendance_records[\s\S]*insert into public\.attendance_record_manual_overrides[\s\S]*insert into public\.attendance_record_audit_logs/i
  );
  assert.doesNotMatch(migration, /insert into public\.attendance_record_manual_overrides[\s\S]*select[\s\S]*from public\.attendance_records/i);
  assert.match(migration, /revoke execute[\s\S]*public, anon, authenticated/i);
  assert.match(migration, /grant execute[\s\S]*service_role/i);
});

test("shadow API is read-only, batched, and keeps cancellation audits out of rows", () => {
  const route = read(
    "app/api/admin/store-settings/attendance-shadow/route.ts"
  );
  assert.match(route, /startBusinessDate/);
  assert.match(route, /endBusinessDate/);
  assert.match(route, /attendance_record_manual_overrides/);
  assert.match(route, /attendance_record_audit_logs/);
  assert.doesNotMatch(route, /\.(insert|update|delete|upsert)\s*\(/);
});
