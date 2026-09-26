import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const migration = readFileSync("supabase/migrations/20260916161512_add_ledger_month_reopen.sql", "utf8");
const original = readFileSync("supabase/migrations/202608210008_add_ledger_month_close_corrections.sql", "utf8");
const latestOwnerMigration = readFileSync("supabase/migrations/20260916150709_separate_owner_capital_recovery.sql", "utf8");
const api = readFileSync("app/api/admin/ledger/month-close/route.ts", "utf8");
const panel = readFileSync("app/(protected)/admin/ledger/entries/MonthCloseSheet.tsx", "utf8");
const entriesPage = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const ledgerPage = readFileSync("app/(protected)/admin/ledger/page.tsx", "utf8");
const ledgerGet = readFileSync("app/api/admin/ledger/route.ts", "utf8");
const reopenSql = migration.split("create or replace function public.ledger_reopen_month_v1(")[1]
  .split("create or replace function public.ledger_close_month_v1(")[0];
const recloseSql = migration.split("create or replace function public.ledger_close_month_v1(")[1]
  .split("alter function public.ledger_reopen_month_v1")[0];

function routeFixture({ closure = null, earlierReopened = [], preflight = { status: "ok", canClose: true, blockers: [], warnings: [], preflightHash: "token" }, rpcResult = { status: "reopened" } } = {}) {
  const calls = [];
  const db = {
    from(table) {
      assert.equal(table, "ledger_month_closures");
      let earlier = false;
      const query = {
        select(value) { calls.push(["select", value]); return query; },
        eq(key, value) { calls.push(["eq", key, value]); return query; },
        lt(key, value) { calls.push(["lt", key, value]); earlier = true; return query; },
        limit() { return Promise.resolve({ data: earlierReopened, error: null }); },
        maybeSingle() { return Promise.resolve({ data: earlier ? null : closure, error: null }); },
      };
      return query;
    },
    async rpc(name, args) {
      calls.push(["rpc", name, args]);
      return { data: name === "ledger_close_preflight_v1" ? preflight : rpcResult, error: null };
    },
  };
  const mod = { exports: {} };
  const code = ts.transpileModule(api, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  new Function("require", "module", "exports", code)(name => {
    if (name === "@/lib/ledger/month-close") return {
      validCloseMonth: value => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value),
      buildMonthCloseSnapshot: async () => ({ funds: 123 }),
      snapshotHash: () => "new-hash",
    };
    if (name === "@/lib/ledger/server") return {
      requireLedgerActor: async () => ({ actor: { id: 7 } }),
      ledgerJson: (body, status = 200) => Response.json(body, { status }),
    };
    if (name === "@/lib/supabase/server") return { supabaseServer: db };
    throw new Error(`Unexpected import: ${name}`);
  }, mod, mod.exports);
  return { route: mod.exports, calls };
}

test("migration keeps one closure row and adds revision, reopen metadata and two status values", () => {
  assert.match(original, /month date not null unique/);
  assert.match(migration, /drop constraint ledger_month_closures_status_check/);
  assert.match(migration, /status in \('closed', 'reopened'\)/);
  for (const column of ["reopened_at timestamptz", "reopened_by bigint references public.users", "reopen_reason text", "revision integer not null default 1"]) {
    assert.ok(migration.includes(column));
  }
  assert.doesNotMatch(migration, /drop constraint ledger_month_closures_month_key|delete from public.ledger_month_closures/);
});

test("history archives the exact prior close and protects its shape and privileges", () => {
  assert.match(migration, /create table public.ledger_month_closure_history/);
  assert.match(migration, /unique \(closure_id, revision\)/);
  assert.match(migration, /month = date_trunc\('month', month\)::date/);
  assert.match(migration, /jsonb_typeof\(preflight_snapshot\) = 'object'/);
  assert.match(migration, /jsonb_typeof\(summary_snapshot\) = 'object'/);
  assert.match(migration, /jsonb_typeof\(warning_snapshot\) = 'array'/);
  assert.match(migration, /snapshot_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public.ledger_month_closure_history from public, anon, authenticated, service_role/);
  assert.match(migration, /grant select on table public.ledger_month_closure_history to service_role/);
  assert.doesNotMatch(migration, /grant (insert|update|delete|all) on table public.ledger_month_closure_history to service_role/i);
  const copied = ["v_closure.id", "v_closure.month", "v_closure.revision", "v_closure.closed_at",
    "v_closure.closed_by", "v_closure.preflight_snapshot", "v_closure.summary_snapshot",
    "v_closure.snapshot_hash", "v_closure.warning_snapshot", "v_reason", "p_actor_user_id"];
  for (const value of copied) assert.ok(reopenSql.includes(value));
  assert.match(reopenSql, /update public.ledger_month_closures\s+set status='reopened',reopened_at=/);
  assert.doesNotMatch(reopenSql, /set status='reopened'[^;]*(?:summary_snapshot|snapshot_hash|closed_at|closed_by|revision)=/);
});

test("reopen requires owner, reason and existing closed row, and blocks later closed months", () => {
  assert.match(reopenSql, /is_active=true and app_login_enabled=true/);
  assert.match(reopenSql, /not in \('owner','master'\)/);
  assert.match(reopenSql, /btrim\(coalesce\(p_reason,''\)\)/);
  for (const status of ["forbidden", "reason_required", "not_closed", "already_reopened", "later_month_closed"]) {
    assert.ok(reopenSql.includes(`'status','${status}'`));
  }
  assert.match(reopenSql, /month>v_month and status='closed'/);
  assert.match(reopenSql, /where month=v_month for update/);
  assert.ok(reopenSql.indexOf("if v_closure.status='reopened'") < reopenSql.indexOf("insert into public.ledger_month_closure_history"));
  assert.match(reopenSql, /'month_reopen','month_closure'/);
});

test("close and reopen share a month lock; reclose reuses the id and all safety checks", () => {
  const lock = "pg_advisory_xact_lock(hashtext('ledger_month_close'),hashtext(v_month::text))";
  assert.ok(reopenSql.includes(lock));
  assert.ok(recloseSql.includes(lock));
  assert.match(reopenSql, /pg_advisory_xact_lock\(hashtext\('ledger_month_close_serial'\)\)/);
  assert.match(recloseSql, /pg_advisory_xact_lock\(hashtext\('ledger_month_close_serial'\)\)/);
  assert.match(recloseSql, /month<v_month and status='reopened'/);
  assert.match(recloseSql, /where month=v_month for update/);
  assert.match(recloseSql, /if v_closure.status='closed' then return jsonb_build_object\('status','already_closed'\)/);
  assert.match(recloseSql, /ledger_close_preflight_v1\(p_month,p_actor_user_id\)/);
  assert.match(recloseSql, /LEDGER_CLOSE_PREFLIGHT_STALE/);
  assert.match(recloseSql, /if not \(v_check->>'canClose'\)::boolean/);
  assert.match(recloseSql, /p_snapshot_hash!~'\^\[0-9a-f\]\{64\}\$'/);
  assert.match(recloseSql, /revision\s*\) values \([\s\S]*?,1\s*\)/);
  assert.match(recloseSql, /v_revision:=v_closure.revision\+1/);
  assert.match(recloseSql, /where id=v_id/);
  assert.match(recloseSql, /'month_closed','month_closure'/);
  assert.match(recloseSql, /'month_reclose','month_closure'/);
  assert.doesNotMatch(recloseSql, /'month_close','month_closure'/);
  assert.doesNotMatch(recloseSql, /delete from public.ledger_month_closures/i);
});

test("owner profit capacity includes only active closed snapshots across reopen and reclose", () => {
  const latest = latestOwnerMigration.match(/create or replace function public\.ledger_owner_financial_capacity_v1\([\s\S]*?end\$\$;/)?.[0];
  const replacement = migration.match(/create or replace function public\.ledger_owner_financial_capacity_v1\([\s\S]*?end\$\$;/)?.[0];
  assert.ok(latest && replacement);
  assert.match(replacement, /into v_profit from public\.ledger_month_closures\s+where status = 'closed'\s+and month between v_start and p_through_month/);
  const restored = replacement.replace(/where status = 'closed'\s+and month between/, "where month between");
  const compact = value => value.replace(/\s+/g, " ").trim();
  assert.equal(compact(restored), compact(latest), "only the closed-status filter may differ from the latest owner capacity");

  const closedOperatingProfit = closures => closures
    .filter(row => row.status === "closed" && row.month >= "2026-08" && row.month <= "2026-08")
    .reduce((total, row) => total + row.summary_snapshot.operatingResult.operatingProfit, 0);
  const august = { month: "2026-08", status: "closed",
    summary_snapshot: { operatingResult: { operatingProfit: 100 } } };
  assert.equal(closedOperatingProfit([august]), 100);
  august.status = "reopened";
  assert.equal(closedOperatingProfit([august]), 0, "retained old snapshot is ignored while reopened");
  august.summary_snapshot.operatingResult.operatingProfit = 120;
  august.status = "closed";
  assert.equal(closedOperatingProfit([august]), 120, "reclose includes only the new active snapshot");

  assert.match(migration, /alter function public\.ledger_owner_financial_capacity_v1\(date\) owner to postgres/);
  assert.match(migration, /revoke all on function public\.ledger_owner_financial_capacity_v1\(date\) from public,anon,authenticated/);
  assert.match(migration, /grant execute on function public\.ledger_owner_financial_capacity_v1\(date\) to service_role,postgres/);
});

test("reopened months are open to existing guards and use live as-of ledger funds", () => {
  assert.match(original, /ledger_month_is_closed_v1\(p_month date\)[\s\S]*?status='closed'/);
  assert.match(original, /if public.ledger_month_is_closed_v1\(p_month\)/);
  assert.match(ledgerGet, /\.eq\("status", "closed"\)/);
  assert.match(ledgerGet, /fundAccountViewMode\(month, currentBusinessDate, Boolean\(closureResult.data\)\)/);
  assert.match(ledgerGet, /fundsViewMode === "closed_snapshot"/);
});

test("RPC security is restricted to service role and postgres", () => {
  for (const name of ["ledger_reopen_month_v1", "ledger_close_month_v1"]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?security definer set search_path=pg_catalog,public`));
    assert.match(migration, new RegExp(`alter function public\\.${name}\\([^;]+ owner to postgres`));
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}\\([^;]+ from public,anon,authenticated`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}\\([^;]+ to service_role,postgres`));
  }
});

test("GET exposes old snapshot only as previousClosure while reopened preflight is fresh", async () => {
  const closure = { id: 9, status: "reopened", revision: 1, snapshot_hash: "old-hash",
    summary_snapshot: { funds: 100 }, closed_at: "2026-09-01", closed_by: 7,
    reopened_at: "2026-09-16", reopened_by: 7, reopen_reason: "검토" };
  const { route } = routeFixture({ closure });
  const response = await route.GET(new Request("http://localhost/api/admin/ledger/month-close?month=2026-08"));
  const body = await response.json();
  assert.equal(body.state, "reopened");
  assert.equal(body.closure.revision, 1);
  assert.equal(body.closure.previousSnapshotHash, "old-hash");
  assert.deepEqual(body.previousClosure.summarySnapshot, { funds: 100 });
  assert.deepEqual(body.currentSummary, { funds: 123 });
  assert.equal(body.currentSnapshotHash, "new-hash");
  assert.equal(body.canClose, true);
  assert.equal(body.closure.summary_snapshot, undefined);
});

test("GET closed and open retain their existing response shape with revision", async () => {
  const closed = routeFixture({ closure: { status: "closed", revision: 2, snapshot_hash: "old" } });
  assert.equal((await (await closed.route.GET(new Request("http://localhost/?month=2026-08"))).json()).state, "closed");
  const open = routeFixture();
  const body = await (await open.route.GET(new Request("http://localhost/?month=2026-08"))).json();
  assert.equal(body.state, "open");
  assert.equal(body.preflight.canClose, true);
});

test("a reopened earlier month blocks a later close in GET and the authoritative RPC", async () => {
  const { route } = routeFixture({ earlierReopened: [{ id: 8 }] });
  const body = await (await route.GET(new Request("http://localhost/?month=2026-09"))).json();
  assert.equal(body.preflight.canClose, false);
  assert.deepEqual(body.preflight.blockers, [{ code: "EARLIER_MONTH_REOPENED" }]);
  const blocked = routeFixture({ rpcResult: { status: "blocked", blockers: [{ code: "EARLIER_MONTH_REOPENED" }] } });
  const response = await blocked.route.POST(new Request("http://localhost/", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ month: "2026-09", expectedPreflightHash: "token" }) }));
  assert.equal(response.status, 409);
});

test("POST reopen requires reason and maps guarded RPC statuses", async () => {
  const missing = routeFixture();
  const request = value => new Request("http://localhost/", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const empty = await missing.route.POST(request({ action: "reopen", month: "2026-08", reason: " " }));
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, "REASON_REQUIRED");
  assert.equal(missing.calls.filter(call => call[0] === "rpc").length, 0);
  for (const [status, httpStatus] of [["not_closed", 409], ["already_reopened", 409],
    ["later_month_closed", 409], ["forbidden", 403], ["reason_required", 400]]) {
    const fixture = routeFixture({ rpcResult: { status } });
    const response = await fixture.route.POST(request({ action: "reopen", month: "2026-08", reason: " 검토 " }));
    assert.equal(response.status, httpStatus);
    assert.deepEqual(fixture.calls.find(call => call[1] === "ledger_reopen_month_v1")[2],
      { p_month: "2026-08-01", p_reason: "검토", p_actor_user_id: 7 });
  }
});

test("POST close default keeps the existing preflight and close RPC contract", async () => {
  const { route, calls } = routeFixture({ rpcResult: { status: "closed", closureId: 9, revision: 2 } });
  const response = await route.POST(new Request("http://localhost/", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ month: "2026-08", expectedPreflightHash: "token" }) }));
  assert.equal(response.status, 201);
  const rpc = calls.find(call => call[1] === "ledger_close_month_v1");
  assert.equal(rpc[2].p_expected_preflight_hash, "token");
  assert.equal(rpc[2].p_snapshot_hash, "new-hash");
});

test("ledger keeps reopen confirmation and close sheet protects the hash", () => {
  assert.match(entriesPage, /재오픈 사유/);
  assert.match(entriesPage, /action: "reopen"/);
  assert.match(entriesPage, /MonthCloseSheet/);
  assert.match(panel, /expectedPreflightHash: preflight.preflightHash/);
  assert.match(panel, /preflight.blockers\?\.length/);
  assert.match(panel, /LEDGER_CLOSE_PREFLIGHT_STALE/);
});

test("ledger dashboard routes the selected month to entries and old page is removed", () => {
  // The dashboard shortcut section was removed on request; 장부작성 stays reachable from the ledger tabs.
  assert.doesNotMatch(ledgerPage, /admin\/ledger\/entries\?month=/);
  assert.match(readFileSync("lib/navigation/ledger-tabs.ts", "utf8"), /href: "\/admin\/ledger\/entries"/);
  assert.equal(existsSync("app/(protected)/admin/ledger/month-close/page.tsx"), false);
  assert.equal(existsSync("app/(protected)/admin/ledger/MonthClosePanel.tsx"), false);
});
