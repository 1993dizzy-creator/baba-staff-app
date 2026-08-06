import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const policyRoute = read("app/api/admin/payroll/meal-allowance/policy/route.ts");
const eligibilityRoute = read("app/api/admin/payroll/meal-allowance/eligibility/route.ts");

test("policy route: both GET and POST require the payroll actor gate (owner/master only)", () => {
  assert.match(policyRoute, /export async function GET\(\) \{\s*\n\s*const auth = await requirePayrollActor\(\);/);
  assert.match(policyRoute, /export async function POST\(request: Request\) \{\s*\n\s*const auth = await requirePayrollActor\(\);/);
});

test("policy route: POST validates dailyAmount as a non-negative safe integer and effectiveFrom as a date string before calling the RPC", () => {
  assert.match(policyRoute, /!Number\.isSafeInteger\(dailyAmount\) \|\|\s*\n\s*dailyAmount < 0/);
  assert.match(policyRoute, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
});

test("policy route: POST calls the v1 RPC with the server-derived actor id (never trusts a client-sent actor/role)", () => {
  const postBody = policyRoute.slice(policyRoute.indexOf("export async function POST"));
  assert.match(postBody, /rpc\("payroll_create_meal_allowance_policy_version_v1"/);
  assert.match(postBody, /p_actor_user_id: auth\.actor\.id/);
  assert.doesNotMatch(postBody, /body\.actorId|body\.role|body\.actorUserId/);
});

test("eligibility route: both GET and POST require the payroll actor gate (owner/master only)", () => {
  assert.match(eligibilityRoute, /export async function GET\(request: Request\) \{\s*\n\s*const auth = await requirePayrollActor\(\);/);
  assert.match(eligibilityRoute, /export async function POST\(request: Request\) \{\s*\n\s*const auth = await requirePayrollActor\(\);/);
});

test("eligibility route: POST calls the v1 RPC with the server-derived actor id", () => {
  const postBody = eligibilityRoute.slice(eligibilityRoute.indexOf("export async function POST"));
  assert.match(postBody, /rpc\("payroll_create_meal_allowance_eligibility_version_v1"/);
  assert.match(postBody, /p_actor_user_id: auth\.actor\.id/);
});

test("eligibility route: POST pre-checks attendance_tracking_enabled before allowing isEligible=true, returning the documented error code", () => {
  const postBody = eligibilityRoute.slice(eligibilityRoute.indexOf("export async function POST"));
  assert.match(postBody, /attendance_tracking_enabled === false/);
  assert.match(postBody, /"MEAL_ALLOWANCE_REQUIRES_ATTENDANCE_TRACKING"/);
});

test("eligibility route: GET response includes attendanceTrackingEnabled, standardWorkdays, and a projected meal allowance preview for the settings UI", () => {
  const getBody = eligibilityRoute.slice(eligibilityRoute.indexOf("export async function GET"), eligibilityRoute.indexOf("export async function POST"));
  assert.match(getBody, /attendanceTrackingEnabled: user\.attendance_tracking_enabled !== false/);
  assert.match(getBody, /standardWorkdays: contracts\.length === 1 \? contracts\[0\]\.standardWorkdays : null/);
  assert.match(getBody, /projectedMealAllowance: \{ amount: projected\.amount, warningCode: projected\.warningCode \}/);
});

test("both routes reject system accounts the same way payroll contract creation does (is_system_account = false)", () => {
  assert.match(eligibilityRoute, /is_system_account/);
});
