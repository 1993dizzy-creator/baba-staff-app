import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript tests require an explicit extension.
import { PART_VALUES, PART_META, getPartKey } from "../lib/common/parts.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("cleaning is a first-class part alongside the existing etc catch-all", () => {
  assert.deepEqual(PART_VALUES, ["owner", "kitchen", "hall", "bar", "cleaning", "etc"]);
  assert.equal(PART_META.cleaning.rank > PART_META.bar.rank, true);
  assert.equal(PART_META.cleaning.rank < PART_META.etc.rank, true);
});

test("getPartKey resolves cleaning explicitly and still falls back unknown values to etc (not kitchen)", () => {
  assert.equal(getPartKey("cleaning"), "cleaning");
  assert.equal(getPartKey("etc"), "etc");
  assert.equal(getPartKey("some-future-part"), "etc");
  assert.equal(getPartKey(null), "etc");
});

test("payroll UI part labels include cleaning in both languages", () => {
  const uiLabels = read("lib/payroll/ui-labels.ts");
  assert.match(uiLabels, /cleaning:"Vệ sinh"/);
  assert.match(uiLabels, /cleaning:"청소"/);
});

test("admin-users text carries cleaning/etc group labels for both languages", () => {
  const text = read("lib/text/admin-users.ts");
  const koStart = text.indexOf("ko: {");
  const viStart = text.indexOf("vi: {");
  const koBlock = text.slice(koStart, viStart);
  const viBlock = text.slice(viStart);
  assert.match(koBlock, /cleaningGroup: "청소"/);
  assert.match(koBlock, /etcGroup: "기타"/);
  assert.match(viBlock, /cleaningGroup: "Vệ sinh"/);
  assert.match(viBlock, /etcGroup: "Khác"/);
});

test("create page derives partOptions from the shared PART_VALUES instead of a separate hardcoded list missing etc", () => {
  const page = read("app/(protected)/admin/users/create/page.tsx");
  assert.match(page, /import \{ PART_VALUES \} from "@\/lib\/common\/parts";/);
  assert.match(page, /const partOptions = PART_VALUES;/);
  assert.doesNotMatch(page, /const partOptions = \["owner", "kitchen", "hall", "bar"\]/);
});

test("list page derives partOptions from the shared PART_VALUES and orders groups owner/kitchen/hall/bar/cleaning/etc/inactive", () => {
  const page = read("app/(protected)/admin/users/page.tsx");
  assert.match(page, /const partOptions = PART_VALUES;/);
  assert.match(
    page,
    /const groupOrder = \["owner", "kitchen", "hall", "bar", "cleaning", "etc", "inactive"\] as const;/
  );
});

test("list page's part grouping uses the shared getPartKey instead of falling unknown parts back to kitchen", () => {
  const page = read("app/(protected)/admin/users/page.tsx");
  assert.match(page, /return getPartKey\(user\.part\);/);
  // 예전 버그: 마지막 분기가 무조건 "kitchen"을 반환했다. 더 이상 없어야 한다.
  const groupFnStart = page.indexOf("function getUserGroup(");
  const groupFnEnd = page.indexOf("\n}", groupFnStart);
  const groupFnSource = page.slice(groupFnStart, groupFnEnd);
  assert.doesNotMatch(groupFnSource, /return "kitchen";/);
});

test("list page's group metadata reuses the shared getPartMeta for color/emoji instead of five duplicated branches", () => {
  const page = read("app/(protected)/admin/users/page.tsx");
  assert.match(page, /const meta = getPartMeta\(key\);/);
});
