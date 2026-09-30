import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const transpile = (path, jsx = false) => ts.transpileModule(readFileSync(path, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: jsx ? ts.JsxEmit.ReactJSX : undefined },
}).outputText;
const helper = { exports: {} };
new Function("require", "module", "exports", transpile("lib/ledger/manual-display-history.ts"))(
  require, helper, helper.exports,
);
const projection = helper.exports.projectManualDisplayHistory;
const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const css = readFileSync("app/(protected)/admin/ledger/entries/entries.module.css", "utf8");
const routeCode = transpile("app/api/admin/ledger/transactions/[id]/display-history/route.ts");
const componentCode = transpile("app/(protected)/admin/ledger/entries/ManualDisplayHistory.tsx", true);
const flush = () => new Promise(resolve => setImmediate(resolve));

function routeFixture({ rows = [], transaction = { id: 81, type: "expense", status: "confirmed", source_type: "manual", correction_of_id: null }, allowed = true } = {}) {
  const calls = [];
  const client = {
    from(table) {
      const filters = [];
      const orders = [];
      const call = { table, filters, orders, columns: "", page: null };
      calls.push(call);
      const query = {
        select(columns) { call.columns = columns; return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        in(column, values) { filters.push([column, values]); return query; },
        order(column, options) { orders.push([column, options]); return query; },
        range(from, to) { call.page = [from, to]; return query; },
        async maybeSingle() {
          return { data: table === "ledger_transactions" ? transaction : null, error: null };
        },
        then(resolve, reject) {
          const data = rows.filter(row => filters.every(([column, value]) => Array.isArray(value) ? value.includes(row[column]) : row[column] === value))
            .toSorted((a, b) => {
              const byTime = b.created_at.localeCompare(a.created_at);
              return byTime || b.id - a.id;
            });
          const page = call.page ? data.slice(call.page[0], call.page[1] + 1) : data;
          return Promise.resolve({ data: page, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const deps = {
    "@/lib/ledger/server": {
      async requireLedgerActor() {
        return allowed ? { actor: { id: 1, role: "owner" }, response: null }
          : { actor: null, response: { status: 403, body: { ok: false, code: "FORBIDDEN" } } };
      },
      ledgerJson(body, status = 200) { return { body, status }; },
    },
    "@/lib/ledger/manual-display-history": helper.exports,
    "@/lib/supabase/server": { supabaseServer: client },
  };
  const testModule = { exports: {} };
  new Function("require", "module", "exports", routeCode)(
    name => deps[name], testModule, testModule.exports,
  );
  const get = id => testModule.exports.GET(new Request("http://localhost/"), { params: Promise.resolve({ id: String(id) }) });
  return { get, calls };
}

function audit({ id, entityId = 81, action = "manual_transaction_display_edited", createdAt, before, after, reason, actor = { name: "Cho", full_name: null, username: "cho" } }) {
  return {
    id, entity_type: "transaction", entity_id: entityId, action,
    created_at: createdAt, before_snapshot: before, after_snapshot: after,
    reason, actor, secret: "must-not-leak",
  };
}

const both = audit({
  id: 5, createdAt: "2026-09-29T12:00:00+07:00", reason: "둘 다 수정",
  before: { display_snapshot: { titleOverride: "기존 제목" }, memo: "기존 메모", amount: 900000 },
  after: { display_snapshot: { titleOverride: "새 제목" }, memo: "새 메모", amount: 900000 },
});
const titleOnly = audit({
  id: 4, createdAt: "2026-09-29T11:00:00+07:00", reason: "제목 오타",
  before: { display_snapshot: {}, memo: "기존 메모" },
  after: { display_snapshot: { titleOverride: "기존 제목" }, memo: "기존 메모" },
});
const memoOnly = audit({
  id: 3, createdAt: "2026-09-29T10:00:00+07:00", reason: "메모 보정",
  before: { display_snapshot: { titleOverride: "같은 제목" }, memo: null },
  after: { display_snapshot: { titleOverride: "같은 제목" }, memo: "기존 메모" },
});

test("zero history returns an empty list; invalid and non-manual targets are rejected", async () => {
  const empty = routeFixture();
  assert.deepEqual((await empty.get(81)).body.history, []);
  assert.equal((await empty.get(0)).status, 400);
  assert.deepEqual(empty.calls[1].filters, [["entity_type", "transaction"], ["entity_id", 81], ["action", ["manual_transaction_display_edited", "manual_transaction_edited"]]]);
  const automatic = routeFixture({ transaction: { ...{ id: 81, type: "expense", status: "confirmed" }, source_type: "automatic", correction_of_id: null } });
  assert.equal((await automatic.get(81)).status, 404);
  assert.equal(automatic.calls.length, 1);
  const denied = routeFixture({ allowed: false });
  assert.equal((await denied.get(81)).status, 403);
  assert.equal(denied.calls.length, 0);
});

test("history API selects only target display edits, returns newest first and strips raw snapshots", async () => {
  const otherAction = audit({ id: 6, action: "manual_transaction_created", createdAt: "2026-09-29T13:00:00+07:00", before: {}, after: {}, reason: "excluded" });
  const otherTransaction = audit({ id: 7, entityId: 82, createdAt: "2026-09-29T14:00:00+07:00", before: {}, after: {}, reason: "excluded" });
  const ui = routeFixture({ rows: [memoOnly, otherTransaction, titleOnly, otherAction, both] });
  const result = await ui.get(81);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.history.map(item => item.reason), ["둘 다 수정", "제목 오타", "메모 보정"]);
  assert.deepEqual(result.body.history.map(item => item.actorName), ["Cho", "Cho", "Cho"]);
  assert.deepEqual(result.body.history[0], {
    createdAt: both.created_at, actorName: "Cho", reason: "둘 다 수정",
    beforeTitle: "기존 제목", afterTitle: "새 제목",
    beforeMemo: "기존 메모", afterMemo: "새 메모",
  });
  assert.equal(result.body.history[1].beforeTitle, null, "missing old title override is not guessed");
  assert.equal(result.body.history[1].beforeMemo, result.body.history[1].afterMemo);
  assert.equal(result.body.history[2].beforeTitle, result.body.history[2].afterTitle);
  assert.equal(result.body.history[2].beforeMemo, null);
  assert.doesNotMatch(JSON.stringify(result.body), /before_snapshot|after_snapshot|secret|amount/);
  assert.deepEqual(ui.calls[1].orders, [["created_at", { ascending: false }], ["id", { ascending: false }]]);
  assert.match(ui.calls[1].columns, /actor:users!ledger_audit_logs_actor_user_id_fkey/);
});

function listMarkup(history, lang = "ko") {
  const deps = {
    react: React,
    "react/jsx-runtime": require("react/jsx-runtime"),
    "./entries.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
  };
  const testModule = { exports: {} };
  new Function("require", "module", "exports", componentCode)(
    name => deps[name], testModule, testModule.exports,
  );
  return renderToStaticMarkup(React.createElement(testModule.exports.ManualDisplayHistoryList, { history, lang }));
}

test("history renders compact cards with only before and after values", () => {
  assert.equal(listMarkup([]), "");
  const rows = [both, titleOnly, memoOnly].map(projection);
  rows[0] = {
    ...rows[0], createdAt: "2026-09-29T09:36:00Z", actorName: "HAN",
    reason: "내용추가", beforeTitle: "이전 제목", afterTitle: "변경 제목",
    beforeMemo: "이전 메모", afterMemo: "변경 메모",
  };
  rows[1] = { ...rows[1], reason: "제목 보정", beforeTitle: null, afterTitle: "새 제목" };
  rows[2] = { ...rows[2], reason: "메모 보정", beforeMemo: null, afterMemo: "새 메모" };
  const html = listMarkup(rows);
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /<details[^>]* open=/);
  assert.ok(html.includes("수정 이력 · 3건"));
  const articles = html.split("<article").slice(1);
  assert.equal(articles.length, 3);
  assert.ok(articles[0].includes('manualDisplayHistoryCardTitle">제목·메모 수정</strong>'));
  assert.ok(articles[1].includes('manualDisplayHistoryCardTitle">제목 수정</strong>'));
  assert.ok(articles[2].includes('manualDisplayHistoryCardTitle">메모 수정</strong>'));
  assert.ok(articles[0].includes('title="내용추가">내용추가</span><span class="manualDisplayHistoryByline"><strong>HAN</strong><span aria-hidden="true">·</span><time dateTime="2026-09-29T09:36:00Z">09.29 16:36</time>'));
  assert.ok(!articles[0].includes(">2026"));
  for (const reason of ["내용추가", "제목 보정", "메모 보정"]) {
    assert.ok(html.includes('class="manualDisplayHistoryReason" title="' + reason + '">' + reason + '</span>'));
  }
  const oldToNew = (before, after) => 'manualDisplayHistoryBefore">' + before + '</span><span class="manualDisplayHistoryArrow" aria-hidden="true">↓</span><span class="manualDisplayHistoryAfter">' + after + '</span>';
  assert.ok(articles[0].includes(oldToNew("이전 제목", "변경 제목")));
  assert.ok(articles[0].includes(oldToNew("이전 메모", "변경 메모")));
  assert.ok(articles[1].includes(oldToNew("없음", "새 제목")));
  assert.ok(articles[2].includes(oldToNew("없음", "새 메모")));
  assert.equal((articles[0].match(/class="manualDisplayHistoryChange"/g) ?? []).length, 2);
  assert.equal((articles[1].match(/class="manualDisplayHistoryChange"/g) ?? []).length, 1);
  assert.equal((articles[2].match(/class="manualDisplayHistoryChange"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /manualDisplayHistoryValueLabel|manualDisplayHistoryField/);
  assert.ok(!articles[1].includes("새 메모"));
  assert.ok(!articles[2].includes("새 제목"));
  assert.match(css, /\.manualDisplayHistoryList\{[^}]*gap:9px/);
  assert.match(css, /\.manualDisplayHistoryItem\{[^}]*gap:6px;padding:9px[^}]*border:1px solid[^}]*border-radius:9px[^}]*background:#fff/);
  assert.match(css, /\.manualDisplayHistoryChange\{[^}]*gap:1px/);
  assert.match(css, /\.manualDisplayHistoryChange\+\.manualDisplayHistoryChange\{[^}]*padding-top:6px;border-top/);
  assert.doesNotMatch(css, /\.manualDisplayHistoryItem\+\.manualDisplayHistoryItem\{border-top/);
  assert.match(css, /\.manualDisplayHistoryMeta\{[^}]*justify-content:flex-end[^}]*flex-wrap:wrap/);
  assert.match(css, /manualDisplayHistoryReason\{[^}]*text-overflow:ellipsis/);
  const viHtml = listMarkup(rows, "vi");
  assert.ok(viHtml.includes("Lịch sử chỉnh sửa · 3 mục"));
  assert.ok(viHtml.includes("Đã sửa tiêu đề và ghi chú"));
  assert.ok(viHtml.includes("Đã sửa tiêu đề"));
  assert.ok(viHtml.includes("Đã sửa ghi chú"));
  assert.doesNotMatch(viHtml, /manualDisplayHistoryValueLabel|manualDisplayHistoryField/);
  assert.match(page, /<ManualDisplayHistory/);
});
test("history component fetches its transaction-specific read API", async () => {
  const values = [];
  const effects = [];
  const requests = [];
  let cursor = 0;
  const deps = {
    react: {
      ...React,
      useState(initial) {
        const slot = cursor++;
        if (!(slot in values)) values[slot] = initial;
        return [values[slot], next => { values[slot] = next; }];
      },
      useEffect(effect) { effects.push(effect); },
    },
    "react/jsx-runtime": require("react/jsx-runtime"),
    "./entries.module.css": { default: new Proxy({}, { get: (_, key) => String(key) }) },
  };
  const testModule = { exports: {} };
  new Function("require", "module", "exports", "fetch", componentCode)(
    name => deps[name], testModule, testModule.exports,
    async (url, options) => {
      requests.push({ url, options });
      return { ok: true, async json() { return { history: [projection(both)] }; } };
    },
  );
  cursor = 0;
  assert.equal(testModule.exports.default({ transactionId: 81, lang: "ko" }), null);
  effects[0]();
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/admin/ledger/transactions/81/display-history");
  assert.equal(requests[0].options.cache, "no-store");
  cursor = 0;
  const element = testModule.exports.default({ transactionId: 81, lang: "ko" });
  assert.match(renderToStaticMarkup(element), /수정 이력 · 1건/);
});


test("history API returns every audit beyond one PostgREST page", async () => {
  const rows = Array.from({ length: 501 }, (_, index) => audit({
    id: index + 1,
    createdAt: "2026-09-29T12:00:00+07:00",
    before: { display_snapshot: {}, memo: null },
    after: { display_snapshot: { titleOverride: "제목" }, memo: null },
    reason: "일괄 조회",
  }));
  const ui = routeFixture({ rows });
  const result = await ui.get(81);
  assert.equal(result.body.history.length, 501);
  assert.equal(ui.calls.filter(call => call.table === "ledger_audit_logs").length, 2);
  assert.deepEqual(ui.calls[1].page, [0, 499]);
  assert.deepEqual(ui.calls[2].page, [500, 999]);
});


test("amount edit history shows transaction and movement audit amount while payable history remains available", async () => {
  const amountEdit = audit({
    id: 11, action: "manual_transaction_edited", createdAt: "2026-09-29T15:00:00+07:00",
    reason: "금액 정정",
    before: { transaction: { display_snapshot: { titleOverride: "Same" }, memo: "Same", amount: 100 }, movements: [{ amount: -100 }] },
    after: { transaction: { display_snapshot: { titleOverride: "Same" }, memo: "Same", amount: 150 }, movements: [{ amount: -150 }] },
  });
  const ui = routeFixture({ rows: [amountEdit] });
  const result = await ui.get(81);
  assert.equal(result.status, 200);
  assert.equal(result.body.history[0].beforeAmount, 100);
  assert.equal(result.body.history[0].afterAmount, 150);
  assert.match(listMarkup(result.body.history), /금액 수정/);
  assert.match(listMarkup(result.body.history), /150 ₫/);
  assert.match(page, /entry\.memo \?\? ""\}:\$\{entry\.amount\}/);
  const payable = routeFixture({ transaction: { id: 81, type: "payable_payment", status: "confirmed", source_type: "manual", correction_of_id: null }, rows: [both] });
  assert.equal((await payable.get(81)).status, 200);
});
