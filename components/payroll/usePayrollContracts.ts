"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkScheduleVersion } from "@/lib/payroll/types";

export type PayrollContractAuditLog = { id: number; action: string; actorUserId: number; actorName: string | null; reason: string | null; createdAt: string };
export type PayrollContractView = {
  id: number;
  baseSalary: number;
  fixedRaiseAmount: number;
  payType: string;
  calculationBasis: string;
  standardWorkdays: number | null;
  standardMinutesPerDay: number;
  timeBlockMinutes: number;
  roundingMode: string;
  lateAdjustmentMode: string;
  overtimeMode: string;
  paidLeaveMode: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  revision: number;
  auditVersion: number | null;
  createdBy?: number | null;
  createdByName?: string | null;
  createdAt?: string | null;
  note?: string | null;
  auditLogs?: PayrollContractAuditLog[];
};

type LoadedState = {
  userId: number | null;
  contracts: PayrollContractView[];
  current: PayrollContractView | null;
  scheduled: PayrollContractView | null;
  workSchedules: WorkScheduleVersion[];
  loading: boolean;
  loadFailed: boolean;
};

export type PayrollContractsController = Omit<LoadedState, "userId"> & {
  userId: number | null;
  /** 계약 이력을 다시 조회한다. 성공하면 이력을, 실패·취소·다른 직원으로 바뀐 경우 null을 돌려준다. */
  load: () => Promise<PayrollContractView[] | null>;
  /** 화면에 이전 계약이 남지 않도록 "조회 중"으로 바꾼 뒤 다시 조회한다. */
  reload: () => void;
};

const EMPTY: LoadedState = { userId: null, contracts: [], current: null, scheduled: null, workSchedules: [], loading: false, loadFailed: false };

/**
 * 직원 1명의 급여계약(GET /api/admin/payroll/contracts?userId=)을 소유한다.
 * 급여설정 직원 탭과 직원관리 상세가 같은 훅을 쓰며, 같은 화면 안에서는 요약·편집이 이 결과를 공유한다
 * (같은 직원에 대한 중복 조회 없음). 직원이 바뀌면 이전 요청을 중단하고, 늦게 도착한 이전 직원의
 * 응답은 반영하지 않는다.
 */
export function usePayrollContracts(userId: number | null, { refreshOnReturn = false }: { refreshOnReturn?: boolean } = {}): PayrollContractsController {
  const [state, setState] = useState<LoadedState>(EMPTY);
  const userIdRef = useRef(userId);
  const fetchFor = useCallback((id: number, signal?: AbortSignal): Promise<PayrollContractView[] | null> => {
    const stale = () => signal?.aborted || userIdRef.current !== id;
    const failed = (error?: unknown) => {
      if (stale() || (error instanceof Error && error.name === "AbortError")) return null;
      setState((previous) => ({ ...(previous.userId === id ? previous : { ...EMPTY, userId: id }), loading: false, loadFailed: true }));
      return null;
    };
    return fetch(`/api/admin/payroll/contracts?userId=${id}`, { cache: "no-store", signal })
      .then(async (response) => {
        if (stale()) return null;
        const data = await response.json().catch(() => null);
        if (stale()) return null;
        if (response.ok && data?.ok !== false && data) {
          const history: PayrollContractView[] = data.history ?? [];
          setState({ userId: id, contracts: history, current: data.current ?? null, scheduled: data.scheduled ?? null, workSchedules: data.workSchedules ?? [], loading: false, loadFailed: false });
          return history;
        }
        return failed();
      }, failed);
  }, []);
  useEffect(() => {
    userIdRef.current = userId;
    if (!userId) return;
    const controller = new AbortController();
    void fetchFor(userId, controller.signal);
    return () => controller.abort();
  }, [userId, fetchFor]);
  const load = useCallback(() => (userId ? fetchFor(userId) : Promise.resolve(null)), [userId, fetchFor]);
  const reload = useCallback(() => {
    if (!userId) return;
    setState((previous) => (previous.userId === userId ? { ...previous, loading: true } : previous));
    void fetchFor(userId);
  }, [userId, fetchFor]);
  useEffect(() => {
    if (!refreshOnReturn || !userId) return;
    const refresh = () => { if (document.visibilityState === "visible") reload(); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) reload(); };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pageshow", restored);
    return () => { document.removeEventListener("visibilitychange", refresh); window.removeEventListener("pageshow", restored); };
  }, [refreshOnReturn, reload, userId]);
  // 아직 이 직원의 첫 응답이 오지 않았으면 이전 직원 자료 대신 빈 "조회 중" 상태를 보여 준다.
  const own = userId !== null && state.userId === userId;
  return {
    userId,
    contracts: own ? state.contracts : [],
    current: own ? state.current : null,
    scheduled: own ? state.scheduled : null,
    workSchedules: own ? state.workSchedules : [],
    loading: userId !== null && (!own || state.loading),
    loadFailed: own && state.loadFailed,
    load,
    reload,
  };
}
