import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { canAssignBarZone, canDeleteBarKeeping, canEditBarZone, canEditClosedBarKeeping, canManageBarKeeping, canReactivateBarKeeping, canViewBar, canViewBarLogs } from "../lib/bar/permissions.ts";

// role/position 통합 작업에서 BAR 정책 코드(lib/bar/permissions.ts)는 원칙적으로 건드리지
// 않았다 — 이미 role + part + is_active만 사용하고 position은 아예 참조하지 않는다.
// 이 테스트는 그 사실이 이후에도 깨지지 않게 고정한다.

const active = (overrides: Record<string, unknown>) => ({ is_active: true, ...overrides });

test("owner/master can fully manage BAR regardless of part", () => {
  for (const role of ["owner", "master"]) {
    for (const part of ["bar", "hall", "kitchen", null]) {
      const user = active({ role, part });
      assert.equal(canViewBar(user), true);
      assert.equal(canViewBarLogs(user), true);
      assert.equal(canEditBarZone(user), true);
      assert.equal(canAssignBarZone(user), true);
      assert.equal(canManageBarKeeping(user), true);
      assert.equal(canReactivateBarKeeping(user), true);
      assert.equal(canEditClosedBarKeeping(user), true);
      assert.equal(canDeleteBarKeeping(user), true);
    }
  }
});

test("part=bar + role=leader is the head bartender with full practical authority except delete", () => {
  const user = active({ role: "leader", part: "bar" });
  assert.equal(canViewBar(user), true);
  assert.equal(canViewBarLogs(user), true);
  assert.equal(canEditBarZone(user), true);
  assert.equal(canAssignBarZone(user), true);
  assert.equal(canManageBarKeeping(user), true);
  assert.equal(canReactivateBarKeeping(user), true);
  assert.equal(canEditClosedBarKeeping(user), true);
  assert.equal(canDeleteBarKeeping(user), false);
});

test("part=bar + role=staff can do general zone/keeping work but not assign or reactivate or delete", () => {
  const user = active({ role: "staff", part: "bar" });
  assert.equal(canViewBar(user), true);
  assert.equal(canViewBarLogs(user), true);
  assert.equal(canEditBarZone(user), true);
  assert.equal(canManageBarKeeping(user), true);
  assert.equal(canAssignBarZone(user), false);
  assert.equal(canReactivateBarKeeping(user), false);
  assert.equal(canEditClosedBarKeeping(user), false);
  assert.equal(canDeleteBarKeeping(user), false);
});

test("part=bar + role=manager can only view (BAR authority is delegated to the head bartender)", () => {
  const user = active({ role: "manager", part: "bar" });
  assert.equal(canViewBar(user), true);
  assert.equal(canViewBarLogs(user), true);
  assert.equal(canEditBarZone(user), false);
  assert.equal(canAssignBarZone(user), false);
  assert.equal(canManageBarKeeping(user), false);
  assert.equal(canReactivateBarKeeping(user), false);
  assert.equal(canDeleteBarKeeping(user), false);
});

test("a leader from another part (e.g. Nhon: role=leader, part=hall) can only view BAR", () => {
  const user = active({ role: "leader", part: "hall" });
  assert.equal(canViewBar(user), true);
  assert.equal(canViewBarLogs(user), true);
  assert.equal(canEditBarZone(user), false);
  assert.equal(canAssignBarZone(user), false);
  assert.equal(canManageBarKeeping(user), false);
  assert.equal(canReactivateBarKeeping(user), false);
  assert.equal(canDeleteBarKeeping(user), false);
});

test("inactive users cannot even view BAR, regardless of role/part", () => {
  const inactiveOwner = { is_active: false, role: "owner", part: "bar" };
  const inactiveBarLeader = { is_active: false, role: "leader", part: "bar" };
  for (const user of [inactiveOwner, inactiveBarLeader]) {
    assert.equal(canViewBar(user), false);
    assert.equal(canViewBarLogs(user), false);
    assert.equal(canEditBarZone(user), false);
    assert.equal(canAssignBarZone(user), false);
    assert.equal(canManageBarKeeping(user), false);
    assert.equal(canReactivateBarKeeping(user), false);
    assert.equal(canDeleteBarKeeping(user), false);
  }
});

test("the position field never affects BAR permission results, however it is set", () => {
  const base = { is_active: true, role: "leader", part: "bar" };
  const withOwnerPosition = { ...base, position: "owner" };
  const withStaffPosition = { ...base, position: "staff" };
  const withNoPosition = { ...base };

  const results = (user: unknown) => ({
    view: canViewBar(user as never),
    edit: canEditBarZone(user as never),
    assign: canAssignBarZone(user as never),
    manage: canManageBarKeeping(user as never),
    reactivate: canReactivateBarKeeping(user as never),
    del: canDeleteBarKeeping(user as never),
  });

  const expected = results(withNoPosition);
  assert.deepEqual(results(withOwnerPosition), expected);
  assert.deepEqual(results(withStaffPosition), expected);
});

test("BarPermissionUser's type does not declare a position field at all", () => {
  const source = readFileSync(join(process.cwd(), "lib/bar/permissions.ts"), "utf8");
  const typeStart = source.indexOf("export type BarPermissionUser");
  const typeEnd = source.indexOf("};", typeStart);
  const typeBody = source.slice(typeStart, typeEnd);
  assert.doesNotMatch(typeBody, /position/);
  assert.match(typeBody, /role\?:/);
  assert.match(typeBody, /part\?:/);
  assert.match(typeBody, /is_active\?:/);
});
