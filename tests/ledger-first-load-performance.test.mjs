import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const read = path => readFileSync(path, "utf8");
// vm results come from another realm; compare plain JSON copies.
const plain = value => JSON.parse(JSON.stringify(value));
const compile = path => ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const entries = read("app/(protected)/admin/ledger/entries/page.tsx");
const closeSheet = read("app/(protected)/admin/ledger/entries/MonthCloseSheet.tsx");
const settingsPage = read("app/(protected)/admin/ledger/settings/page.tsx");

// Read-only query double: applies eq/neq/lt/lte/gte/in filters (nested keys too) and records every table/RPC.
function makeDb(tables) {
  const reads = [], rpcs = [];
  const db = {
    rpc: async name => { rpcs.push(name); throw new Error(`unexpected rpc ${name}`); },
    // Supabase builders run only when awaited, so a read is recorded on execution, not on from().
    from(table) {
      const filters = []; let from = 0, to = 999;
      const value = (row, key) => key.split(".").reduce((current, part) => current?.[part], row);
      const chain = {
        select() { return chain; }, order() { return chain; }, limit() { return chain; },
        range(start, end) { from = start; to = end; return chain; },
        or() { return chain; }, not() { return chain; }, like() { return chain; },
        async maybeSingle() { const rows = apply(); return { data: rows[0] ?? null, error: null }; },
        then(resolve, reject) { return Promise.resolve({ data: apply().slice(from, to + 1), error: null }).then(resolve, reject); },
      };
      const ops = { eq: (a, b) => a === b, neq: (a, b) => a !== b, lt: (a, b) => a < b, lte: (a, b) => a <= b, gte: (a, b) => a >= b, in: (a, b) => b.includes(a) };
      for (const [name, op] of Object.entries(ops)) chain[name] = (key, expected) => { filters.push(row => op(value(row, key), expected)); return chain; };
      const apply = () => { reads.push(table); return (tables[table] ?? []).filter(row => filters.every(filter => filter(row))); };
      return chain;
    },
  };
  return { db, reads, rpcs };
}

const accounts = [
  { id: 1, code: "store_cash", type: "cash", holder_name: null, display_name: "매장 현금", is_active: true, is_business_fund: true, sort_order: 1 },
  { id: 5, code: "baba_corporate_bank", type: "bank", holder_name: null, display_name: "BABA 법인계좌", is_active: true, is_business_fund: true, sort_order: 2 },
  { id: 2, code: "vuong_personal_custody", type: "personal_custody", holder_name: null, display_name: "개인(Vương)", is_active: true, is_business_fund: true, sort_order: 3 },
  { id: 3, code: "cho_personal_custody", type: "personal_custody", holder_name: null, display_name: "개인(Cho)", is_active: true, is_business_fund: true, sort_order: 4 },
  { id: 4, code: "card_clearing", type: "card_clearing", holder_name: null, display_name: "카드 정산대기", is_active: true, is_business_fund: false, sort_order: 5 },
];
const movement = (account, amount, date, type = "income") => ({ fund_account_id: account, amount, transaction: { status: "confirmed", type, source_type: "manual", business_date: date, occurred_at: `${date}T12:00:00+07:00` } });
const ledgerTables = () => ({
  ledger_month_closures: [],
  ledger_fund_accounts: accounts,
  ledger_movements: [movement(1, 500_000, "2026-07-20"), movement(5, 2_000_000, "2026-08-05"), movement(4, 900_000, "2026-08-06"), movement(1, -100_000, "2026-08-09", "expense")],
  ledger_reserve_plans: [{ id: 7, name: "다음 연간 임대료 준비금", is_active: true, fund_account_id: 5, linked_recurring_plan: null }],
  ledger_reserve_entries: [{ id: 41, reserve_plan_id: 7, entry_type: "allocate", amount: 600_000, occurred_at: "2026-08-20T12:00:00+07:00", memo: null }],
});

function ledgerRoute(db) {
  const exports = {};
  vm.runInNewContext(compile("app/api/admin/ledger/route.ts"), {
    exports, URL, console: { error() {} },
    require(name) {
      const map = {
        "@/lib/supabase/server": { supabaseServer: db },
        "@/lib/ledger/server": { requireLedgerActor: async () => ({}), ledgerJson: body => body },
        "@/lib/ledger/inventory-display": { withInventoryDisplay: async rows => rows, loadInventoryProjectionIssues: async () => [] },
        "@/lib/ledger/entries": { buildLedgerEntries: () => [], buildReserveLedgerEntries: () => [] },
        "@/lib/ledger/reserve-balances": require("../lib/ledger/reserve-balances.ts"),
        "@/lib/ledger/fund-account-view": require("../lib/ledger/fund-account-view.ts"),
        "@/lib/ledger/dashboard-cash-report": require("../lib/ledger/dashboard-cash-report.ts"),
        "@/lib/ledger/manual-entry-policy": require("../lib/ledger/manual-entry-policy.ts"),
        "@/lib/partners/emoji": require("../lib/partners/emoji.ts"),
        "@/lib/ledger/payables": require("../lib/ledger/payables.ts"),
        "@/lib/ledger/summary": require("../lib/ledger/summary.ts"),
        "@/lib/ledger/cash-outflow": require("../lib/ledger/cash-outflow.ts"),
        "@/lib/ledger/card-settlements": require("../lib/ledger/card-settlements.ts"),
        "@/lib/ledger/card-settlement-data": { loadCardSales: async () => [], loadCardRows: async () => [], loadCardAllocationLines: async () => [] },
        "@/lib/common/business-time": {
          getBusinessDate: () => "2026-09-15",
          getBusinessMonthEndBoundary: month => { const next = new Date(`${month}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1); const businessDateExclusive = next.toISOString().slice(0, 10); return { businessDateExclusive, cutoffAt: `${businessDateExclusive}T03:00:00+07:00` }; },
        },
      };
      if (!(name in map)) throw new Error(`Unexpected import ${name}`);
      return map[name];
    },
  });
  return exports;
}

test("D: scope=accounts returns the same account balances as the full ledger GET without month-ledger reads", async () => {
  const light = makeDb(ledgerTables());
  const lightBody = await ledgerRoute(light.db).GET(new Request("http://local/api/admin/ledger?month=2026-08&scope=accounts"));
  assert.deepEqual(plain(Object.keys(lightBody).sort()), ["accounts", "fundsView", "month", "ok", "scope"]);
  const full = makeDb(ledgerTables());
  const fullBody = await ledgerRoute(full.db).GET(new Request("http://local/api/admin/ledger?month=2026-08"));
  assert.ok(fullBody.ok, JSON.stringify(fullBody));
  // Same Source of Truth: identical balances, reserves and available amounts for every account.
  assert.deepEqual(plain(lightBody.accounts), plain(fullBody.accounts));
  assert.deepEqual(plain(lightBody.fundsView), plain(fullBody.fundsView));
  const bank = lightBody.accounts.find(account => account.code === "baba_corporate_bank");
  assert.equal(bank.balance, 2_000_000);
  assert.equal(bank.reserveTotal, 600_000);
  // card_clearing stays in the backend payload; the settings UI filters it out.
  assert.equal(lightBody.accounts.find(account => account.code === "card_clearing").balance, 900_000);
  // No month-ledger, profit, category, partner or candidate reads in scope=accounts.
  for (const table of ["ledger_transactions", "ledger_categories", "ledger_parties", "business_partners", "ledger_candidates", "ledger_card_fee_closures"]) {
    assert.ok(!light.reads.includes(table), table);
    assert.ok(full.reads.includes(table) || table === "ledger_card_fee_closures" || table === "ledger_candidates", `full GET still reads ${table}`);
  }
  assert.deepEqual(new Set(light.reads), new Set(["ledger_month_closures", "ledger_fund_accounts", "ledger_movements", "ledger_reserve_plans", "ledger_reserve_entries"]));
  assert.match(settingsPage, /fetch\(`\/api\/admin\/ledger\?month=\$\{month\}&scope=accounts`/);
  assert.doesNotMatch(settingsPage, /fetch\(`\/api\/admin\/ledger\?month=\$\{month\}`,/);
});

test("A: month-close status mode reads one closure row — no preflight RPC, no snapshot", async () => {
  const { db, reads, rpcs } = makeDb({ ledger_month_closures: [{ id: 3, month: "2026-08-01", status: "closed", revision: 2 }] });
  const exports = {};
  vm.runInNewContext(compile("app/api/admin/ledger/month-close/route.ts"), {
    exports, URL, console: { error() {} },
    require(name) {
      const map = {
        "@/lib/supabase/server": { supabaseServer: db },
        "@/lib/ledger/server": { requireLedgerActor: async () => ({ actor: { id: 1 } }), ledgerJson: (body, status = 200) => ({ ...body, status }) },
        "@/lib/ledger/month-close": { validCloseMonth: value => /^\d{4}-\d{2}$/.test(value ?? ""), buildMonthCloseSnapshot: async () => { throw new Error("snapshot must not run"); }, snapshotHash: () => "x" },
        "@/lib/ledger/post-close-card-fee": { normalizePostCloseCardFeeSnapshot: value => value },
      };
      if (!(name in map)) throw new Error(`Unexpected import ${name}`);
      return map[name];
    },
  });
  const closed = await exports.GET(new Request("http://local/api/admin/ledger/month-close?month=2026-08&mode=status"));
  assert.deepEqual(plain(closed), { ok: true, month: "2026-08", state: "closed", closure: { id: 3, revision: 2 }, status: 200 });
  const open = await exports.GET(new Request("http://local/api/admin/ledger/month-close?month=2026-09&mode=status"));
  assert.deepEqual(plain(open), { ok: true, month: "2026-09", state: "open", closure: null, status: 200 });
  assert.deepEqual(rpcs, []);
  assert.deepEqual([...new Set(reads)], ["ledger_month_closures"]);
});

test("A: entries loads month-close status only; the full preflight GET runs when MonthCloseSheet opens", () => {
  const load = entries.slice(entries.indexOf("const load = useCallback"), entries.indexOf("useEffect(() => {\n    const controller = new AbortController();\n    void load(controller.signal);"));
  assert.match(load, /fetch\(`\/api\/admin\/ledger\/month-close\?month=\$\{requestedMonth\}&mode=status`/);
  // Only the light header summary is part of load(); the full investments GET is not.
  assert.match(load, /fetch\(`\/api\/admin\/ledger\/investments\?month=\$\{requestedMonth\}&mode=summary`/);
  assert.doesNotMatch(load, /investments\?month=\$\{requestedMonth\}`/);
  // The sheet mounts only while open, keyed by month, and reads the full GET on every mount.
  assert.match(entries, /\{closeSheetOpen && monthCloseState\?\.month === month &&/);
  assert.match(entries, /<MonthCloseSheet key=\{month\} month=\{month\}/);
  assert.match(closeSheet, /fetch\(`\/api\/admin\/ledger\/month-close\?month=\$\{month\}`, \{ cache: "no-store" \}\)/);
  assert.match(closeSheet, /useEffect\(\(\) => \{ void refresh\(\); \}, \[refresh\]\);/);
  // After close/reopen the page reloads its status (onClosed → load()).
  assert.match(entries, /onClosed=\{async \(\) => \{\s*setCloseSheetOpen\(false\);\s*const fresh = await load\(\);/);
});

test("B: investments are lazy, cached per month and invalidated by every applied reload", () => {
  assert.match(entries, /const investmentsNeeded = investmentExpanded \|\| manualOpen;/);
  assert.match(entries, /if \(!investmentsNeeded\) return;/);
  assert.match(entries, /const key = `\$\{requestedMonth\}:\$\{investmentsVersion\}`;\s*if \(investmentsLoadedKeyRef\.current === key\) return;/);
  assert.match(entries, /\}, \[investmentsNeeded, month, investmentsVersion, vi\]\);/);
  assert.match(entries, /bumpInvestmentsVersion\(\);\s*return ledgerBody as LedgerData;/);
  // Stale-month guard and failure handling are kept.
  assert.match(entries, /if \(controller\.signal\.aborted \|\| \(body\?\.month && body\.month !== requestedMonth\)\) return;/);
});

test("C: the month payables view no longer ships history; the historical sheet reads its party on open", () => {
  const route = read("app/api/admin/ledger/payables/route.ts");
  assert.match(route, /return ledgerJson\(\{ok:true,month,partyId:historyPartyId,historyPayables\}\);/);
  assert.match(route, /\.\.\.\(month!==null\?\{month,summary:balances\.summary\}:\{\}\)/);
  assert.doesNotMatch(route.slice(route.indexOf("const verification=")), /historyPayables/);
  assert.match(entries, /fetch\(`\/api\/admin\/ledger\/payables\?month=\$\{month\}&historyPartyId=\$\{party\.partyId\}`/);
  assert.doesNotMatch(entries, /historyPayables\.filter/);
});

test("F: removed dead entry points have no imports left; recurring DB contract stays", () => {
  for (const path of ["app/(protected)/admin/ledger/InventoryCandidatePanel.tsx", "app/api/admin/ledger/bep/route.ts", "lib/ledger/bep.ts", "app/api/admin/ledger/recurring-expenses/route.ts", "app/api/admin/ledger/recurring-expenses/payments/route.ts", "app/api/admin/ledger/recurring-expenses/sync/route.ts", "app/api/admin/ledger/supplier-party-mappings/route.ts"]) {
    assert.equal(existsSync(path), false, path);
  }
  for (const path of ["lib/ledger/bep-core.ts", "lib/ledger/month-close.ts", "supabase/migrations/202608210007_add_recurring_reserves_bep.sql", "supabase/migrations/20261002062405_fix_preflight_inactive_recurring_plans.sql", "supabase/migrations/202608210004_add_ledger_payable_payments.sql"]) {
    assert.equal(existsSync(path), true, path);
  }
  assert.match(read("supabase/migrations/202608210004_add_ledger_payable_payments.sql"), /ledger_upsert_supplier_party_mapping_v1/);
});

test("G: generated caches, QA profiles and temp files are ignored; fixtures and migrations are not", () => {
  const ignore = read(".gitignore");
  for (const rule of ["/.cache/", "/.qa-*/", "/.tmp-*", "Crashpad/", "*.dmp", ".tmp/", ".next/"]) assert.ok(ignore.includes(rule), rule);
  assert.doesNotMatch(ignore, /^[0-9a-f]{40}$/m, "stray commit hash removed");
  for (const kept of ["supabase/migrations", "tests", "artifacts/ledger-entries-css/README.md", "docs"]) assert.equal(existsSync(kept), true, kept);
  // No rule ignores a whole source directory (only scoped entries such as /supabase/.temp/).
  for (const dir of ["supabase", "tests", "artifacts", "docs", "app", "lib"]) assert.doesNotMatch(ignore, new RegExp(`^/?${dir}/?$`, "m"), dir);
});

// ---------------------------------------------------------------------------
// 투자금 header summary (mode=summary)
// ---------------------------------------------------------------------------
function investmentLoaders(tables) {
  const { db, reads } = makeDb(tables);
  const filters = [];
  const recordingDb = { from(table) { const chain = db.from(table); for (const op of ["gte", "lt"]) { const original = chain[op]; chain[op] = (key, value) => { filters.push({ table, op, key, value }); return original(key, value); }; } return chain; } };
  const exports = {};
  vm.runInNewContext(compile("lib/ledger/investments-server.ts"), {
    exports, console,
    require(name) {
      const map = {
        "server-only": {},
        "@/lib/supabase/server": { supabaseServer: recordingDb },
        "@/lib/common/business-time": require("../lib/common/business-time.ts"),
        "@/lib/ledger/investments": require("../lib/ledger/investments.ts"),
      };
      if (!(name in map)) throw new Error(`Unexpected import ${name}`);
      return map[name];
    },
  });
  return { ...exports, reads, filters };
}
const investmentTables = participants => ({
  ledger_owner_participants: participants,
  ledger_owner_investments: [
    { id: 1, participant_id: 10, entry_type: "opening", signed_amount: "2869689000", occurred_at: "2026-08-01T12:00:00+07:00", reason: null, source_snapshot: null },
    { id: 2, participant_id: 10, entry_type: "adjustment", signed_amount: "-100000000", occurred_at: "2026-09-01T02:59:00+07:00", reason: null, source_snapshot: null },
    { id: 3, participant_id: 10, entry_type: "adjustment", signed_amount: "-130000000", occurred_at: "2026-09-01T03:00:00+07:00", reason: null, source_snapshot: null },
    { id: 4, participant_id: 10, entry_type: "contribution", signed_amount: "50000000", occurred_at: "2026-10-01T03:00:00+07:00", reason: null, source_snapshot: { fundAccountId: 5 } },
  ],
  ledger_fund_accounts: [{ id: 5, display_name: "BABA 법인계좌" }],
  users: [{ id: 7, name: "Cho" }],
});
const activeParticipant = { id: 10, user_id: 7, sort_order: 1, is_eligible: true, effective_from: "2026-08-01", effective_to: null };

test("investment summary: Source of Truth is ledger_owner_investments for the selected 03:00 month only, equal to the full load", async () => {
  const light = investmentLoaders(investmentTables([activeParticipant]));
  const summary = await light.loadOwnerInvestmentMonthSummary("2026-09");
  // 9/1 02:59 belongs to August; 9/1 03:00 to September; October is excluded.
  assert.deepEqual(plain(summary), { month: "2026-09", configured: true, periodNetChange: -130_000_000 });
  assert.deepEqual([...new Set(light.reads)], ["ledger_owner_participants", "ledger_owner_investments"]);
  assert.deepEqual(plain(light.filters), [
    { table: "ledger_owner_investments", op: "gte", key: "occurred_at", value: "2026-09-01T03:00:00+07:00" },
    { table: "ledger_owner_investments", op: "lt", key: "occurred_at", value: "2026-10-01T03:00:00+07:00" },
  ]);
  const full = investmentLoaders(investmentTables([activeParticipant]));
  const fullData = await full.loadOwnerInvestmentMonth("2026-09");
  assert.equal(fullData.summary.periodNetChange, summary.periodNetChange);
  assert.equal(fullData.configured, summary.configured);
  for (const month of ["2026-08", "2026-10"]) {
    const [a, b] = [await investmentLoaders(investmentTables([activeParticipant])).loadOwnerInvestmentMonthSummary(month), await investmentLoaders(investmentTables([activeParticipant])).loadOwnerInvestmentMonth(month)];
    assert.equal(a.periodNetChange, b.summary.periodNetChange, month);
  }
  const source = read("lib/ledger/investments-server.ts");
  const summaryFn = source.slice(source.indexOf("export async function loadOwnerInvestmentMonthSummary"), source.indexOf("export async function loadOwnerInvestmentMonth("));
  assert.match(summaryFn, /ownerInvestmentMonthBounds\(month\)/);
  assert.match(summaryFn, /isParticipantEffectiveForMonth\(row, month\)/);
  assert.doesNotMatch(summaryFn, /ledger_transactions|owner_settlement|loadOwnerInvestmentMonth\(|"users"|ledger_fund_accounts/);
});

test("investment summary: not configured for the month → 미설정 without reading investments", async () => {
  const later = { ...activeParticipant, effective_from: "2026-10-01" };
  const light = investmentLoaders(investmentTables([later]));
  assert.deepEqual(plain(await light.loadOwnerInvestmentMonthSummary("2026-09")), { month: "2026-09", configured: false, periodNetChange: 0 });
  assert.deepEqual([...new Set(light.reads)], ["ledger_owner_participants"]);
});

test("investments route: mode=summary dispatches the light loader; default GET keeps the full load", () => {
  const route = read("app/api/admin/ledger/investments/route.ts");
  assert.match(route, /if \(params\.get\("mode"\) === "summary"\) return ledgerJson\(\{ ok: true, mode: "summary", \.\.\.await loadOwnerInvestmentMonthSummary\(month\) \}\);\s*const data = await loadOwnerInvestmentMonth\(month\);/);
  assert.match(entries, /const investmentHeader: InvestmentHeaderSummary \| null = activeInvestments\s*\? \{ month, configured: activeInvestments\.configured, periodNetChange: activeInvestments\.summary\.periodNetChange \}\s*: investmentSummary\?\.month === month \? investmentSummary : null;/);
});
