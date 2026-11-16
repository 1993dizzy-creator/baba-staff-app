import assert from "node:assert/strict";
import test from "node:test";
import { buildPaymentOutflows } from "../lib/payroll/payment-outflows.ts";
import { digestDifferenceReasons, nextRunLedgerTab, RUN_LEDGER_TABS, shortPaymentDate, summarizeRunOutflow } from "../lib/payroll/run-ledger-view.ts";

// Synthetic amounts only (public repository). Real batch figures are verified outside Git.

test("summary: total outflow = employee paid + unassigned residual; stored batch total only compared, never replaced", () => {
  const employees = [
    { id: 1, employee_name: "A", payment_status: "paid" as const, actual_paid_amount: 5000000, payment_date: "2026-11-10", fund_account_id: 2 },
    { id: 2, employee_name: "B", payment_status: "paid" as const, actual_paid_amount: 4000002, payment_date: "2026-11-10", fund_account_id: 2 },
    { id: 3, employee_name: "C", payment_status: "unpaid" as const, actual_paid_amount: null, payment_date: null, fund_account_id: null },
  ];
  const residuals = [{ id: 1, payment_date: "2026-11-10", fund_account_id: 2, amount: 1, reason: "synthetic" }];
  const outflows = buildPaymentOutflows({ employees, residuals });
  assert.deepEqual(summarizeRunOutflow(9000002, outflows), { outflowTotal: 9000003, employeePaidTotal: 9000002, residualTotal: 1, storedPaidTotal: 9000002, paidTotalMatches: true });
  assert.equal(summarizeRunOutflow("9000000", outflows).paidTotalMatches, false);
  assert.equal(summarizeRunOutflow(null, buildPaymentOutflows({ employees: [] })).outflowTotal, 0, "empty / paying batch");
});

test("difference digest: common lead shown once, amount segment dropped from the short note, originals untouched", () => {
  const lead = "2026-10 synthetic corrected sheet basis";
  const reasons = [
    `${lead} · APP 계산 100₫ → 실지급 92₫ (차액 −8₫)`,
    `${lead} · APP 계산 200₫ → 실지급 202₫ (차액 +2₫) · bank 150₫ + cash refund 52₫`,
    null,
  ];
  const before = JSON.stringify(reasons);
  const digest = digestDifferenceReasons(reasons);
  assert.equal(digest.commonLead, lead);
  assert.deepEqual(digest.notes, [null, "bank 150₫ + cash refund 52₫", null]);
  assert.equal(JSON.stringify(reasons), before, "input reasons are not modified");
  // 서로 다른 자유 입력 사유(일반 급여월): 공통 사유 없음, 전체가 짧은 안내(화면에서 2줄 말줄임, 원문은 상세)
  assert.deepEqual(digestDifferenceReasons(["교통비 정산", "현금 반올림"]), { commonLead: null, notes: ["교통비 정산", "현금 반올림"] });
  // 1명뿐이면 공통 사유로 묶지 않는다
  assert.deepEqual(digestDifferenceReasons([`${lead} · APP 계산 1₫ → 실지급 2₫ (차액 +1₫)`]), { commonLead: null, notes: [lead] });
});

test("tabs switch in a fixed order with arrow/Home/End keys", () => {
  assert.deepEqual(RUN_LEDGER_TABS, ["payments", "differences", "audit"]);
  assert.equal(nextRunLedgerTab("payments", "ArrowRight"), "differences");
  assert.equal(nextRunLedgerTab("audit", "ArrowRight"), "payments");
  assert.equal(nextRunLedgerTab("payments", "ArrowLeft"), "audit");
  assert.equal(nextRunLedgerTab("differences", "Home"), "payments");
  assert.equal(nextRunLedgerTab("differences", "End"), "audit");
  assert.equal(nextRunLedgerTab("differences", "Enter"), null);
});

test("short payment date keeps unknown formats as-is", () => {
  assert.equal(shortPaymentDate("2026-11-10"), "11/10");
  assert.equal(shortPaymentDate("2026-01-05"), "1/5");
  assert.equal(shortPaymentDate(null), "—");
  assert.equal(shortPaymentDate("legacy"), "legacy");
});

test("2nd pass helpers: short title, minor-difference tone, magnitude order, one-line reason, store-time formats", async () => {
  const { runLedgerTitle, isMinorDifference, sortByDifferenceMagnitude, oneLineDifferenceReason, formatAppRecordedAt, formatExactRecordedAt } = await import("../lib/payroll/run-ledger-view.ts");
  assert.equal(runLedgerTitle("2026-10", "ko"), "26년 10월 급여장부");
  assert.equal(runLedgerTitle("2026-10", "vi"), "Sổ lương 10/26");
  assert.equal(runLedgerTitle("2027-01", "ko"), "27년 1월 급여장부");
  assert.equal(isMinorDifference(-14), true); assert.equal(isMinorDifference(999), true); assert.equal(isMinorDifference(-1000), false); assert.equal(isMinorDifference(1693), false);
  const rows = [{ id: "a", differenceAmount: 2 }, { id: "b", differenceAmount: -8848 }, { id: "c", differenceAmount: 1693 }, { id: "d", differenceAmount: -2 }];
  const before = JSON.stringify(rows);
  assert.deepEqual(sortByDifferenceMagnitude(rows).map(row => row.id), ["b", "c", "a", "d"], "stable for equal magnitude");
  assert.equal(JSON.stringify(rows), before);
  assert.equal(oneLineDifferenceReason("lead · APP 계산 1₫ → 실지급 2₫ (차액 +1₫) · note", "note", "lead"), "note");
  assert.equal(oneLineDifferenceReason("lead · APP 계산 1₫ → 실지급 2₫ (차액 +1₫)", null, "lead"), "lead");
  assert.equal(oneLineDifferenceReason("free text", null, null), "free text");
  assert.equal(oneLineDifferenceReason("  ", null, "lead"), null);
  // 2026-11-16 12:11 UTC = 19:11 Asia/Ho_Chi_Minh (실행 환경 시간대와 무관)
  assert.equal(formatAppRecordedAt("2026-11-16T12:11:02.642863+00:00", "ko"), "11/16 19:11");
  assert.equal(formatAppRecordedAt("2026-11-16T12:11:02.642863+00:00", "vi"), "16/11 19:11");
  assert.equal(formatAppRecordedAt("2026-11-16T17:30:00Z", "ko"), "11/17 00:30", "24h, date rolls in store time");
  assert.equal(formatExactRecordedAt("2026-11-16T12:11:02.642863+00:00"), "2026-11-16 19:11:02.642 (UTC+07:00 Asia/Ho_Chi_Minh)");
  assert.equal(formatAppRecordedAt(null, "ko"), "—"); assert.equal(formatExactRecordedAt("bad"), "—");
});

test("3rd pass: part groups by payment-time part_snapshot, responsible roles first, subtotals exclude the residual", async () => {
  const { groupRunEmployeesByPart, showsDifferenceBadgeInList, responsibleRoleOf } = await import("../lib/payroll/run-ledger-view.ts");
  const e = (id: number, name: string, part: string | null, position: string | null, amount: number | null, status: "paid" | "unpaid" = "paid") => ({ id, employee_name: name, part_snapshot: part, position_snapshot: position, payment_status: status, actual_paid_amount: amount });
  const employees = [e(1, "Nhung", "hall", "staff", 100), e(2, "Uyen", "hall", "manager", 300), e(3, "Ann", "hall", "staff", 200), e(4, "Quyen", "kitchen", "leader", 400),
    e(5, "Boss", "owner", "owner", 1000), e(6, "Zed", null, "staff", 50), e(7, "Kim", "bar", "staff", null, "unpaid"), e(8, "Ann", "hall", "staff", 700)];
  const before = JSON.stringify(employees);
  const groups = groupRunEmployeesByPart(employees);
  assert.deepEqual(groups.map(g => g.part), ["owner", "kitchen", "hall", "bar", "etc"], "shared part rank (owner → kitchen → hall → bar → cleaning → etc)");
  const hall = groups.find(g => g.part === "hall")!;
  assert.deepEqual(hall.employees.map(x => x.id), [2, 3, 8, 1], "manager first, then name, then id (stable)");
  assert.equal(hall.paidTotal, 1300); assert.equal(hall.count, 4);
  const bar = groups.find(g => g.part === "bar")!;
  assert.deepEqual([bar.count, bar.unpaidCount, bar.paidTotal], [1, 1, 0], "unpaid never counted as 0₫ paid");
  assert.equal(groups.reduce((n, g) => n + g.paidTotal, 0), 100 + 300 + 200 + 400 + 1000 + 50 + 700, "sum of subtotals = employee paid total (no residual)");
  assert.equal(JSON.stringify(employees), before);
  assert.equal(showsDifferenceBadgeInList(-8848), true); assert.equal(showsDifferenceBadgeInList(1693), true);
  assert.equal(showsDifferenceBadgeInList(-14), false); assert.equal(showsDifferenceBadgeInList(2), false); assert.equal(showsDifferenceBadgeInList(0), false);
  assert.equal(responsibleRoleOf("manager"), "manager"); assert.equal(responsibleRoleOf("leader"), "leader");
  assert.equal(responsibleRoleOf("staff"), null); assert.equal(responsibleRoleOf("owner"), null);
});
