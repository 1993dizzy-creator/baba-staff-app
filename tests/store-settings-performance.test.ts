import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const page = readFileSync(
  join(process.cwd(), "app/(protected)/admin/settings/store/page.tsx"),
  "utf8"
);

const mainPage = page.slice(
  page.indexOf("export default function StoreSettingsPage"),
  page.indexOf("function HoursTab")
);
const holidaysTab = page.slice(
  page.indexOf("function HolidaysTab"),
  page.indexOf("function PrepareHolidayYearModal")
);

test("store settings language changes update the fallback without refetching server data", () => {
  assert.match(mainPage, /const failedTextRef = useRef\(t\.failed\);\s*failedTextRef\.current = t\.failed;/);
  assert.match(mainPage, /catch \{\s*setError\(failedTextRef\.current\);\s*\}\s*\}, \[\]\);/);
  assert.match(mainPage, /useEffect\(\(\) => \{\s*void load\(\);\s*\}, \[load\]\);/);
  assert.doesNotMatch(mainPage, /\}, \[t\.failed\]\);/);
});

test("store settings mutations still refresh while audit remains lazy", () => {
  assert.match(mainPage, /method: "POST"[\s\S]*?await load\(\);/);
  assert.match(mainPage, /method: "DELETE"[\s\S]*?await load\(\);/);
  assert.match(mainPage, /async function toggleHistory\(\)[\s\S]*?\/api\/admin\/store-settings\/audit/);
  const initialEffect = mainPage.match(/useEffect\(\(\) => \{\s*void load\(\);\s*\}, \[load\]\);/)?.[0] ?? "";
  assert.doesNotMatch(initialEffect, /audit/);
});

test("holiday language changes keep the latest fallback without refetching the selected year", () => {
  assert.match(holidaysTab, /const holidaysFailedTextRef = useRef\(t\.holidaysFailed\);\s*holidaysFailedTextRef\.current = t\.holidaysFailed;/);
  assert.match(holidaysTab, /catch \{\s*setError\(holidaysFailedTextRef\.current\);\s*\} finally/);
  assert.match(holidaysTab, /\},\s*\[\]\s*\);/);
  assert.doesNotMatch(holidaysTab, /\[t\.holidaysFailed\]/);
});

test("holiday year and mutations retain their required refreshes", () => {
  assert.match(holidaysTab, /useEffect\(\(\) => \{\s*void load\(year\);\s*\}, \[year, load\]\);/);
  assert.match(holidaysTab, /method: "POST"[\s\S]*?await load\(year\);/);
  assert.match(holidaysTab, /if \(preparedYear === year\) void load\(year\);/);
  assert.match(holidaysTab, /const storeToday = getVietnamDateParts\(\);/);
  assert.match(holidaysTab, /if \(storeToday\.month < 11\) return;/);
});
