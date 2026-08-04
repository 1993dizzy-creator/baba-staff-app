import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { formatInsuranceNote } from "../lib/payroll/insurance-note.ts";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { calculatePayrollRates, applyUnifiedPayrollWorkPolicy } from "../lib/payroll/work-policy.ts";
import type { PayrollContract } from "../lib/payroll/types.ts";

test("known initial insurance note is translated and other notes are preserved", () => {
  assert.equal(formatInsuranceNote("Initial payroll insurance enrollment", false), "최초 보험 가입 설정");
  assert.equal(formatInsuranceNote("Initial payroll insurance enrollment", true), "Thiết lập tham gia bảo hiểm ban đầu");
  assert.equal(formatInsuranceNote("Manager-entered note", false), "Manager-entered note");
  assert.equal(formatInsuranceNote(null, false), null);
});

test("v7 daily rates and recognized days use each schedule's minutes", () => {
  const base: PayrollContract = {
    id: 1, userId: 1, payType: "monthly", calculationBasis: "minute", baseSalary: 7_800_000,
    fixedRaiseAmount: 0, standardWorkdays: 26, standardMinutesPerDay: 540, timeBlockMinutes: 1,
    roundingMode: "none", lateAdjustmentMode: "separate", earlyLeaveAdjustmentMode: "deduct_minutes",
    overtimeMode: "requires_approval", paidLeaveMode: "unpaid", effectiveFrom: "2026-08-01", effectiveTo: null, revision: 1,
  };
  const dayRate = 300_000;
  for (const scheduleMinutes of [540, 360]) {
    const dailyContract = { ...base, standardMinutesPerDay: scheduleMinutes };
    const rates = calculatePayrollRates(dailyContract);
    const fullDay = applyUnifiedPayrollWorkPolicy({ contract: dailyContract, actualRecognizedMinutes: scheduleMinutes, dayRate: rates.dayRate, minuteRate: rates.minuteRate, lateMinutes: 0, earlyLeaveMinutes: 0 });
    assert.equal(rates.dayRate, dayRate);
    assert.equal(rates.minuteRate, dayRate / scheduleMinutes);
    assert.equal(fullDay.recognizedWorkdays, 1);
    assert.equal(fullDay.workAmount, dayRate);
  }
  const late = { ...base, standardMinutesPerDay: 360 };
  const lateRates = calculatePayrollRates(late);
  const lateDay = applyUnifiedPayrollWorkPolicy({ contract: late, actualRecognizedMinutes: 330, dayRate: lateRates.dayRate, minuteRate: lateRates.minuteRate, lateMinutes: 30, earlyLeaveMinutes: 0 });
  assert.equal(lateDay.recognizedWorkdays, 330 / 360);
  assert.equal(lateDay.workAmount, lateRates.minuteRate * 330);
});

test("contract history API and UI expose named registration and all corrections without normal internal-id labels", () => {
  const route = fs.readFileSync("app/api/admin/payroll/contracts/route.ts", "utf8");
  const page = fs.readFileSync("app/(protected)/admin/payroll/settings/page.tsx", "utf8");
  assert.match(route, /action,actor_user_id,reason,created_at/);
  assert.match(route, /\.in\("id", actorIds\)/);
  assert.match(route, /auditLogs/);
  assert.match(page, /등록 담당자/);
  assert.match(page, /정정 담당자/);
  assert.match(page, /정정 사유/);
  assert.match(page, /corrections\.map/);
  assert.doesNotMatch(page, /"생성자"\} #\{contract\.createdBy\}/);
  assert.match(page, /createdByName/);
});

test("v7 batch path injects each day's schedule minutes while preserving contract snapshots", () => {
  const engine = fs.readFileSync("lib/payroll/monthly-run.ts", "utf8");
  assert.match(engine, /dailyContract=\{\.\.\.contract,standardMinutesPerDay:scheduleMinutes\}/);
  assert.match(engine, /calculatePayrollRates\(dailyContract/);
  assert.match(engine, /contract:dailyContract/);
  assert.match(engine, /contractSnapshot:contracts/);
});
