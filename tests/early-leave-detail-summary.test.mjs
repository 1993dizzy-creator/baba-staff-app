import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { formatVietnamTime } from "../lib/common/business-time.ts";
import { attendanceText } from "../lib/text/attendance.ts";

const external = createRequire(import.meta.url);
const path = "app/(protected)/admin/payroll/attendance/[userId]/page.tsx";
const page = readFileSync(path, "utf8");
function renderReview(review, extra = {}) {
  const start = page.indexOf("{record.early_leave_review &&");
  const end = page.indexOf("{isLongShift ?", start);
  const expression = page.slice(start + 1, end).trim().slice(0,-1);
  const styles = [...new Set(expression.match(/\b\w+Style\b/g))].map(name => {
    const declarationStart = page.indexOf(`const ${name}: CSSProperties =`);
    return page.slice(declarationStart, page.indexOf("\n};",declarationStart) + 3);
  }).join("\n");
  const code = ts.transpileModule(`${styles}\nexport const view = (${expression});`, {
    fileName: "review.tsx", compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const record = { id: 8, check_out_at: "2026-09-04T16:00:00Z", early_leave_review: review,
    early_leave_display_context: { peerAverageCheckOutAt: "2026-09-04T17:58:00Z" } };
  const scope = { record, formatVietnamTime, lang: "ko", t: attendanceText.ko, c: { minute: "분" }, isSaving: false,
    onResolveEarlyLeave: () => {}, ...extra };
  const exports = {};
  new Function("require", "exports", ...Object.keys(scope), code)(external, exports, ...Object.values(scope));
  return exports.view;
}
const baseReview = { rawEarlyLeaveMinutes: 120, effectiveEarlyLeaveMinutes: 60, earlyLeaveGraceMinutes: 60 };
const text = view => renderToStaticMarkup(view).replace(/<[^>]*>/g, "");

for (const [selection, expected] of [["use_raw",120],["use_effective",60]]) {
  test(`confirmed ${selection} renders four information lines and the existing selected value`, () => {
    const view = renderReview({ ...baseReview, earlyLeaveReviewRequired: false, earlyLeaveSelection: selection });
    assert.equal(view.props.children.filter(Boolean).length, 4);
    assert.equal(text(view), `당일 평균 퇴근시간: 00:58마감시간 기준 조퇴: 120분허용시간 적용 조퇴: 60분적용된 조퇴 판정 시간: ${expected}분`);
    assert.doesNotMatch(text(view), /퇴근:|23:00|원천|유효|확정된 적용 기준/);
    assert.equal(view.props.children[3].props.style.fontWeight, 800);
  });
}

test("pending review displays unconfirmed and retains both original selection buttons and their real values", () => {
  const calls = [];
  const view = renderReview({ ...baseReview, rawEarlyLeaveMinutes: 64, effectiveEarlyLeaveMinutes: 4,
    earlyLeaveReviewRequired: true, earlyLeaveSelection: null }, { onResolveEarlyLeave: (...args) => calls.push(args) });
  const [average,raw,effective,applied,actions] = view.props.children;
  assert.equal(text(raw), "마감시간 기준 조퇴: 64분");
  assert.equal(text(effective), "허용시간 적용 조퇴: 4분");
  assert.equal(text(average), "당일 평균 퇴근시간: 00:58");
  assert.equal(text(applied), "적용된 조퇴 판정 시간: 미확정");
  assert.equal(actions.props.style.flexWrap, "wrap");
  assert.deepEqual(actions.props.children.map(button => text(button)), ["원천 64분 적용","유효 4분 적용"]);
  for (const button of actions.props.children) button.props.onClick();
  assert.deepEqual(calls, [[8,"use_raw"],[8,"use_effective"]]);
});

test("no comparison peer shows dash; saved-state disables pending choices", () => {
  const pending = { ...baseReview, earlyLeaveReviewRequired: true, earlyLeaveSelection: null };
  const view = renderReview(pending, { isSaving: true, record: { id: 8, check_out_at: "2026-09-04T16:00:00Z", early_leave_review: pending, early_leave_display_context: null } });
  assert.equal(text(view.props.children[0]), "당일 평균 퇴근시간: -");
  assert.ok(view.props.children[4].props.children.every(button => button.props.disabled));
});

test("banner removes decision labels and wraps its right-aligned button group", () => {
  const banner = readFileSync("app/(protected)/admin/payroll/attendance/page.tsx", "utf8");
  assert.doesNotMatch(banner, /earlyLeaveDecisionLabelStyle|Đánh giá/);
  assert.match(banner, /const earlyLeaveDecisionButtonsStyle[\s\S]*?flexWrap: "wrap"[\s\S]*?justifyContent: "flex-end"[\s\S]*?marginLeft: "auto"/);
});

test("Vietnamese summary uses short labels and localized minutes without forcing nowrap or clipping", () => {
  const view = renderReview({ ...baseReview, earlyLeaveReviewRequired: false, earlyLeaveSelection: "use_effective" },
    { lang: "vi", t: attendanceText.vi, c: { minute: "phút" } });
  assert.equal(text(view), "TB tan ca hôm đó: 00:58Về sớm theo giờ kết ca: 120 phútVề sớm sau miễn trừ: 60 phútThời gian về sớm áp dụng: 60 phút");
  assert.equal(view.props.style.fontSize, 11);
  assert.equal(view.props.style.whiteSpace, undefined);
  assert.equal(view.props.style.overflow, undefined);
});
