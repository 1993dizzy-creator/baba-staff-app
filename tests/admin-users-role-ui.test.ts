import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const listPage = read("app/(protected)/admin/users/page.tsx");
const createPage = read("app/(protected)/admin/users/create/page.tsx");
const text = read("lib/text/admin-users.ts");

test("the role field label reads as a job title (직급/Chức vụ), not 권한/Quyền, in both languages", () => {
  const koStart = text.indexOf("ko: {");
  const viStart = text.indexOf("vi: {");
  const koBlock = text.slice(koStart, viStart);
  const viBlock = text.slice(viStart);
  assert.match(koBlock, /role: "직급"/);
  assert.match(viBlock, /role: "Chức vụ"/);
  assert.doesNotMatch(koBlock, /role: "권한"/);
  assert.doesNotMatch(viBlock, /role: "Quyền"/);
});

test("the role field help text explains that role decides access and management features, in both languages", () => {
  assert.match(text, /roleFieldHelp: "직급에 따라 앱의 접근 권한과 관리 기능이 결정됩니다\."/);
  assert.match(text, /roleFieldHelp: "Chức vụ quyết định quyền truy cập và chức năng quản lý trong ứng dụng\."/);
});

for (const [name, page] of [
  ["list page", listPage],
  ["create page", createPage],
] as const) {
  test(`${name}: there is no separate position select, only a single role select`, () => {
    assert.doesNotMatch(page, /positionOptions/);
    assert.doesNotMatch(page, /getPositionLabel/);
    assert.doesNotMatch(page, /isPositionOption/);
    assert.match(page, /roleOptions\.map\(/);
  });

  test(`${name}: role select options come from the shared editable-role list and are labeled via getEmployeeRoleLabel`, () => {
    assert.match(page, /from "@\/lib\/common\/roles"/);
    assert.match(page, /EDITABLE_EMPLOYEE_ROLE_VALUES/);
    assert.match(page, /getEmployeeRoleLabel\(role, lang\)/);
    // list page dropped the roleFieldHelp notice under the role|part row (compact
    // detail-edit UI follow-up); create page still shows it.
    if (name === "create page") {
      assert.match(page, /text\.roleFieldHelp/);
    } else {
      assert.doesNotMatch(page, /text\.roleFieldHelp/);
    }
  });

  test(`${name}: master is never one of the selectable role options`, () => {
    const roleOptionsLine = page.match(/const roleOptions = [^\n;]+;/)?.[0] ?? "";
    assert.ok(roleOptionsLine, "expected a roleOptions declaration");
    assert.doesNotMatch(roleOptionsLine, /master/);
  });
}

test("list page: the name-adjacent title uses the role label, not position || role", () => {
  assert.match(listPage, /const positionText = getEmployeeRoleLabel\(user\.role, lang\);/);
  assert.doesNotMatch(listPage, /user\.position \|\| user\.role/);
});

test("list page: display order ranks by role via the shared rank function (master first)", () => {
  assert.match(listPage, /function getRank\(user: UserRow\) \{\s*\n\s*return getEmployeeRoleRank\(user\.role\);\s*\n\s*\}/);
});

test("list page: the edit draft no longer tracks or sends a user-selected position", () => {
  assert.doesNotMatch(listPage, /isPositionOption\(draft\.position\)/);
  assert.doesNotMatch(listPage, /update\("position"/);
  const updatesBlockStart = listPage.indexOf("const updates: Record<string, unknown> = original.role === \"master\"");
  const updatesBlockEnd = listPage.indexOf("if (original.role === \"owner\")", updatesBlockStart);
  const updatesBlock = listPage.slice(updatesBlockStart, updatesBlockEnd);
  assert.doesNotMatch(updatesBlock, /position:/);
  assert.match(updatesBlock, /role: draft\.role,/);
});

test("list page: master accounts render without the role/part edit selects (still gated by isMasterUser)", () => {
  assert.match(listPage, /\{!isMasterUser \? \(/);
});

test("create page: FormState has no user-input position field, and the generation-eligible roles exclude master", () => {
  assert.doesNotMatch(createPage, /position: string;/);
  const roleOptionsLine = createPage.match(/const roleOptions = [^\n;]+;/)?.[0] ?? "";
  assert.match(roleOptionsLine, /EDITABLE_EMPLOYEE_ROLE_VALUES/);
});

test("create page: the preview title and work-time visibility are role-based, not position-based", () => {
  assert.match(createPage, /const previewPosition = getEmployeeRoleLabel\(form\.role, lang\);/);
  assert.match(createPage, /form\.role === "owner" \|\| !form\.attendance_tracking_enabled/);
  assert.doesNotMatch(createPage, /form\.position/);
});

test("create page: the submit payload never includes a user-selected position field", () => {
  const submitStart = createPage.indexOf("async function submit()");
  const submitEnd = createPage.indexOf("\n  }", createPage.indexOf("body: JSON.stringify", submitStart));
  const submitBody = createPage.slice(submitStart, submitEnd);
  assert.doesNotMatch(submitBody, /position/);
  assert.match(submitBody, /\.\.\.form/);
});
