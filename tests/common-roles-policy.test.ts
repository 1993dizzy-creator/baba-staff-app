import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { EDITABLE_EMPLOYEE_ROLE_VALUES, EMPLOYEE_ROLE_VALUES, getEmployeeRoleLabel, getEmployeeRoleRank, isEditableEmployeeRole, isEmployeeRole, isOwnerOrMasterRole, toLegacyEmployeePosition } from "../lib/common/roles.ts";

test("EMPLOYEE_ROLE_VALUES includes master; EDITABLE_EMPLOYEE_ROLE_VALUES excludes it", () => {
  assert.deepEqual(EMPLOYEE_ROLE_VALUES, ["master", "owner", "manager", "leader", "staff"]);
  assert.deepEqual(EDITABLE_EMPLOYEE_ROLE_VALUES, ["owner", "manager", "leader", "staff"]);
  assert.equal(EDITABLE_EMPLOYEE_ROLE_VALUES.includes("master" as never), false);
});

test("isEmployeeRole / isEditableEmployeeRole distinguish master from the editable set", () => {
  assert.equal(isEmployeeRole("master"), true);
  assert.equal(isEditableEmployeeRole("master"), false);
  for (const role of ["owner", "manager", "leader", "staff"]) {
    assert.equal(isEmployeeRole(role), true);
    assert.equal(isEditableEmployeeRole(role), true);
  }
  assert.equal(isEmployeeRole("admin"), false);
  assert.equal(isEmployeeRole(null), false);
  assert.equal(isEmployeeRole(undefined), false);
  assert.equal(isEditableEmployeeRole("admin"), false);
});

test("isOwnerOrMasterRole treats owner and master as the same tier", () => {
  assert.equal(isOwnerOrMasterRole("owner"), true);
  assert.equal(isOwnerOrMasterRole("master"), true);
  for (const role of ["manager", "leader", "staff", "admin", null, undefined]) {
    assert.equal(isOwnerOrMasterRole(role), false);
  }
});

test("getEmployeeRoleRank orders master -> owner -> manager -> leader -> staff -> unknown", () => {
  assert.equal(getEmployeeRoleRank("master"), 0);
  assert.equal(getEmployeeRoleRank("owner"), 1);
  assert.equal(getEmployeeRoleRank("manager"), 2);
  assert.equal(getEmployeeRoleRank("leader"), 3);
  assert.equal(getEmployeeRoleRank("staff"), 4);
  assert.equal(getEmployeeRoleRank("admin"), 99);
  assert.equal(getEmployeeRoleRank(null), 99);
  assert.ok(getEmployeeRoleRank("master") < getEmployeeRoleRank("owner"));

  const sorted = ["staff", "leader", "master", "staff", "manager", "owner"]
    .map((role) => ({ role, rank: getEmployeeRoleRank(role) }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.role);
  assert.deepEqual(sorted, ["master", "owner", "manager", "staff", "staff", "leader"].sort(
    (a, b) => getEmployeeRoleRank(a) - getEmployeeRoleRank(b)
  ));
});

test("getEmployeeRoleLabel matches the confirmed label policy in both languages", () => {
  assert.equal(getEmployeeRoleLabel("master", "ko"), "최고관리자");
  assert.equal(getEmployeeRoleLabel("master", "vi"), "Quản trị viên cao nhất");
  assert.equal(getEmployeeRoleLabel("owner", "ko"), "사장");
  assert.equal(getEmployeeRoleLabel("owner", "vi"), "Chủ cửa hàng");
  assert.equal(getEmployeeRoleLabel("manager", "ko"), "매니저");
  assert.equal(getEmployeeRoleLabel("manager", "vi"), "Quản lý");
  assert.equal(getEmployeeRoleLabel("leader", "ko"), "리더");
  assert.equal(getEmployeeRoleLabel("leader", "vi"), "Trưởng nhóm");
  assert.equal(getEmployeeRoleLabel("staff", "ko"), "직원");
  assert.equal(getEmployeeRoleLabel("staff", "vi"), "Nhân viên");
});

test("getEmployeeRoleLabel falls back to the raw string, or '-', for unknown values", () => {
  assert.equal(getEmployeeRoleLabel("some-future-role", "ko"), "some-future-role");
  assert.equal(getEmployeeRoleLabel(null, "ko"), "-");
  assert.equal(getEmployeeRoleLabel(undefined, "ko"), "-");
  assert.equal(getEmployeeRoleLabel("", "ko"), "-");
});

test("toLegacyEmployeePosition derives the legacy users.position value from role", () => {
  assert.equal(toLegacyEmployeePosition("master"), "owner");
  assert.equal(toLegacyEmployeePosition("owner"), "owner");
  assert.equal(toLegacyEmployeePosition("manager"), "manager");
  assert.equal(toLegacyEmployeePosition("leader"), "leader");
  assert.equal(toLegacyEmployeePosition("staff"), "staff");
  assert.equal(toLegacyEmployeePosition("admin"), null);
  assert.equal(toLegacyEmployeePosition("some-future-role"), null);
  assert.equal(toLegacyEmployeePosition(null), null);
  assert.equal(toLegacyEmployeePosition(undefined), null);
});
