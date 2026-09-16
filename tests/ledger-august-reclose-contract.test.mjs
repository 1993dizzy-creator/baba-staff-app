import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = name => fs.readFileSync(`supabase/migrations/${name}`, "utf8");

test("owner investment repository copy contains only the production function change", () => {
  const sql = read("20260916171636_fix_owner_investment_source_metadata.sql");
  assert.match(sql, /create or replace function public\.ledger_create_owner_investment_v1\(/i);
  assert.match(sql, /source_type, source_snapshot, source_fingerprint, source_synced_at, memo/);
  assert.match(sql, /md5\(v_operation::text\), now\(\)/);
  assert.match(sql, /security definer/i);
  assert.doesNotMatch(sql, /^\s*(?:alter\s+function|revoke\b|grant\b)/im);
});

test("both recurring sync versions skip inactive plans", () => {
  const sql = read("20260916172211_ignore_inactive_recurring_expense_plans.sql");
  assert.match(sql, /create or replace function public\.ledger_sync_recurring_expenses_v1\(/i);
  assert.match(sql, /create or replace function public\.ledger_sync_recurring_expenses_v2\(/i);
  assert.match(sql, /for v_plan in[\s\S]*?where frequency='monthly'\s+and is_active = true/);
  assert.match(sql, /for v_plan in select\*from public\.ledger_recurring_expense_plans where frequency='monthly'and is_active=true/);
  assert.doesNotMatch(sql, /^\s*(?:alter\s+function|revoke\b|grant\b)/im);
});

test("misclassified rent plan is selected by attributes and updated by its selected ID", () => {
  const sql = read("20260916172305_deactivate_misclassified_rent_recurring_plan.sql");
  assert.match(sql, /\bdo\s+\$\$/i);
  assert.match(sql, /source_key_prefix = 'rent'/);
  assert.match(sql, /effective_from = date '2026-09-01'/);
  assert.match(sql, /amount = 60000000/);
  assert.match(sql, /is_active = true/);
  assert.match(sql, /order by id desc\s+limit 1\s+for update/i);
  assert.match(sql, /if not found then\s+return;/i);
  assert.match(sql, /v_before_snapshot := to_jsonb\(v_plan\)/);
  assert.match(sql, /set is_active = false,[\s\S]*?memo = '사용자 확인 2026-09-17: 월 60M은 임대료 비용 인식이 아니라 다음 연간 임대료 준비금 적립 계획\. 반복비용 계획 비활성화\.'[\s\S]*?where id = v_plan\.id/);
  assert.match(sql, /v_after_snapshot := to_jsonb\(v_plan\)/);
  assert.match(sql, /insert into public\.ledger_audit_logs\s*\([\s\S]*?before_snapshot, after_snapshot, reason[\s\S]*?1, 'recurring_plan_deactivated', 'recurring_plan', v_plan\.id,[\s\S]*?v_before_snapshot, v_after_snapshot,[\s\S]*?'60M은 월 임대료 비용이 아니라 준비금 적립 계획으로 사용자 확인'/);
});
