import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types test runner requires the explicit extension.
import { stablePayrollSourceHash } from "../lib/payroll/source-export/stable-hash.ts";

const source = {
  calculatedAt: "2026-09-09T01:00:00.000Z",
  attendance: [{ id: 2, minutes: 480 }, { id: 1, minutes: 420 }],
  contracts: [{ id: 10, revision: 3 }],
  adjustments: [{ id: 20, amount: 50_000 }],
  extraWork: [{ decisionId: 30, decision: "approved" }],
};

test("same payroll source always produces the same hash", () => {
  assert.equal(stablePayrollSourceHash(source), stablePayrollSourceHash(structuredClone(source)));
});

test("generated timestamps and array query order do not affect the hash", () => {
  const reordered = {
    ...source,
    calculatedAt: "2026-09-09T02:00:00.000Z",
    capturedAt: "2026-09-09T02:00:00.000Z",
    generatedAt: "2026-09-09T02:00:00.000Z",
    attendance: [...source.attendance].reverse(),
  };
  assert.equal(stablePayrollSourceHash(source), stablePayrollSourceHash(reordered));
});

for (const [name, changed] of [
  ["attendance", { ...source, attendance: [{ id: 1, minutes: 421 }, source.attendance[0]] }],
  ["contract revision", { ...source, contracts: [{ id: 10, revision: 4 }] }],
  ["adjustment", { ...source, adjustments: [...source.adjustments, { id: 21, amount: 10_000 }] }],
  ["extra-work decision", { ...source, extraWork: [{ decisionId: 30, decision: "rejected" }] }],
] as const) {
  test(`${name} changes the hash`, () => {
    assert.notEqual(stablePayrollSourceHash(source), stablePayrollSourceHash(changed));
  });
}

test("director insurance mapping and employee rate change the calculation hash", () => {
  const mapped = {
    ...source,
    insuranceSettings: {
      director: {
        enabled: true,
        userId: 2,
        baseAmount: 9_000_000,
        rateBp: 3_000,
        employeeRateBp: 950,
        companyPaidInsuranceTaxableAmount: 855_000,
      },
    },
  };
  assert.notEqual(
    stablePayrollSourceHash(mapped),
    stablePayrollSourceHash({ ...mapped, insuranceSettings: { director: { ...mapped.insuranceSettings.director, userId: 3 } } }),
  );
  assert.notEqual(
    stablePayrollSourceHash(mapped),
    stablePayrollSourceHash({ ...mapped, insuranceSettings: { director: { ...mapped.insuranceSettings.director, employeeRateBp: 1_050 } } }),
  );
});

// v8 지각/조퇴 deduction item metadata는 payment snapshot(automaticItemsSnapshot)에 그대로 들어가
// stablePayrollSourceHash로 해싱된다 — APP↔T8 교차검증 시 근거 값이 바뀌면 hash도 바뀌어야 한다.
const withLate = {
  ...source,
  automaticItemsSnapshot: [
    { category: "base_work", direction: "addition", amount: 350_000, sourceSnapshot: { recognizedMinutes: 600 } },
    // 일반 지각: /admin/payroll/settings minor/major tier
    { category: "late_deduction", direction: "deduction", amount: 35_000, businessDate: "2026-08-12", sourceSnapshot: { type: "late", latePenaltyMode: "settings_tier", effectiveLateMinutes: 17, manualLateNormalized: false, penaltyTier: "minor", minorPenaltyMinutes: 60, majorPenaltyRateBp: 5000, minuteRate: 350_000 / 600 } },
  ],
};

test("identical late-deduction item metadata hashes identically", () => {
  assert.equal(stablePayrollSourceHash(withLate), stablePayrollSourceHash(structuredClone(withLate)));
});

for (const [name, mutate] of [
  ["effective late minutes", (s: typeof withLate) => { s.automaticItemsSnapshot[1].sourceSnapshot.effectiveLateMinutes = 18; }],
  ["late penalty tier", (s: typeof withLate) => { s.automaticItemsSnapshot[1].sourceSnapshot.penaltyTier = "major"; }],
  ["late penalty settings (minorPenaltyMinutes)", (s: typeof withLate) => { s.automaticItemsSnapshot[1].sourceSnapshot.minorPenaltyMinutes = 45; }],
  ["late deduction amount", (s: typeof withLate) => { s.automaticItemsSnapshot[1].amount = 175_000; }],
  ["late penalty mode (general → normalized 30-minute)", (s: typeof withLate) => { s.automaticItemsSnapshot[1].sourceSnapshot.latePenaltyMode = "normalized_30min"; s.automaticItemsSnapshot[1].sourceSnapshot.manualLateNormalized = true; }],
  ["adding an early-leave deduction", (s: typeof withLate) => { s.automaticItemsSnapshot.push({ category: "early_leave_deduction", direction: "deduction", amount: 20_000, businessDate: "2026-08-12", sourceSnapshot: { type: "early_leave", effectiveEarlyLeaveMinutes: 41, penaltyMinutes: 60, penaltyBlockMinutes: 30 } } as never); }],
] as const) {
  test(`${name} changes the payment hash`, () => {
    const mutated = structuredClone(withLate);
    mutate(mutated);
    assert.notEqual(stablePayrollSourceHash(withLate), stablePayrollSourceHash(mutated));
  });
}
