import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const route = read("app/api/admin/payroll/settings/route.ts");

test("existing GET and PATCH handlers are untouched by the new atomic PUT — legacy read/partial-update paths still exist", () => {
  assert.match(route, /export async function GET\(\) \{/);
  assert.match(route, /export async function PATCH\(request: Request\) \{/);
  const patchBody = route.slice(route.indexOf("export async function PATCH"), route.indexOf("// PATCH(위)는"));
  assert.match(patchBody, /supabaseServer\.from\("payroll_settings"\)\.update\(update\)\.eq\("id",1\)/);
});

test("PUT requires the payroll actor gate (owner/master only), same as GET/PATCH", () => {
  assert.match(route, /export async function PUT\(request: Request\) \{\s*\n\s*const auth = await requirePayrollActor\(\);/);
});

test("PUT validates every payroll_settings field before calling the RPC (defense in depth, mirrors the RPC's own validation)", () => {
  const putBody = route.slice(route.indexOf("export async function PUT"));
  for (const check of [
    "paymentDay < 1 || paymentDay > 28",
    "employeeInsuranceRateBp < 0 || employeeInsuranceRateBp > 10000",
    "employerInsuranceRateBp < 0 || employerInsuranceRateBp > 10000",
    "typeof directorInsuranceEnabled !== \"boolean\"",
    "directorInsuranceBaseAmount < 0",
    "directorInsuranceRateBp < 0 || directorInsuranceRateBp > 10000",
    "lateMajorThresholdMinutes < 1 || lateMajorThresholdMinutes > 1440",
    "lateMinorPenaltyMinutes < 1 || lateMinorPenaltyMinutes > 1440",
    "lateMajorPenaltyRateBp < 0 || lateMajorPenaltyRateBp > 10000",
    "unauthorizedAbsencePenaltyDays < 1 || unauthorizedAbsencePenaltyDays > 31",
  ]) {
    assert.ok(putBody.includes(check), `expected PUT validation to include: ${check}`);
  }
});

test("PUT treats mealDailyAmount/mealEffectiveFrom as both-null (no meal change) or both-filled only, blocking a half-filled pair before calling the RPC", () => {
  const putBody = route.slice(route.indexOf("export async function PUT"));
  assert.match(putBody, /const mealBothBlank = /);
  assert.match(putBody, /const mealBothFilled = /);
  assert.match(putBody, /if \(!mealBothBlank && !mealBothFilled\) \{\s*\n\s*return payrollJson\(\{ ok:false, code:"INVALID_MEAL_ALLOWANCE_POLICY" \}, 400\);/);
});

test("PUT calls the single atomic RPC with the server-derived actor id, never a client-sent actor/role", () => {
  const putBody = route.slice(route.indexOf("export async function PUT"));
  assert.match(putBody, /rpc\("payroll_update_common_settings_v1", \{/);
  assert.match(putBody, /p_actor_user_id: auth\.actor\.id,/);
  assert.doesNotMatch(putBody, /body\.actorId|body\.role/);
  // PUT은 정확히 한 번만 supabaseServer.rpc를 호출한다(payroll_settings update와 식대 revision
  // 생성을 각각 별도 요청으로 나누지 않는다 — RPC 내부에서 하나의 transaction으로 처리).
  assert.equal((putBody.match(/supabaseServer\.rpc\(/g) ?? []).length, 1);
  assert.doesNotMatch(putBody, /supabaseServer\.from\("payroll_settings"\)\.update/);
  assert.doesNotMatch(putBody, /supabaseServer\.from\("payroll_meal_allowance_policy_versions"\)/);
});

test("PUT maps RPC failure to distinct error codes without ever silently succeeding on a partial write", () => {
  const putBody = route.slice(route.indexOf("export async function PUT"));
  assert.match(putBody, /if \(error\) \{/);
  for (const code of [
    "FORBIDDEN",
    "INVALID_PAYMENT_DAY",
    "INVALID_INSURANCE_SETTINGS",
    "INVALID_PENALTY_SETTINGS",
    "MEAL_ALLOWANCE_INVALID_AMOUNT",
    "INVALID_MEAL_ALLOWANCE_POLICY",
  ]) {
    assert.ok(putBody.includes(`"${code}"`), `expected error code mapping for ${code}`);
  }
});
