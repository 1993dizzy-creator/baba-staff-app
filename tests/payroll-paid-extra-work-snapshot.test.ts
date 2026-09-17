import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { lockPaidExtraWorkReview, paidExtraWorkAmount, paidExtraWorkRows } from "../lib/payroll/paid-extra-work.ts";
import type { PayrollOverviewEmployee } from "../lib/payroll/overview.ts";

const extraWorkRoute = readFileSync("app/api/admin/payroll/part-time-extra-work/route.ts", "utf8");
const overviewRoute = readFileSync("app/api/admin/payroll/overview/route.ts", "utf8");

function overviewEmployee(): PayrollOverviewEmployee {
  return {
    userId: 14, name: "Khoi", part: "kitchen", position: "chef", role: "staff",
    contract: { id: 21, payType: "monthly" },
    amounts: { partTimeExtraWorkAmount: 0, netPayoutAmount: 8_000_000 },
    partTimeExtraWork: [{ status: "review_required", attendanceRecordId: 1350 }],
    reviewCount: 1, blockingCount: 1,
    warningCodes: ["PART_TIME_EXTRA_WORK_REVIEW_REQUIRED"],
    calculationStatus: "requires_review",
    levelApplication: { status: "applied" }, tax: { status: "calculated" },
  } as unknown as PayrollOverviewEmployee;
}

test("paid payroll displays only stored decisions and its paid-time amount", () => {
  const approved = { attendanceRecordId: 7, candidateMinutes: 34, candidateAmount: 37_778,
    status: "approved", decision: { id: 10, decision: "approved" } };
  const rejected = { attendanceRecordId: 8, candidateMinutes: 40, candidateAmount: 44_444,
    status: "rejected", decision: { id: 11, decision: "rejected" } };
  const snapshot = { employee: { userId: 14, amounts: { partTimeExtraWorkAmount: 37_778, netPayoutAmount: 9_000_000 } },
    partTimeExtraWorkSnapshot: [approved, rejected,
      { attendanceRecordId: 9, status: "review_required", decision: null },
      { attendanceRecordId: 10, status: "stale", decision: { id: 12 } }] };
  assert.deepEqual(paidExtraWorkRows(snapshot), [approved, rejected]);
  assert.equal(paidExtraWorkAmount(snapshot), 37_778);
  const current = overviewEmployee();
  const archived = lockPaidExtraWorkReview(current, snapshot);
  assert.deepEqual(archived.partTimeExtraWork, [approved, rejected]);
  assert.equal(archived.amounts, current.amounts);
  assert.equal(archived.contract, current.contract);
  assert.deepEqual(snapshot.partTimeExtraWorkSnapshot, [approved, rejected,
    { attendanceRecordId: 9, status: "review_required", decision: null },
    { attendanceRecordId: 10, status: "stale", decision: { id: 12 } }]);
});

test("paid month with no historical extra-work decisions never exposes newly recalculated rows", () => {
  const snapshot = { employee: { userId: 14, amounts: { partTimeExtraWorkAmount: 0, netPayoutAmount: 8_000_000 } },
    partTimeExtraWorkSnapshot: [] };
  assert.deepEqual(paidExtraWorkRows(snapshot), []);
  assert.equal(paidExtraWorkAmount(snapshot), 0);
  const current = overviewEmployee();
  const visible = lockPaidExtraWorkReview(current, snapshot);
  assert.deepEqual(visible.partTimeExtraWork, []);
  assert.equal(visible.reviewCount, 0);
  assert.equal(visible.blockingCount, 0);
  assert.deepEqual(visible.warningCodes, []);
  assert.equal(visible.calculationStatus, "calculable");
  assert.equal(visible.amounts, current.amounts);
  assert.match(extraWorkRoute, /paidPayment \? paidExtraWorkRows\(snapshot \?\? null\) : employee\.partTimeExtraWork/);
  assert.match(extraWorkRoute, /paidPayment \? paidExtraWorkAmount\(snapshot \?\? null\)/);
  assert.match(extraWorkRoute, /\.eq\("payment_status", "paid"\)/);
  assert.match(overviewRoute, /payment\?\.payment_status==="paid"[\s\S]*lockPaidExtraWorkReview\(employee,payment\.calculation_snapshot/);
  assert.doesNotMatch(overviewRoute, /\.\.\.archived|paidOverviewEmployee|PAID_PAYROLL_SNAPSHOT_MISSING/);
  assert.doesNotMatch(extraWorkRoute.slice(extraWorkRoute.indexOf("export async function GET"), extraWorkRoute.indexOf("export async function POST")),
    /\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
});

test("August overview keeps live contract, part, position and pay for abbreviated and full payment snapshots", () => {
  const abbreviated = { employee: { name: "Khoi", userId: 14, amounts: { partTimeExtraWorkAmount: 0 } },
    partTimeExtraWorkSnapshot: [] };
  const full = { employee: { ...overviewEmployee(), part: "wrong-part", position: "wrong-position", contract: null },
    partTimeExtraWorkSnapshot: [] };
  for (const snapshot of [abbreviated, full]) {
    const current = overviewEmployee();
    const visible = lockPaidExtraWorkReview(current, snapshot);
    assert.equal(visible.contract, current.contract);
    assert.equal(visible.part, "kitchen");
    assert.equal(visible.position, "chef");
    assert.equal(visible.role, "staff");
    assert.equal(visible.amounts, current.amounts);
    assert.equal(visible.name, "Khoi");
  }
  assert.match(overviewRoute, /const visibleEmployee=payment\?\.payment_status==="paid"/);
  assert.match(overviewRoute, /lockPaidExtraWorkReview\(employee,/);
});
