import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const {
  summarizeOwnerInvestments,
  ownerInvestmentMonthBounds,
  isParticipantEffectiveForMonth,
  OWNER_INVESTMENT_MONTH,
  ZERO_OWNER_INVESTMENT_SUMMARY,
} = createRequire(import.meta.url)("../lib/ledger/investments.ts") as typeof import("../lib/ledger/investments");

const read = (path: string) => readFileSync(path, "utf8");

function row(id: number, entryType: "opening" | "contribution" | "adjustment", signedAmount: number | string, occurredAt: string) {
  return { id, participant_id: 1, entry_type: entryType, signed_amount: signedAmount, occurred_at: occurredAt };
}

// ---------------------------------------------------------------------------
// 1. Monthly calculation contract from the task spec: prior cumulative 100,
//    a +50 contribution and a -10 adjustment inside September.
// ---------------------------------------------------------------------------
test("month summary: opening cumulative, period contribution/adjustment and net change compose to an exact closing cumulative", () => {
  const rows = [
    row(1, "opening", 100, "2026-08-01T08:00:00Z"),
    row(2, "contribution", 50, "2026-09-10T08:00:00Z"),
    row(3, "adjustment", -10, "2026-09-20T08:00:00Z"),
  ];
  const { summary, periodRows } = summarizeOwnerInvestments(rows, "2026-09");
  assert.equal(summary.openingCumulative, 100);
  assert.equal(summary.periodOpening, 0);
  assert.equal(summary.periodContribution, 50);
  assert.equal(summary.periodAdjustment, -10);
  assert.equal(summary.periodNetChange, 40);
  assert.equal(summary.closingCumulative, 140);
  // closing must equal opening + net change exactly, by construction (not just numerically).
  assert.equal(summary.closingCumulative, summary.openingCumulative + summary.periodNetChange);
  assert.equal(periodRows.length, 2);
  assert.deepEqual(periodRows.map((r) => r.id), [2, 3]); // chronological, opening-month row excluded
});

// ---------------------------------------------------------------------------
// 2. Next-month isolation: a contribution recorded in October must never be
//    part of September's period or its closing cumulative.
// ---------------------------------------------------------------------------
test("a next month's contribution never leaks into this month's period or closing cumulative", () => {
  const rows = [
    row(1, "opening", 100, "2026-08-01T08:00:00Z"),
    row(2, "contribution", 50, "2026-09-10T08:00:00Z"),
    row(3, "contribution", 999, "2026-10-05T08:00:00Z"),
  ];
  const { summary, periodRows } = summarizeOwnerInvestments(rows, "2026-09");
  assert.equal(summary.periodContribution, 50);
  assert.equal(summary.closingCumulative, 150);
  assert.ok(periodRows.every((r) => r.id !== 3));
});

// ---------------------------------------------------------------------------
// 3. Past-month pinning: viewing September must not retroactively change when
//    a later (October) contribution exists — September's own numbers are fixed
//    regardless of what happens afterward.
// ---------------------------------------------------------------------------
test("a past month's summary is pinned and does not retroactively change because of a later month's activity", () => {
  const withoutFuture = summarizeOwnerInvestments(
    [row(1, "opening", 100, "2026-08-01T08:00:00Z"), row(2, "contribution", 50, "2026-09-10T08:00:00Z")],
    "2026-09",
  ).summary;
  const withFuture = summarizeOwnerInvestments(
    [
      row(1, "opening", 100, "2026-08-01T08:00:00Z"),
      row(2, "contribution", 50, "2026-09-10T08:00:00Z"),
      row(3, "contribution", 5_000_000, "2026-10-01T08:00:00Z"),
      row(4, "adjustment", -2_000_000, "2026-11-15T08:00:00Z"),
    ],
    "2026-09",
  ).summary;
  assert.deepEqual(withFuture, withoutFuture);
});

// ---------------------------------------------------------------------------
// 4. The 03:00 Asia/Ho_Chi_Minh business-day cutoff: a row just before 03:00
//    local time on the 1st belongs to the previous month; a row at/after 03:00
//    belongs to the new month. Mirrors
//    ledger_create_owner_investment_v1's own v_date computation exactly.
// ---------------------------------------------------------------------------
test("03:00 Asia/Ho_Chi_Minh cutoff: 02:30 on the 1st stays in the previous month, 03:00 sharp rolls into the new month", () => {
  // Local 2026-09-01T02:30 = UTC 2026-08-31T19:30 — before the 03:00 cutoff, so it
  // is still "August" and must land in September's opening cumulative, not its period.
  const beforeCutoff = row(1, "contribution", 10_000, "2026-08-31T19:30:00Z");
  // Local 2026-09-01T03:00:00 exactly = UTC 2026-08-31T20:00:00 — the cutoff instant
  // itself already belongs to the new business day/month (>=, not >).
  const atCutoff = row(2, "contribution", 20_000, "2026-08-31T20:00:00Z");
  const { summary, periodRows } = summarizeOwnerInvestments([beforeCutoff, atCutoff], "2026-09");
  assert.equal(summary.openingCumulative, 10_000);
  assert.equal(summary.periodContribution, 20_000);
  assert.deepEqual(periodRows.map((r) => r.id), [2]);
});

test("the same 03:00 cutoff correctly rolls a late-night investment into the PREVIOUS month when querying that month", () => {
  // Local 2026-10-01T02:59:59 = UTC 2026-09-30T19:59:59 — one second before the
  // cutoff, so it is still business day/month September, not October.
  const rows = [row(1, "adjustment", 5_000, "2026-09-30T19:59:59Z")];
  const septemberView = summarizeOwnerInvestments(rows, "2026-09");
  assert.equal(septemberView.summary.periodAdjustment, 5_000);
  assert.equal(septemberView.periodRows.length, 1);
  const octoberView = summarizeOwnerInvestments(rows, "2026-10");
  assert.equal(octoberView.summary.periodAdjustment, 0);
  assert.equal(octoberView.summary.openingCumulative, 5_000);
});

// ---------------------------------------------------------------------------
// 5. opening: reflected in cumulative exactly like any other signed entry —
//    the pure summarizer does not care whether a fund movement exists (that
//    is the RPC's job; source of truth here is ledger_owner_investments alone).
// ---------------------------------------------------------------------------
test("opening entries accumulate exactly like contribution/adjustment ones, with no separate movement concept", () => {
  const { summary } = summarizeOwnerInvestments(
    [row(1, "opening", 30_000_000, "2026-09-02T08:00:00Z")],
    "2026-09",
  );
  assert.equal(summary.periodOpening, 30_000_000);
  assert.equal(summary.periodNetChange, 30_000_000);
  assert.equal(summary.closingCumulative, 30_000_000);
});

// ---------------------------------------------------------------------------
// 6. contribution is counted in the investment summary but must remain outside
//    income/expense/operatingProfit — regression against the existing
//    entries.ts / route.ts contract (unchanged by this feature).
// ---------------------------------------------------------------------------
test("contribution is summarized here but stays excluded from P&L (existing direction/PROFIT_TYPES contract, unchanged)", () => {
  const { summary } = summarizeOwnerInvestments([row(1, "contribution", 10_000_000, "2026-09-05T08:00:00Z")], "2026-09");
  assert.equal(summary.periodContribution, 10_000_000);
  const entries = read("lib/ledger/entries.ts");
  assert.match(entries, /PROFIT_TYPES = new Set\(\["income", "expense", "sales", "expense_recognition"\]\)/);
  assert.doesNotMatch(entries, /PROFIT_TYPES[^;]*investment/);
  const route = read("app/api/admin/ledger/route.ts");
  assert.doesNotMatch(route, /in\("type",\s*\["income",\s*"expense",\s*"sales"\][^)]*\)[\s\S]{0,80}investment/);
  assert.match(route, /in\("type", \["income", "expense", "sales"\]\)/);
});

// ---------------------------------------------------------------------------
// 7. adjustment supports both signs; the pure summarizer never floors/clamps —
//    the "cumulative investment cannot go negative" rule is the RPC's own
//    guard (negative_cumulative_investment, covered by
//    tests/ledger-owner-settlements.test.ts), not something this read path
//    should silently mask.
// ---------------------------------------------------------------------------
test("adjustment nets positive and negative entries without any artificial floor — a negative net change passes through as-is", () => {
  const rows = [
    row(1, "opening", 100, "2026-08-01T08:00:00Z"),
    row(2, "adjustment", 30, "2026-09-03T08:00:00Z"),
    row(3, "adjustment", -90, "2026-09-18T08:00:00Z"),
  ];
  const { summary } = summarizeOwnerInvestments(rows, "2026-09");
  assert.equal(summary.periodAdjustment, -60);
  assert.equal(summary.closingCumulative, 40);
  const migration = read("supabase/migrations/202608210009_add_owner_settlements.sql");
  assert.match(migration, /negative_cumulative_investment/);
  assert.match(migration, /v_current\+p_signed_amount<0/);
});

// ---------------------------------------------------------------------------
// Precision: numeric(16,3) fractional amounts must sum exactly (reuses the
// existing BigInt-cents sumPayableAmounts helper — no duplicated math).
// ---------------------------------------------------------------------------
test("fractional numeric(16,3) amounts sum exactly, opening + net change === closing to the thousandth", () => {
  const rows = [
    row(1, "opening", "100000000.001", "2026-08-01T08:00:00Z"),
    row(2, "contribution", "0.001", "2026-09-01T05:00:00Z"),
    row(3, "adjustment", "-0.002", "2026-09-02T05:00:00Z"),
  ];
  const { summary } = summarizeOwnerInvestments(rows, "2026-09");
  assert.equal(summary.openingCumulative, 100000000.001);
  assert.equal(summary.periodNetChange, -0.001);
  assert.equal(summary.closingCumulative, 100000000);
  // A local numeric(16,3)-safe summation helper, not a duplicated float-math one —
  // mirrors lib/ledger/payables.ts's sumPayableAmounts technique deliberately kept
  // local (see the file's own comment) so this stays import-free and testable.
  assert.match(read("lib/ledger/investments.ts"), /function sumInvestmentAmounts\(values: readonly \(number \| string\)\[\]\)/);
  assert.doesNotMatch(read("lib/ledger/investments.ts"), /^import /m);
});

test("ownerInvestmentMonthBounds rejects a malformed month and mirrors the RPC's own +07:00 03:00 cutoff instant", () => {
  assert.throws(() => ownerInvestmentMonthBounds("2026-9"), /INVALID_MONTH/);
  const bounds = ownerInvestmentMonthBounds("2026-09");
  assert.equal(bounds.monthStartAt, "2026-09-01T03:00:00+07:00");
  assert.equal(bounds.nextMonthStartAt, "2026-10-01T03:00:00+07:00");
  const december = ownerInvestmentMonthBounds("2026-12");
  assert.equal(december.nextMonthStartAt, "2027-01-01T03:00:00+07:00");
  assert.match(OWNER_INVESTMENT_MONTH.source, /\\d\{4\}-/);
  const migration = read("supabase/migrations/202608210009_add_owner_settlements.sql");
  assert.match(migration, /v_date:=\(\(p_occurred_at at time zone'Asia\/Ho_Chi_Minh'\)-interval'3 hours'\)::date/);
  const monthClose = read("lib/ledger/month-close.ts");
  assert.match(monthClose, /endAt = `\$\{endExclusive\}T03:00:00\+07:00`/);
});

test("empty/all-zero summary constant matches a from-scratch empty calculation", () => {
  assert.deepEqual(summarizeOwnerInvestments([], "2026-09").summary, ZERO_OWNER_INVESTMENT_SUMMARY);
});

// ---------------------------------------------------------------------------
// 8/9. The route/loader contract: zero participants must be a normal 200
// response with configured:false (never a 404/500), and it must be
// distinguishable from "configured but zero period activity" (also 200,
// configured:true, with an all-zero-or-real summary and an empty events list).
// ---------------------------------------------------------------------------
test("investments route: authorized/validated like the other ledger read endpoints, and never special-cases zero participants into an error status", () => {
  const route = read("app/api/admin/ledger/investments/route.ts");
  assert.match(route, /requireLedgerActor/);
  assert.match(route, /OWNER_INVESTMENT_MONTH\.test\(month\)/);
  assert.match(route, /INVALID_MONTH/);
  // Only one success response shape, unconditionally ok:true — configured is a
  // field in the payload, never a different HTTP/ok outcome.
  assert.match(route, /return ledgerJson\(\{ ok: true, \.\.\.data \}\);/);
  assert.doesNotMatch(route, /configured[\s\S]{0,60}(404|ok:\s*false)/);
});

test("investments loader: configured is driven by isParticipantEffectiveForMonth (selected-month effective participants), not a bare participant-exists probe", () => {
  const server = read("lib/ledger/investments-server.ts");
  assert.match(server, /allParticipantsForConfig\.data \?\? \[\]\)\.some\(\(row\) => isParticipantEffectiveForMonth\(row, month\)\)/);
  assert.match(server, /if \(!configured\) return \{ month, configured: false, summary: ZERO_OWNER_INVESTMENT_SUMMARY, events: \[\] \};/);
  // The "configured but nothing happened this period" path is a totally different
  // branch — it still runs the real summarizer and can return real (zero) numbers.
  assert.match(server, /if \(periodRows\.length === 0\) return \{ month, configured: true, summary, events: \[\] \};/);
  // The historical participant/user lookup used to name past events is a
  // SEPARATE, unfiltered query keyed by the investment rows' own participant_id —
  // it must never be narrowed by the same-month eligibility check above, or past
  // events would lose their participant name once that participant becomes
  // ineligible / their window ends.
  assert.match(server, /ledger_owner_participants"\)\.select\("id,user_id"\)\.in\("id", participantIds\)/);
});

// ---------------------------------------------------------------------------
// configured must reflect eligibility AS OF the selected month — the same
// selected-month contract lib/ledger/owners.ts's own participant query already
// uses (effective_from<=monthDate, effective_to is null or >=monthDate,
// is_eligible=true) — not "does any participant row exist anywhere in time".
// ---------------------------------------------------------------------------
test("Case 1: a participant effective only from a future month is not configured for an earlier month, but is for its own start month", () => {
  const participant = { is_eligible: true, effective_from: "2026-09-01", effective_to: null };
  assert.equal(isParticipantEffectiveForMonth(participant, "2026-08"), false);
  assert.equal(isParticipantEffectiveForMonth(participant, "2026-09"), true);
});

test("Case 2: same open-ended participant remains configured for any month at or after their start", () => {
  const participant = { is_eligible: true, effective_from: "2026-09-01", effective_to: null };
  assert.equal(isParticipantEffectiveForMonth(participant, "2026-10"), true);
  assert.equal(isParticipantEffectiveForMonth(participant, "2027-01"), true);
});

test("Case 3: a closed effective_to window is configured through its last month and not configured the month after", () => {
  const participant = { is_eligible: true, effective_from: "2026-08-01", effective_to: "2026-08-31" };
  assert.equal(isParticipantEffectiveForMonth(participant, "2026-08"), true);
  assert.equal(isParticipantEffectiveForMonth(participant, "2026-09"), false);
  // Also not configured before the window starts.
  assert.equal(isParticipantEffectiveForMonth(participant, "2026-07"), false);
});

test("Case 4: is_eligible=false is never configured, even with an otherwise-matching effective window", () => {
  const participant = { is_eligible: false, effective_from: "2026-08-01", effective_to: "2026-08-31" };
  assert.equal(isParticipantEffectiveForMonth(participant, "2026-08"), false);
  const openEnded = { is_eligible: false, effective_from: "2026-01-01", effective_to: null };
  assert.equal(isParticipantEffectiveForMonth(openEnded, "2026-09"), false);
});

test("configured for a month is true when ANY participant (of possibly several) is effective that month, not just the first row", () => {
  const rows = [
    { is_eligible: true, effective_from: "2026-08-01", effective_to: "2026-08-31" }, // not effective in September
    { is_eligible: false, effective_from: "2026-09-01", effective_to: null }, // ineligible
    { is_eligible: true, effective_from: "2026-09-01", effective_to: null }, // effective in September
  ];
  assert.equal(rows.some((row) => isParticipantEffectiveForMonth(row, "2026-09")), true);
  assert.equal(rows.some((row) => isParticipantEffectiveForMonth(row, "2026-07")), false);
});

// ---------------------------------------------------------------------------
// opening/adjustment never carry a fund account, no matter what a stored
// snapshot happens to contain — only entry_type='contribution' ever surfaces one.
// ---------------------------------------------------------------------------
test("only contribution events ever surface a fund account — opening/adjustment ignore source_snapshot.fundAccountId entirely", () => {
  const server = read("lib/ledger/investments-server.ts");
  assert.match(server, /row\.entry_type === "contribution" && typeof rawFundAccountId === "number" \? rawFundAccountId : null/);
  assert.match(server, /\.filter\(\(row\) => row\.entry_type === "contribution"\)/);
});
