import test from "node:test";
import assert from "node:assert/strict";
import { buildSettlementPreview, parseSettlementPlan, settlementDifferenceReason, validSettlementRequestKey } from "../lib/payroll/special-settlement-2026-10.ts";

// Synthetic plan only.
const base = () => ({
  version: 1, payrollMonth: "2026-10", sourceTitle: "synthetic",
  employees: [
    { userId: 1, actualPaidAmount: 1000, allocations: [{ paymentDate: "2026-11-10", fundAccountId: 2, amount: 1000, kind: "salary" }] },
    { userId: 2, actualPaidAmount: 520, allocations: [{ paymentDate: "2026-11-10", fundAccountId: 2, amount: 500, kind: "salary" }, { paymentDate: "2026-11-10", fundAccountId: 1, amount: 20, kind: "penalty_refund", note: "refund" }] },
    { userId: 3, actualPaidAmount: 300, allocations: [{ paymentDate: "2026-11-14", fundAccountId: 1, amount: 300, kind: "salary" }] },
  ],
  residuals: [{ paymentDate: "2026-11-10", fundAccountId: 2, amount: 1, reason: "rounding" }],
  expectedGroups: [{ paymentDate: "2026-11-10", fundAccountId: 2, amount: 1501 }, { paymentDate: "2026-11-10", fundAccountId: 1, amount: 20 }, { paymentDate: "2026-11-14", fundAccountId: 1, amount: 300 }],
  expectedTotal: 1821,
});
const errorsOf = (raw: unknown) => { const r = parseSettlementPlan(raw); return r.ok ? [] : r.errors; };

test("valid plan reconciles groups, residual and total; hash is stable", () => {
  const a = parseSettlementPlan(base()), b = parseSettlementPlan(base());
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  if (a.ok && b.ok) assert.equal(a.planHash, b.planHash);
});

test("plan rejects every reconciliation break", () => {
  const cases: Array<[string, (p: ReturnType<typeof base>) => void, RegExp]> = [
    ["group total", p => { p.expectedGroups[0].amount = 1500; }, /TOTAL_MISMATCH/],
    ["missing residual makes bank short", p => { p.residuals = []; }, /TOTAL_MISMATCH/],
    ["allocation sum", p => { p.employees[1].actualPaidAmount = 521; }, /ALLOCATION_SUM/],
    ["two salary allocations", p => { p.employees[1].allocations[1].kind = "salary"; }, /SALARY_ALLOCATION_COUNT/],
    ["duplicate user", p => { p.employees[2].userId = 1; }, /DUPLICATE_USER/],
    ["payment before month end", p => { p.employees[2].allocations[0].paymentDate = "2026-10-31"; }, /DATE_BEFORE_MONTH_END/],
    ["undeclared group", p => { p.expectedGroups.pop(); p.expectedTotal = 1521; }, /UNDECLARED/],
    ["residual too large", p => { p.residuals[0].amount = 1001; }, /residuals\[0\]:SHAPE/],
    ["wrong month", p => { (p as { payrollMonth: string }).payrollMonth = "2026-09"; }, /PLAN_MONTH/],
    ["expected total", p => { p.expectedTotal = 1820; }, /EXPECTED_TOTAL_MISMATCH/],
  ];
  for (const [name, mutate, pattern] of cases) { const p = base(); mutate(p); assert.match(errorsOf(p).join(","), pattern, name); }
});

test("preview: roster must equal plan, unpaid blockers surface, token tracks calculation", () => {
  const parsed = parseSettlementPlan(base()); assert.ok(parsed.ok); if (!parsed.ok) return;
  const candidates = [1, 2, 3].map(userId => ({ userId, employeeName: `E${userId}`, calculatedNetAmount: userId === 2 ? 518 : userId * 1000 === 1000 ? 1000 : 300, calculationHash: `h${userId}`, isPayable: true, failureCodes: [], paymentStatus: "unpaid" as const }));
  const ok = buildSettlementPreview(parsed.plan, parsed.planHash, candidates);
  assert.deepEqual(ok.blockers, []);
  assert.equal(ok.rows.find(r => r.userId === 2)!.differenceAmount, 2);
  assert.match(ok.rows.find(r => r.userId === 2)!.differenceReason!, /차액 \+2₫ · $|차액 \+2₫/);
  assert.equal(ok.rows.find(r => r.userId === 1)!.differenceReason, null);
  const changed = buildSettlementPreview(parsed.plan, parsed.planHash, candidates.map(c => c.userId === 1 ? { ...c, calculationHash: "other" } : c));
  assert.notEqual(changed.previewToken, ok.previewToken);
  const blocked = buildSettlementPreview(parsed.plan, parsed.planHash, [...candidates.slice(0, 2).map(c => c.userId === 2 ? { ...c, isPayable: false, calculationHash: null } : c), { ...candidates[0], userId: 9 }]);
  assert.deepEqual(blocked.blockers.sort(), ["EMPLOYEE_NOT_PAYABLE:2", "PLAN_USER_NOT_IN_ROSTER:3", "ROSTER_USER_NOT_IN_PLAN:9"]);
  const done = buildSettlementPreview(parsed.plan, parsed.planHash, candidates.map(c => ({ ...c, paymentStatus: "paid" as const })));
  assert.deepEqual(done.blockers, ["NOTHING_TO_SETTLE"]);
});

test("difference reason and request key format", () => {
  assert.equal(settlementDifferenceReason({ sourceTitle: "x", calculatedNetAmount: 10, actualPaidAmount: 10, note: null }), null);
  assert.match(settlementDifferenceReason({ sourceTitle: "x", calculatedNetAmount: 6105555, actualPaidAmount: 6100000, note: "cash" })!, /\(차액 −5555₫\) · cash$/);
  assert.equal(validSettlementRequestKey("oct2026-0123456789abcdef"), true);
  assert.equal(validSettlementRequestKey("short"), false);
  assert.equal(validSettlementRequestKey("bad key with spaces 12345"), false);
});
