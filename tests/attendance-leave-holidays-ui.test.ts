import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/attendance/leave/page.tsx");

// ---------------------------------------------------------------------------
// /attendance/leave — 기존 휴무 캘린더 로직(getCalendarCells/leaveCountByDate)을
// 건드리지 않고 holidayByDate라는 별도 Map만 추가한다. 공휴일은 비핵심 정보
// 레이어라 fetch 실패가 휴무 캘린더 자체를 막지 않아야 한다.
//
// 표시 정책: /api/attendance/holidays는 이제 BABA가 실제 "매장 영업 + 200% 적용"으로
// 선택한 날짜만 서버 단계에서 걸러 반환한다(store_holidays 전체가 아님) — 그래서
// 이 페이지는 응답을 그대로 믿고 추가 클라이언트 필터링을 하지 않는다. 아래 7개
// 시나리오는 이 계약을 명시적으로 검증한다:
//   1) 법정공휴일 + BABA 선택 → API가 반환 → 🇻🇳 마커 표시
//   2) 법정공휴일 + BABA 미선택 → API가 반환하지 않음 → 마커 없음
//   3) 평범한 날짜 → 마커 없음
//   4) 선택된 공휴일 + 승인된 휴무 → 마커와 승인 배지가 함께 표시
//   5) 선택된 공휴일 + 대기중 휴무 → 마커와 대기 배지가 함께 표시
//   6) 공휴일 fetch 실패 → 휴무 캘린더는 정상 렌더
//   7) payroll 계산 로직 변화 없음(공휴일 개념과 완전히 독립)
// ---------------------------------------------------------------------------

test("[scenario 6] holidays are fetched independently from users/leave records — its own request cache + its own useEffect, not folded into loadLeaveRecords", () => {
  assert.match(page, /const holidayRequests = new Map<string, Promise<Holiday\[\]>>\(\);/);
  assert.match(page, /function requestHolidays\(date: Date\) \{/);
  assert.match(page, /const loadHolidays = useCallback\(async \(date: Date\) => \{/);
  assert.match(page, /useEffect\(\(\) => \{\s*\n\s*void loadHolidays\(calendarDate\);\s*\n\s*\}, \[calendarDate, loadHolidays\]\);/);
});

test("holiday fetch reads /api/attendance/holidays (the public, server-filtered month endpoint), not the owner-only admin holidays API", () => {
  assert.match(page, /attendanceFetch\(`\/api\/attendance\/holidays\?month=\$\{month\}`\)/);
  assert.doesNotMatch(page, /\/api\/admin\/store-settings\/holidays/);
});

test("[scenario 6] a holiday fetch failure is non-blocking: console.warn only, leave calendar's own feedback/error state is never touched by it", () => {
  const fn = page.slice(page.indexOf("const loadHolidays = useCallback"), page.indexOf("useEffect(() => {\n    void loadHolidays"));
  assert.match(fn, /console\.warn\("fetch holidays error \(non-critical\):", error\);/);
  assert.doesNotMatch(fn, /setFeedback/);
});

test("[scenarios 1+2] holidayByDate trusts the API response as-is (every returned item is keyed in), with no extra client-side isEmployerSelected/internalPayMultiplier filter — the selection filtering is entirely the server's job (INNER JOIN in loadHolidaysForMonth), not duplicated here", () => {
  assert.match(
    page,
    /const holidayByDate = useMemo\(\(\) => \{\s*\n\s*const map = new Map<string, Holiday>\(\);\s*\n\s*holidays\.forEach\(\(holiday\) => map\.set\(holiday\.holidayDate, holiday\)\);\s*\n\s*return map;\s*\n\s*\}, \[holidays\]\);/
  );
  const memoBlock = page.slice(page.indexOf("const holidayByDate = useMemo"), page.indexOf("const holidayByDate = useMemo") + 300);
  assert.doesNotMatch(memoBlock, /internalPayMultiplier|isEmployerSelected/);
});

test("[scenario 3] calendar cell: a non-holiday day never renders the 🇻🇳 marker", () => {
  const cellBlock = page.slice(page.indexOf("const isHoliday = holidayByDate.has"), page.indexOf("</button>\n              );\n            })}"));
  assert.match(cellBlock, /\{isHoliday && \(/);
  assert.match(cellBlock, /🇻🇳/);
});

test("[scenario 1] calendar cell: holiday date number turns red and shares the same red as Sunday (no conflicting color rule), Saturday blue is overridden on a holiday", () => {
  const cellBlock = page.slice(page.indexOf("const isHoliday = holidayByDate.has"), page.indexOf("</button>\n              );\n            })}"));
  assert.match(cellBlock, /color: active\s*\n\s*\? "#ffffff"\s*\n\s*: isHoliday \|\| isSunday\s*\n\s*\? "#dc2626"/);
});

test("calendar cell: active (selected date, black background) always wins over the holiday background/border", () => {
  const cellBlock = page.slice(page.indexOf("const isHoliday = holidayByDate.has"), page.indexOf("</button>\n              );\n            })}"));
  assert.match(cellBlock, /borderColor: active\s*\n\s*\? "#111827"/);
  assert.match(cellBlock, /background: active\s*\n\s*\? "#111827"/);
  // holiday branch must come after pending/approved so approval badges still take the
  // background when both a holiday and a leave request exist on the same date.
  const borderIdx = cellBlock.indexOf("borderColor: active");
  const borderBlock = cellBlock.slice(borderIdx, cellBlock.indexOf("background: active"));
  const pendingIdx = borderBlock.indexOf("hasPending");
  const holidayIdx = borderBlock.indexOf("isHoliday");
  assert.ok(pendingIdx > -1 && holidayIdx > -1 && pendingIdx < holidayIdx);
});

test("[scenarios 4+5] the 🇻🇳 marker and the approved/pending count badges are two independent sibling elements in the same cell — neither is gated by the other, so a selected holiday with an approved or pending leave shows both at once", () => {
  const cellBlock = page.slice(page.indexOf("const isHoliday = holidayByDate.has"), page.indexOf("</button>\n              );\n            })}"));
  const markerBlock = cellBlock.slice(cellBlock.indexOf("<span>"), cellBlock.indexOf("{(hasApproved || hasPending) && ("));
  assert.match(markerBlock, /\{isHoliday && \(/);
  assert.doesNotMatch(markerBlock, /hasApproved|hasPending/);
  assert.match(cellBlock, /\{\(hasApproved \|\| hasPending\) && \(\s*\n\s*<span style=\{countGroupStyle\}>/);
  const badgeBlock = cellBlock.slice(cellBlock.indexOf("{(hasApproved || hasPending) && ("));
  assert.doesNotMatch(badgeBlock, /isHoliday/);
});

test("holiday marker style keeps the 34px cell height — small font, no extra block/line added", () => {
  assert.match(page, /const holidayFlagStyle: CSSProperties = \{\s*\n\s*fontSize: 8,\s*\n\s*lineHeight: 1,/);
  assert.match(page, /const emptyCalendarCellStyle: CSSProperties = \{\s*\n\s*height: 34,/);
  assert.match(page, /const calendarCellStyle: CSSProperties = \{\s*\n\s*height: 34,/);
});

test("[scenario 1] selected-date detail: a two-line holiday notice (🇻🇳 + localized name, then the BABA internal premium line) renders right after the date title, and is visually/semantically separate from leave request cards", () => {
  const detailBlock = page.slice(
    page.indexOf("{copy.selectedDate} · {selectedDate}"),
    page.indexOf("{isInitialLoading ? (")
  );
  assert.match(detailBlock, /\{selectedHoliday && \(/);
  assert.match(detailBlock, /<div>🇻🇳 \{lang === "vi" \? selectedHoliday\.nameVi : selectedHoliday\.nameKo\}<\/div>/);
  assert.match(detailBlock, /<div style=\{holidayPremiumLineStyle\}>\{copy\.holidayPremiumNotice\}<\/div>/);
});

test("holidayPremiumNotice copy (ko/vi) states the BABA-internal premium, never a legal/statutory rate name — checked on the actual copy values, not the design-rationale comments which legitimately explain what it is NOT", () => {
  assert.match(page, /holidayPremiumNotice: "매장 영업 · 200%"/);
  assert.match(page, /holidayPremiumNotice: "Mở cửa · 200%"/);
  const koLine = page.slice(page.indexOf('holidayPremiumNotice: "매장'), page.indexOf('holidayPremiumNotice: "매장') + 60);
  const viLine = page.slice(page.indexOf('holidayPremiumNotice: "Mở'), page.indexOf('holidayPremiumNotice: "Mở') + 60);
  for (const forbidden of ["statutoryPayRate", "legalPayMultiplier", "legallyPaid", "statutory200", "법정"]) {
    assert.doesNotMatch(koLine, new RegExp(forbidden, "i"));
    assert.doesNotMatch(viLine, new RegExp(forbidden, "i"));
  }
});

test("selectedHoliday derives from holidayByDate.get(selectedDate) — a plain lookup, no side effects", () => {
  assert.match(page, /const selectedHoliday = holidayByDate\.get\(selectedDate\);/);
});

test("holiday presence never gates or auto-triggers the leave request button, approval buttons, or cancel actions (no isHoliday/selectedHoliday check inside handleLeaveRequest/handleApproveLeave/handleCancelApproval/handleCancelPendingLeave)", () => {
  const handlerBounds: Array<[string, string]> = [
    ["const handleLeaveRequest = async", "const handleApproveLeave = async"],
    ["const handleApproveLeave = async", "const handleCancelApproval = async"],
    ["const handleCancelApproval = async", "const handleCancelPendingLeave = async"],
    ["const handleCancelPendingLeave = async", "const userMap = useMemo"],
  ];
  for (const [startMarker, endMarker] of handlerBounds) {
    const start = page.indexOf(startMarker);
    const end = page.indexOf(endMarker);
    assert.ok(start > -1 && end > start, `could not bound ${startMarker}`);
    const body = page.slice(start, end);
    assert.doesNotMatch(body, /isHoliday|selectedHoliday|holidayByDate/);
  }
});

test("Holiday type carries internalPayMultiplier (documented as always-set, since the API only ever returns BABA-selected dates) and has no attendance_record/leave-request fields — display-only shape mirroring the API response", () => {
  const typeBlock = page.slice(page.indexOf("type Holiday = {"), page.indexOf("const usersRequests"));
  assert.match(typeBlock, /holidayDate: string;/);
  assert.match(typeBlock, /nameKo: string;/);
  assert.match(typeBlock, /nameVi: string;/);
  assert.match(typeBlock, /internalPayMultiplier: number \| null;/);
  assert.doesNotMatch(typeBlock, /approval_status|work_date|user_id/);
});

test("[scenario 7] payroll calculation modules never reference holidays or the internal premium — the holiday feature stays a display-only layer, no payroll regression from this change", () => {
  const payrollDir = join(process.cwd(), "lib/payroll");
  let files: string[];
  try {
    files = readdirSync(payrollDir).filter((name) => name.endsWith(".ts"));
  } catch {
    files = [];
  }
  assert.ok(files.length > 0, "expected lib/payroll to contain modules");
  for (const file of files) {
    const content = read(`lib/payroll/${file}`);
    assert.doesNotMatch(content, /internalPayMultiplier|holiday/i, `${file} must not reference holidays`);
  }
});
