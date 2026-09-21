import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node direct TS tests use explicit extensions.
import { getBusinessMonthEndBoundary } from "../lib/common/business-time.ts";
// @ts-expect-error Node direct TS tests use explicit extensions.
import { buildFundAccountView, fundAccountViewMode } from "../lib/ledger/fund-account-view.ts";
// @ts-expect-error Node direct TS tests use explicit extensions.
import { reservesByFundAccount } from "../lib/ledger/reserve-balances.ts";

const route = readFileSync("app/api/admin/ledger/route.ts", "utf8");
const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const monthClose = readFileSync("lib/ledger/month-close.ts", "utf8");
const accounts = [
  { id: 1, code: "store_cash", display_name: "cash" },
  { id: 2, code: "baba_corporate_bank", display_name: "bank" },
];

test("current business month remains live while an open past month is provisional", () => {
  assert.equal(fundAccountViewMode("2026-09", "2026-09-15", false), "live");
  assert.equal(fundAccountViewMode("2026-08", "2026-09-15", false), "provisional");
  assert.equal(fundAccountViewMode("2026-08", "2026-09-15", true), "closed_snapshot");
});

test("past provisional queries exclude next-month movements and reserve entries at the shared 03:00 cutoff", () => {
  assert.deepEqual(getBusinessMonthEndBoundary("2026-08"), {
    businessDateExclusive: "2026-09-01",
    cutoffAt: "2026-09-01T03:00:00+07:00",
  });
  assert.match(route, /movementsQuery\.lt\("transaction\.business_date", nextMonth\)/);
  assert.match(route, /reserveEntriesQuery\.lt\("occurred_at", monthEndCutoffAt\)/);
  assert.match(route, /getBusinessMonthEndBoundary\(month\)/);
});

test("live balances and reserves use the same current dataset", () => {
  const result = buildFundAccountView({
    accounts,
    openingMovements: [{ fund_account_id: 1, amount: 40 }],
    movements: [{ fund_account_id: 1, amount: 100 }, { fund_account_id: 2, amount: 80 }],
    reservePlans: [{ id: 10, name: "rent", fund_account_id: 1, entries: [{ entry_type: "allocate", amount: 25 }] }],
    groupReserves: reservesByFundAccount,
    mode: "live",
  });
  assert.equal(result[0].balance, 100);
  assert.equal(result[0].reserveTotal, 25);
  assert.equal(result[0].availableBalance, 75);
  assert.equal(result[0].openingBalance, 40);
});

test("an explicit opening takes precedence for the whole month, even with earlier movements", () => {
  const result = buildFundAccountView({
    accounts,
    openingMovements: [{ fund_account_id: 1, amount: 40 }],
    priorConfirmedMovements: [{ fund_account_id: 1, amount: 900 }, { fund_account_id: 2, amount: 800 }],
    movements: [{ fund_account_id: 1, amount: 100 }, { fund_account_id: 2, amount: 80 }],
    reservePlans: [], groupReserves: reservesByFundAccount, mode: "live",
  });
  assert.deepEqual(result.map(account => account.openingBalance), [40, 0]);
  assert.deepEqual(result.map(account => account.balance), [100, 80]);
});

test("a later month without explicit opening uses the cumulative prior confirmed movements", () => {
  const result = buildFundAccountView({
    accounts,
    openingMovements: [],
    priorConfirmedMovements: [
      { fund_account_id: 1, amount: 120 }, { fund_account_id: 1, amount: -20 },
      { fund_account_id: 2, amount: 80 },
    ],
    movements: [{ fund_account_id: 1, amount: 130 }, { fund_account_id: 2, amount: 70 }],
    reservePlans: [], groupReserves: reservesByFundAccount, mode: "provisional",
  });
  assert.deepEqual(result.map(account => account.openingBalance), [100, 80]);
  assert.deepEqual(result.map(account => account.balance), [130, 70]);
});

test("September opening matches the four fund balances without doubling live or closed balances", () => {
  const septemberAccounts = [
    { id: 1, code: "store_cash" },
    { id: 2, code: "vuong_personal_custody" },
    { id: 3, code: "cho_personal_custody" },
    { id: 4, code: "baba_corporate_bank" },
  ];
  const priorConfirmedMovements = [
    { fund_account_id: 1, amount: 51_502_786 },
    { fund_account_id: 2, amount: 6_774_110 },
    { fund_account_id: 3, amount: 46_343_661 },
    { fund_account_id: 4, amount: 222_917_683 },
  ];
  const options = { accounts: septemberAccounts, openingMovements: [], priorConfirmedMovements,
    reservePlans: [], groupReserves: reservesByFundAccount };
  const live = buildFundAccountView({ ...options, mode: "live", movements: [
    ...priorConfirmedMovements, { fund_account_id: 1, amount: -2_000_000 },
  ] });
  assert.deepEqual(live.map(account => account.openingBalance), [51_502_786, 6_774_110, 46_343_661, 222_917_683]);
  assert.equal(live.reduce((total, account) => total + account.openingBalance, 0), 327_538_240);
  assert.equal(live[0].balance, 49_502_786);
  const closed = buildFundAccountView({ ...options, mode: "closed_snapshot", movements: [],
    closeSummary: { funds: { accounts: septemberAccounts.map((account, index) => ({ ...account, balance: [45, 60, 70, 80][index] })) } },
  });
  assert.equal(closed.reduce((total, account) => total + account.openingBalance, 0), 327_538_240);
  assert.deepEqual(closed.map(account => account.balance), [45, 60, 70, 80]);
});

test("the ledger route reads every prior confirmed movement only when no explicit opening exists", () => {
  assert.match(route, /openingResult\.data\?\.length \?\? 0/);
  assert.match(route, /loadPriorConfirmedFundMovements\(monthStart\)/);
  assert.match(route, /\.eq\("transaction\.status", "confirmed"\)/);
  assert.match(route, /\.lt\("transaction\.business_date", monthStart\)/);
  assert.match(route, /\.range\(from, from \+ pageSize - 1\)/);
  assert.match(route, /priorConfirmedMovements,/);
});

test("closed months use stored balances and stored reserve values even after current DB values drift", () => {
  const closeSummary = {
    funds: { accounts: [{ id: 1, code: "store_cash", balance: 100 }, { id: 2, code: "baba_corporate_bank", balance: 200 }] },
    reserve: { plans: [{ id: 10, name: "rent", fund_account_id: 2, currentAmount: 30 }] },
  };
  const first = buildFundAccountView({
    accounts,
    openingMovements: [],
    movements: [{ fund_account_id: 1, amount: 999 }, { fund_account_id: 2, amount: 888 }],
    reservePlans: [{ id: 10, name: "rent", fund_account_id: 1, entries: [{ entry_type: "allocate", amount: 777 }] }],
    groupReserves: reservesByFundAccount,
    mode: "closed_snapshot",
    closeSummary,
  });
  const afterDrift = buildFundAccountView({
    accounts,
    openingMovements: [],
    movements: [{ fund_account_id: 1, amount: -5000 }],
    reservePlans: [],
    groupReserves: reservesByFundAccount,
    mode: "closed_snapshot",
    closeSummary,
  });
  assert.deepEqual(first.map(({ balance, reserveTotal, availableBalance }) => ({ balance, reserveTotal, availableBalance })), [
    { balance: 100, reserveTotal: 0, availableBalance: 100 },
    { balance: 200, reserveTotal: 30, availableBalance: 170 },
  ]);
  assert.deepEqual(afterDrift.map(({ balance, reserveTotal, availableBalance }) => ({ balance, reserveTotal, availableBalance })), first.map(({ balance, reserveTotal, availableBalance }) => ({ balance, reserveTotal, availableBalance })));
});

test("legacy snapshots without reserve fund_account_id stay readable and do not mix in live reserve values", () => {
  assert.doesNotThrow(() => buildFundAccountView({
    accounts,
    openingMovements: [],
    movements: [{ fund_account_id: 1, amount: 999 }],
    reservePlans: [{ id: 10, name: "live", fund_account_id: 1, entries: [{ entry_type: "allocate", amount: 50 }] }],
    groupReserves: reservesByFundAccount,
    mode: "closed_snapshot",
    closeSummary: { funds: { accounts: [{ id: 1, balance: 100 }] }, reserve: { plans: [{ id: 10, name: "legacy", currentAmount: 30 }] } },
  }));
  const [account] = buildFundAccountView({
    accounts: accounts.slice(0, 1), openingMovements: [], movements: [], reservePlans: [],
    groupReserves: reservesByFundAccount, mode: "closed_snapshot",
    closeSummary: { funds: { accounts: [{ id: 1, balance: 100 }] }, reserve: { plans: [{ id: 10, name: "legacy", currentAmount: 30 }] } },
  });
  assert.equal(account.reserveTotal, 0);
  assert.equal(account.availableBalance, 100);
});

test("month-close snapshots preserve reserve fund-account linkage and the ledger API owns the canonical source metadata", () => {
  assert.match(monthClose, /ledger_reserve_plans"\)\.select\("[^"]*fund_account_id/);
  assert.match(monthClose, /linked_recurring_plan:ledger_recurring_expense_plans/);
  assert.match(route, /summary_snapshot/);
  assert.match(route, /mode: fundsViewMode/);
  assert.match(route, /closeSummary: closureResult\.data\?\.summary_snapshot/);
  assert.doesNotMatch(route.slice(route.indexOf("const accounts = buildFundAccountView"), route.indexOf("const accountById")), /currentRecalculation/);
});

test("UI labels the selected month and only badges non-live views without weakening stale-response protection", () => {
  assert.match(page, /현재 보유금 \(\$\{Number\(month\.slice\(5, 7\)\)\}월\)/);
  assert.match(page, /Tiền hiện có \(T\$\{Number\(month\.slice\(5, 7\)\)\}\)/);
  assert.match(page, /"마감"[\s\S]*"미마감"/);
  assert.match(page, /"Đã chốt"[\s\S]*"Chưa chốt"/);
  assert.match(page, /requestSequence !== loadRequestSequenceRef\.current/);
  assert.match(page, /const controller = new AbortController\(\)/);
  assert.match(page, /ledgerBody\.month && ledgerBody\.month !== requestedMonth/);
  assert.match(page, /const currentMonth = \(\) => getBusinessDate\(\)\.slice\(0, 7\)/);
});

test("income, expense, payable, card, and investment contracts remain wired to their existing fields", () => {
  for (const marker of ["recognizedIncome", "paidExpense", "unsettledCardGross", "payables?.totalOutstanding", "activeInvestments"]) {
    assert.match(`${route}\n${page}`, new RegExp(marker.replace("?", "\\?")));
  }
});
