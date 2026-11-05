import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync("app/(protected)/admin/ledger/entries/MonthCloseSheet.tsx", "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));

function sheetFixture({ vi = false, revision = 1, replies }) {
  const values = [], effects = [], calls = [];
  let cursor = 0;
  let closed = 0;
  const react = { ...React,
    useState(initial) {
      const slot = cursor++;
      if (!(slot in values)) values[slot] = initial;
      return [values[slot], next => { values[slot] = typeof next === "function" ? next(values[slot]) : next; }];
    },
    useEffect(effect) { effects.push(effect); },
    useCallback(callback) { return callback; },
  };
  const runtime = require("react/jsx-runtime");
  const testModule = { exports: {} };
  const deps = { react, "react/jsx-runtime": runtime,
    "@/components/bar/keeping/KeepingUi": { BarSheet: ({ children, footer, title }) => React.createElement("section", { role: "dialog", "aria-label": title }, children, footer), primaryButtonStyle: {}, secondaryButtonStyle: {} },
    "./entries.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
  };
  new Function("require", "module", "exports", "fetch", code)(name => deps[name], testModule, testModule.exports,
    async (url, options) => {
      calls.push({ url, options });
      const reply = replies.shift();
      assert.ok(reply, `Unexpected request: ${url}`);
      return Response.json(reply.body, { status: reply.status ?? 200 });
    });
  const props = { month: "2026-08", revision, vi, onClose() {}, async onClosed() { closed++; }, returnFocusRef: { current: null } };
  function render() {
    cursor = 0;
    effects.length = 0;
    const element = testModule.exports.default(props);
    const buttons = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
      visit(node.props?.footer);
    }
    visit(element);
    return { html: renderToStaticMarkup(element), buttons, effects: [...effects] };
  }
  return { render, calls, get closed() { return closed; } };
}

const check = (overrides = {}) => ({ month: "2026-08", state: "reopened", preflight: {
  canClose: true, blockers: [], warnings: [
    { code: "PAYABLE_OUTSTANDING", amount: 67_759_028 },
    { code: "BALANCE_ADJUSTMENT", count: 8 },
    { code: "RESERVE_SHORTFALL", count: 1 },
  ], preflightHash: "fresh-token", ...overrides,
} });

test("opening the sheet gets fresh preflight, renders localized warnings, and sends its hash", async () => {
  const fixture = sheetFixture({ replies: [
    { body: check() }, { body: { ok: true, result: { status: "closed", revision: 2 } } },
  ] });
  const initial = fixture.render();
  assert.match(initial.html, /장부를 점검 중입니다/);
  initial.effects[0]();
  await flush();
  const ready = fixture.render();
  assert.match(ready.html, /aria-label="8월 재마감"/);
  assert.match(ready.html, /마감 점검/);
  assert.match(ready.html, /당월 거래처 미납금<\/span><strong>67\.759\.028 ₫/);
  assert.match(ready.html, /잔액 조정 기록<\/span><strong>8건/);
  assert.match(ready.html, /임대료 준비금 미충족<\/span><strong>1건/);
  assert.match(ready.html, /1차 마감본은 이력으로 보존됩니다/);
  assert.match(ready.html, /마감 후에는 장부 수정이 제한됩니다/);
  assert.doesNotMatch(ready.html, /현재 장부 상태를 확인했습니다|예비금 부족/);
  assert.equal(ready.buttons.find(button => button.props.children === "마감 완료")?.props.disabled, false);
  ready.buttons.find(button => button.props.children === "마감 완료").props.onClick();
  await flush();
  assert.equal(fixture.calls[0].url, "/api/admin/ledger/month-close?month=2026-08");
  assert.deepEqual(JSON.parse(fixture.calls[1].options.body), { action: "close", month: "2026-08", expectedPreflightHash: "fresh-token" });
  assert.equal(fixture.closed, 1);
});

test("blockers prevent close; unknown codes have safe localized fallback", async () => {
  const fixture = sheetFixture({ vi: true, replies: [{ body: check({ canClose: false, blockers: [{ code: "EARLIER_MONTH_REOPENED" }, { code: "NEW_CODE" }], warnings: [{ code: "NEW_WARNING" }] }) }] });
  fixture.render().effects[0]();
  await flush();
  const ready = fixture.render();
  assert.match(ready.html, /Tháng trước đang được kiểm tra lại/);
  assert.match(ready.html, /Mục cần kiểm tra thêm/);
  assert.doesNotMatch(ready.html, /NEW_CODE|NEW_WARNING/);
  assert.equal(ready.buttons.find(button => button.props.children === "Hoàn tất chốt sổ")?.props.disabled, true);
  assert.equal(fixture.calls.length, 1);
});

test("payment verification blocker shows count and amount without a raw code", async () => {
  const fixture = sheetFixture({ replies: [{ body: check({ canClose: false, blockers: [{ code: "PAYMENT_VERIFICATION_UNRESOLVED", count: 3, amount: 2_450_000 }], warnings: [] }) }] });
  fixture.render().effects[0]();
  await flush();
  const ready = fixture.render();
  assert.match(ready.html, /결제 미확인 입고/);
  assert.match(ready.html, /3건 · 2\.450\.000 ₫/);
  assert.doesNotMatch(ready.html, /PAYMENT_VERIFICATION_UNRESOLVED/);
  assert.equal(ready.buttons.find(button => button.props.children === "마감 완료")?.props.disabled, true);
});

test("stale preflight shows guidance and refreshes the sheet before another close", async () => {
  const fixture = sheetFixture({ replies: [
    { body: check() },
    { status: 409, body: { code: "LEDGER_CLOSE_PREFLIGHT_STALE" } },
    { body: check({ preflightHash: "new-token", warnings: [] }) },
    { body: { ok: true } },
  ] });
  fixture.render().effects[0]();
  await flush();
  fixture.render().buttons.find(button => button.props.children === "마감 완료").props.onClick();
  await flush();
  const refreshed = fixture.render();
  assert.match(refreshed.html, /점검 이후 장부 내용이 변경되었습니다/);
  assert.doesNotMatch(refreshed.html, /LEDGER_CLOSE_PREFLIGHT_STALE/);
  assert.equal(fixture.calls[2].url, "/api/admin/ledger/month-close?month=2026-08");
  refreshed.buttons.find(button => button.props.children === "마감 완료").props.onClick();
  await flush();
  assert.equal(JSON.parse(fixture.calls[3].options.body).expectedPreflightHash, "new-token");
  assert.equal(fixture.closed, 1);
});

test("initial close keeps its own title and shares the completion label", async () => {
  const fixture = sheetFixture({ revision: null, replies: [{ body: { ...check(), state: "open" } }] });
  fixture.render().effects[0]();
  await flush();
  const ready = fixture.render();
  assert.match(ready.html, /aria-label="8월 월마감"/);
  assert.match(ready.html, /마감 완료/);
  assert.doesNotMatch(ready.html, /차 마감본은 이력으로 보존됩니다/);
});

test("Vietnamese reserve warning names the rent reserve", async () => {
  const fixture = sheetFixture({ vi: true, replies: [{ body: check() }] });
  fixture.render().effects[0]();
  await flush();
  const ready = fixture.render();
  assert.match(ready.html, /Chưa đủ quỹ dự phòng tiền thuê<\/span><strong>1 mục/);
  assert.match(ready.html, /Hoàn tất chốt sổ/);
});

const findButton = (buttons, testId) => buttons.find(button => {
  const child = button.props.children;
  return child && typeof child === "object" && child.props?.["data-testid"] === testId;
});

test("loading and closing show a centered spinner with screen-reader text; failure restores the button", async () => {
  for (const vi of [false, true]) {
    const fixture = sheetFixture({ vi, replies: [{ body: check() }, { status: 500, body: { code: "BOOM" } }] });
    const initial = fixture.render();
    assert.match(initial.html, /data-testid="month-close-loading"[^>]*role="status"|role="status"[^>]*data-testid="month-close-loading"/);
    assert.match(initial.html, /class="closeSpinner" aria-hidden="true"/);
    assert.match(initial.html, vi ? /<span class="srOnly">Đang kiểm tra sổ…<\/span>/ : /<span class="srOnly">장부를 점검 중입니다…<\/span>/);
    assert.doesNotMatch(initial.html, /reopenHelp/);
    initial.effects[0]();
    await flush();
    const ready = fixture.render();
    assert.doesNotMatch(ready.html, /month-close-loading/);
    const label = vi ? "Hoàn tất chốt sổ" : "마감 완료";
    ready.buttons.find(button => button.props.children === label).props.onClick();
    // While the close request is in flight: spinner, disabled close and cancel, no double submit.
    const closing = fixture.render();
    const busyButton = findButton(closing.buttons, "month-close-busy");
    assert.ok(busyButton, "busy spinner in the close button");
    assert.equal(busyButton.props.disabled, true);
    assert.equal(closing.buttons.find(button => button.props.children === (vi ? "Hủy" : "취소")).props.disabled, true);
    assert.match(closing.html, vi ? /<span class="srOnly">Đang chốt…<\/span>/ : /<span class="srOnly">마감 중…<\/span>/);
    assert.match(closing.html, /closeSpinner closeSpinnerOnDark/);
    busyButton.props.onClick();
    await flush();
    assert.equal(fixture.calls.length, 2, "second click while busy sends nothing");
    const failed = fixture.render();
    assert.match(failed.html, vi ? /Không thể chốt sổ/ : /장부를 마감하지 못했습니다/);
    assert.equal(failed.buttons.find(button => button.props.children === label).props.disabled, false);
    assert.doesNotMatch(failed.html, /month-close-busy|BOOM/);
    assert.equal(fixture.closed, 0);
  }
});

test("a failed preflight load hides the spinner and offers a retry", async () => {
  const fixture = sheetFixture({ replies: [{ status: 500, body: {} }] });
  fixture.render().effects[0]();
  await flush();
  const failed = fixture.render();
  assert.doesNotMatch(failed.html, /month-close-loading|closeSpinner/);
  assert.match(failed.html, /장부를 점검하지 못했습니다/);
  assert.ok(failed.buttons.some(button => button.props.children === "다시 점검"));
});

test('pending card fees display a warning and permit close without a fee-confirmation action',async()=>{
 const fixture=sheetFixture({replies:[{body:check({warnings:[{code:'CARD_FEE_PENDING',amount:6926797}]})}]});fixture.render().effects[0]();await flush();const ready=fixture.render();
 assert.match(ready.html,/6\.926\.797/);assert.match(ready.html,/당월 미정산 카드금액/);assert.equal(ready.buttons.find(b=>b.props.children==='\uB9C8\uAC10 \uC644\uB8CC').props.disabled,false);
});

test('verified unpaid, later-paid and reserve warnings allow close; earlier reopened months still block in both languages', async () => {
  for (const vi of [false, true]) {
    const warnings = [
      { code: 'PAYABLE_OUTSTANDING', amount: 1_410_000 },
      { code: 'PAYMENT_VERIFICATION_LATER_PAID', count: 1, amount: 1_101_600 },
      { code: 'RESERVE_SHORTFALL', count: 1 },
      { code: 'CARD_FEE_PENDING', amount: 6_926_797 },
    ];
    for (const earlierReopened of [false, true]) {
      const fixture = sheetFixture({ vi, replies: [{ body: check({ warnings,
        canClose: !earlierReopened, blockers: earlierReopened ? [{ code: 'EARLIER_MONTH_REOPENED' }] : [],
      }) }] });
      fixture.render().effects[0](); await flush();
      const ready = fixture.render();
      for (const amount of [/1\.410\.000 ₫/, /1\.101\.600 ₫/]) assert.match(ready.html, amount);
      assert.match(ready.html, vi ? /Công nợ nhà cung cấp trong tháng/ : /당월 거래처 미납금/);
      assert.match(ready.html, vi ? /Chưa thanh toán cuối tháng · Đã thanh toán sau đó/ : /월말 미지급 · 이후 지급완료/);
      assert.match(ready.html, vi ? /Doanh thu thẻ chưa được đối soát trong tháng/ : /당월 미정산 카드금액/);
      assert.match(ready.html, vi ? /Chưa đủ quỹ dự phòng tiền thuê/ : /임대료 준비금 미충족/);
      const button = ready.buttons.find(b => b.props.children === (vi ? 'Hoàn tất chốt sổ' : '마감 완료'));
      assert.equal(button.props.disabled, earlierReopened);
      if (earlierReopened) { button.props.onClick(); await flush(); }
      assert.equal(fixture.calls.length, 1, 'no close request during warning/guard display verification');
    }
  }
});
