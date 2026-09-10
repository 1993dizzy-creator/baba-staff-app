import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error Node test execution requires explicit TypeScript extensions.
import { applyUnifiedPayrollWorkPolicy as applyPayrollWorkPolicy, calculatePayrollRates, selectUnifiedRecognizedMinutes } from "../lib/payroll/work-policy.ts";
// @ts-expect-error Node test execution requires explicit TypeScript extensions.
import { normalizeAttendanceDayFacts } from "../lib/payroll/attendance-facts.ts";
// @ts-expect-error Node test execution requires explicit TypeScript extensions.
import { calculateLatePenalty, calculateTimePenalty } from "../lib/payroll/penalties.ts";
import type { PayrollContract, WorkScheduleVersion } from "../lib/payroll/types.ts";

// BABA 확정 정책(engine v8):
//   정상근무 1일 = 그 날짜 기준급여 전액 (지각/조퇴로 기본급 분단위 감소 없음).
//   일반 지각(manualLateNormalized=false) → 기존 /admin/payroll/settings minor/major tier.
//   수동 정상화 지각(manualLateNormalized=true) + 조퇴 → effective 분을 30분 단위 올림.
//   1일 기본급  − 지각 패널티  − 조퇴 패널티

// /admin/payroll/settings 현재 기본값
const SETTINGS = { thresholdMinutes: 20, minorPenaltyMinutes: 60, majorPenaltyRateBp: 5000 };

// 10시간 스케줄(600분) — task 예시(1일 350,000 / 기준근무 600분)와 맞춘다.
const sched10h: WorkScheduleVersion = { id: 1, userId: 9, startTime: "16:00", endTime: "02:00", unpaidBreakMinutes: 0, effectiveFrom: "2026-08-01", effectiveTo: null, revision: 1, changeReason: null };
// 5시간 스케줄(300분) — hourly task 예시(35,000 × 5 = 175,000).
const sched5h: WorkScheduleVersion = { ...sched10h, id: 2, startTime: "16:00", endTime: "21:00" };

// monthly: dayRate = 9,100,000 / 26 = 350,000
const monthly: PayrollContract = { id: 10, userId: 9, payType: "monthly", calculationBasis: "minute", baseSalary: 9_100_000, fixedRaiseAmount: 0, standardWorkdays: 26, standardMinutesPerDay: 600, timeBlockMinutes: 1, roundingMode: "none", lateAdjustmentMode: "separate", earlyLeaveAdjustmentMode: "separate", overtimeMode: "ignore", paidLeaveMode: "unpaid", effectiveFrom: "2026-08-01", effectiveTo: null, revision: 1 };
const daily: PayrollContract = { ...monthly, id: 11, payType: "daily", baseSalary: 350_000, standardWorkdays: null };
const hourly: PayrollContract = { ...monthly, id: 12, payType: "hourly", baseSalary: 35_000, standardWorkdays: null };

type DayOpts = { lateGrace?: number; earlyLeaveGrace?: number; manualLateNormalized?: boolean; schedule?: WorkScheduleVersion };

// monthly-run.ts calculateEmployee 의 정상근무일 지각/조퇴 분기를 그대로 재현한다.
function simulateDay(contract: PayrollContract, checkInAt: string, checkOutAt: string, opts: DayOpts = {}) {
  const schedule = opts.schedule ?? sched10h;
  const f = normalizeAttendanceDayFacts({
    userId: 9, businessDate: "2026-08-03", schedule,
    lateGraceMinutes: opts.lateGrace ?? 0, earlyLeaveGraceMinutes: opts.earlyLeaveGrace ?? 0,
    manualLateNormalized: opts.manualLateNormalized ?? false,
    attendanceRecord: { id: 1, status: "done", checkInAt, checkOutAt, approvalStatus: "approved" },
  });
  const dailyContract = { ...contract, standardMinutesPerDay: f.scheduledMinutes as number };
  const rate = calculatePayrollRates(dailyContract, contract.baseSalary);
  const recognized = selectUnifiedRecognizedMinutes({ scheduledMinutes: f.scheduledMinutes as number, scheduledOverlapMinutes: f.scheduledOverlapMinutes as number, actualMinutes: f.actualMinutes as number, lateMinutes: f.lateMinutes, earlyLeaveMinutes: f.earlyLeaveMinutes, manualLateNormalized: f.manualLateNormalized });
  const work = applyPayrollWorkPolicy({ contract: dailyContract, actualRecognizedMinutes: recognized, dayRate: rate.dayRate, minuteRate: rate.minuteRate, lateMinutes: f.lateMinutes, earlyLeaveMinutes: f.earlyLeaveMinutes });
  const latePenalty = f.manualLateNormalized
    ? { mode: "normalized_30min" as const, tier: null as string | null, ...calculateTimePenalty({ effectiveMinutes: f.effectiveLateMinutes, minuteRate: rate.minuteRate }) }
    : { mode: "settings_tier" as const, penaltyMinutes: null as number | null, ...calculateLatePenalty({ lateMinutes: f.effectiveLateMinutes, minuteRate: rate.minuteRate, dayRate: rate.dayRate, ...SETTINGS }) };
  const earlyLeavePenalty = calculateTimePenalty({ effectiveMinutes: f.earlyLeaveMinutes, minuteRate: rate.minuteRate });
  const base = Math.round(work.workAmount);
  return { facts: f, rate, base, latePenalty, earlyLeavePenalty, net: base - latePenalty.amount - earlyLeavePenalty.amount };
}

const IN = (hhmm: string) => `2026-08-03T${hhmm}:00+07:00`;
const OUT = (hhmm: string, nextDay = true) => `2026-08-0${nextDay ? "4" : "3"}T${hhmm}:00+07:00`;

// A. 일반 지각 17분 → 1일 전액 + minor 정책(60분 × 분급). 30분이면 실패.
test("A. general 17-minute late: full base + settings minor tier (60 minutes of pay), NOT a 30-minute block", () => {
  const d = simulateDay(monthly, IN("16:17"), OUT("02:00"));
  assert.equal(d.facts.manualLateNormalized, false);
  assert.equal(d.facts.effectiveLateMinutes, 17);
  assert.equal(d.base, 350_000);
  assert.equal(d.latePenalty.mode, "settings_tier");
  assert.equal(d.latePenalty.tier, "minor");
  assert.equal(d.latePenalty.amount, Math.round((350_000 / 600) * 60)); // 35,000
  assert.notEqual(d.latePenalty.amount, Math.round((350_000 / 600) * 30));
  assert.equal(d.earlyLeavePenalty.amount, 0);
});

// B. 일반 지각 20분 (경계) → minor
test("B. general 20-minute late is still the minor tier", () => {
  const d = simulateDay(monthly, IN("16:20"), OUT("02:00"));
  assert.equal(d.latePenalty.tier, "minor");
  assert.equal(d.latePenalty.amount, Math.round((350_000 / 600) * 60));
});

// C. 일반 지각 21분 → major (dayRate × 0.5)
test("C. general 21-minute late crosses into the major tier (dayRate x 0.5)", () => {
  const d = simulateDay(monthly, IN("16:21"), OUT("02:00"));
  assert.equal(d.latePenalty.tier, "major");
  assert.equal(d.latePenalty.amount, Math.round(350_000 * 0.5)); // 175,000
  assert.equal(d.base, 350_000);
});

// D. 수동 정상화 17분 → 1일 전액 + 30분 급여. minor 60분이면 실패.
test("D. normalized 17-minute late: full base + a 30-minute-block penalty (never the minor 60)", () => {
  const d = simulateDay(monthly, IN("16:17"), OUT("02:00"), { manualLateNormalized: true });
  assert.equal(d.facts.manualLateNormalized, true);
  assert.equal(d.facts.lateMinutes, 0);
  assert.equal(d.facts.rawLateMinutes, 17);
  assert.equal(d.facts.effectiveLateMinutes, 17);
  assert.equal(d.base, 350_000);
  assert.equal(d.latePenalty.mode, "normalized_30min");
  assert.equal(d.latePenalty.penaltyMinutes, 30);
  assert.equal(d.latePenalty.amount, Math.round((350_000 / 600) * 30)); // 17,500
  assert.notEqual(d.latePenalty.amount, Math.round((350_000 / 600) * 60));
});

// E. 수동 정상화 31분 → 60분 급여
test("E. normalized 31-minute late rounds up to a 60-minute-block penalty", () => {
  const d = simulateDay(monthly, IN("16:31"), OUT("02:00"), { manualLateNormalized: true });
  assert.equal(d.latePenalty.penaltyMinutes, 60);
  assert.equal(d.latePenalty.amount, Math.round((350_000 / 600) * 60));
  assert.equal(d.base, 350_000);
});

// F. 조퇴 17분 → 1일 전액 + 조퇴 30분
test("F. 17-minute early leave: full base + a 30-minute early-leave penalty", () => {
  const d = simulateDay(monthly, IN("16:00"), OUT("01:43"));
  assert.equal(d.facts.earlyLeaveMinutes, 17);
  assert.equal(d.base, 350_000);
  assert.equal(d.latePenalty.amount, 0);
  assert.equal(d.earlyLeavePenalty.penaltyMinutes, 30);
  assert.equal(d.earlyLeavePenalty.amount, Math.round((350_000 / 600) * 30));
});

// G. 조퇴 31분 → 60분
test("G. 31-minute early leave rounds up to a 60-minute penalty", () => {
  const d = simulateDay(monthly, IN("16:00"), OUT("01:29"));
  assert.equal(d.facts.earlyLeaveMinutes, 31);
  assert.equal(d.earlyLeavePenalty.penaltyMinutes, 60);
});

// H. 일반 지각 17분 + 조퇴 41분 → 1일 전액, 지각 minor 60분, 조퇴 60분 (독립)
test("H. general 17-minute late + 41-minute early leave: full base, minor-tier late, 60-minute early leave", () => {
  const d = simulateDay(monthly, IN("16:17"), OUT("01:19"));
  assert.equal(d.facts.effectiveLateMinutes, 17);
  assert.equal(d.facts.earlyLeaveMinutes, 41);
  assert.equal(d.base, 350_000); // scheduledOverlap 재차감 없음
  assert.equal(d.latePenalty.tier, "minor");
  assert.equal(d.latePenalty.amount, Math.round((350_000 / 600) * 60));
  assert.equal(d.earlyLeavePenalty.penaltyMinutes, 60);
  assert.equal(d.net, 350_000 - Math.round((350_000 / 600) * 60) - Math.round((350_000 / 600) * 60));
});

// I. 수동 정상화 지각 17분 + 조퇴 41분 → 1일 전액, 정상화 지각 30분, 조퇴 60분
test("I. normalized 17-minute late + 41-minute early leave: full base, 30-minute normalized late, 60-minute early leave", () => {
  const d = simulateDay(monthly, IN("16:17"), OUT("01:19"), { manualLateNormalized: true });
  assert.equal(d.base, 350_000);
  assert.equal(d.latePenalty.mode, "normalized_30min");
  assert.equal(d.latePenalty.penaltyMinutes, 30);
  assert.equal(d.earlyLeavePenalty.penaltyMinutes, 60);
  assert.equal(d.net, 350_000 - Math.round((350_000 / 600) * 30) - Math.round((350_000 / 600) * 60));
});

// J. grace 적용 후 effectiveLateMinutes = 0 → 지각 penalty 0
test("J. within the store grace, effectiveLateMinutes is 0 and there is no late penalty (general or normalized)", () => {
  const general = simulateDay(monthly, IN("16:08"), OUT("02:00"), { lateGrace: 10 });
  assert.equal(general.facts.effectiveLateMinutes, 0);
  assert.equal(general.latePenalty.amount, 0);
  const normalized = simulateDay(monthly, IN("16:08"), OUT("02:00"), { lateGrace: 10, manualLateNormalized: true });
  assert.equal(normalized.facts.effectiveLateMinutes, 0);
  assert.equal(normalized.latePenalty.amount, 0);
});

// N. hourly + 일반 지각 → 기본급 175,000 전액 + minor/major tier
test("N. hourly 5h @ 35,000 + general 17-minute late: base 175,000 and a separate minor-tier penalty", () => {
  const d = simulateDay(hourly, IN("16:17"), OUT("21:00", false), { schedule: sched5h });
  assert.equal(d.rate.minuteRate, 35_000 / 60);
  assert.equal(d.base, 175_000);
  assert.equal(d.latePenalty.mode, "settings_tier");
  assert.equal(d.latePenalty.tier, "minor");
  assert.equal(d.latePenalty.amount, Math.round((35_000 / 60) * 60));
});

// O. hourly + 수동 정상화 지각 → 기본급 175,000 전액 + 30분 단위
test("O. hourly + normalized 17-minute late: base 175,000 and a separate 30-minute-block penalty", () => {
  const d = simulateDay(hourly, IN("16:17"), OUT("21:00", false), { schedule: sched5h, manualLateNormalized: true });
  assert.equal(d.base, 175_000);
  assert.equal(d.latePenalty.mode, "normalized_30min");
  assert.equal(d.latePenalty.penaltyMinutes, 30);
  assert.equal(d.latePenalty.amount, Math.round((35_000 / 60) * 30));
});

// daily 정상 + 조퇴
test("daily: normal day pays the contract day rate; early leave adds only a separate 30-minute deduction", () => {
  assert.equal(simulateDay(daily, IN("16:00"), OUT("02:00")).base, 350_000);
  const early = simulateDay(daily, IN("16:00"), OUT("01:40"));
  assert.equal(early.base, 350_000);
  assert.equal(early.earlyLeavePenalty.penaltyMinutes, 30);
});

// K/L/M. fixed_monthly 는 근태 연동 대상이 아니다 — 지각/조퇴/무단결근 로직 이전에 return 한다.
test("K/L/M. the fixed_monthly branch returns before any late/early-leave logic and only keeps the existing unauthorized-absence policy", () => {
  const engine = readFileSync(join(process.cwd(), "lib/payroll/monthly-run.ts"), "utf8");
  const fixedBranch = engine.slice(
    engine.indexOf("if(calculationDate&&fixedContractMatches.length===1){"),
    engine.indexOf("for(const date of eligibleDates){"),
  );
  assert.ok(fixedBranch.length > 0);
  // fixed_monthly 경로 안에서는 지각/조퇴 계산기를 절대 부르지 않는다.
  assert.doesNotMatch(fixedBranch, /calculateLatePenalty|calculateTimePenalty|selectUnifiedRecognizedMinutes|early_leave_deduction/);
  assert.doesNotMatch(fixedBranch, /item\("late_deduction"/);
  // 무단결근 정책(3일 = unauthorizedAbsencePenaltyDays)은 그대로.
  assert.match(fixedBranch, /calculateUnauthorizedAbsencePenalty\(\{dayRate:rate\.dayRate,penaltyDays:input\.penaltySettings\.unauthorizedAbsencePenaltyDays\}\)/);
  assert.match(fixedBranch, /return\{userId:user\.id/);
});

// selectUnifiedRecognizedMinutes 은 언제나 스케줄 전액을 돌려준다.
test("selectUnifiedRecognizedMinutes always returns the full scheduled day", () => {
  for (const args of [
    { scheduledMinutes: 600, scheduledOverlapMinutes: 400, actualMinutes: 400, lateMinutes: 120, earlyLeaveMinutes: 0, manualLateNormalized: false },
    { scheduledMinutes: 600, scheduledOverlapMinutes: 300, actualMinutes: 300, lateMinutes: 60, earlyLeaveMinutes: 60, manualLateNormalized: false },
    { scheduledMinutes: 600, scheduledOverlapMinutes: 500, actualMinutes: 500, lateMinutes: 0, earlyLeaveMinutes: 0, manualLateNormalized: true },
  ]) {
    assert.equal(selectUnifiedRecognizedMinutes(args), 600);
  }
});
