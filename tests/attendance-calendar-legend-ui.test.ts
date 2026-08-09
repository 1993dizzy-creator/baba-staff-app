import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const attendance = read("app/(protected)/attendance/page.tsx");
const detail = read("app/(protected)/admin/payroll/attendance/[userId]/page.tsx");

function styleBlock(source: string, name: string) {
  const start = source.indexOf(`const ${name}: CSSProperties = {`);
  const end = source.indexOf("};", start) + 2;
  return source.slice(start, end).replace(/\s+/g, " ");
}

test("both attendance calendars use the same compact two-by-two legend styles", () => {
  for (const name of ["calendarHeaderRow", "calendarLegendStyle", "legendItemStyle", "legendDotStyle"]) {
    assert.equal(styleBlock(attendance, name), styleBlock(detail, name));
  }
  const legend = styleBlock(attendance, "calendarLegendStyle");
  assert.match(legend, /display: "grid"/);
  assert.match(legend, /gridTemplateColumns: "repeat\(2, max-content\)"/);
  assert.match(legend, /justifyContent: "end"/);
  assert.match(legend, /columnGap: 8/);
  assert.match(legend, /rowGap: 3/);
  assert.match(legend, /paddingInlineEnd: 6/);
  assert.doesNotMatch(legend, /flexWrap|gap: 14/);
});

test("legend text and dots are compact while labels and colors remain unchanged", () => {
  const item = styleBlock(attendance, "legendItemStyle");
  const dot = styleBlock(attendance, "legendDotStyle");
  assert.match(item, /gap: 4/);
  assert.match(item, /fontSize: 11/);
  assert.match(item, /lineHeight: 1\.15/);
  assert.match(item, /whiteSpace: "nowrap"/);
  assert.match(dot, /width: 6/);
  assert.match(dot, /height: 6/);
  for (const source of [attendance, detail]) {
    assert.match(source, /<LegendItem label=\{t\.workNormal\} color="#10b981" \/>/);
    assert.match(source, /<LegendItem label=\{t\.workLate\} color="#f59e0b" \/>/);
    assert.match(source, /<LegendItem label=\{t\.workEarlyLeave\} color="#ef4444" \/>/);
    assert.match(source, /<LegendItem label=\{t\.workLeave\} color="#6b7280" \/>/);
  }
});
