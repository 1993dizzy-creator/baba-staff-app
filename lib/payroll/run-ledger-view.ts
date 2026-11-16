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

/** 장부 제목(짧게): KO "26년 10월 급여장부", VI "Sổ lương 10/26". month = "YYYY-MM" */
export function runLedgerTitle(month: string, lang: "ko" | "vi"): string {
  const yy = month.slice(2, 4); const mm = month.slice(5, 7);
  return lang === "vi" ? `Sổ lương ${mm}/${yy}` : `${yy}년 ${Number(mm)}월 급여장부`;
}

/** 소액(1,000₫ 미만) 차액 = 반올림 수준. 오류처럼 강조하지 않는다(표시 색만 다름, 값은 그대로). */
export const MINOR_DIFFERENCE_LIMIT = 1000;
export function isMinorDifference(amount: number): boolean {
  return Math.abs(amount) < MINOR_DIFFERENCE_LIMIT;
}

/** 차액 검토 순서: 절대값이 큰 차이부터(같으면 기존 순서 유지). 원본 배열은 바꾸지 않는다. */
export function sortByDifferenceMagnitude<T extends { differenceAmount: number }>(rows: readonly T[]): T[] {
  return rows.map((row, index) => ({ row, index }))
    .sort((a, b) => Math.abs(b.row.differenceAmount) - Math.abs(a.row.differenceAmount) || a.index - b.index)
    .map(({ row }) => row);
}

/** 목록·기본 상세용 한 줄 사유: 직원별 추가 안내가 있으면 그것, 없으면 공통 사유, 둘 다 없으면 원문. */
export function oneLineDifferenceReason(reason: string | null | undefined, note: string | null, commonLead: string | null): string | null {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) return null;
  return note ?? commonLead ?? text;
}

export const STORE_TIME_ZONE = "Asia/Ho_Chi_Minh";
function zonedParts(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: STORE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return { ...parts, ms: String(date.getUTCMilliseconds()).padStart(3, "0") } as Record<string, string>;
}
/** APP 기록 시각(짧게, 베트남 시간 24시간): KO "11/16 19:11", VI "16/11 19:11". */
export function formatAppRecordedAt(value: string | null | undefined, lang: "ko" | "vi"): string {
  const p = value ? zonedParts(value) : null;
  if (!p) return "—";
  const day = lang === "vi" ? `${p.day}/${p.month}` : `${Number(p.month)}/${Number(p.day)}`;
  return `${day} ${p.hour}:${p.minute}`;
}
/** 고급 감사자료용 정확한 시각: "2026-11-16 19:11:02.642 (UTC+07:00 Asia/Ho_Chi_Minh)". 원본 ISO는 따로 함께 보여준다. */
export function formatExactRecordedAt(value: string | null | undefined): string {
  const p = value ? zonedParts(value) : null;
  if (!p) return "—";
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${p.ms} (UTC+07:00 ${STORE_TIME_ZONE})`;
}
