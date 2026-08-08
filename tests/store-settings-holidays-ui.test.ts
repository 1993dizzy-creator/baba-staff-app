import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/settings/store/page.tsx");

// ---------------------------------------------------------------------------
// /admin/settings/store — 세 번째 탭 "공휴일 / Ngày lễ". store_setting_versions와
// 독립된 원본이므로 HolidaysTab은 페이지 상단 data/load()와 별도로 자체 fetch를
// 관리한다. 음력설 묶음 선택(tetOption/TET_OPTIONS) UX는 완전히 제거되었고, 대신
// holiday_group별 2일 이상인 그룹만 날짜 단위 토글 버튼을 보여준다.
// ---------------------------------------------------------------------------

function holidaysTabFn() {
  return page.slice(page.indexOf("function HolidaysTab"), page.indexOf("function ConfirmScheduleModal"));
}

test("holidays tab is wired independently of the hours/attendance data gate — it renders as soon as tab==='holidays', not gated behind `data &&`", () => {
  assert.match(page, /\{tab === "holidays" \? <HolidaysTab lang=\{lang\} \/> : null\}/);
});

test("StoreHoliday type carries internalPayMultiplier (null = BABA 200% not applied), not a legal/statutory field name", () => {
  const typeDef = page.slice(page.indexOf("type StoreHoliday = {"), page.indexOf("type StoreHolidayCalendar = {"));
  assert.match(typeDef, /internalPayMultiplier: number \| null;/);
  for (const forbidden of ["statutoryPayRate", "legalPayMultiplier", "legallyPaid", "statutory200"]) {
    assert.doesNotMatch(typeDef, new RegExp(forbidden, "i"));
  }
});

test("StoreHolidayCalendar is now just { year, countryCode } — no status/tetOption/confirmedBy fields left over from the old bundle-selection design", () => {
  const typeDef = page.slice(page.indexOf("type StoreHolidayCalendar = {"), page.indexOf("type HolidaysApiData = {"));
  assert.match(typeDef, /year: number;/);
  assert.match(typeDef, /countryCode: string;/);
  assert.doesNotMatch(typeDef, /status|tetOption|confirmedBy|confirmedAt|nationalDayAdjacentDate/i);
});

test("the old Tet bundle-selection contract is completely gone from the page (no TET_OPTIONS/getTetOptionDates import, no tetOption anywhere)", () => {
  assert.doesNotMatch(page, /TET_OPTIONS|getTetOptionDates|TetOption|isTetOption/);
  assert.doesNotMatch(page, /tetOption/i);
  assert.match(page, /import \{ getHolidayGroupLabel \} from "@\/lib\/store-settings\/holidays-data";/);
});

test("HolidaysTab manages its own fetch (year, data, loading, error, busyHolidayId) — it does not reuse the page-level ApiData/load()", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /const \[year, setYear\] = useState\(\(\) => new Date\(\)\.getFullYear\(\)\);/);
  assert.match(fn, /const \[data, setData\] = useState<HolidaysApiData \| null>\(null\);/);
  assert.match(fn, /const \[busyHolidayId, setBusyHolidayId\] = useState<number \| null>\(null\);/);
  assert.match(fn, /fetch\(\s*\n?\s*`\/api\/admin\/store-settings\/holidays\?year=\$\{targetYear\}`/);
  assert.doesNotMatch(fn, /props\.data\.overview/);
});

test("year navigation exists (‹ / ›) and re-fetches on change", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /onClick=\{\(\) => setYear\(\(value\) => value - 1\)\}/);
  assert.match(fn, /onClick=\{\(\) => setYear\(\(value\) => value \+ 1\)\}/);
  assert.match(fn, /useEffect\(\(\) => \{\s*\n\s*void load\(year\);\s*\n\s*\}, \[year, load\]\);/);
});

test("top section always renders the full legal holiday list from the server (MM/DD + localized name), no status badge — the 202608080003 draft/confirmed status concept is gone from the UI", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /holidays\.map\(\(holiday\) => \(/);
  assert.match(fn, /\{monthDay\(holiday\.holidayDate\)\}/);
  assert.match(fn, /\{props\.lang === "vi" \? holiday\.nameVi : holiday\.nameKo\}/);
  assert.doesNotMatch(fn, /holidaysStatus|calendar\.status|calendar\?\.status/);
});

test("copy no longer has the old status/tet/national-day-specific keys", () => {
  for (const removedKey of [
    "holidaysStatus:",
    "holidaysStatusDraft:",
    "holidaysStatusConfirmed:",
    "tetTitle:",
    "tetUnselected:",
    "tetConfirm:",
    "tetSaving:",
    "nationalDayTitle:",
    "nationalDaySelected:",
  ]) {
    assert.doesNotMatch(page, new RegExp(removedKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("copy has the new BABA-internal-policy keys (ko/vi), and description text never implies a legal/statutory rate", () => {
  assert.match(page, /operationPolicyTitle: "BABA 200% 적용일"/);
  assert.match(page, /operationPolicyDescription: "선택한 날짜는 매장 영업 및 내부 200% 적용일로 관리됩니다\."/);
  assert.match(page, /operationPolicySaving: "저장 중…"/);
  assert.match(page, /dayCountSuffix: "일"/);
  assert.match(page, /operationPolicyTitle: "Ngày áp dụng 200% nội bộ BABA"/);
  assert.match(page, /operationPolicySaving: "Đang lưu…"/);
  assert.match(page, /dayCountSuffix: "ngày"/);
  for (const forbidden of ["법정", "statutory", "legal"]) {
    const descLine = page.slice(page.indexOf('operationPolicyDescription: "선택한'), page.indexOf('operationPolicyDescription: "선택한') + 120);
    assert.doesNotMatch(descLine, new RegExp(forbidden, "i"));
  }
});

test("groups with 2+ dates in the year get an individual per-date toggle grid; groups with exactly 1 date (New Year/Hung Kings/Reunification/Labor Day) get no selection UI at all", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /if \(items\.length < 2\) continue;/);
});

test("group labels come from getHolidayGroupLabel with a per-group fallback to the holiday's own localized name — not a hardcoded switch", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /const fallbackName = props\.lang === "vi" \? sorted\[0\]\.nameVi : sorted\[0\]\.nameKo;/);
  assert.match(fn, /label: getHolidayGroupLabel\(group, props\.lang, fallbackName\),/);
});

test("selection section only renders when at least one qualifying group exists, and shows the group header as 'label · N일/ngày'", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /\{selectableGroups\.length > 0 \? \(/);
  assert.match(fn, /\{groupEntry\.label\} · \{groupEntry\.items\.length\}\{t\.dayCountSuffix\}/);
});

test("each date in a qualifying group renders its own toggle button (MM/DD), active = internalPayMultiplier !== null, using the existing black 'active' visual style", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /const active = holiday\.internalPayMultiplier !== null;/);
  assert.match(fn, /\.\.\.\(active \? styles\.holidayToggleButtonActive : null\)/);
  assert.match(fn, /\{isBusy \? t\.operationPolicySaving : monthDay\(holiday\.holidayDate\)\}/);
});

test("holidayToggleButtonActive reuses the existing black 'active' style (border/background #111827), not a new color scheme", () => {
  const styleBlock = page.slice(page.indexOf("holidayToggleButtonActive: {"), page.indexOf("holidayToggleButtonActive: {") + 200);
  assert.match(styleBlock, /border: "1px solid #111827"/);
  assert.match(styleBlock, /background: "#111827"/);
});

test("clicking a toggle button saves immediately (POST {holidayId, selected}) and reloads — no batch dirty-state, no confirm dialog for a single-date toggle", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /if \(busyHolidayId !== null \|\| !data\?\.capabilities\.mutate\) return;/);
  assert.match(fn, /setBusyHolidayId\(holiday\.id\);/);
  assert.match(fn, /method: "POST",/);
  assert.match(
    fn,
    /body: JSON\.stringify\(\{\s*\n\s*holidayId: holiday\.id,\s*\n\s*selected: holiday\.internalPayMultiplier === null,\s*\n\s*\}\),/
  );
  assert.match(fn, /await load\(year\);/);
  assert.doesNotMatch(fn, /window\.confirm/);
});

test("only one date can be in-flight at a time (busyHolidayId is a single id, not a Set) — every button is disabled while any save is in progress, matching the previous single-flight save pattern", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /const disabled = busyHolidayId !== null \|\| !data\?\.capabilities\.mutate;/);
});

test("HolidaysTab never touches attendance_records, leave requests, or payroll — display/toggle-only per the design principle", () => {
  const fn = holidaysTabFn();
  assert.doesNotMatch(fn, /attendance_records|leave|payroll/i);
});

test("mobile: the 3 tabs still share the existing flex:1 subNavTab layout — no new tab-specific width override that could break the one-row layout", () => {
  assert.match(page, /subNavTab: \{[\s\S]*?flex: 1,/);
  const tabsRenderBlock = page.slice(page.indexOf("<nav style={styles.subNav}"), page.indexOf("</nav>"));
  assert.doesNotMatch(tabsRenderBlock, /tab === "holidays" \? \{/);
});
