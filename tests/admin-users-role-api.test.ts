import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const createRoute = read("app/api/admin/users/create/route.ts");
const updateRoute = read("app/api/admin/users/route.ts");

// ---------------------------------------------------------------------------
// 직원 생성 API: body.position을 신뢰하지 않고 role에서 파생한다.
// 실제 role -> position 파생 값 자체는 lib/common/roles.ts의 toLegacyEmployeePosition을
// tests/common-roles-policy.test.ts에서 실제 함수 호출로 이미 검증했다. 여기서는
// API가 그 함수를 실제로 쓰고 있는지, body.position을 읽지 않는지만 확인한다.
// ---------------------------------------------------------------------------

test("create API never reads body.position, and derives position only from the validated role", () => {
  assert.doesNotMatch(createRoute, /body\.position/);
  assert.doesNotMatch(createRoute, /ALLOWED_POSITIONS/);
  assert.doesNotMatch(createRoute, /getBlockedPositionError/);
  assert.match(createRoute, /from "@\/lib\/common\/roles"/);
  assert.match(createRoute, /const position = toLegacyEmployeePosition\(role\);/);

  // position은 role이 ALLOWED_ROLES/BLOCKED_FORM_ROLES 검증을 통과한 *뒤*에만 계산된다.
  const positionIndex = createRoute.indexOf("const position = toLegacyEmployeePosition(role);");
  const allowedRolesCheckIndex = createRoute.indexOf("if (!ALLOWED_ROLES.has(role))");
  const blockedRolesCheckIndex = createRoute.indexOf("if (BLOCKED_FORM_ROLES.has(role))");
  assert.ok(positionIndex > allowedRolesCheckIndex && allowedRolesCheckIndex > -1);
  assert.ok(positionIndex > blockedRolesCheckIndex && blockedRolesCheckIndex > -1);
});

test("create API still rejects master/admin roles and unknown roles before any position derivation", () => {
  assert.match(createRoute, /BLOCKED_FORM_ROLES = new Set\(\["master", "admin"\]\)/);
  assert.match(createRoute, /ALLOWED_ROLES = new Set\(\["owner", "manager", "leader", "staff"\]\)/);
});

// ---------------------------------------------------------------------------
// 직원 수정 API: position은 독립 입력이 아니며, 최종 role에서 항상 재계산된다.
// ---------------------------------------------------------------------------

test("update API removed the independent position allow-list, validator, and position-based sort", () => {
  assert.doesNotMatch(updateRoute, /ALLOWED_POSITIONS/);
  assert.doesNotMatch(updateRoute, /getBlockedPositionError/);
  assert.doesNotMatch(updateRoute, /POSITION_ORDER/);
  assert.doesNotMatch(updateRoute, /ROLE_ORDER/);
});

test("update API silently drops any client-sent position field (no 400, rolling-deploy safe)", () => {
  const allowedKeysBlock = updateRoute.slice(
    updateRoute.indexOf("const ALLOWED_UPDATE_KEYS"),
    updateRoute.indexOf("]);", updateRoute.indexOf("const ALLOWED_UPDATE_KEYS"))
  );
  assert.doesNotMatch(allowedKeysBlock, /"position"/);
  assert.match(allowedKeysBlock, /"role"/);
});

test("update API always recomputes legacy position from the resulting role, unconditionally, without mutating the update object", () => {
  assert.match(updateRoute, /from "@\/lib\/common\/roles"/);
  assert.match(updateRoute, /toLegacyEmployeePosition/);
  assert.match(
    updateRoute,
    /const resultingRole = Object\.prototype\.hasOwnProperty\.call\(update, "role"\)\s*\n\s*\? update\.role as string \| null\s*\n\s*: target\.role;/
  );
  assert.match(updateRoute, /const derivedPosition = toLegacyEmployeePosition\(resultingRole\);/);
  assert.match(updateRoute, /p_updates: \{ \.\.\.update, position: derivedPosition \}/);
  // position은 update 자체를 변형하지 않는다 — master의 payroll_eligible_override
  // 단독 수정이 position 병합 때문에 일반 수정으로 오인되지 않게 하기 위함
  // (tests/admin-users-master-override-policy.test.ts 참고).
  assert.doesNotMatch(updateRoute, /update\.position\s*=/);
});

test("update API sorts by the shared role rank (master first), not a hand-rolled role/position map", () => {
  assert.match(updateRoute, /from "@\/lib\/common\/roles"/);
  assert.match(updateRoute, /getEmployeeRoleRank\(a\.role\) - getEmployeeRoleRank\(b\.role\)/);
});

test("master accounts remain blocked from general edits; only the payroll-override-only path is exempt", () => {
  assert.match(updateRoute, /from "@\/lib\/employee\/profile-update-policy"/);
  assert.match(updateRoute, /const isPayrollOverrideOnly = isPayrollOverrideOnlyUpdate\(update, hasPayrollOverrideUpdate\);/);
  assert.match(updateRoute, /if \(isMasterGeneralEditBlocked\(target\.role, isPayrollOverrideOnly\)\)/);
  assert.match(updateRoute, /getMasterEditError/);
  // 실제 판정 로직 자체는 tests/admin-users-master-override-policy.test.ts에서
  // 실제 함수 호출(시나리오 A/B/C)로 검증한다.
});
