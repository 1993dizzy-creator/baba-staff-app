import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { formatVietnamTime } from "../lib/common/business-time.ts";
import { attendanceText } from "../lib/text/attendance.ts";

const page = readFileSync("app/(protected)/admin/payroll/attendance/page.tsx", "utf8");
const external = createRequire(import.meta.url);
function evaluate(source, scope) {
  const output = ts.transpileModule(source, {
    fileName: "card.tsx",
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function("require", "exports", ...Object.keys(scope), output)(external, exports, ...Object.values(scope));
  return exports;
}
const records = [
  { id: 1, user_id: 8, user: { name: "Khoi" }, work_date: "2026-09-04", effectiveScheduleStart: "16:00", effectiveScheduleEnd: "01:00",
    actualCheckOutAt: "2026-09-04T16:00:00Z", peerAverageCheckOutAt: "2026-09-04T17:58:00Z", rawEarlyLeaveMinutes: 120, effectiveEarlyLeaveMinutes: 60 },
  { id: 2, user_id: 9, user: { name: "Triem" }, work_date: "2026-09-05", effectiveScheduleStart: "16:00", effectiveScheduleEnd: "01:00",
    actualCheckOutAt: "2026-09-05T16:00:00Z", peerAverageCheckOutAt: null, rawEarlyLeaveMinutes: 64, effectiveEarlyLeaveMinutes: 4 },
];
function renderCards(extra = {}) {
  const start = page.indexOf("{earlyLeaveReviewRecords.map");
  const end = page.indexOf("</div>)}", start) + "</div>)".length;
  const expression = page.slice(start + 1, end);
  const styles = [...new Set(expression.match(/\b\w+Style\b/g))].map(name => {
    const declarationStart = page.indexOf(`const ${name}: CSSProperties =`);
    const declarationEnd = page.indexOf("\n};", declarationStart) + 3;
    assert.ok(declarationStart >= 0, name);
    return page.slice(declarationStart, declarationEnd);
  }).join("\n");
  return evaluate(`${styles}\nexport const cards = (${expression});`, {
    earlyLeaveReviewRecords: records, processingRecordId: null, lang: "ko", c: { minute: "분" }, t: attendanceText.ko,
    formatVietnamTime, handleResolveEarlyLeave: () => {}, goDetailForDate: () => {}, ...extra,
  }).cards;
}
function buttons(element) {
  if (!element || typeof element !== "object") return [];
  if (element.type === "button") return [element];
  const children = element.props?.children;
  return (Array.isArray(children) ? children : [children]).flatMap(buttons);
}
function visibleText(element) { return renderToStaticMarkup(element).replace(/<[^>]*>/g, ""); }

test("actual card JSX renders three compact buttons with different real per-card values and concise checkout text", () => {
  const cards = renderCards();
  assert.deepEqual(cards.map(card => buttons(card).map(visibleText)), [
    ["120분 조퇴", "60분 조퇴", "상세보기"], ["64분 조퇴", "4분 조퇴", "상세보기"],
  ]);
  const text = cards.map(visibleText).join(" ");
  assert.match(text, /Khoi.*16:00~01:00.*2026-09-04/);
  assert.match(text, /퇴근 23:00.*평균 퇴근 00:58/);
  assert.match(text, /평균 퇴근 -/);
  assert.doesNotMatch(text, /원천|유효|허용|실제 퇴근|동일 근무시간/);
  assert.match(buttons(cards[1])[0].props["aria-label"], /원천 64분 적용/);
  assert.match(buttons(cards[1])[1].props["aria-label"], /유효 4분 적용/);
});

test("actual card clicks select only use_raw/use_effective and keep date-specific detail navigation", () => {
  const selections = [], details = [];
  const cards = renderCards({ handleResolveEarlyLeave: (...args) => selections.push(args), goDetailForDate: (...args) => details.push(args) });
  for (const card of cards) for (const button of buttons(card)) button.props.onClick();
  assert.deepEqual(selections, [[1, "use_raw"], [1, "use_effective"], [2, "use_raw"], [2, "use_effective"]]);
  assert.deepEqual(details, [[8, "2026-09-04"], [9, "2026-09-05"]]);
  const navigation = page.slice(page.indexOf("const goDetailForDate ="), page.indexOf("    return (", page.indexOf("const goDetailForDate =")));
  const pushed = [];
  evaluate(navigation + "\nexport { goDetailForDate };", { router: { push: (url) => pushed.push(url) } }).goDetailForDate(8, "2026-09-04");
  assert.equal(pushed[0], "/admin/payroll/attendance/8?month=2026-09&date=2026-09-04");
});

test("action row wraps naturally and only the existing mutation choices are disabled during processing", () => {
  const cards = renderCards({ processingRecordId: 1 });
  for (const card of cards) {
    const row = card.props.children[2];
    assert.equal(row.props.style.display, "flex");
    const group = row.props.children;
    assert.equal(group.props.style.flexWrap, "wrap");
    assert.equal(group.props.style.justifyContent, "flex-end");
    assert.equal(group.props.style.marginLeft, "auto");

    const [raw,effective] = buttons(card);
    assert.equal(raw.props.disabled, true);
    assert.equal(effective.props.disabled, true);
  }
  assert.doesNotMatch(page.slice(page.indexOf("{earlyLeaveReviewRecords.map"), page.indexOf("{unresolvedOpenRecords.length > 0")), /평균 적용|use_average/);
});

function resolutionHarness(fetch) {
  const calls = [], messages = [], states = [];
  let remaining = records;
  const guard = { current: false };
  const start = page.indexOf("const handleResolveEarlyLeave =");
  const end = page.indexOf("const handleAutoCorrect =", start);
  const { handleResolveEarlyLeave } = evaluate(page.slice(start,end) + "\nexport { handleResolveEarlyLeave };", {
    earlyLeaveResolutionRef: guard, processingRecordId: null, setProcessingRecordId: (value) => states.push(value),
    attendanceFetch: async (url,options) => { calls.push({ url, options }); return fetch(url,options); },
    setEarlyLeaveReviewRecords: (update) => { remaining = update(remaining); },
    fetchUnresolvedOpenRecords: async () => calls.push("review-refresh"),
    fetchMonthlyOverview: async () => calls.push("month-refresh"), lang: "ko", t: attendanceText.ko,
    alert: (message) => messages.push(message),
  });
  return { handleResolveEarlyLeave, calls, messages, states, guard, remaining: () => remaining };
}

for (const selection of ["use_raw", "use_effective"]) test(`${selection} uses the existing resolution API without client-supplied minutes, then refreshes`, async () => {
  const h = resolutionHarness(async () => ({ ok: true, json: async () => ({ ok: true }) }));
  await h.handleResolveEarlyLeave(1, selection);
  assert.equal(h.calls[0].url, "/api/attendance/admin");
  assert.equal(h.calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(h.calls[0].options.body), { action: "resolve_early_leave", attendance_id: 1, selection, lang: "ko" });
  assert.deepEqual(h.remaining().map(record => record.id), [2]);
  assert.deepEqual(h.calls.slice(1), ["review-refresh", "month-refresh"]);
  assert.deepEqual(h.states, [1,null]);
  assert.equal(h.guard.current, false);
});

test("paid-lock rejection keeps the card and displays the existing server error", async () => {
  const h = resolutionHarness(async () => ({ ok: false, json: async () => ({ ok: false, code: "PAYROLL_PAID_LOCKED", message: "급여 지급완료로 수정할 수 없습니다." }) }));
  await h.handleResolveEarlyLeave(1, "use_raw");
  assert.equal(h.remaining().length, 2);
  assert.deepEqual(h.messages, ["급여 지급완료로 수정할 수 없습니다."]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.states, [1,null]);
});

test("rapid double click sends one mutation even before React updates busy state", async () => {
  let resolveRequest;
  const h = resolutionHarness(() => new Promise(resolve => { resolveRequest = resolve; }));
  const pending = h.handleResolveEarlyLeave(1, "use_raw");
  await h.handleResolveEarlyLeave(1, "use_effective");
  assert.equal(h.calls.length, 1);
  resolveRequest({ ok: true, json: async () => ({ ok: true }) });
  await pending;
  assert.equal(h.guard.current, false);
});

for (const lang of ["ko", "vi"]) test(lang + " card actions have no decision label and keep button text unbroken", () => {
  const cards = renderCards({ lang, t: attendanceText[lang], c: { minute: lang === "vi" ? "phút" : "분" } });
  for (const card of cards) {
    assert.doesNotMatch(visibleText(card), /판정|Đánh giá/);
    assert.equal(card.props.children[2].props.children.type, "div");
    for (const button of buttons(card)) assert.equal(button.props.style.whiteSpace, "nowrap");
  }
});
