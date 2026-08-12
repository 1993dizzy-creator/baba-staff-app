import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node direct TypeScript tests require extensions.
import { attendanceBonusMonthlyStatus } from "../lib/payroll/attendance-bonus-status.ts";

const policy = { minimumActualWorkdays: 26, allowedLateCount: 0, allowedEarlyLeaveCount: 0, bonusAmount: 300000 };
const standing = { actualWorkDays: 8, lateCount: 0, earlyLeaveCount: 0, unauthorizedAbsenceCount: 0, blockingCount: 0, perfectAttendanceCurrent: true };
const status = (overrides: Partial<Parameters<typeof attendanceBonusMonthlyStatus>[0]> = {}) => attendanceBonusMonthlyStatus({
  vi: false,
  isEligible: true,
  eligibilityEffectiveMonth: "2026-08",
  payrollMonth: "2026-08",
  monthClosed: false,
  policy,
  standing,
  ...overrides,
});

test("monthly status handles ineligible, future eligibility and missing policy", () => {
  assert.equal(status({ isEligible: false }), "미대상");
  assert.equal(status({ eligibilityEffectiveMonth: "2026-09" }), "적용 전");
  assert.equal(status({ policy: null }), "공통 정책 미설정");
});

test("monthly status reports blocking and exceeded late/early counts", () => {
  assert.equal(status({ standing: { ...standing, blockingCount: 1 } }), "조건 미충족 · 근태 확인 필요");
  assert.equal(status({ standing: { ...standing, lateCount: 1, perfectAttendanceCurrent: false } }), "조건 미충족 · 지각 1회");
  assert.equal(status({ standing: { ...standing, earlyLeaveCount: 1, perfectAttendanceCurrent: false } }), "조건 미충족 · 조퇴 1회");
  assert.equal(status({ standing: { ...standing, lateCount: 1, earlyLeaveCount: 1, perfectAttendanceCurrent: false } }), "조건 미충족 · 지각 1회 · 조퇴 1회");
});

test("monthly status distinguishes perfect progress, allowed defects and minimum completion", () => {
  assert.equal(status(), "💯 유지 중 · 8/26일");
  assert.equal(status({ policy: { ...policy, allowedLateCount: 1 }, standing: { ...standing, lateCount: 1, perfectAttendanceCurrent: false } }), "조건 유지 중 · 8/26일");
  assert.equal(status({ standing: { ...standing, actualWorkDays: 26 } }), "지급 조건 충족 중 · 26/26일");
});

test("closed-month status only confirms payment when every final condition is met", () => {
  assert.equal(status({ monthClosed: true, standing: { ...standing, actualWorkDays: 26 } }), "지급 확정 · 300,000 VND");
  assert.equal(status({ monthClosed: true }), "미지급 · 조건 미충족");
  assert.equal(status({ monthClosed: true, standing: { ...standing, actualWorkDays: 26, lateCount: 1, perfectAttendanceCurrent: false } }), "미지급 · 조건 미충족");
});

test("Vietnamese monthly status is localized", () => {
  assert.equal(status({ vi: true }), "💯 Đang duy trì · 8/26 ngày");
  assert.equal(status({ vi: true, isEligible: false }), "Không áp dụng");
});
