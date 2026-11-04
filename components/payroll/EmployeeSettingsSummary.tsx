"use client";

import type { CSSProperties } from "react";
import { money, payrollLabel, type PayrollUiLang } from "@/lib/payroll/ui-labels";
import type { PayrollInsuranceSettingVersion } from "@/lib/payroll/insurance";
import type { PayrollTaxSettingVersion } from "@/lib/payroll/tax";
import type { WorkScheduleVersion } from "@/lib/payroll/types";
import {
  pickAttendanceBonus,
  pickContract,
  pickInsurance,
  pickMealAllowance,
  pickTax,
  pickWorkSchedule,
  type SettingHistoryState,
  type SummaryReference,
} from "@/lib/payroll/settings-summary";

type SummaryContract = { effectiveFrom: string; effectiveTo: string | null; payType: string; baseSalary: number; fixedRaiseAmount: number };
type MealVersion = { isEligible: boolean; effectiveFrom: string; revision: number };
type BonusVersion = { isEligible: boolean; effectiveMonth: string; revision: number };

export const EMPLOYEE_SETTING_ANCHORS = {
  contract: "payroll-setting-contract",
  insurance: "payroll-setting-insurance",
  tax: "payroll-setting-tax",
  meal: "payroll-setting-meal",
  bonus: "payroll-setting-bonus",
} as const;

type Tone = "ok" | "warn" | "muted" | "error";
type Row = { key: string; label: string; anchor: string; tone: Tone; value: string; meta?: string; next?: string };

// 급여설정 직원 탭 상단의 "선택 직원 급여설정 요약". 각 카드가 이미 조회한 이력만 사용하고,
// 조회 중/실패는 "미설정"과 다른 문구로 보여준다. 기준 월(현재·과거·예정)을 명시한다.
export default function EmployeeSettingsSummary({
  lang,
  reference,
  contracts,
  workSchedules,
  requiresFixedMonthly,
  directorManagedInsurance,
  insurance,
  tax,
  meal,
  bonus,
}: {
  lang: PayrollUiLang;
  reference: SummaryReference;
  contracts: SettingHistoryState<SummaryContract>;
  workSchedules: WorkScheduleVersion[];
  requiresFixedMonthly: boolean;
  directorManagedInsurance: boolean;
  insurance: SettingHistoryState<PayrollInsuranceSettingVersion>;
  tax: SettingHistoryState<PayrollTaxSettingVersion>;
  meal: SettingHistoryState<MealVersion>;
  bonus: SettingHistoryState<BonusVersion>;
}) {
  const vi = lang === "vi";
  const past = reference.kind === "past";
  const t = {
    loading: vi ? "Đang tải…" : "조회 중…",
    error: vi ? "Không tải được · chưa xác định" : "조회 실패 · 확인 불가",
    none: past ? (vi ? "Không có cài đặt trong tháng này" : "해당 월 적용 설정 없음") : (vi ? "Chưa cài đặt" : "미설정"),
    since: vi ? "Áp dụng từ" : "적용",
    next: past ? (vi ? "Thay đổi sau đó" : "이후 변경") : (vi ? "Đã đặt lịch" : "예약"),
    from: (date: string) => (vi ? `từ ${date}` : `${date}부터`),
  };
  const month = (value: string) => value.slice(0, 7);

  function stateRow(key: string, label: string, anchor: string, status: SettingHistoryState<unknown>["status"]): Row | null {
    if (status === "loading") return { key, label, anchor, tone: "muted", value: t.loading };
    if (status === "error") return { key, label, anchor, tone: "error", value: t.error };
    return null;
  }

  const rows: Row[] = [];

  // 1. 급여계약
  {
    const label = vi ? "Hợp đồng lương" : "급여계약";
    const pending = stateRow("contract", label, EMPLOYEE_SETTING_ANCHORS.contract, contracts.status);
    if (pending) rows.push(pending);
    else {
      const pick = pickContract(contracts.history, reference);
      const describe = (contract: SummaryContract) => `${payrollLabel(lang, contract.payType)} · ${money(contract.baseSalary)}${contract.fixedRaiseAmount > 0 ? ` (+${money(contract.fixedRaiseAmount)})` : ""}`;
      rows.push(pick.overlap
        ? { key: "contract", label, anchor: EMPLOYEE_SETTING_ANCHORS.contract, tone: "warn", value: vi ? "Thời gian hợp đồng bị trùng · cần kiểm tra" : "계약 적용기간 중복 · 확인 필요" }
        : pick.applied
          ? { key: "contract", label, anchor: EMPLOYEE_SETTING_ANCHORS.contract, tone: "ok", value: describe(pick.applied), meta: `${t.since} ${pick.applied.effectiveFrom}`, next: pick.scheduled ? `${t.next} · ${t.from(pick.scheduled.effectiveFrom)} ${describe(pick.scheduled)}` : undefined }
          : { key: "contract", label, anchor: EMPLOYEE_SETTING_ANCHORS.contract, tone: "warn", value: t.none, next: pick.scheduled ? `${t.next} · ${t.from(pick.scheduled.effectiveFrom)} ${describe(pick.scheduled)}` : undefined });
    }
  }

  // 2. 근무시간 (계약 조회 응답에 함께 포함된 스케줄 이력)
  {
    const label = vi ? "Giờ làm việc" : "근무시간";
    const pending = stateRow("schedule", label, EMPLOYEE_SETTING_ANCHORS.contract, contracts.status);
    if (pending) rows.push(pending);
    else if (requiresFixedMonthly) rows.push({ key: "schedule", label, anchor: EMPLOYEE_SETTING_ANCHORS.contract, tone: "muted", value: vi ? "Không cần (lương cố định hàng tháng)" : "불필요 (월 고정급)" });
    else {
      const pick = pickWorkSchedule(workSchedules, reference);
      const describe = (schedule: WorkScheduleVersion) => `${schedule.startTime}~${schedule.endTime}${schedule.unpaidBreakMinutes > 0 ? (vi ? ` · nghỉ ${schedule.unpaidBreakMinutes} phút` : ` · 휴게 ${schedule.unpaidBreakMinutes}분`) : ""}`;
      rows.push(pick.overlap
        ? { key: "schedule", label, anchor: EMPLOYEE_SETTING_ANCHORS.contract, tone: "warn", value: vi ? "Lịch làm việc bị trùng · cần kiểm tra" : "근무 스케줄 중복 · 확인 필요" }
        : pick.applied
          ? { key: "schedule", label, anchor: EMPLOYEE_SETTING_ANCHORS.contract, tone: "ok", value: describe(pick.applied), meta: `${t.since} ${pick.applied.effectiveFrom}`, next: pick.scheduled ? `${t.next} · ${t.from(pick.scheduled.effectiveFrom)} ${describe(pick.scheduled)}` : undefined }
          : { key: "schedule", label, anchor: EMPLOYEE_SETTING_ANCHORS.contract, tone: "warn", value: vi ? (past ? "Không có lịch làm việc trong tháng này" : "Chưa có lịch làm việc hợp lệ") : (past ? "해당 월 유효 스케줄 없음" : "유효한 근무 스케줄 없음") });
    }
  }

  // 3. 보험
  {
    const label = vi ? "Bảo hiểm" : "보험";
    if (directorManagedInsurance) rows.push({ key: "insurance", label, anchor: EMPLOYEE_SETTING_ANCHORS.insurance, tone: "muted", value: vi ? "Quản lý trong cài đặt chung" : "회사 공통 설정에서 관리" });
    else {
      const pending = stateRow("insurance", label, EMPLOYEE_SETTING_ANCHORS.insurance, insurance.status);
      if (pending) rows.push(pending);
      else {
        const pick = pickInsurance(insurance.history, reference);
        const describe = (version: PayrollInsuranceSettingVersion) => version.isEnrolled ? (vi ? "Tham gia" : "가입") : (vi ? "Không tham gia" : "미가입");
        rows.push({
          key: "insurance", label, anchor: EMPLOYEE_SETTING_ANCHORS.insurance,
          tone: pick.applied ? "ok" : "muted",
          value: pick.applied ? describe(pick.applied) : t.none,
          meta: pick.applied ? `${vi ? "Tháng áp dụng" : "적용 월"} ${month(pick.applied.effectiveMonth)}` : undefined,
          next: pick.scheduled ? `${t.next} · ${t.from(month(pick.scheduled.effectiveMonth))} ${describe(pick.scheduled)}` : undefined,
        });
      }
    }
  }

  // 4. TNCN
  {
    const label = "TNCN";
    const pending = stateRow("tax", label, EMPLOYEE_SETTING_ANCHORS.tax, tax.status);
    if (pending) rows.push(pending);
    else {
      const pick = pickTax(tax.history, reference);
      const describe = (version: PayrollTaxSettingVersion) => version.taxMode === "resident_progressive" ? (vi ? "Cư trú · lũy tiến" : "거주자 누진세율") : (vi ? "Không áp dụng" : "미적용");
      const review = vi ? "Cần kiểm tra" : "확인 필요";
      rows.push({
        key: "tax", label, anchor: EMPLOYEE_SETTING_ANCHORS.tax,
        tone: pick.requiresReview ? "warn" : "ok",
        value: pick.applied ? `${describe(pick.applied)}${pick.requiresReview ? ` · ${review}` : ""}` : `${t.none} · ${review}`,
        meta: pick.applied ? `${vi ? "Tháng áp dụng" : "적용 월"} ${month(pick.applied.effectiveMonth)}` : undefined,
        next: pick.scheduled ? `${t.next} · ${t.from(month(pick.scheduled.effectiveMonth))} ${describe(pick.scheduled)}` : undefined,
      });
    }
  }

  // 5. 식대
  {
    const label = vi ? "Trợ cấp ăn" : "식대";
    const pending = stateRow("meal", label, EMPLOYEE_SETTING_ANCHORS.meal, meal.status);
    if (pending) rows.push(pending);
    else {
      const pick = pickMealAllowance(meal.history, reference);
      const describe = (version: MealVersion) => version.isEligible ? (vi ? "Đối tượng" : "대상") : (vi ? "Không phải đối tượng" : "비대상");
      rows.push({
        key: "meal", label, anchor: EMPLOYEE_SETTING_ANCHORS.meal,
        tone: pick.applied ? "ok" : "muted",
        value: pick.applied ? describe(pick.applied) : t.none,
        meta: pick.applied ? `${vi ? "Ngày áp dụng" : "적용일"} ${pick.applied.effectiveFrom}` : undefined,
        next: pick.scheduled ? `${t.next} · ${t.from(pick.scheduled.effectiveFrom)} ${describe(pick.scheduled)}` : undefined,
      });
    }
  }

  // 6. 개근 보너스
  {
    const label = vi ? "Thưởng chuyên cần" : "개근 보너스";
    const pending = stateRow("bonus", label, EMPLOYEE_SETTING_ANCHORS.bonus, bonus.status);
    if (pending) rows.push(pending);
    else {
      const pick = pickAttendanceBonus(bonus.history, reference);
      const describe = (version: BonusVersion) => version.isEligible ? (vi ? "Đối tượng" : "대상") : (vi ? "Không phải đối tượng" : "비대상");
      rows.push({
        key: "bonus", label, anchor: EMPLOYEE_SETTING_ANCHORS.bonus,
        tone: pick.applied ? "ok" : "muted",
        value: pick.applied ? describe(pick.applied) : t.none,
        meta: pick.applied ? `${vi ? "Tháng áp dụng" : "적용 월"} ${month(pick.applied.effectiveMonth)}` : undefined,
        next: pick.scheduled ? `${t.next} · ${t.from(month(pick.scheduled.effectiveMonth))} ${describe(pick.scheduled)}` : undefined,
      });
    }
  }

  const referenceLabel = reference.kind === "current"
    ? (vi ? `Theo hiện tại (${reference.date})` : `현재 적용 기준 (${reference.date})`)
    : reference.kind === "past"
      ? (vi ? `Theo tháng ${reference.month} (quá khứ · theo lịch sử phiên bản)` : `${reference.month} 기준 (과거 월 · 버전 이력 기준)`)
      : (vi ? `Theo tháng ${reference.month} (dự kiến)` : `${reference.month} 기준 (예정 월)`);

  return (
    <div style={s.wrap} aria-label={vi ? "Tóm tắt cài đặt lương" : "급여설정 요약"}>
      <div style={s.reference}>{referenceLabel}</div>
      <ul style={s.list}>
        {rows.map((row) => (
          <li key={row.key} style={s.row}>
            <button type="button" style={s.rowButton} onClick={() => document.getElementById(row.anchor)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              <span style={s.label}>{row.label}</span>
              <span style={s.body}>
                <span style={{ ...s.value, ...toneStyle[row.tone] }}>{row.value}</span>
                {row.meta ? <small style={s.meta}>{row.meta}</small> : null}
                {row.next ? <small style={s.next}>{row.next}</small> : null}
              </span>
              <span style={s.chevron} aria-hidden="true">›</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const toneStyle: Record<Tone, CSSProperties> = {
  ok: { color: "#111827" },
  warn: { color: "#b45309" },
  muted: { color: "#6b7280" },
  error: { color: "#b91c1c" },
};

const s = {
  wrap: { display: "grid", gap: 6, minWidth: 0 },
  reference: { fontSize: 11.5, fontWeight: 800, color: "#475569" },
  list: { listStyle: "none", margin: 0, padding: 0, display: "grid", border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden", background: "#fff" },
  row: { borderBottom: "1px solid #f1f5f9", minWidth: 0 },
  rowButton: { width: "100%", display: "grid", gridTemplateColumns: "minmax(72px, 30%) minmax(0, 1fr) 12px", alignItems: "start", gap: 8, padding: "8px 10px", border: 0, background: "transparent", textAlign: "left", cursor: "pointer", minWidth: 0, boxSizing: "border-box" },
  label: { fontSize: 12, fontWeight: 800, color: "#475569", overflowWrap: "anywhere" },
  body: { display: "grid", gap: 2, minWidth: 0 },
  value: { fontSize: 12.5, fontWeight: 800, lineHeight: 1.35, overflowWrap: "anywhere" },
  meta: { fontSize: 11, color: "#64748b", lineHeight: 1.35 },
  next: { fontSize: 11, color: "#1d4ed8", lineHeight: 1.35, overflowWrap: "anywhere" },
  chevron: { color: "#9ca3af", fontSize: 14, lineHeight: 1.2 },
} satisfies Record<string, CSSProperties>;
