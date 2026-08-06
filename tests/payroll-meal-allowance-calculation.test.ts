import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's test runner requires the explicit TypeScript extension.
import { calculateCurrentMealAllowanceCost, calculateProjectedMealAllowanceForEmployee, selectMealAllowanceEligibilityAt, selectMealAllowancePolicyAt } from "../lib/payroll/meal-allowance.ts";

// ---------------------------------------------------------------------------
// 공통 정책 resolver
// ---------------------------------------------------------------------------

test("policy resolver: no version → null", () => {
  assert.equal(selectMealAllowancePolicyAt([], "2026-08-06"), null);
});

test("policy resolver: single version applies from its effective date onward", () => {
  const versions = [{ id: 1, dailyAmount: 30000, effectiveFrom: "2026-08-01", revision: 1 }];
  assert.equal(selectMealAllowancePolicyAt(versions, "2026-07-31"), null);
  assert.equal(selectMealAllowancePolicyAt(versions, "2026-08-01")?.dailyAmount, 30000);
  assert.equal(selectMealAllowancePolicyAt(versions, "2026-12-31")?.dailyAmount, 30000);
});

test("policy resolver: date-based change picks the version effective on that date", () => {
  const versions = [
    { id: 1, dailyAmount: 30000, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, dailyAmount: 35000, effectiveFrom: "2026-08-15", revision: 2 },
  ];
  assert.equal(selectMealAllowancePolicyAt(versions, "2026-08-10")?.dailyAmount, 30000);
  assert.equal(selectMealAllowancePolicyAt(versions, "2026-08-15")?.dailyAmount, 35000);
  assert.equal(selectMealAllowancePolicyAt(versions, "2026-08-20")?.dailyAmount, 35000);
});

test("policy resolver: same effective_from, highest revision wins (정정)", () => {
  const versions = [
    { id: 1, dailyAmount: 30000, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, dailyAmount: 32000, effectiveFrom: "2026-08-01", revision: 2 },
  ];
  assert.equal(selectMealAllowancePolicyAt(versions, "2026-08-01")?.dailyAmount, 32000);
});

test("policy resolver: past-date reproduction — a later version does not change a past date's amount", () => {
  const versions = [
    { id: 1, dailyAmount: 30000, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, dailyAmount: 40000, effectiveFrom: "2026-09-01", revision: 2 },
  ];
  assert.equal(selectMealAllowancePolicyAt(versions, "2026-08-20")?.dailyAmount, 30000);
});

// ---------------------------------------------------------------------------
// 직원 대상 resolver
// ---------------------------------------------------------------------------

test("eligibility resolver: no version → 미대상", () => {
  assert.equal(selectMealAllowanceEligibilityAt([], "2026-08-06"), false);
});

test("eligibility resolver: before eligibility start date → false", () => {
  const versions = [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-08-10", revision: 1 }];
  assert.equal(selectMealAllowanceEligibilityAt(versions, "2026-08-09"), false);
});

test("eligibility resolver: on/after eligibility start date → true", () => {
  const versions = [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-08-10", revision: 1 }];
  assert.equal(selectMealAllowanceEligibilityAt(versions, "2026-08-10"), true);
  assert.equal(selectMealAllowanceEligibilityAt(versions, "2026-09-01"), true);
});

test("eligibility resolver: after a later 미대상 version → false", () => {
  const versions = [
    { id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, userId: 1, isEligible: false, effectiveFrom: "2026-08-20", revision: 2 },
  ];
  assert.equal(selectMealAllowanceEligibilityAt(versions, "2026-08-15"), true);
  assert.equal(selectMealAllowanceEligibilityAt(versions, "2026-08-20"), false);
});

test("eligibility resolver: mid-month change is reflected exactly on the boundary date", () => {
  const versions = [
    { id: 1, userId: 1, isEligible: false, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, userId: 1, isEligible: true, effectiveFrom: "2026-08-16", revision: 2 },
  ];
  assert.equal(selectMealAllowanceEligibilityAt(versions, "2026-08-15"), false);
  assert.equal(selectMealAllowanceEligibilityAt(versions, "2026-08-16"), true);
});

test("eligibility resolver: multiple employees are resolved independently", () => {
  const byUser = new Map([
    [1, [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-08-01", revision: 1 }]],
    [2, [{ id: 2, userId: 2, isEligible: false, effectiveFrom: "2026-08-01", revision: 1 }]],
  ]);
  assert.equal(selectMealAllowanceEligibilityAt(byUser.get(1)!, "2026-08-10"), true);
  assert.equal(selectMealAllowanceEligibilityAt(byUser.get(2)!, "2026-08-10"), false);
});

// ---------------------------------------------------------------------------
// 현재 식대비용
// ---------------------------------------------------------------------------

const policyFlat = [{ id: 1, dailyAmount: 30000, effectiveFrom: "2026-08-01", revision: 1 }];
const eligibleFromMonthStart = new Map([
  [1, [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-08-01", revision: 1 }]],
]);
const employedAllMonth = new Map([[1, { hireDate: null, terminationDate: null }]]);

test("current cost: one real check-in day counts once", () => {
  const result = calculateCurrentMealAllowanceCost({
    attendanceDays: [{ userId: 1, workDate: "2026-08-03" }],
    users: employedAllMonth,
    eligibilityVersionsByUser: eligibleFromMonthStart,
    policyVersions: policyFlat,
  });
  assert.equal(result.totalAmount, 30000);
  assert.equal(result.byUser.get(1), 30000);
});

test("current cost: an open (unresolved checkout) attendance day is still counted — caller only needs check_in_at not null", () => {
  // 열린 미퇴근 기록은 check_out_at 컬럼과 무관하게 이미 attendanceDays 목록에
  // work_date로만 들어온다(체크아웃 여부는 이 함수의 입력에 아예 없음) — 그 자체가
  // "퇴근 기록 없어도 식대 발생" 정책을 구조적으로 보장한다.
  const result = calculateCurrentMealAllowanceCost({
    attendanceDays: [{ userId: 1, workDate: "2026-08-03" }],
    users: employedAllMonth,
    eligibilityVersionsByUser: eligibleFromMonthStart,
    policyVersions: policyFlat,
  });
  assert.equal(result.totalAmount, 30000);
});

test("current cost: 지각·조퇴 여부와 무관하게 동일 금액(함수 입력에 지각/조퇴 정보가 아예 없음)", () => {
  const lateDay = calculateCurrentMealAllowanceCost({
    attendanceDays: [{ userId: 1, workDate: "2026-08-03" }],
    users: employedAllMonth,
    eligibilityVersionsByUser: eligibleFromMonthStart,
    policyVersions: policyFlat,
  });
  const onTimeDay = calculateCurrentMealAllowanceCost({
    attendanceDays: [{ userId: 1, workDate: "2026-08-04" }],
    users: employedAllMonth,
    eligibilityVersionsByUser: eligibleFromMonthStart,
    policyVersions: policyFlat,
  });
  assert.equal(lateDay.totalAmount, onTimeDay.totalAmount);
});

test("current cost: 승인 휴무만 있는 날(체크인 없음)은 애초에 attendanceDays에 없으므로 자동 제외된다", () => {
  const result = calculateCurrentMealAllowanceCost({
    attendanceDays: [], // leave-only day는 check_in_at이 null이라 호출자가 애초에 넘기지 않는다
    users: employedAllMonth,
    eligibilityVersionsByUser: eligibleFromMonthStart,
    policyVersions: policyFlat,
  });
  assert.equal(result.totalAmount, 0);
});

test("current cost: 취소·삭제된 출근 기록도 attendance_records에서 하드 삭제되므로 목록에 없다 — 함수는 넘어온 것만 계산", () => {
  const result = calculateCurrentMealAllowanceCost({
    attendanceDays: [{ userId: 1, workDate: "2026-08-03" }], // 취소된 기록은 목록에 없음을 가정
    users: employedAllMonth,
    eligibilityVersionsByUser: eligibleFromMonthStart,
    policyVersions: policyFlat,
  });
  assert.equal(result.totalAmount, 30000); // 취소된 중복 기록이 없으므로 1일분만 계산됨
});

test("current cost: 같은 영업일 복수 기록은 최대 1회만 인정(방어적 dedup)", () => {
  const result = calculateCurrentMealAllowanceCost({
    attendanceDays: [
      { userId: 1, workDate: "2026-08-03" },
      { userId: 1, workDate: "2026-08-03" },
    ],
    users: employedAllMonth,
    eligibilityVersionsByUser: eligibleFromMonthStart,
    policyVersions: policyFlat,
  });
  assert.equal(result.totalAmount, 30000);
});

test("current cost: 재직기간 밖 날짜는 제외된다", () => {
  const users = new Map([[1, { hireDate: "2026-08-10", terminationDate: null }]]);
  const result = calculateCurrentMealAllowanceCost({
    attendanceDays: [{ userId: 1, workDate: "2026-08-05" }],
    users,
    eligibilityVersionsByUser: eligibleFromMonthStart,
    policyVersions: policyFlat,
  });
  assert.equal(result.totalAmount, 0);
});

test("current cost: 식대 미대상 직원의 출근일은 제외된다", () => {
  const ineligible = new Map([[1, [{ id: 1, userId: 1, isEligible: false, effectiveFrom: "2026-08-01", revision: 1 }]]]);
  const result = calculateCurrentMealAllowanceCost({
    attendanceDays: [{ userId: 1, workDate: "2026-08-05" }],
    users: employedAllMonth,
    eligibilityVersionsByUser: ineligible,
    policyVersions: policyFlat,
  });
  assert.equal(result.totalAmount, 0);
});

test("current cost: 공통 식대 금액이 미설정인 날짜는 제외된다", () => {
  const laterPolicy = [{ id: 1, dailyAmount: 30000, effectiveFrom: "2026-08-15", revision: 1 }];
  const result = calculateCurrentMealAllowanceCost({
    attendanceDays: [{ userId: 1, workDate: "2026-08-05" }],
    users: employedAllMonth,
    eligibilityVersionsByUser: eligibleFromMonthStart,
    policyVersions: laterPolicy,
  });
  assert.equal(result.totalAmount, 0);
});

test("current cost: 날짜별로 유효했던 식대 단가를 적용한다(월중 단가 변경)", () => {
  const policy = [
    { id: 1, dailyAmount: 30000, effectiveFrom: "2026-08-01", revision: 1 },
    { id: 2, dailyAmount: 35000, effectiveFrom: "2026-08-15", revision: 2 },
  ];
  const result = calculateCurrentMealAllowanceCost({
    attendanceDays: [
      { userId: 1, workDate: "2026-08-10" },
      { userId: 1, workDate: "2026-08-16" },
    ],
    users: employedAllMonth,
    eligibilityVersionsByUser: eligibleFromMonthStart,
    policyVersions: policy,
  });
  assert.equal(result.totalAmount, 30000 + 35000);
});

// ---------------------------------------------------------------------------
// 예상 식대비용
// ---------------------------------------------------------------------------

const AUG_START = "2026-08-01";
const AUG_END_EXCLUSIVE = "2026-09-01"; // 31일짜리 달

test("projected cost: standard_workdays × daily_amount for a full month with no exceptions", () => {
  const result = calculateProjectedMealAllowanceForEmployee({
    userId: 1,
    hireDate: null,
    terminationDate: null,
    monthStart: AUG_START,
    monthEndExclusive: AUG_END_EXCLUSIVE,
    contracts: [{ effectiveFrom: "2026-01-01", effectiveTo: null, standardWorkdays: 26 }],
    eligibilityVersions: [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-01-01", revision: 1 }],
    policyVersions: [{ id: 1, dailyAmount: 30000, effectiveFrom: "2026-01-01", revision: 1 }],
  });
  assert.equal(result.amount, 780000);
  assert.equal(result.warningCode, null);
});

test("projected cost: sums across multiple employees", () => {
  const inputFor = (userId: number) => ({
    userId,
    hireDate: null,
    terminationDate: null,
    monthStart: AUG_START,
    monthEndExclusive: AUG_END_EXCLUSIVE,
    contracts: [{ effectiveFrom: "2026-01-01", effectiveTo: null, standardWorkdays: 26 }],
    eligibilityVersions: [{ id: 1, userId, isEligible: true, effectiveFrom: "2026-01-01", revision: 1 }],
    policyVersions: [{ id: 1, dailyAmount: 30000, effectiveFrom: "2026-01-01", revision: 1 }],
  });
  const totals = [1, 2].map((userId) => calculateProjectedMealAllowanceForEmployee(inputFor(userId)).amount);
  assert.deepEqual(totals, [780000, 780000]);
  assert.equal(totals.reduce((sum, value) => sum + value, 0), 1560000);
});

test("projected cost: 미대상 직원은 0", () => {
  const result = calculateProjectedMealAllowanceForEmployee({
    userId: 1,
    hireDate: null,
    terminationDate: null,
    monthStart: AUG_START,
    monthEndExclusive: AUG_END_EXCLUSIVE,
    contracts: [{ effectiveFrom: "2026-01-01", effectiveTo: null, standardWorkdays: 26 }],
    eligibilityVersions: [{ id: 1, userId: 1, isEligible: false, effectiveFrom: "2026-01-01", revision: 1 }],
    policyVersions: [{ id: 1, dailyAmount: 30000, effectiveFrom: "2026-01-01", revision: 1 }],
  });
  assert.equal(result.amount, 0);
  assert.equal(result.warningCode, null);
});

test("projected cost: 월 중간 입사는 비례 계산된다", () => {
  // 8/16 입사 → 재직 16일 / 31일
  const result = calculateProjectedMealAllowanceForEmployee({
    userId: 1,
    hireDate: "2026-08-16",
    terminationDate: null,
    monthStart: AUG_START,
    monthEndExclusive: AUG_END_EXCLUSIVE,
    contracts: [{ effectiveFrom: "2026-08-16", effectiveTo: null, standardWorkdays: 26 }],
    eligibilityVersions: [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-08-16", revision: 1 }],
    policyVersions: [{ id: 1, dailyAmount: 30000, effectiveFrom: "2026-01-01", revision: 1 }],
  });
  const expected = Math.round(26 * (16 / 31) * 30000);
  assert.equal(result.amount, expected);
  assert.ok(result.amount < 780000);
});

test("projected cost: 월 중간 퇴사는 비례 계산된다", () => {
  // 퇴사일 8/15 → 재직 15일 / 31일
  const result = calculateProjectedMealAllowanceForEmployee({
    userId: 1,
    hireDate: null,
    terminationDate: "2026-08-15",
    monthStart: AUG_START,
    monthEndExclusive: AUG_END_EXCLUSIVE,
    contracts: [{ effectiveFrom: "2026-01-01", effectiveTo: null, standardWorkdays: 26 }],
    eligibilityVersions: [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-01-01", revision: 1 }],
    policyVersions: [{ id: 1, dailyAmount: 30000, effectiveFrom: "2026-01-01", revision: 1 }],
  });
  const expected = Math.round(26 * (15 / 31) * 30000);
  assert.equal(result.amount, expected);
});

test("projected cost: 월 중간 식대 대상 변경(시작)은 대상 기간만 비례 계산된다", () => {
  // 8/16부터 대상 → 대상 기간 16일 / 31일
  const result = calculateProjectedMealAllowanceForEmployee({
    userId: 1,
    hireDate: null,
    terminationDate: null,
    monthStart: AUG_START,
    monthEndExclusive: AUG_END_EXCLUSIVE,
    contracts: [{ effectiveFrom: "2026-01-01", effectiveTo: null, standardWorkdays: 26 }],
    eligibilityVersions: [
      { id: 1, userId: 1, isEligible: false, effectiveFrom: "2026-01-01", revision: 1 },
      { id: 2, userId: 1, isEligible: true, effectiveFrom: "2026-08-16", revision: 2 },
    ],
    policyVersions: [{ id: 1, dailyAmount: 30000, effectiveFrom: "2026-01-01", revision: 1 }],
  });
  const expected = Math.round(26 * (16 / 31) * 30000);
  assert.equal(result.amount, expected);
});

test("projected cost: 월 중간 식대 대상 변경(종료)은 대상 기간만 비례 계산된다", () => {
  // 8/16부터 미대상 → 대상 기간 15일 / 31일
  const result = calculateProjectedMealAllowanceForEmployee({
    userId: 1,
    hireDate: null,
    terminationDate: null,
    monthStart: AUG_START,
    monthEndExclusive: AUG_END_EXCLUSIVE,
    contracts: [{ effectiveFrom: "2026-01-01", effectiveTo: null, standardWorkdays: 26 }],
    eligibilityVersions: [
      { id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-01-01", revision: 1 },
      { id: 2, userId: 1, isEligible: false, effectiveFrom: "2026-08-16", revision: 2 },
    ],
    policyVersions: [{ id: 1, dailyAmount: 30000, effectiveFrom: "2026-01-01", revision: 1 }],
  });
  const expected = Math.round(26 * (15 / 31) * 30000);
  assert.equal(result.amount, expected);
});

test("projected cost: 월 중간 단가 변경은 하위 기간별로 나눠 소수로 합산한 뒤 최종 한 번만 반올림된다(방식 B)", () => {
  // 8/1~8/15(15일)엔 30,000, 8/16~8/31(16일)엔 35,000
  const result = calculateProjectedMealAllowanceForEmployee({
    userId: 1,
    hireDate: null,
    terminationDate: null,
    monthStart: AUG_START,
    monthEndExclusive: AUG_END_EXCLUSIVE,
    contracts: [{ effectiveFrom: "2026-01-01", effectiveTo: null, standardWorkdays: 26 }],
    eligibilityVersions: [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-01-01", revision: 1 }],
    policyVersions: [
      { id: 1, dailyAmount: 30000, effectiveFrom: "2026-01-01", revision: 1 },
      { id: 2, dailyAmount: 35000, effectiveFrom: "2026-08-16", revision: 2 },
    ],
  });
  // 방식 B(정책): 구간별 raw 금액을 소수 정밀도로 합산한 뒤 최종 1회만 반올림.
  const expectedB = Math.round(26 * (15 / 31) * 30000 + 26 * (16 / 31) * 35000);
  // 방식 A(과거 구현, 회귀 방지용 대조값): 구간별로 먼저 반올림한 뒤 정수 합산.
  const legacyMethodA = Math.round(26 * (15 / 31) * 30000) + Math.round(26 * (16 / 31) * 35000);
  assert.equal(expectedB, 847097);
  assert.equal(legacyMethodA, 847096);
  assert.notEqual(expectedB, legacyMethodA, "이 케이스는 방식 A/B가 실제로 갈리는 회귀 케이스여야 한다");
  assert.equal(result.amount, expectedB, "현재 구현은 방식 B(전체 raw 합산 후 최종 1회 반올림)를 따라야 한다");
});

test("projected cost 회귀: 8월(31일)·standardWorkdays=26·8/1~15 30,000·8/16~31 35,000 조합에서 정확히 847,097원이 나와야 한다(과거 구현의 847,096원과 1원 차이)", () => {
  const result = calculateProjectedMealAllowanceForEmployee({
    userId: 1,
    hireDate: null,
    terminationDate: null,
    monthStart: AUG_START,
    monthEndExclusive: AUG_END_EXCLUSIVE,
    contracts: [{ effectiveFrom: "2026-01-01", effectiveTo: null, standardWorkdays: 26 }],
    eligibilityVersions: [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-01-01", revision: 1 }],
    policyVersions: [
      { id: 1, dailyAmount: 30000, effectiveFrom: "2026-01-01", revision: 1 },
      { id: 2, dailyAmount: 35000, effectiveFrom: "2026-08-16", revision: 2 },
    ],
  });
  assert.equal(result.amount, 847097);
});

test("projected cost: 유효 급여계약 없음 → 0 + STANDARD_WORKDAYS_MISSING 경고, 계산 자체는 실패하지 않음", () => {
  const result = calculateProjectedMealAllowanceForEmployee({
    userId: 1,
    hireDate: null,
    terminationDate: null,
    monthStart: AUG_START,
    monthEndExclusive: AUG_END_EXCLUSIVE,
    contracts: [],
    eligibilityVersions: [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-01-01", revision: 1 }],
    policyVersions: [{ id: 1, dailyAmount: 30000, effectiveFrom: "2026-01-01", revision: 1 }],
  });
  assert.equal(result.amount, 0);
  assert.equal(result.warningCode, "STANDARD_WORKDAYS_MISSING");
});

test("projected cost: standard_workdays 없음(null) → 0 + 경고", () => {
  const result = calculateProjectedMealAllowanceForEmployee({
    userId: 1,
    hireDate: null,
    terminationDate: null,
    monthStart: AUG_START,
    monthEndExclusive: AUG_END_EXCLUSIVE,
    contracts: [{ effectiveFrom: "2026-01-01", effectiveTo: null, standardWorkdays: null }],
    eligibilityVersions: [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-01-01", revision: 1 }],
    policyVersions: [{ id: 1, dailyAmount: 30000, effectiveFrom: "2026-01-01", revision: 1 }],
  });
  assert.equal(result.amount, 0);
  assert.equal(result.warningCode, "STANDARD_WORKDAYS_MISSING");
});

test("projected cost: standard_workdays 0 → 0 + 경고", () => {
  const result = calculateProjectedMealAllowanceForEmployee({
    userId: 1,
    hireDate: null,
    terminationDate: null,
    monthStart: AUG_START,
    monthEndExclusive: AUG_END_EXCLUSIVE,
    contracts: [{ effectiveFrom: "2026-01-01", effectiveTo: null, standardWorkdays: 0 }],
    eligibilityVersions: [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-01-01", revision: 1 }],
    policyVersions: [{ id: 1, dailyAmount: 30000, effectiveFrom: "2026-01-01", revision: 1 }],
  });
  assert.equal(result.amount, 0);
  assert.equal(result.warningCode, "STANDARD_WORKDAYS_MISSING");
});

test("projected cost: 계약 정보 부족이 있어도 예외를 던지지 않고 0으로 안전하게 처리된다(지급 차단과 분리)", () => {
  assert.doesNotThrow(() =>
    calculateProjectedMealAllowanceForEmployee({
      userId: 1,
      hireDate: null,
      terminationDate: null,
      monthStart: AUG_START,
      monthEndExclusive: AUG_END_EXCLUSIVE,
      contracts: [],
      eligibilityVersions: [{ id: 1, userId: 1, isEligible: true, effectiveFrom: "2026-01-01", revision: 1 }],
      policyVersions: [],
    }),
  );
});
