import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { isMasterGeneralEditBlocked, isPayrollOverrideOnlyUpdate } from "../lib/employee/profile-update-policy.ts";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { toLegacyEmployeePosition } from "../lib/common/roles.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

// ---------------------------------------------------------------------------
// 실제 값으로 시나리오 A/B/C를 검증한다. app/api/admin/users/route.ts(PATCH)의
// normalizeUpdate 출력 형태를 그대로 흉내 낸 update 객체를 구성해, 그 라우트가
// 실제로 쓰는 순수 판정 함수(isPayrollOverrideOnlyUpdate, isMasterGeneralEditBlocked)
// 와 position 파생 함수(toLegacyEmployeePosition)를 그대로 호출한다.
// ---------------------------------------------------------------------------

test("scenario A: master + payroll_eligible_override-only update is allowed, role stays master, position stays owner", () => {
  const targetRole = "master";
  const update = { payroll_eligible_override: true }; // normalizeUpdate가 만들 유일한 키
  const hasPayrollOverrideUpdate = true;

  const isPayrollOverrideOnly = isPayrollOverrideOnlyUpdate(update, hasPayrollOverrideUpdate);
  assert.equal(isPayrollOverrideOnly, true);

  const blocked = isMasterGeneralEditBlocked(targetRole, isPayrollOverrideOnly);
  assert.equal(blocked, false, "override-only master update must be allowed, not 403");

  // update에는 role 키가 없으므로 resultingRole은 target.role(master)로 떨어진다.
  const resultingRole = Object.prototype.hasOwnProperty.call(update, "role")
    ? (update as Record<string, unknown>).role
    : targetRole;
  assert.equal(resultingRole, "master");

  const derivedPosition = toLegacyEmployeePosition(resultingRole);
  assert.equal(derivedPosition, "owner");

  // RPC에 보낼 최종 payload는 update 자체를 건드리지 않고 스프레드로만 병합된다 —
  // 즉 update 원본은 여전히 override-only(1개 키) 상태를 유지해야 한다.
  assert.deepEqual(update, { payroll_eligible_override: true });
  const finalPayload = { ...update, position: derivedPosition };
  assert.deepEqual(finalPayload, { payroll_eligible_override: true, position: "owner" });
  assert.doesNotMatch(JSON.stringify(finalPayload), /"role"/); // role은 RPC 쪽에서 v_before.role(master) 유지
});

test("scenario B: master + a general field (name or role) present is still blocked with 403", () => {
  for (const update of [{ name: "New Name" }, { role: "owner" }, { name: "New Name", role: "owner" }]) {
    const hasPayrollOverrideUpdate = false;
    const isPayrollOverrideOnly = isPayrollOverrideOnlyUpdate(update, hasPayrollOverrideUpdate);
    assert.equal(isPayrollOverrideOnly, false);
    assert.equal(isMasterGeneralEditBlocked("master", isPayrollOverrideOnly), true);
  }

  // payroll_eligible_override와 다른 필드가 함께 오는 경우(override-only가 아님)도 차단되어야 한다.
  const mixedUpdate = { payroll_eligible_override: true, name: "New Name" };
  const isPayrollOverrideOnlyMixed = isPayrollOverrideOnlyUpdate(mixedUpdate, true);
  assert.equal(isPayrollOverrideOnlyMixed, false, "override-only requires exactly one key");
  assert.equal(isMasterGeneralEditBlocked("master", isPayrollOverrideOnlyMixed), true);
});

test("scenario C: owner with a stale/mismatched legacy position (staff or null) still saves, and position self-heals to owner", () => {
  for (const staleTargetPosition of ["staff", null, "", "leader"]) {
    const targetRole = "owner";
    const update = { name: "New Name", role: "owner", part: "kitchen" }; // 클라이언트가 보내는 일반 수정 payload 형태
    const hasPayrollOverrideUpdate = false;

    const isPayrollOverrideOnly = isPayrollOverrideOnlyUpdate(update, hasPayrollOverrideUpdate);
    assert.equal(isMasterGeneralEditBlocked(targetRole, isPayrollOverrideOnly), false, "owner is never master-blocked");

    const resultingRole = Object.prototype.hasOwnProperty.call(update, "role")
      ? (update as Record<string, unknown>).role
      : targetRole;
    const derivedPosition = toLegacyEmployeePosition(resultingRole);

    // 저장 전 target.position이 무엇이었든(staleTargetPosition), 저장 결과는 항상 role=owner -> position=owner로 복구된다.
    assert.equal(derivedPosition, "owner");
    assert.notEqual(derivedPosition, staleTargetPosition === "" ? null : staleTargetPosition);
  }
});

test("route.ts never mutates the update object with position; it merges a separately-held derivedPosition only at the RPC call site", () => {
  const route = read("app/api/admin/users/route.ts");
  assert.doesNotMatch(route, /update\.position\s*=/);
  assert.match(route, /const derivedPosition = toLegacyEmployeePosition\(resultingRole\);/);
  assert.match(route, /p_updates: \{ \.\.\.update, position: derivedPosition \}/);

  // isPayrollOverrideOnly / master 차단 판정은 derivedPosition 계산보다 반드시 먼저 나와야 한다.
  const overrideOnlyIndex = route.indexOf("const isPayrollOverrideOnly = isPayrollOverrideOnlyUpdate(");
  const masterBlockIndex = route.indexOf("if (isMasterGeneralEditBlocked(target.role, isPayrollOverrideOnly))");
  const derivedPositionIndex = route.indexOf("const derivedPosition = toLegacyEmployeePosition(resultingRole);");
  assert.ok(overrideOnlyIndex > -1 && masterBlockIndex > overrideOnlyIndex);
  assert.ok(derivedPositionIndex > masterBlockIndex);
});

test("route.ts uses the shared pure policy functions instead of inline duplicated boolean expressions", () => {
  const route = read("app/api/admin/users/route.ts");
  assert.match(route, /from "@\/lib\/employee\/profile-update-policy"/);
  assert.doesNotMatch(route, /hasPayrollOverrideUpdate && Object\.keys\(update\)\.length === 1/);
  assert.doesNotMatch(route, /target\.role === "master" && !isPayrollOverrideOnly/);
});
