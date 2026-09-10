import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node test execution requires explicit TypeScript extensions.
import { reviewLabel } from "../lib/payroll/ui-labels.ts";

const card = readFileSync(join(process.cwd(), "components/payroll/CompensationCard.tsx"), "utf8");

test("blocked payment card shows human-readable reasons drawn from data already on the employee", () => {
  // 이미 급여 overview에서 계산된 warningCodes(리뷰 + 세금)를 재사용한다.
  assert.match(card, /employee\.warningCodes\.map\(\(code\) => reviewLabel\(lang, code\)\)/);
  assert.match(card, /지급 불가 사유/);
  assert.match(card, /Lý do chưa thể chi trả/);
  // 새로운 Source Export / source-export API 호출로 사유를 만들지 않는다.
  assert.doesNotMatch(card, /source-export/);
  assert.doesNotMatch(card, /buildPayrollSourceExport/);
});

test("reviewLabel maps every payment-blocking code to friendly bilingual copy, never the raw code", () => {
  const codes = [
    "NO_PAYROLL_CONTRACT", "MISSING_CHECK_IN", "MISSING_CHECK_OUT", "INVALID_TIME_RANGE",
    "SCHEDULE_HISTORY_UNAVAILABLE", "CONTRACT_OVERLAP", "CALCULATION_FAILED",
    "PENDING_LEAVE_APPROVAL", "LEAVE_PAYROLL_TREATMENT_UNSPECIFIED",
    "EMPLOYEE_LEVEL_BASE_DATE_REQUIRED",
    "PART_TIME_EXTRA_WORK_REVIEW_REQUIRED", "PART_TIME_EXTRA_WORK_DECISION_STALE",
    "TAX_PROFILE_REQUIRES_REVIEW", "TAX_POLICY_MISSING", "TAX_POLICY_INVALID",
    "OVERTIME_TAX_EXEMPTION_REQUIRES_REVIEW",
  ];
  for (const code of codes) {
    for (const lang of ["ko", "vi"] as const) {
      const label = reviewLabel(lang, code);
      assert.ok(label && label !== code, `${lang}/${code} should be translated`);
      assert.doesNotMatch(label, /[A-Z]{2,}_[A-Z]/);
    }
  }
});

test("the technical part-time stale code is shown as a re-review sentence, not the code name", () => {
  assert.equal(reviewLabel("ko", "PART_TIME_EXTRA_WORK_DECISION_STALE"), "추가근무 원천정보가 변경되어 재검토가 필요합니다.");
  assert.notEqual(reviewLabel("vi", "PART_TIME_EXTRA_WORK_DECISION_STALE"), "PART_TIME_EXTRA_WORK_DECISION_STALE");
});

test("the common extra-work review copy no longer calls the feature part-time", () => {
  assert.equal(reviewLabel("ko", "PART_TIME_EXTRA_WORK_REVIEW_REQUIRED"), "추가근무 승인이 필요합니다.");
  assert.equal(reviewLabel("vi", "PART_TIME_EXTRA_WORK_REVIEW_REQUIRED"), "Cần duyệt làm thêm giờ.");
});
