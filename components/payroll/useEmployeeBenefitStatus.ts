"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PayrollInsuranceSettingVersion } from "@/lib/payroll/insurance";
import type { PayrollTaxSettingVersion } from "@/lib/payroll/tax";
import {
  pickAttendanceBonus,
  pickInsurance,
  pickMealAllowance,
  pickTax,
  resolveSettingsSummaryReference,
  type SummaryReference,
} from "@/lib/payroll/settings-summary";

/** /admin/users 복리후생 스위치 4개(장기근무 레벨은 직원 목록의 levelProgramPolicy로 판정). */
export type BenefitKey = "meal" | "bonus" | "insurance" | "tax";

/** 예약된 다음 버전이 지금과 다른 상태로 바꾸는 경우(예: 해제 예정 2026-12). */
export type BenefitSchedule = { on: boolean; from: string };

export type BenefitStatus =
  | { state: "loading" }
  | { state: "error" }
  | {
      state: "ready";
      /** 오늘(베트남) 기준 실제 적용 중인지. 급여 계산과 같은 선택 규칙(settings-summary의 pick*)으로 판정한다. */
      on: boolean;
      /** 적용 중인 버전이 하나라도 있는지(없으면 "미설정"). */
      configured: boolean;
      /** 적용 중인 버전의 시작일/월 */
      since: string | null;
      scheduled: BenefitSchedule | null;
      /** 식대·개근: 근태 기록 사용 여부(미사용이면 대상으로 바꿀 수 없음 — 기존 서버 검증과 같다) */
      attendanceTrackingEnabled?: boolean;
      /** 보험: 적용 중인 기준급여 */
      insuranceBaseAmount?: number;
      /** TNCN: 프로필 없음·명의 없음 등 지급 전 확인 필요(계산 결과 0과 무관) */
      requiresReview?: boolean;
    };

const ENDPOINTS: Record<BenefitKey, (userId: number) => string> = {
  meal: (userId) => `/api/admin/payroll/meal-allowance/eligibility?userId=${userId}`,
  bonus: (userId) => `/api/admin/payroll/attendance-bonus/eligibility?userId=${userId}`,
  insurance: (userId) => `/api/admin/payroll/insurance?userId=${userId}`,
  tax: (userId) => `/api/admin/payroll/tax-settings?userId=${userId}`,
};
export const BENEFIT_KEYS: readonly BenefitKey[] = ["meal", "bonus", "insurance", "tax"];

function vietnamToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function schedule(on: boolean, next: { on: boolean; from: string } | null): BenefitSchedule | null {
  return next && next.on !== on ? next : null;
}

/** 설정 API 응답(기존 카드가 쓰는 것과 같은 GET)을 스위치 상태로 바꾼다. */
export function benefitStatusFromResponse(key: BenefitKey, data: Record<string, unknown>, reference: SummaryReference): BenefitStatus {
  const history = Array.isArray(data.history) ? data.history : [];
  if (key === "meal") {
    const pick = pickMealAllowance(history as { isEligible: boolean; effectiveFrom: string; revision: number }[], reference);
    const on = pick.applied?.isEligible === true;
    return { state: "ready", on, configured: pick.applied !== null, since: pick.applied?.effectiveFrom ?? null,
      scheduled: schedule(on, pick.scheduled ? { on: pick.scheduled.isEligible, from: pick.scheduled.effectiveFrom } : null),
      attendanceTrackingEnabled: data.attendanceTrackingEnabled !== false };
  }
  if (key === "bonus") {
    const pick = pickAttendanceBonus(history as { isEligible: boolean; effectiveMonth: string; revision: number }[], reference);
    const on = pick.applied?.isEligible === true;
    return { state: "ready", on, configured: pick.applied !== null, since: pick.applied?.effectiveMonth ?? null,
      scheduled: schedule(on, pick.scheduled ? { on: pick.scheduled.isEligible, from: pick.scheduled.effectiveMonth } : null),
      attendanceTrackingEnabled: data.attendanceTrackingEnabled !== false };
  }
  if (key === "insurance") {
    const pick = pickInsurance(history as PayrollInsuranceSettingVersion[], reference);
    const on = pick.applied?.isEnrolled === true;
    return { state: "ready", on, configured: pick.applied !== null, since: pick.applied?.effectiveMonth.slice(0, 7) ?? null,
      scheduled: schedule(on, pick.scheduled ? { on: pick.scheduled.isEnrolled, from: pick.scheduled.effectiveMonth.slice(0, 7) } : null),
      insuranceBaseAmount: pick.applied?.insuranceBaseAmount ?? 0 };
  }
  // TNCN: 설정 대상 여부만 ON/OFF로 표현한다(not_applicable = OFF). 세금 계산 결과(0₫ 포함)로 판단하지 않는다.
  const pick = pickTax(history as PayrollTaxSettingVersion[], reference);
  const on = pick.applied?.taxMode === "resident_progressive";
  return { state: "ready", on, configured: pick.applied !== null, since: pick.applied?.effectiveMonth.slice(0, 7) ?? null,
    scheduled: schedule(on, pick.scheduled ? { on: pick.scheduled.taxMode === "resident_progressive", from: pick.scheduled.effectiveMonth.slice(0, 7) } : null),
    requiresReview: pick.requiresReview };
}

type Loaded = { userId: number | null; statuses: Partial<Record<BenefitKey, BenefitStatus>> };

export type EmployeeBenefitStatusController = {
  status: (key: BenefitKey) => BenefitStatus;
  /** 한 항목만 다시 조회한다(저장 후 실제 적용 상태 확인·조회 실패 재시도). */
  reload: (key: BenefitKey) => void;
};

/**
 * 직원 1명의 복리후생 스위치 상태. userId가 있을 때만(직원 상세의 근무·급여를 펼친 뒤) 4개 설정을 한 번씩 조회한다.
 * 기존 설정 카드와 같은 GET을 쓰며(새 API 없음), 항목별로 조회·실패를 따로 다룬다(하나가 실패해도 나머지는 표시).
 * 직원이 바뀌면 이전 요청을 중단하고 늦게 온 이전 직원의 응답은 버린다.
 */
export function useEmployeeBenefitStatus(userId: number | null): EmployeeBenefitStatusController {
  const [loaded, setLoaded] = useState<Loaded>({ userId: null, statuses: {} });
  const userIdRef = useRef(userId);
  const fetchOne = useCallback((id: number, key: BenefitKey, signal?: AbortSignal) => {
    const stale = () => signal?.aborted || userIdRef.current !== id;
    const put = (status: BenefitStatus) => setLoaded((previous) => ({
      userId: id,
      statuses: { ...(previous.userId === id ? previous.statuses : {}), [key]: status },
    }));
    const failed = (error?: unknown) => {
      if (stale() || (error instanceof Error && error.name === "AbortError")) return;
      put({ state: "error" });
    };
    return fetch(ENDPOINTS[key](id), { cache: "no-store", signal }).then(async (response) => {
      if (stale()) return;
      const data = await response.json().catch(() => null);
      if (stale()) return;
      if (!response.ok || !data || data.ok === false) return failed();
      put(benefitStatusFromResponse(key, data, resolveSettingsSummaryReference(null, vietnamToday())));
    }, failed);
  }, []);
  useEffect(() => {
    userIdRef.current = userId;
    if (!userId) return;
    const controller = new AbortController();
    for (const key of BENEFIT_KEYS) void fetchOne(userId, key, controller.signal);
    return () => controller.abort();
  }, [userId, fetchOne]);
  const reload = useCallback((key: BenefitKey) => {
    if (!userId) return;
    setLoaded((previous) => (previous.userId === userId ? { userId, statuses: { ...previous.statuses, [key]: { state: "loading" } } } : previous));
    void fetchOne(userId, key);
  }, [userId, fetchOne]);
  const own = userId !== null && loaded.userId === userId;
  const status = useCallback((key: BenefitKey): BenefitStatus => (own ? loaded.statuses[key] : undefined) ?? { state: "loading" }, [own, loaded]);
  return { status, reload };
}
