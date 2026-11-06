import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildFundAccountLog,
  fundAccountLogFallbackTitle,
  fundAccountLogRoute,
  fundAccountLogRowsFromMovements,
  type FundAccountMovementSourceRow,
} from "../lib/ledger/fund-account-log.ts";

const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const route = readFileSync("app/api/admin/ledger/fund-accounts/[id]/movements/route.ts", "utf8");
const css = readFileSync("app/(protected)/admin/ledger/entries/entries.module.css", "utf8");

const CASH = 1, BANK = 2, CHO = 3, VUONG = 5;
const NAMES: Record<number, string> = { 1: "매장 현금", 2: "BABA 법인계좌", 3: "개인(Cho)", 5: "개인(Vương)" };
let nextMovementId = 1;
// One confirmed transaction as PostgREST returns it, seen from every account it touches.
function tx(id: number, type: string, day: string, time: string, legs: Array<[number, number]>, extra: { memo?: string; party?: string; category?: string } = {}) {
  const movements = legs.map(([fund_account_id, amount]) => ({ id: nextMovementId++, fund_account_id, amount: amount.toFixed(3), fund_account: { display_name: NAMES[fund_account_id] } }));
  const transaction = {
    id, type, business_date: day, occurred_at: time.includes("T") ? time : `${day}T${time}:00+07:00`, memo: extra.memo ?? null,
    party: extra.party ? { name: extra.party } : null, category: extra.category ? [{ name: extra.category }] : [], movements,
  };
  return movements.map((movement): FundAccountMovementSourceRow => ({ id: movement.id, fund_account_id: movement.fund_account_id, amount: movement.amount, transaction }));
}
// Production November transfers: #4068 현금 → Cho 2,356,200; #4069 Vượng → 현금 4,704,000.
const rows = [
  ...tx(4068, "transfer", "2026-11-01", "23:30", [[CASH, -2_356_200], [CHO, 2_356_200]], { memo: "현금 → Cho 정산" }),
  ...tx(4069, "transfer", "2026-11-02", "22:10", [[VUONG, -4_704_000], [CASH, 4_704_000]]),
  ...tx(4100, "sales", "2026-11-02", "23:59", [[CASH, 6_000_000]], { category: "POS 매출" }),
  // After midnight but before 03:00: still business date 11/2.
  ...tx(4101, "expense", "2026-11-02", "2026-11-03T02:30:00+07:00",[[CASH, -557_000]], { party: "Trung Đông" }),
  ...tx(4102, "card_settlement_deposit", "2026-11-03", "10:00", [[BANK, 9_000_000]]),
];
const forAccount = (id: number) => rows.filter((row) => Number(row.fund_account_id) === id);

test("each account gets only its own movements, once, with + deposit / − withdrawal from its side", () => {
  const cash = fundAccountLogRowsFromMovements(forAccount(CASH), CASH);
  assert.deepEqual(cash.map((row) => [row.transactionId, row.amount]), [[4068, -2_356_200], [4069, 4_704_000], [4100, 6_000_000], [4101, -557_000]]);
  // A stray row of another account or a repeated page row is never counted.
  assert.equal(fundAccountLogRowsFromMovements([...forAccount(CASH), ...forAccount(CASH), ...forAccount(CHO)], CASH).length, 4);
  const cho = fundAccountLogRowsFromMovements(forAccount(CHO), CHO);
  const vuong = fundAccountLogRowsFromMovements(forAccount(VUONG), VUONG);
  assert.deepEqual(cho.map((row) => row.amount), [2_356_200]);
  assert.deepEqual(vuong.map((row) => row.amount), [-4_704_000]);
  assert.deepEqual(fundAccountLogRowsFromMovements(forAccount(BANK), BANK).map((row) => row.amount), [9_000_000]);
  // Transfers name the other side from this account's point of view.
  assert.equal(fundAccountLogRoute(cash[0], "ko"), "→ Cho");
  assert.equal(fundAccountLogRoute(cash[1], "ko"), "← Vương");
  assert.equal(fundAccountLogRoute(cho[0], "ko"), "← 현금");
  assert.equal(fundAccountLogRoute(cho[0], "vi"), "← Tiền mặt");
  assert.equal(fundAccountLogRoute(vuong[0], "vi"), "→ Tiền mặt");
  assert.equal(fundAccountLogRoute(cash[2], "ko"), null);
  assert.equal(fundAccountLogFallbackTitle(cash[3], "ko"), "Trung Đông");
  assert.equal(fundAccountLogFallbackTitle(cash[2], "ko"), "POS 매출");
  assert.equal(fundAccountLogFallbackTitle(fundAccountLogRowsFromMovements(forAccount(BANK), BANK)[0], "vi"), "Tiền thẻ về");
});

test("running balance reconciles opening + movements to the card balance, newest first", () => {
  const cash = fundAccountLogRowsFromMovements(forAccount(CASH), CASH);
  const opening = 78_005_406;
  const net = -2_356_200 + 4_704_000 + 6_000_000 - 557_000;
  const log = buildFundAccountLog(cash, opening, opening + net);
  assert.equal(log.balanceReliable, true);
  assert.equal(log.inflow, 10_704_000);
  assert.equal(log.outflow, -2_913_200);
  assert.equal(log.net, net);
  assert.deepEqual(log.rows.map((row) => row.transactionId), [4101, 4100, 4069, 4068]);
  assert.equal(log.rows[0].balanceAfter, opening + net);
  assert.equal(log.rows.at(-1)!.balanceAfter, opening - 2_356_200);
  // The 02:30 expense belongs to business date 11/2 and sorts after 11/2 evening rows.
  assert.equal(log.rows[0].businessDate, "2026-11-02");
});

test("running balance is hidden when the log does not reconcile with the card", () => {
  const cash = fundAccountLogRowsFromMovements(forAccount(CASH), CASH);
  const log = buildFundAccountLog(cash, 78_005_406, 1);
  assert.equal(log.balanceReliable, false);
  assert.ok(log.rows.every((row) => row.balanceAfter === null));
  // Amounts are still the movements' own amounts.
  assert.equal(log.net, -2_356_200 + 4_704_000 + 6_000_000 - 557_000);
  // Fractional movement amounts within ₫ rounding still reconcile.
  const fractional = fundAccountLogRowsFromMovements(tx(4200, "balance_adjustment", "2026-11-04", "12:00", [[CASH, 0.1]]).concat(tx(4201, "balance_adjustment", "2026-11-04", "12:01", [[CASH, 0.2]])), CASH);
  assert.equal(buildFundAccountLog(fractional, 0, 0.3).balanceReliable, true);
});

test("route: read-only, this account's confirmed movements, business-date month, same cutoff as the balance", () => {
  assert.match(route, /requireLedgerActor\(\)/);
  assert.match(route, /export async function GET/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)|\.(insert|update|upsert|delete|rpc)\(/);
  assert.match(route, /\.from\("ledger_movements"\)/);
  assert.match(route, /\.eq\("fund_account_id", accountId\)/);
  assert.match(route, /\.eq\("transaction\.status", "confirmed"\)/);
  assert.match(route, /\.neq\("transaction\.type", "opening"\)/);
  assert.match(route, /\.gte\("transaction\.business_date", monthStart\)/);
  assert.match(route, /\.lt\("transaction\.business_date", nextMonth\)/);
  assert.match(route, /if \(live\) query = query\.lte\("transaction\.occurred_at", now\.toISOString\(\)\)/);
  assert.match(route, /const live = month === getBusinessDate\(now\)\.slice\(0, 7\)/);
  assert.match(route, /\.order\("id", \{ ascending: true \}\)\.range\(from, from \+ PAGE_SIZE - 1\)/);
});

test("page: whole KPI card opens the account log in a BarSheet; rows reuse the entry detail", () => {
  assert.match(page, /className=\{styles\.balanceCard\}\s+key=\{account\.id\}\s+aria-haspopup="dialog"\s+onClick=\{\(\) => setLogAccountId\(account\.id\)\}/);
  assert.match(page, /\{logAccount && data && !selected \? \(\s+<FundAccountLogSheet/);
  const sheet = page.slice(page.indexOf("function FundAccountLogSheet"), page.indexOf("function ReserveEntryDetailSheet"));
  assert.match(sheet, /<BarSheet/);
  assert.match(sheet, /fetch\(`\/api\/admin\/ledger\/fund-accounts\/\$\{account\.id\}\/movements\?month=\$\{month\}`/);
  assert.doesNotMatch(sheet, /method: "(POST|PUT|PATCH|DELETE)"/);
  assert.match(sheet, /buildFundAccountLog\(rows, account\.openingBalance, account\.balance\)/);
  assert.match(sheet, /entry \? entryDisplayTitle\(entry, lang\) : fundAccountLogFallbackTitle\(row, lang\)/);
  assert.match(sheet, /onClick=\{\(\) => onOpenEntry\(entry\)\}/);
  for (const label of ["월초 잔액", "Đầu tháng", "입금", "Tiền vào", "출금", "Tiền ra", "현재 잔액", "Số dư hiện tại"]) assert.match(sheet, new RegExp(label));
  assert.match(css, /\.accountLogRow\{width:100%;min-width:0;display:grid;grid-template-columns:minmax\(0,1fr\) max-content/);
  assert.match(css, /\.accountLogMain strong\{overflow:hidden;[^}]*text-overflow:ellipsis;white-space:nowrap\}/);
});
