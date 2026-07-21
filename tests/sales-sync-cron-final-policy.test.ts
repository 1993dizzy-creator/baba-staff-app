import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const shared = read("lib/pos/cukcuk/sales-sync-cron-shared.ts");
const normal = read("app/api/cron/sales-sync/route.ts");
const final = read("app/api/cron/sales-sync-final/route.ts");

test("normal and final sales-sync crons share one implementation, not duplicated ones", () => {
  for (const route of [normal, final]) {
    assert.match(route, /from "@\/lib\/pos\/cukcuk\/sales-sync-cron-shared"/);
    assert.match(route, /authorizeCron\(req\)/);
    assert.match(route, /callSalesSyncRoute\(/);
    assert.match(route, /buildSalesSyncCronResponse\(/);
    // The full processing logic must not be re-declared in either route file.
    assert.doesNotMatch(route, /function normalizeSyncResponse/);
    assert.doesNotMatch(route, /function authorizeCron/);
  }
  assert.match(shared, /export function normalizeSyncResponse/);
  assert.match(shared, /export function authorizeCron/);
  assert.match(shared, /export async function callSalesSyncRoute/);
});

test("the normal cron never sends an explicit businessDate", () => {
  assert.doesNotMatch(normal, /businessDate:/);
  assert.match(normal, /callSalesSyncRoute\(\{\s*origin,\s*posAdminSecret,\s*\}\)/);
});

test("the final cron always resolves and sends the previous business date, not the current one", () => {
  assert.match(final, /loadBusinessTimeAdapter\(new Date\(\)\)/);
  assert.match(final, /addStoreDays\(adapter\.databaseBusinessDate, -1\)/);
  assert.match(final, /businessDate: resolved\.targetBusinessDate/);
  // Guards against a regression that would send the just-resolved current
  // business date instead of the day before it.
  assert.doesNotMatch(final, /businessDate: resolved\.currentBusinessDate/);
});

test("the final cron falls back to the legacy business date calculation if the settings lookup throws", () => {
  assert.match(final, /catch \(error\) \{/);
  assert.match(final, /getBusinessDate\(\)/);
  assert.match(final, /SALES_SYNC_FINAL_STORE_SETTING_LOOKUP_FAILED/);
});

test("the final cron logs its resolved target with revision/fallback context and no secrets", () => {
  assert.match(final, /SALES_SYNC_FINAL_TARGET/);
  assert.match(final, /currentBusinessDate: resolved\.currentBusinessDate/);
  assert.match(final, /targetBusinessDate: resolved\.targetBusinessDate/);
  assert.match(final, /revision: resolved\.revision/);
  assert.match(final, /isFallback: resolved\.isFallback/);
  assert.doesNotMatch(final, /console\.(log|error|warn)\([^)]*posAdminSecret/);
  assert.doesNotMatch(final, /console\.(log|error|warn)\([^)]*accessToken/);
});

test("vercel.json points the existing 03:00/03:05 schedules at the final routes, not the normal ones", () => {
  const vercelJson = JSON.parse(read("vercel.json")) as {
    crons: { path: string; schedule: string }[];
  };
  const finalSync = vercelJson.crons.find((c) => c.path === "/api/cron/sales-sync-final");
  const finalDeductions = vercelJson.crons.find((c) => c.path === "/api/cron/sales-deductions-final");
  const repeatingSync = vercelJson.crons.find((c) => c.path === "/api/cron/sales-sync");
  const repeatingDeductions = vercelJson.crons.find((c) => c.path === "/api/cron/sales-deductions");

  assert.equal(finalSync?.schedule, "0 20 * * *");
  assert.equal(finalDeductions?.schedule, "5 20 * * *");
  assert.equal(repeatingSync?.schedule, "*/5 10-18 * * *");
  assert.equal(repeatingDeductions?.schedule, "*/15 10-18 * * *");
});
