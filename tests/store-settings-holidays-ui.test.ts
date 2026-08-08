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
//
// 이번 파일이 추가로 검증하는 것(2026-08-09 개선):
//   - 1일짜리 공휴일은 자동 200%, 목록에서 굵게 + "(200%)" 표시.
//   - 아직 준비되지 않은 연도는 "준비" 버튼을 보여준다(코드 수정 없이 owner/master가
//     직접 만든다).
//   - 11월 이후 다음 연도 미준비 안내 배너.
// ---------------------------------------------------------------------------

function holidaysTabFn() {
  return page.slice(page.indexOf("function HolidaysTab"), page.indexOf("function PrepareHolidayYearModal"));
}

function prepareModalFn() {
  return page.slice(page.indexOf("function PrepareHolidayYearModal"), page.indexOf("function ConfirmScheduleModal"));
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
});

test("page imports the shared holidays-policy judge functions (isBabaPremiumHoliday/countHolidayGroupSizes) instead of reimplementing the effective-premium decision, and the FIXED_HOLIDAY_DEFINITIONS common definition for the prepare-year preview", () => {
  assert.match(
    page,
    /import \{\s*\n\s*FIXED_HOLIDAY_DEFINITIONS,\s*\n\s*getHolidayGroupLabel,\s*\n\s*\} from "@\/lib\/store-settings\/holidays-data";/
  );
  assert.match(
    page,
    /import \{ countHolidayGroupSizes, isBabaPremiumHoliday \} from "@\/lib\/store-settings\/holidays-policy";/
  );
});

test("HolidaysTab manages its own fetch (year, data, loading, error, busyHolidayId, prepareOpen, reminderYear) — it does not reuse the page-level ApiData/load()", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /const \[year, setYear\] = useState\(\(\) => new Date\(\)\.getFullYear\(\)\);/);
  assert.match(fn, /const \[data, setData\] = useState<HolidaysApiData \| null>\(null\);/);
  assert.match(fn, /const \[busyHolidayId, setBusyHolidayId\] = useState<number \| null>\(null\);/);
  assert.match(fn, /const \[prepareOpen, setPrepareOpen\] = useState<number \| null>\(null\);/);
  assert.match(fn, /const \[reminderYear, setReminderYear\] = useState<number \| null>\(null\);/);
  assert.match(fn, /fetch\(\s*\n?\s*`\/api\/admin\/store-settings\/holidays\?year=\$\{targetYear\}`/);
  assert.doesNotMatch(fn, /props\.data\.overview/);
});

test("year navigation exists (‹ / ›) and re-fetches on change", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /onClick=\{\(\) => setYear\(\(value\) => value - 1\)\}/);
  assert.match(fn, /onClick=\{\(\) => setYear\(\(value\) => value \+ 1\)\}/);
  assert.match(fn, /useEffect\(\(\) => \{\s*\n\s*void load\(year\);\s*\n\s*\}, \[year, load\]\);/);
});

test("top section shows a 'not prepared' notice + prepare button (mutate-gated) when calendar is null, instead of just an empty-state message", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /: !data\?\.calendar \? \(/);
  assert.match(fn, /\{t\.notPreparedPrefix\}\s*\n\s*\{year\}\s*\n\s*\{t\.notPreparedSuffix\}/);
  assert.match(fn, /onClick=\{\(\) => setPrepareOpen\(year\)\}/);
  assert.match(fn, /data\?\.capabilities\.mutate \? \(\s*\n\s*<button type="button" style=\{ui\.button\} onClick=\{\(\) => setPrepareOpen\(year\)\}>/);
});

test("top section renders the full legal holiday list from the server (MM/DD + localized name) only once calendar exists and holidays is non-empty, no status badge left over from the 202608080003 draft/confirmed concept", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /holidays\.map\(\(holiday\) => \{/);
  assert.match(fn, /\{monthDay\(holiday\.holidayDate\)\}/);
  assert.doesNotMatch(fn, /holidaysStatus|calendar\.status|calendar\?\.status/);
});

test("effective (200%) holidays render bold with a literal ' (200%)' suffix appended to the name — judged via the shared isBabaPremiumHoliday helper, not re-derived ad hoc", () => {
  const fn = holidaysTabFn();
  assert.match(
    fn,
    /const effective = isBabaPremiumHoliday\(\s*\n\s*holiday,\s*\n\s*groupSizes\.get\(holiday\.holidayGroup\) \?\? 0\s*\n\s*\);/
  );
  assert.match(fn, /style=\{effective \? styles\.holidayNameActive : undefined\}/);
  assert.match(fn, /\{effective \? " \(200%\)" : ""\}/);
});

test("groupSizes is computed once via countHolidayGroupSizes(holidays) and reused by both the top list and the toggle-active judgement — a single source of truth per render, not two divergent computations", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /const groupSizes = countHolidayGroupSizes\(holidays\);/);
  assert.equal((fn.match(/countHolidayGroupSizes\(/g) ?? []).length, 1);
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

test("copy has the not-prepared / prepare-button / November-reminder keys for both languages", () => {
  assert.match(page, /notPreparedPrefix: "아직 "/);
  assert.match(page, /notPreparedSuffix: "년 공휴일이 준비되지 않았습니다\."/);
  assert.match(page, /prepareButtonSuffix: "년 공휴일 준비"/);
  assert.match(page, /reminderPrefix: "⚠️ "/);
  assert.match(page, /reminderSuffix: "년 공휴일 설정이 아직 없습니다\."/);
  assert.match(page, /notPreparedPrefix: "Chưa chuẩn bị ngày lễ năm "/);
  assert.match(page, /prepareButtonPrefix: "Chuẩn bị ngày lễ năm "/);
  assert.match(page, /reminderPrefix: "⚠️ Chưa có cài đặt ngày lễ năm "/);
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

test("each date in a qualifying group renders its own toggle button (MM/DD), active judged via the shared isBabaPremiumHoliday helper (not raw internalPayMultiplier !== null), using the existing black 'active' visual style", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /const active = isBabaPremiumHoliday\(holiday, groupEntry\.items\.length\);/);
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

// ---------------------------------------------------------------------------
// 11월 이후 "다음 연도 준비" 안내 배너
// ---------------------------------------------------------------------------

test("November-onward reminder is judged on BABA's Asia/Ho_Chi_Minh calendar date (getVietnamDateParts), not the browser/server's local new Date() — month is 1-12 from that helper, so the check is >= 11 (not the 0-indexed >= 10 a raw Date.getMonth() would need)", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /const storeToday = getVietnamDateParts\(\);/);
  assert.match(fn, /if \(storeToday\.month < 11\) return;/);
  assert.match(fn, /const nextRealYear = storeToday\.year \+ 1;/);
  assert.match(fn, /`\/api\/admin\/store-settings\/holidays\?year=\$\{nextRealYear\}`/);
  assert.match(fn, /setReminderYear\(json\.calendar \? null : nextRealYear\);/);
  assert.doesNotMatch(fn, /now\.getMonth\(\)|now\.getFullYear\(\)|new Date\(\)\.getMonth/);
});

test("page imports getVietnamDateParts from the shared lib/common/business-time module — no new/duplicated timezone math written inline in the page", () => {
  assert.match(page, /import \{ getVietnamDateParts \} from "@\/lib\/common\/business-time";/);
});

test("the reminder judgement does NOT use a business-day-cutoff-aware function (calculateStoreBusinessDate/getBusinessDate) — this is a plain Vietnam calendar date check, not an operating-hours cutoff decision", () => {
  const fn = holidaysTabFn();
  const effectBlock = fn.slice(
    fn.indexOf("const storeToday = getVietnamDateParts();"),
    fn.indexOf("// 날짜 1개씩 즉시 저장한다")
  );
  assert.doesNotMatch(effectBlock, /calculateStoreBusinessDate|getBusinessDate/);
});

test("reminder fetch failure is swallowed silently (non-critical banner) — it must not set an error/feedback state that blocks the rest of the tab", () => {
  const fn = holidaysTabFn();
  const effectBlock = fn.slice(
    fn.indexOf("const storeToday = getVietnamDateParts();"),
    fn.indexOf("// 날짜 1개씩 즉시 저장한다")
  );
  assert.match(effectBlock, /catch \{\s*\n\s*\/\/ no-op\s*\n\s*\}/);
  assert.doesNotMatch(effectBlock, /setError\(/);
});

test("reminder banner renders only when reminderYear is set, offers a prepare button (mutate-gated), and hides once the year is prepared (existing data ⇒ no banner)", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /\{reminderYear !== null \? \(/);
  assert.match(fn, /\{t\.reminderPrefix\}\s*\n\s*\{reminderYear\}\s*\n\s*\{t\.reminderSuffix\}/);
  assert.match(fn, /onClick=\{\(\) => setPrepareOpen\(reminderYear\)\}/);
});

test("handlePrepareSuccess reloads the currently browsed year only if it matches the prepared year, and clears the reminder only if the prepared year matches it — no unconditional double-reload", () => {
  const fn = holidaysTabFn();
  assert.match(fn, /function handlePrepareSuccess\(preparedYear: number\) \{/);
  assert.match(fn, /if \(preparedYear === year\) void load\(year\);/);
  assert.match(fn, /if \(preparedYear === reminderYear\) setReminderYear\(null\);/);
});

// ---------------------------------------------------------------------------
// PrepareHolidayYearModal — 다음 연도 공휴일 준비
// ---------------------------------------------------------------------------

test("modal previews the 4 fixed holidays from FIXED_HOLIDAY_DEFINITIONS (no input needed for them) and only collects the 3 variable inputs (Hung Kings date, Tet start date, national day adjacent choice)", () => {
  const fn = prepareModalFn();
  assert.match(fn, /FIXED_HOLIDAY_DEFINITIONS\.map\(\(def\) => \(/);
  assert.match(fn, /const \[hungKingsDate, setHungKingsDate\] = useState\(""\);/);
  assert.match(fn, /const \[tetStartDate, setTetStartDate\] = useState\(""\);/);
  assert.match(fn, /const \[nationalDayOption, setNationalDayOption\] = useState<"before" \| "after" \| "">\(""\);/);
});

test("Tet is entered as a single start date and the other 4 dates are auto-computed via addDaysToDateKey — not 5 separate date inputs", () => {
  const fn = prepareModalFn();
  assert.match(
    fn,
    /const tetDates =\s*\n\s*tetStartDate\.length === 10\s*\n\s*\? Array\.from\(\{ length: 5 \}, \(_, index\) => addDaysToDateKey\(tetStartDate, index\)\)\s*\n\s*: \[\];/
  );
  assert.doesNotMatch(fn, /tetDates\[1\]|tetDates\[2\]|tetDates\[3\]|tetDates\[4\]/);
});

test("national day adjacent date is a binary choice (year-09-01 or year-09-03), 09-02 itself is always fixed and never asked", () => {
  const fn = prepareModalFn();
  assert.match(fn, /nationalDayOption === "before"\s*\n\s*\? `\$\{props\.year\}-09-01`/);
  assert.match(fn, /: nationalDayOption === "after"\s*\n\s*\? `\$\{props\.year\}-09-03`/);
  assert.doesNotMatch(fn, /09-02/);
});

test("submit is disabled unless Hung Kings date, all 5 Tet dates (within the target year), and a national day choice are all present", () => {
  const fn = prepareModalFn();
  assert.match(fn, /const canSubmit =\s*\n\s*hungKingsDate\.length === 10 &&\s*\n\s*tetDates\.length === 5 &&/);
  assert.match(fn, /tetDates\.every\(\(date\) => date\.startsWith\(String\(props\.year\)\)\)/);
  assert.match(fn, /nationalDayAdjacentDate\.length === 10 &&/);
  assert.match(fn, /disabled=\{!canSubmit\}/);
});

test("submit posts to /api/admin/store-settings/holidays/prepare-year with the full payload (year/hungKingsDate/tetDates/nationalDayAdjacentDate/sourceUrl/sourcePublishedAt) and calls onSuccess on ok", () => {
  const fn = prepareModalFn();
  assert.match(fn, /fetch\("\/api\/admin\/store-settings\/holidays\/prepare-year", \{/);
  assert.match(fn, /method: "POST",/);
  assert.match(fn, /year: props\.year,/);
  assert.match(fn, /hungKingsDate,/);
  assert.match(fn, /tetDates,/);
  assert.match(fn, /nationalDayAdjacentDate,/);
  assert.match(fn, /sourceUrl: sourceUrl\.trim\(\) \|\| null,/);
  assert.match(fn, /sourcePublishedAt: sourcePublishedAt \|\| null,/);
  assert.match(fn, /props\.onSuccess\(props\.year\);/);
});

test("YEAR_ALREADY_EXISTS is mapped to a distinct, clear conflict message (not the generic invalid message)", () => {
  const fn = prepareModalFn();
  assert.match(
    fn,
    /code === "YEAR_ALREADY_EXISTS"\s*\n\s*\? t\.prepareYearExists/
  );
});

test("source URL/published-at are optional fields (never required for canSubmit)", () => {
  const fn = prepareModalFn();
  const canSubmitBlock = fn.slice(fn.indexOf("const canSubmit ="), fn.indexOf("async function submit"));
  assert.doesNotMatch(canSubmitBlock, /sourceUrl|sourcePublishedAt/);
});

test("modal never touches attendance_records/leave/payroll and never creates a store_holiday_operation_policies row from the client (that stays server/RPC-only)", () => {
  const fn = prepareModalFn();
  assert.doesNotMatch(fn, /attendance_records|leave|payroll|store_holiday_operation_policies/i);
});
