import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/202607190001_create_store_settings_foundation.sql"), "utf8");

test("settings tables are RLS protected and service-role only", () => {
  assert.match(sql, /enable row level security/g);
  assert.match(sql, /revoke all on table public\.store_setting_versions from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.store_schedule_settings_v1[\s\S]*to service_role/i);
  assert.doesNotMatch(sql, /grant execute[\s\S]*to authenticated/i);
});

test("current and scheduled state is derived from effective business date", () => {
  assert.match(sql, /state = 'active' and effective_from_business_date <= p_business_date/i);
  assert.match(sql, /state = 'active' and effective_from_business_date > p_business_date/i);
  assert.match(sql, /state in \('active', 'cancelled'\)/i);
});

test("schedule is serialized, future-only, seven-day and audited", () => {
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /p_effective_from_business_date <= v_current_business_date/);
  assert.match(sql, /jsonb_array_length\(p_hours\) <> 7/);
  assert.match(sql, /v_item \?& array\['weekday','isClosed','openTime','closeTime'\]/);
  assert.match(sql, /jsonb_typeof\(v_item->'weekday'\) <> 'number'/);
  assert.match(sql, /store_setting_audit_logs[\s\S]*'created'/);
  assert.match(sql, /version_conflict/);
});

test("cancel is serialized, future-only and audited", () => {
  assert.match(sql, /store_cancel_scheduled_settings_v1/);
  assert.match(sql, /effective_from_business_date>v_current_business_date for update/);
  assert.match(sql, /state='cancelled',revision=v_latest_revision\+1/);
  assert.match(sql, /'cancelled'/);
});

test("PostgreSQL business date uses timezone and strict cutoff boundary", () => {
  assert.match(sql, /p_timestamp at time zone p_timezone/);
  assert.match(sql, /::time < p_cutoff/);
  assert.match(sql, /then \(\(p_timestamp at time zone p_timezone\)::date - 1\)/);
  assert.match(sql, /store_business_date_for_timestamp_v1/);
  assert.match(sql, /effective_from_business_date <= v_candidate/);
  assert.match(sql, /return greatest\(v_result, v_effective\)/);
  assert.match(sql, /v_current_business_date date := public\.store_business_date_for_timestamp_v1\(now\(\)\)/);
});

test("migration deliberately contains no dated seed or legacy data mutation", () => {
  assert.doesNotMatch(sql, /insert into public\.store_setting_versions[\s\S]*'20\d\d-\d\d-\d\d'/i);
  assert.doesNotMatch(sql, /update public\.(pos_|attendance_|inventory_|bar_)/i);
});
