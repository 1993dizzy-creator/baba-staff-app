// 신규 직원 생성 화면의 최초 급여계약·복리후생 요청을 만든다(기존 저장 API를 그대로 호출하기 위한 값만 계산).
// 이 파일은 tests/에서 "@/" 별칭 없이 직접 실행되므로 상대 경로 import만 쓴다.
//
// 급여 유형 매핑(기존 DB/API 값만 사용, 새 유형을 만들지 않음):
//   고정급            = pay_type "monthly" + calculation_basis "fixed_monthly" (근태 OFF, 근무시간표 없음)
//   월급제 · 월급 기준 = pay_type "monthly" + calculation_basis "minute"        (근태 ON, 실근무 정산)
//   월급제 · 시급 기준 = pay_type "hourly"  + calculation_basis "minute"        (근태 ON, 기존 시급제와 같은 계산)
// pay_type은 금액의 단위(월급/시급)이고, calculation_basis가 계산 방식(고정 지급/실근무)이다.

import { calendarProration } from "./first-month-proration.ts";

export type NewEmployeePayKind = "fixed" | "monthly";
export type NewEmployeePayUnit = "monthly" | "hourly";

/** 급여계약 저장이 가능한 가장 이른 적용일(기존 계약 RPC 제약). */
export const PAYROLL_CONTRACT_MIN_EFFECTIVE_FROM = "2026-08-01";
/** 월급 기준 계약의 기본 월 기준 근무일수(기존 계약 화면 기본값과 같다). */
export const NEW_EMPLOYEE_STANDARD_WORKDAYS = 26;

const DATE_KEY = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isNewEmployeeHireDate(value: string | null | undefined): value is string {
  const match = typeof value === "string" ? DATE_KEY.exec(value) : null;
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** 고정급만 근태 OFF. 월급제(월급·시급 기준)는 실근무 정산이라 근태 ON. */
export function attendanceTrackingForPayKind(kind: NewEmployeePayKind) {
  return kind === "monthly";
}

export type NewEmployeeContractRequest = {
  firstMonthProration?: boolean;
  payType: "monthly" | "hourly";
  calculationBasis: "fixed_monthly" | "minute";
  baseSalary: number;
  fixedRaiseAmount: 0;
  standardWorkdays: number | null;
  effectiveFrom: string;
};

function clampEffectiveFrom(date: string) {
  return date < PAYROLL_CONTRACT_MIN_EFFECTIVE_FROM ? PAYROLL_CONTRACT_MIN_EFFECTIVE_FROM : date;
}

/**
 * 최초 급여계약 요청. 기존 계약 API(POST /api/admin/payroll/contracts)의 입력 형식 그대로다.
 * - 고정급: 월 고정 지급 계약은 매월 1일부터만 저장할 수 있으므로 입사월 1일부터 적용한다.
 * - 월급제: 근무시간표가 입사일부터 생성되므로 입사일부터 적용한다.
 */
export function newEmployeeContractRequest(input: { kind: NewEmployeePayKind; unit: NewEmployeePayUnit; amount: number; hireDate: string }): NewEmployeeContractRequest {
  if (input.kind === "fixed") {
    return { firstMonthProration: true, payType: "monthly", calculationBasis: "fixed_monthly", baseSalary: input.amount, fixedRaiseAmount: 0,
      standardWorkdays: NEW_EMPLOYEE_STANDARD_WORKDAYS, effectiveFrom: clampEffectiveFrom(`${input.hireDate.slice(0, 7)}-01`) };
  }
  const hourly = input.unit === "hourly";
  return { payType: hourly ? "hourly" : "monthly", calculationBasis: "minute", baseSalary: input.amount, fixedRaiseAmount: 0,
    standardWorkdays: hourly ? null : NEW_EMPLOYEE_STANDARD_WORKDAYS, effectiveFrom: clampEffectiveFrom(input.hireDate) };
}

/** 이미 저장된 계약이 이 요청과 같은 계약인지(재시도·응답 유실 시 중복 저장 방지). */
export function contractMatchesRequest(contract: { payType: string; calculationBasis: string; baseSalary: number; effectiveFrom: string; fixedRaiseAmount?: number; standardWorkdays?: number | null }, request: NewEmployeeContractRequest) {
  return contract.payType === request.payType && contract.calculationBasis === request.calculationBasis
    && Number(contract.baseSalary) === request.baseSalary && contract.effectiveFrom === request.effectiveFrom
    && (!request.firstMonthProration || (contract.fixedRaiseAmount === request.fixedRaiseAmount && contract.standardWorkdays === request.standardWorkdays));
}

/** 식대는 입사일부터 적용한다. */
export function newEmployeeMealEffectiveFrom(hireDate: string) {
  return hireDate;
}

/** 개근 보너스 적용월: 입사월부터, 단 과거 월은 저장할 수 없으므로(기존 RPC) 이번 달보다 이르면 이번 달. */
export function newEmployeeBonusEffectiveMonth(hireDate: string, currentMonth: string) {
  const hireMonth = hireDate.slice(0, 7);
  return hireMonth < currentMonth ? currentMonth : hireMonth;
}



/**
 * 고정급 입사월 일할 금액(안내용): 계약 월급 × (입사일 포함 재직 달력일수 / 해당 월 일수), VND 반올림.
 * 서버의 신규 정책 등록과 최초 계약 연결이 완료된 경우에만 자동 계산이 활성화된다.
 * 1일 입사는 일할이 없으므로 null.
 */
export function fixedMonthlyFirstMonthProration(amount: number, hireDate: string) {
  if (!isNewEmployeeHireDate(hireDate)) return null;
  const day = Number(hireDate.slice(8, 10));
  if (day === 1) return null;
  return calendarProration(amount, hireDate);
}
