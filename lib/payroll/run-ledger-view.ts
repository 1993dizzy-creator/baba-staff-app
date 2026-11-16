// /admin/payroll/[runId] 급여장부 화면 구성 전용(읽기 전용). 저장된 값을 화면용으로 묶기만 하며
// 금액을 재계산·보정하지 않는다. difference_reason 원문은 바꾸지 않고, 목록용 짧은 안내만 따로 만든다.

import type { PaymentOutflows } from "./payment-outflows.ts";

export type RunLedgerTab = "payments" | "differences" | "audit";
export const RUN_LEDGER_TABS: readonly RunLedgerTab[] = ["payments", "differences", "audit"];

/** 키보드 탭 이동(←/→/Home/End). 탭 순서는 RUN_LEDGER_TABS를 따른다. */
export function nextRunLedgerTab(current: RunLedgerTab, key: string): RunLedgerTab | null {
  const index = RUN_LEDGER_TABS.indexOf(current);
  if (key === "ArrowRight") return RUN_LEDGER_TABS[(index + 1) % RUN_LEDGER_TABS.length];
  if (key === "ArrowLeft") return RUN_LEDGER_TABS[(index - 1 + RUN_LEDGER_TABS.length) % RUN_LEDGER_TABS.length];
  if (key === "Home") return RUN_LEDGER_TABS[0];
  if (key === "End") return RUN_LEDGER_TABS[RUN_LEDGER_TABS.length - 1];
  return null;
}

export type RunOutflowSummary = {
  /** 전체 출금액 = 지급일·계좌별 출금 합계(직원 지급 + 미배분 잔차) */
  outflowTotal: number;
  employeePaidTotal: number;
  residualTotal: number;
  /** 배치에 저장된 actual_paid_total */
  storedPaidTotal: number;
  /** 직원별 실지급 합계 = 배치 저장 합계 (다르면 화면에 경고만 표시) */
  paidTotalMatches: boolean;
};

export function summarizeRunOutflow(storedPaidTotal: unknown, outflows: PaymentOutflows): RunOutflowSummary {
  const stored = Number(storedPaidTotal);
  const storedPaid = Number.isFinite(stored) ? stored : 0;
  return {
    outflowTotal: outflows.outflowTotal,
    employeePaidTotal: outflows.employeePaidTotal,
    residualTotal: outflows.residualTotal,
    storedPaidTotal: storedPaid,
    paidTotalMatches: outflows.employeePaidTotal === storedPaid,
  };
}

const REASON_SEPARATOR = " · ";
// "APP 계산 X₫ → 실지급 Y₫ (차액 ±Z₫)" 구간은 목록에 이미 숫자로 보이므로 짧은 안내에서만 생략한다.
const AMOUNT_SEGMENT = /^APP 계산 .+→ 실지급 .+$/;

export type DifferenceReasonDigest = {
  /** 2명 이상이 같은 첫 구간으로 시작하면, 그 공통 사유를 한 번만 보여준다. */
  commonLead: string | null;
  /** 행별 짧은 안내(공통 사유·금액 구간 제외). 원문은 그대로 따로 보존·표시한다. null = 추가 안내 없음 */
  notes: (string | null)[];
};

export function digestDifferenceReasons(reasons: readonly (string | null | undefined)[]): DifferenceReasonDigest {
  const parts = reasons.map(reason => {
    const text = typeof reason === "string" ? reason.trim() : "";
    return text ? text.split(REASON_SEPARATOR) : null;
  });
  const recorded = parts.filter((segments): segments is string[] => segments !== null);
  const lead = recorded[0]?.[0] ?? null;
  // 사유 미기록 행은 공통 사유 판단에서 빼고, 화면에서 "사유 미기록"으로 따로 표시한다.
  const commonLead = lead && recorded.length >= 2 && recorded.every(segments => segments.length > 1 && segments[0] === lead) ? lead : null;
  const notes = parts.map(segments => {
    if (!segments) return null;
    const rest = (commonLead ? segments.slice(1) : segments).filter(segment => !AMOUNT_SEGMENT.test(segment.trim()));
    const note = rest.join(REASON_SEPARATOR).trim();
    return note || null;
  });
  return { commonLead, notes };
}

/** 날짜 표시: 2026-11-10 → 11/10 (같은 해 장부에서 짧게). 형식이 다르면 원문 그대로. */
export function shortPaymentDate(value: string | null | undefined): string {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${Number(match[2])}/${Number(match[3])}` : value;
}
