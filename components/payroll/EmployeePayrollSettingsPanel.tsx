"use client";
// 직원 1명의 급여·복리후생 설정(급여계약 등록·정정, 보험, 세금, 식대, 개근 보너스).
// /admin/payroll/settings 직원 탭과 /admin/users 직원 상세가 이 컴포넌트 하나를 함께 쓴다.
// 저장은 항목별 기존 API를 그대로 사용한다(단일 저장 API 없음). 직원이 바뀌면 key로 다시 마운트해
// 이전 직원의 입력·오류·저장 확인 대기 상태가 섞이지 않게 한다.
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import EmployeeNameWithLevel from "@/components/employee/EmployeeNameWithLevel";
import EmployeeInsuranceSettings, {
  type EmployeeInsuranceLoadState,
} from "@/components/payroll/EmployeeInsuranceSettings";
import EmployeeMealAllowanceSettings from "@/components/payroll/EmployeeMealAllowanceSettings";
import EmployeeAttendanceBonusSettings from "@/components/payroll/EmployeeAttendanceBonusSettings";
import type { MealAllowanceVersion } from "@/components/payroll/EmployeeMealAllowanceSettings";
import type { AttendanceBonusEligibilityHistoryVersion } from "@/components/payroll/EmployeeAttendanceBonusSettings";
import EmployeeTaxSettings from "@/components/payroll/EmployeeTaxSettings";
import PayrollModal from "@/components/payroll/PayrollModal";
import EmployeeSettingsSummary, { EMPLOYEE_SETTING_ANCHORS } from "@/components/payroll/EmployeeSettingsSummary";
import type { PayrollContractsController, PayrollContractView } from "@/components/payroll/usePayrollContracts";
import type { SettingHistoryState, SummaryReference } from "@/lib/payroll/settings-summary";
import type { PayrollInsuranceSettingVersion } from "@/lib/payroll/insurance";
import type { PayrollTaxSettingVersion } from "@/lib/payroll/tax";
import { money, payrollLabel, type PayrollUiLang } from "@/lib/payroll/ui-labels";
import type { EmployeeLevelInfo } from "@/lib/employee-level/types";
import { vietnamCurrentMonthStart } from "@/lib/payroll/ui-dates";
import { currencyAmount, formatIntegerInput, integerInputDigits, isMonthFirstDate, minutesToHoursInput, signedAmount } from "@/lib/payroll/contract-form";
import { payrollContractErrorMessage } from "@/lib/payroll/contract-errors";
import { contractSaveApplied, type SubmittedContractSave } from "@/lib/payroll/contract-save-verification";
import type { WorkScheduleVersion } from "@/lib/payroll/types";
import { scheduledMinutesPerDay, schedulesActiveOn } from "@/lib/payroll/work-schedule";
import { isPayrollOwnerRole, requiresFixedMonthlyContract } from "@/lib/payroll/eligibility";
import { NO_PAYROLL_UNSAVED, readPendingContractSave, writePendingContractSave, type PayrollUnsavedState } from "@/components/payroll/payrollUnsaved";

export type EmployeePayrollPanelUser = {
  id: number;
  name: string | null;
  username: string;
  role: string | null;
  attendanceTrackingEnabled: boolean;
  levelInfo: EmployeeLevelInfo;
};
type InsuranceCurrent = {
  isEnrolled: boolean;
  insuranceBaseAmount: number;
  effectiveMonth: string;
  revision: number;
};
type SelectedInsuranceState = {
  current: InsuranceCurrent | null;
  history: PayrollInsuranceSettingVersion[];
  error: boolean;
  loading: boolean;
};
type Contract = PayrollContractView;
type FormState = {
  payType: string;
  calculationBasis: string;
  baseSalary: string;
  fixedRaiseAmount: string;
  standardWorkdays: string;
  standardHoursPerDay: string;
  timeBlockMinutes: string;
  roundingMode: string;
  lateAdjustmentMode: string;
  overtimeMode: string;
  effectiveFrom: string;
  fixedRaiseReason: string;
};
const defaults: FormState = {
  payType: "monthly",
  calculationBasis: "minute",
  baseSalary: "",
  fixedRaiseAmount: "0",
  standardWorkdays: "26",
  standardHoursPerDay: "9",
  timeBlockMinutes: "60",
  roundingMode: "none",
  lateAdjustmentMode: "separate",
  overtimeMode: "ignore",
  effectiveFrom: vietnamCurrentMonthStart(),
  fixedRaiseReason: "",
};
function fromContract(contract: Contract | null): FormState {
  return contract
    ? {
        payType: contract.payType,
        calculationBasis: contract.calculationBasis === "fixed_monthly" ? "fixed_monthly" : contract.calculationBasis,
        baseSalary: String(contract.baseSalary),
        fixedRaiseAmount: String(contract.fixedRaiseAmount),
        standardWorkdays: String(contract.standardWorkdays ?? 26),
        standardHoursPerDay: minutesToHoursInput(contract.standardMinutesPerDay),
        timeBlockMinutes: String(contract.timeBlockMinutes),
        roundingMode: contract.roundingMode,
        lateAdjustmentMode: contract.lateAdjustmentMode,
        overtimeMode: contract.overtimeMode,
        effectiveFrom: vietnamCurrentMonthStart(),
        fixedRaiseReason: "",
      }
    : { ...defaults };
}
function salaryInputLabel(lang: PayrollUiLang, payType: string) {
  if (payType === "hourly") return lang === "vi" ? "Lương theo giờ" : "시급";
  if (payType === "daily") return lang === "vi" ? "Lương theo ngày" : "일급";
  return lang === "vi" ? "Lương hợp đồng hàng tháng" : "월 계약급여";
}

export default function EmployeePayrollSettingsPanel({
  user,
  lang,
  contracts: contractsSource,
  summaryReference,
  metaLabel,
  showIdentity = true,
  anchorPrefix = "",
  headerAction,
  levelAction,
  onSettledChange,
  onUnsavedChange,
  onMealHistoryChange,
}: {
  user: EmployeePayrollPanelUser;
  lang: PayrollUiLang;
  /** usePayrollContracts(user.id)의 결과. 화면이 계약 조회를 소유하고 요약과 편집이 공유한다. */
  contracts: PayrollContractsController;
  summaryReference: SummaryReference;
  metaLabel?: string;
  /** 직원관리 상세처럼 이미 직원이 표시된 곳에서는 이름 헤더를 숨긴다. */
  showIdentity?: boolean;
  /** 같은 화면에 여러 직원 패널이 열릴 때 요약→항목 이동용 id가 겹치지 않게 한다. */
  anchorPrefix?: string;
  headerAction?: ReactNode;
  levelAction?: ReactNode;
  /** 계약·보험 첫 조회가 끝났는지(급여설정 화면의 선택 직원 스크롤용). */
  onSettledChange?: (settled: boolean, userId: number) => void;
  /** 저장하지 않은 입력(계약·식대·개근·보험·세금)과 계약 저장 결과 확인 대기를 구분해 알린다. */
  onUnsavedChange?: (state: PayrollUnsavedState) => void;
  onMealHistoryChange?: (state: SettingHistoryState<MealAllowanceVersion>) => void;
}) {
  const l = lang;
  const vi = lang === "vi";
  const selected = user;
  const userId = user.id;
  const { contracts, current: currentContract, workSchedules, loading: contractsLoading, loadFailed: contractsLoadFailed } = contractsSource;
  const [errorHidden, setErrorHidden] = useState(false);
  const [contractsReloading, setContractsReloading] = useState(false);
  const [notice, setNotice] = useState("");
  // 결과가 불확실한 계약 저장 요청. 반영 여부를 확인하기 전에는 같은 요청을 다시 보내지 않는다.
  // 직원별로 sessionStorage에도 남겨, 다른 화면·직원으로 갔다 와도 확인 전에는 새 저장을 막는다.
  const [pendingContractSave, setPendingContractSaveState] = useState<SubmittedContractSave | null>(() => (typeof window === "undefined" ? null : readPendingContractSave(user.id)));
  const setPendingContractSave = useCallback((submitted: SubmittedContractSave | null) => {
    setPendingContractSaveState(submitted);
    writePendingContractSave(user.id, submitted);
  }, [user.id]);
  // 계약 등록·정정 창을 열 때의 입력값(이후 실제로 바뀌었는지 판정용).
  const [formBaseline, setFormBaseline] = useState("");
  // 식대·개근·보험·세금 카드가 알려 준 미저장 입력.
  const [cardDirty, setCardDirty] = useState<Record<"insurance" | "tax" | "meal" | "bonus", boolean>>({ insurance: false, tax: false, meal: false, bonus: false });
  const cardDirtyReporters = useMemo(() => {
    const reporter = (key: "insurance" | "tax" | "meal" | "bonus") => (dirty: boolean) =>
      setCardDirty((previous) => (previous[key] === dirty ? previous : { ...previous, [key]: dirty }));
    return { insurance: reporter("insurance"), tax: reporter("tax"), meal: reporter("meal"), bonus: reporter("bonus") };
  }, []);
  const [form, setForm] = useState<FormState>(defaults);
  const [open, setOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "correct">("create");
  const [correctionTarget, setCorrectionTarget] = useState<Contract | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [modalError, setModalError] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedInsuranceState, setSelectedInsuranceState] = useState<SelectedInsuranceState | null>(null);
  // 급여설정 요약: 각 설정 카드가 조회한 이력을 받아 둔다(이 패널은 직원 1명 전용).
  const [taxHistoryState, setTaxHistoryState] = useState<SettingHistoryState<PayrollTaxSettingVersion> | null>(null);
  const [mealHistoryState, setMealHistoryState] = useState<SettingHistoryState<MealAllowanceVersion> | null>(null);
  const [bonusHistoryState, setBonusHistoryState] = useState<SettingHistoryState<AttendanceBonusEligibilityHistoryVersion> | null>(null);
  const formId = useId();
  const loadFailedMessage = vi ? "Không thể tải hợp đồng lương." : "급여계약을 불러오지 못했습니다.";
  const error = contractsLoadFailed && !errorHidden ? loadFailedMessage : "";
  // 다시 조회하면 조회 실패 안내를 다시 보일 수 있게 한다(기존: 실패할 때마다 오류 문구 재설정).
  const load = useCallback(async () => { setErrorHidden(false); return contractsSource.load(); }, [contractsSource]);
  const handleInsuranceLoadStateChange = useCallback(
    (_loadedUserId: number, state: EmployeeInsuranceLoadState) => {
      setSelectedInsuranceState((previous) => ({
        current: state.loading && previous ? previous.current : state.current,
        history: state.history,
        error: state.error,
        loading: state.loading,
      }));
    },
    [],
  );
  const directorManagedInsurance = selected.username === "mjk";
  const selectedInsurance = selectedInsuranceState?.current ?? null;
  const selectedInsuranceError = selectedInsuranceState?.error ?? false;
  const selectedInsuranceLoading = !directorManagedInsurance && (selectedInsuranceState?.loading ?? true);
  const selectedIsOwner = isPayrollOwnerRole(selected?.role ?? null);
  // owner/master이거나 근태 기록을 쓰지 않는 직원(attendance_tracking_enabled=false)은
  // 근무시간 없이 월 고정급(monthly + fixed_monthly) 계약만 쓴다. role 자체는 바뀌지 않는다
  // — 이 값은 "계약에 근무시간이 필요한가"만 판정한다.
  const selectedRequiresFixedMonthly = requiresFixedMonthlyContract(selected?.role ?? null, selected?.attendanceTrackingEnabled ?? true);
  const selectedRequiresWorkSchedule = !selectedRequiresFixedMonthly;
  const effectiveSchedules = schedulesActiveOn(workSchedules, form.effectiveFrom);
  const effectiveSchedule = effectiveSchedules.length === 1 ? effectiveSchedules[0] : null;
  const automaticStandardMinutes = effectiveSchedule ? scheduledMinutesPerDay(effectiveSchedule.startTime, effectiveSchedule.endTime, effectiveSchedule.unpaidBreakMinutes) : null;
  const vietnamToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const loadingHistory = { status: "loading" as const, history: [] };
  const summaryContracts: SettingHistoryState<Contract> = contractsLoading ? loadingHistory : contractsLoadFailed ? { status: "error", history: [] } : { status: "ready", history: contracts };
  const summaryInsurance: SettingHistoryState<PayrollInsuranceSettingVersion> = !selectedInsuranceState || selectedInsuranceState.loading
    ? loadingHistory
    : selectedInsuranceState.error ? { status: "error", history: [] } : { status: "ready", history: selectedInsuranceState.history };
  const summaryTax = taxHistoryState ?? loadingHistory;
  const summaryMeal = mealHistoryState ?? loadingHistory;
  const summaryBonus = bonusHistoryState ?? loadingHistory;
  const currentScheduleMatches = schedulesActiveOn(workSchedules, vietnamToday);
  const currentSchedule = currentScheduleMatches.length === 1 ? currentScheduleMatches[0] : null;
  const effectiveMonthStart = `${form.effectiveFrom.slice(0, 7)}-01`;
  const nextMonth = new Date(`${effectiveMonthStart}T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const effectiveMonthEndExclusive = nextMonth.toISOString().slice(0, 10);
  const effectiveMonthSchedules = workSchedules
    .filter((schedule) => (!schedule.effectiveTo || schedule.effectiveTo > schedule.effectiveFrom) && schedule.effectiveFrom < effectiveMonthEndExclusive && (!schedule.effectiveTo || schedule.effectiveTo > effectiveMonthStart))
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const settled = !contractsLoading && !selectedInsuranceLoading;
  useEffect(() => { onSettledChange?.(settled, userId); }, [onSettledChange, settled, userId]);
  // 창만 열고 바꾸지 않았으면 경고하지 않는다. 저장 중에는 결과가 오기 전이므로 미저장으로 본다.
  const contractInputDirty = open && (saving || JSON.stringify(form) !== formBaseline || correctionReason.trim() !== "");
  const unsavedInput = contractInputDirty || Object.values(cardDirty).some(Boolean);
  const pendingVerification = pendingContractSave !== null;
  useEffect(() => { onUnsavedChange?.({ input: unsavedInput, pendingVerification }); }, [onUnsavedChange, unsavedInput, pendingVerification]);
  useEffect(() => () => { onUnsavedChange?.(NO_PAYROLL_UNSAVED); }, [onUnsavedChange]);
  const current = currentContract;
  // Same rule as the payroll engine: only monthly pay with the level raise enabled.
  const levelRaise = selected?.levelInfo.eligible
    && selected.levelInfo.salaryRaiseEnabled !== false
    && current?.payType === "monthly"
    ? selected.levelInfo.earnedRaiseCount *
      selected.levelInfo.raiseAmountPerStep
    : 0;
  const combined = current
    ? current.baseSalary + current.fixedRaiseAmount + levelRaise
    : null;
  const currentFixedRaise = (formMode === "correct" ? correctionTarget : current)?.fixedRaiseAmount ?? 0;
  const nextFixedRaise = Number(form.fixedRaiseAmount || 0);
  const fixedRaiseChanged = nextFixedRaise !== currentFixedRaise;
  const anchor = (key: keyof typeof EMPLOYEE_SETTING_ANCHORS) => `${anchorPrefix}${EMPLOYEE_SETTING_ANCHORS[key]}`;
  function openForm() {
    if (pendingContractSave) return;
    const next = fromContract(current);
    const initialForm = selectedRequiresFixedMonthly ? { ...next, payType: "monthly", calculationBasis: "fixed_monthly", standardWorkdays: "26", standardHoursPerDay: "9" } : next;
    setForm(initialForm);
    setFormBaseline(JSON.stringify(initialForm));
    setFormMode("create");
    setCorrectionTarget(null);
    setCorrectionReason("");
    setErrorHidden(true);
    setModalError("");
    setOpen(true);
  }
  function openCorrectionForm() {
    if (pendingContractSave) return;
    const latest = contracts[0] ?? null;
    if (!latest) return;
    const next = { ...fromContract(latest), effectiveFrom: latest.effectiveFrom };
    const initialForm = selectedRequiresFixedMonthly ? { ...next, payType: "monthly", calculationBasis: "fixed_monthly", standardWorkdays: "26", standardHoursPerDay: "9" } : next;
    setForm(initialForm);
    setFormBaseline(JSON.stringify(initialForm));
    setFormMode("correct");
    setCorrectionTarget(latest);
    setCorrectionReason("");
    setErrorHidden(true);
    setModalError("");
    setOpen(true);
  }
  function closeForm() {
    if (saving) return;
    setModalError("");
    setOpen(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!userId || saving) return;
    setModalError("");
    const fixedMonthlyEffectiveDateMessage = vi ? "Hợp đồng trả cố định hàng tháng chỉ có thể áp dụng từ ngày đầu tiên của tháng." : "매월 고정 지급 계약은 매월 1일부터 적용할 수 있습니다.";
    if (form.calculationBasis === "fixed_monthly" && !isMonthFirstDate(form.effectiveFrom)) {
      window.alert(fixedMonthlyEffectiveDateMessage);
      return;
    }
    const standardMinutesPerDay = selectedRequiresFixedMonthly ? 540 : automaticStandardMinutes;
    if (standardMinutesPerDay === null) {
      setModalError(payrollContractErrorMessage(l, effectiveSchedules.length > 1 ? "WORK_SCHEDULE_OVERLAP" : effectiveSchedule ? "INVALID_WORK_SCHEDULE" : "WORK_SCHEDULE_NOT_FOUND"));
      return;
    }
    if (fixedRaiseChanged && !form.fixedRaiseReason.trim()) {
      setModalError(vi ? "Cần nhập lý do thay đổi mức tăng lương cố định." : "고정 급여인상 총액 변경 사유를 입력해주세요.");
      return;
    }
    if (formMode === "correct" && !correctionReason.trim()) {
      setModalError(payrollContractErrorMessage(l, "CONTRACT_CORRECTION_REASON_REQUIRED"));
      return;
    }
    if (pendingContractSave) return;
    const correcting = formMode === "correct" ? correctionTarget : null;
    const submitted: SubmittedContractSave = correcting
      ? { mode: "correct", contractId: correcting.id, expectedAuditVersion: correcting.auditVersion, effectiveFrom: form.effectiveFrom, payType: form.payType, baseSalary: Number(form.baseSalary), fixedRaiseAmount: Number(form.fixedRaiseAmount) }
      : { mode: "create", knownContractIds: contracts.map((contract) => contract.id), effectiveFrom: form.effectiveFrom, payType: form.payType, baseSalary: Number(form.baseSalary), fixedRaiseAmount: Number(form.fixedRaiseAmount) };
    const failureCode = formMode === "correct" ? "PAYROLL_CONTRACT_CORRECTION_FAILED" : "PAYROLL_CONTRACT_CREATE_FAILED";
    setSaving(true);
    setNotice("");
    try {
      let response: Response;
      try {
        response = await fetch(correcting ? "/api/admin/payroll/contracts/correct" : "/api/admin/payroll/contracts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...form,
            calculationBasis: selectedRequiresFixedMonthly ? "fixed_monthly" : "minute",
            timeBlockMinutes: 60,
            roundingMode: "none",
            lateAdjustmentMode: "separate",
            overtimeMode: "ignore",
            earlyLeaveAdjustmentMode: "deduct_minutes",
            paidLeaveMode: "unpaid",
            note: fixedRaiseChanged ? form.fixedRaiseReason.trim() : correcting?.note ?? null,
            userId,
            contractId: correcting?.id,
            expectedRevision: correcting?.revision,
            expectedAuditVersion: correcting?.auditVersion,
            expectedEffectiveFrom: correcting?.effectiveFrom,
            correctionReason: correcting ? correctionReason.trim() : undefined,
            baseSalary: Number(form.baseSalary),
            fixedRaiseAmount: Number(form.fixedRaiseAmount),
            standardWorkdays: selectedRequiresFixedMonthly ? 26 : form.payType === "monthly" ? Number(form.standardWorkdays) : null,
            standardMinutesPerDay,
          }),
        });
      } catch {
        // 네트워크 오류·응답 유실 — 기존 계약을 조회해 실제 반영 여부를 확인한다(자동 재저장 없음).
        await verifyContractSave(submitted);
        return;
      }
      const data = await response.json().catch(() => null) as { ok?: boolean; code?: string } | null;
      if (!response.ok) {
        if (!data) {
          // 게이트웨이 오류 등 응답 본문 유실 — 결과가 불확실하므로 반영 여부를 먼저 확인한다.
          await verifyContractSave(submitted);
          return;
        }
        // 서버가 실패를 응답했다 — 계약은 바뀌지 않았다. 입력값은 그대로 유지한다.
        setModalError(payrollContractErrorMessage(l, data.code, failureCode));
        return;
      }
      if (!data || data.ok !== true) {
        await verifyContractSave(submitted);
        return;
      }
      // 저장 성공. 저장 후 재조회 실패는 저장 실패와 구분해 안내한다.
      const history = await load();
      setOpen(false);
      setNotice(history
        ? (vi ? "Đã lưu hợp đồng lương." : "급여계약을 저장했습니다.")
        : (vi ? "Đã lưu hợp đồng lương nhưng chưa tải lại được danh sách hợp đồng. Vui lòng tải lại." : "급여계약은 저장되었지만 계약 목록을 다시 불러오지 못했습니다. 다시 조회해주세요."));
    } catch {
      setModalError(payrollContractErrorMessage(l, failureCode));
    } finally {
      setSaving(false);
    }
  }
  async function verifyContractSave(submitted: SubmittedContractSave) {
    const history = await load();
    if (!history) {
      setPendingContractSave(submitted);
      setModalError(vi
        ? "Chưa xác nhận được kết quả lưu. Giá trị đã nhập vẫn được giữ. Để tránh lưu trùng, hãy kiểm tra lại kết quả trước khi lưu."
        : "저장 결과를 확인하지 못했습니다. 입력값은 유지됩니다. 중복 저장을 막기 위해 결과를 다시 확인한 뒤 진행해주세요.");
      return;
    }
    setPendingContractSave(null);
    setErrorHidden(true);
    if (contractSaveApplied(history, submitted)) {
      setModalError("");
      setOpen(false);
      setNotice(vi ? "Đã xác nhận hợp đồng lương được lưu." : "급여계약 저장 반영을 확인했습니다.");
      return;
    }
    setModalError(vi
      ? "Đã kiểm tra: hợp đồng chưa được lưu. Giá trị đã nhập vẫn được giữ — hãy kiểm tra rồi lưu lại."
      : "확인 결과 저장이 반영되지 않았습니다. 입력값은 유지되니 확인 후 다시 저장해주세요.");
  }
  async function recheckContracts() {
    if (!userId || contractsReloading || saving) return;
    setContractsReloading(true);
    try {
      if (pendingContractSave) {
        setModalError("");
        await verifyContractSave(pendingContractSave);
        return;
      }
      const history = await load();
      if (history) setNotice("");
    } finally {
      setContractsReloading(false);
    }
  }
  return (
    <div style={s.employeeSettings}>
      {notice ? <p role="status" style={s.notice}>{notice}</p> : null}
      {pendingContractSave && !open ? (
        <div role="alert" style={s.error}>
          {vi ? "Chưa xác nhận được kết quả lưu hợp đồng lương. Vui lòng kiểm tra lại trước khi lưu tiếp." : "급여계약 저장 결과를 아직 확인하지 못했습니다. 다시 저장하기 전에 결과를 확인해주세요."}
          <button type="button" style={s.retryButton} disabled={contractsReloading || saving} onClick={() => void recheckContracts()}>{vi ? "Kiểm tra lại kết quả lưu" : "저장 결과 다시 확인"}</button>
        </div>
      ) : error ? (
        <div role="alert" style={s.error}>
          {error}
          {contractsLoadFailed ? <button type="button" style={s.retryButton} disabled={contractsReloading} onClick={() => void recheckContracts()}>{contractsReloading ? (vi ? "Đang tải" : "조회 중") : vi ? "Tải lại" : "다시 조회"}</button> : null}
        </div>
      ) : null}
      <section style={showIdentity ? s.employeeSummary : s.employeeSummaryPlain}>
        {showIdentity ? <div style={s.summaryHeader}>
          <div style={s.summaryIdentity}>
            <EmployeeNameWithLevel
              name={selected.name ?? selected.username}
              levelInfo={selected.levelInfo}
              lang={lang}
              showDisabledBadge
              nameStyle={s.summaryName}
            />
            {metaLabel ? <span style={s.sectionHelp}>{metaLabel}</span> : null}
          </div>
          {headerAction}
        </div> : null}
        <div style={s.summaryGrid}>
          <SummaryItem
            label={vi ? "Tổng lương hiện tại" : "현재 합산급여"}
            value={combined === null ? (vi ? "Chưa cài đặt hợp đồng lương" : "급여계약 미설정") : money(combined)}
            important
          />
          <SummaryItem
            label={vi ? "Bảo hiểm" : "보험"}
            value={
              directorManagedInsurance
                ? vi ? "Quản lý trong cài đặt chung" : "회사 공통 설정에서 관리"
                : selectedInsuranceError
                  ? vi ? "Không thể tải trạng thái bảo hiểm" : "보험 상태 조회 실패"
                  : selectedInsurance
                  ? selectedInsurance.isEnrolled ? (vi ? "Đang tham gia" : "가입") : (vi ? "Không tham gia" : "미가입")
                  : vi ? "Chưa cài đặt bảo hiểm · xử lý là không tham gia" : "보험 미설정 · 미가입 처리"
            }
          />
        </div>
        <EmployeeSettingsSummary
          lang={l}
          reference={summaryReference}
          contracts={summaryContracts}
          workSchedules={workSchedules}
          requiresFixedMonthly={selectedRequiresFixedMonthly}
          directorManagedInsurance={directorManagedInsurance}
          insurance={summaryInsurance}
          tax={summaryTax}
          meal={summaryMeal}
          bonus={summaryBonus}
          anchorPrefix={anchorPrefix}
        />
      </section>

      <section id={anchor("contract")} style={{ ...s.card, ...s.anchorTarget }}>
        <div style={s.head}>
          <div>
            <h2 style={s.cardTitle}>{vi ? "Hợp đồng lương" : "급여계약"}</h2>
            <p style={s.sectionHelp}>{vi ? "Điều kiện hợp đồng hiện đang áp dụng" : "현재 적용 중인 계약 조건"}</p>
          </div>
          <div style={s.contractActions}>
            {contracts[0]?.auditVersion ? <button type="button" style={s.secondary} onClick={openCorrectionForm}>
              {vi ? "Chỉnh sửa hợp đồng mới nhất" : "최신 계약 정정"}
            </button> : null}
            <button type="button" style={s.primary} onClick={openForm}>
              {vi ? "Đăng ký thay đổi" : "계약 변경 등록"}
            </button>
          </div>
        </div>
        {current ? (
          <ContractSummary contract={current} levelRaise={levelRaise} combined={combined ?? 0} lang={l} />
        ) : (
          <p style={s.emptyState}>{vi ? "Chưa cài đặt hợp đồng lương. Hãy đăng ký hợp đồng mới." : "급여계약이 설정되지 않았습니다. 새 계약을 등록해주세요."}</p>
        )}
        {levelAction ? <div style={s.levelRow}>
          <span>{selected.levelInfo.displayLabel ?? (vi ? "Không áp dụng cấp" : "레벨 미적용")} · {vi ? "Tăng theo cấp" : "레벨 인상"} {signedAmount(levelRaise, vi)}</span>
          {levelAction}
        </div> : null}
        <details style={s.details}>
          <summary>{vi ? `Lịch sử hợp đồng ${contracts.length} mục` : `계약 이력 ${contracts.length}건`}</summary>
          {contracts.map((contract, index) => <ContractCard key={contract.id} contract={contract} previous={contracts[index + 1] ?? null} vi={vi} />)}
        </details>
      </section>

      <div id={anchor("insurance")} style={s.anchorTarget}>
      {selected.username !== "mjk" ? (
        <EmployeeInsuranceSettings
          key={`insurance-${selected.id}`}
          userId={selected.id}
          vi={vi}
          onLoadStateChange={handleInsuranceLoadStateChange}
          onDirtyChange={cardDirtyReporters.insurance}
        />
      ) : (
        <aside style={s.directorNotice}>
          {vi
            ? "Bảo hiểm giám đốc pháp nhân được quản lý trong phần cài đặt bảo hiểm chung của công ty ở trên."
            : "법인장 보험은 위의 회사 공통 보험 설정에서 관리합니다."}
        </aside>
      )}

      </div>

      <div id={anchor("tax")} style={s.anchorTarget}>
        <EmployeeTaxSettings key={`tax-${selected.id}`} userId={selected.id} employeeName={selected.name ?? selected.username} vi={vi} onHistoryStateChange={setTaxHistoryState} onDirtyChange={cardDirtyReporters.tax} />
      </div>

      <div id={anchor("meal")} style={s.anchorTarget}>
        <EmployeeMealAllowanceSettings key={`meal-allowance-${selected.id}`} userId={selected.id} vi={vi} onHistoryStateChange={(state) => { setMealHistoryState(state); onMealHistoryChange?.(state); }} onDirtyChange={cardDirtyReporters.meal} />
      </div>
      <div id={anchor("bonus")} style={s.anchorTarget}>
        <EmployeeAttendanceBonusSettings key={`attendance-bonus-${selected.id}`} userId={selected.id} vi={vi} onHistoryStateChange={setBonusHistoryState} onDirtyChange={cardDirtyReporters.bonus} />
      </div>
      {open && (
        <PayrollModal
          placement="top"
          title={formMode === "correct" ? (vi ? "Chỉnh sửa hợp đồng lương mới nhất" : "최신 급여계약 정정") : (vi ? "Đăng ký hợp đồng lương" : "급여계약 등록")}
          closeLabel={vi ? "Đóng" : "닫기"}
          onClose={closeForm}
          footer={
            pendingContractSave ? (
              <button type="button" style={s.modalSave} disabled={contractsReloading || saving} onClick={() => void recheckContracts()}>
                {contractsReloading ? (vi ? "Đang kiểm tra" : "확인 중") : vi ? "Kiểm tra lại kết quả lưu" : "저장 결과 다시 확인"}
              </button>
            ) : (
            <button form={formId} style={s.modalSave} disabled={saving || (selectedRequiresWorkSchedule && automaticStandardMinutes === null)}>
              {saving ? (vi ? "Đang lưu" : "저장 중") : vi ? "Lưu" : "저장"}
            </button>
            )
          }
        >
          <form id={formId} style={s.form} onSubmit={submit}>
            <Field label={vi ? "Ngày áp dụng" : "적용 시작일"}>
              {formMode === "correct"
                ? <div style={s.readOnlyValue}>{form.effectiveFrom}</div>
                : <input
                    style={s.input}
                    type="date"
                    required
                    value={form.effectiveFrom}
                    onChange={(event) => setForm({ ...form, effectiveFrom: event.target.value })}
                  />}
            </Field>
            {modalError ? <p role="alert" style={s.error}>{modalError}</p> : null}
            <MoneyInputField
              label={salaryInputLabel(l, form.payType)}
              value={form.baseSalary}
              change={(value) => setForm({ ...form, baseSalary: value })}
            >
              {form.payType === "hourly" ? <small style={s.fieldHelp}>
                {vi
                  ? "Nhập mức lương cho 1 giờ. Ví dụ: nhập 30.000 đồng thì sẽ được tính là 30.000 đồng/giờ."
                  : "1시간 기준 급여를 입력합니다. 예: 30,000동 입력 시 시급 30,000동으로 계산됩니다."}
              </small> : null}
            </MoneyInputField>
            <MoneyInputField
              label={vi ? "Tổng mức tăng lương cố định" : "고정 급여인상 총액"}
              value={form.fixedRaiseAmount}
              change={(value) => setForm({ ...form, fixedRaiseAmount: value })}
              clearZeroOnFocus
            >
              <small style={s.fieldHelp}>{vi ? "Nhập tổng số tiền tăng cố định hiện áp dụng, không phải riêng mức thay đổi lần này." : "이번 변동액이 아닌 현재 적용할 누적 총액을 입력합니다."}</small>
            </MoneyInputField>
            <div style={s.changePreview}>
              <SummaryItem label={vi ? "Tổng hiện tại" : "현재 총액"} value={currencyAmount(currentFixedRaise, vi)} />
              <SummaryItem label={vi ? "Tổng sau thay đổi" : "변경 후 총액"} value={currencyAmount(nextFixedRaise, vi)} important />
            </div>
            {fixedRaiseChanged ? <Field label={vi ? "Lý do thay đổi mức tăng lương cố định" : "고정 급여인상 사유"}>
              <textarea style={s.input} required value={form.fixedRaiseReason} onChange={(event) => setForm({ ...form, fixedRaiseReason: event.target.value })} />
            </Field> : null}
            {formMode === "correct" ? <Field label={vi ? "Lý do chỉnh sửa hợp đồng" : "계약 정정 사유"}>
              <textarea style={s.input} required value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} />
            </Field> : null}
            <div style={s.level}>
              <b>{selected.levelInfo.displayLabel ?? (vi ? "Không áp dụng cấp" : "레벨 미적용")} · {vi ? "Tăng theo cấp" : "레벨 인상"} {signedAmount(levelRaise, vi)}</b>
            </div>
            {selectedRequiresFixedMonthly ? <>
              <ReadOnlyField label={vi ? "Loại lương" : "급여 형태"} value={payrollLabel(l, "monthly")} />
              <ReadOnlyField label={vi ? "Cách tính lương" : "급여 산정 방식"} value={payrollLabel(l, "fixed_monthly")} />
            </> : <><SelectField
              label={vi ? "Loại lương" : "급여 형태"}
              value={form.payType}
              options={["monthly", "daily", "hourly"]}
              lang={l}
              change={(value) =>
                setForm({
                  ...form,
                  payType: value,
                  fixedRaiseAmount:
                    value === "monthly" ? form.fixedRaiseAmount : "0",
                  calculationBasis: form.calculationBasis,
                })
              }
            />
            </>}
            {!selectedRequiresFixedMonthly && form.payType === "monthly" && (
              <NumberField
                label={vi ? "Ngày làm việc chuẩn" : "월 기준 근무일수"}
                value={form.standardWorkdays}
                change={(value) =>
                  setForm({ ...form, standardWorkdays: value })
                }
                step="0.01"
              />
            )}
            {selectedRequiresWorkSchedule ? (
              <ScheduleHistory current={currentSchedule} monthSchedules={effectiveMonthSchedules} month={form.effectiveFrom.slice(0, 7)} vi={vi} />
            ) : selectedIsOwner ? null : (
              <section style={s.scheduleBox}>
                <span style={s.fieldHelp}>
                  {vi ? "Không sử dụng chấm công · Lương cố định hàng tháng" : "근태 미사용 · 월 고정급"}
                </span>
              </section>
            )}
            {selectedRequiresWorkSchedule && automaticStandardMinutes === null ? (
              <p role="alert" style={s.error}>
                {payrollContractErrorMessage(l, effectiveSchedules.length > 1 ? "WORK_SCHEDULE_OVERLAP" : effectiveSchedule ? "INVALID_WORK_SCHEDULE" : "WORK_SCHEDULE_NOT_FOUND")}
              </p>
            ) : null}
          </form>
        </PayrollModal>
      )}
    </div>
  );
}
function ContractCard({ contract, previous, vi }: { contract: Contract; previous: Contract | null; vi: boolean }) {
  const before = previous?.fixedRaiseAmount ?? 0;
  const corrections = (contract.auditLogs ?? []).filter((audit) => audit.action === "corrected");
  const userLabel = (name: string | null | undefined, id: number | null | undefined) => name || `${vi ? "Người dùng" : "사용자"} #${id}`;
  return (
    <article style={s.contract}>
      <b>{vi ? `Lần thay đổi ${contract.revision}` : `변경번호 ${contract.revision}`}</b>
      <span>
        {salaryInputLabel(vi ? "vi" : "ko", contract.payType)} {money(contract.baseSalary)}
      </span>
      <span>
        {vi ? "Tổng mức tăng cố định" : "고정 인상 총액"} {currencyAmount(before, vi)} → {currencyAmount(contract.fixedRaiseAmount, vi)}
      </span>
      {contract.fixedRaiseAmount !== before && contract.note ? <span>{vi ? "Lý do" : "사유"}: {contract.note}</span> : null}
      <span>{vi ? "Ngày áp dụng" : "적용일"} {contract.effectiveFrom}</span>
      {contract.createdBy ? <small>{vi ? "Người đăng ký" : "등록 담당자"}: {userLabel(contract.createdByName, contract.createdBy)}</small> : null}
      {contract.createdAt ? <small>{vi ? "Thời gian đăng ký" : "등록 시각"}: {new Date(contract.createdAt).toLocaleString(vi ? "vi-VN" : "ko-KR")}</small> : null}
      {corrections.length ? <details style={s.auditDetails}>
        <summary>{vi ? `Lịch sử chỉnh sửa ${corrections.length} mục` : `정정 기록 ${corrections.length}건`}</summary>
        {corrections.map((audit) => <div key={audit.id} style={s.auditEntry}>
          <span>{vi ? "Người chỉnh sửa" : "정정 담당자"}: {userLabel(audit.actorName, audit.actorUserId)}</span>
          {audit.reason ? <span>{vi ? "Lý do chỉnh sửa" : "정정 사유"}: {audit.reason}</span> : null}
          <span>{vi ? "Thời gian chỉnh sửa" : "정정 시각"}: {new Date(audit.createdAt).toLocaleString(vi ? "vi-VN" : "ko-KR")}</span>
        </div>)}
      </details> : null}
    </article>
  );
}
function ScheduleHistory({ current, monthSchedules, month, vi }: { current: WorkScheduleVersion | null; monthSchedules: WorkScheduleVersion[]; month: string; vi: boolean }) {
  const scheduleValue = (schedule: WorkScheduleVersion) => {
    const minutes = scheduledMinutesPerDay(schedule.startTime, schedule.endTime, schedule.unpaidBreakMinutes);
    return `${schedule.startTime}~${schedule.endTime} · ${minutes === null ? "-" : minutes / 60}${vi ? " giờ" : "시간"}`;
  };
  const scheduleEnd = (effectiveTo: string | null) => {
    if (!effectiveTo) return vi ? "sau đó" : "이후";
    const end = new Date(`${effectiveTo}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() - 1);
    return end.toISOString().slice(0, 10);
  };
  return <section style={s.scheduleBox}>
    <b>{vi ? "Giờ làm việc hiện tại" : "현재 근무시간"}</b>
    <span>{current ? scheduleValue(current) : (vi ? "Không có lịch làm việc hiện tại" : "현재 근무시간 없음")}</span>
    {monthSchedules.length > 1 ? <>
      <b>{vi ? `Lịch sử giờ làm việc tháng ${month.slice(5, 7)}` : `${Number(month.slice(5, 7))}월 근무시간 이력`}</b>
      {monthSchedules.map((schedule) => <div key={schedule.id} style={s.scheduleRow}>
        <span>{schedule.effectiveFrom} ~ {scheduleEnd(schedule.effectiveTo)}</span>
        <span>{scheduleValue(schedule)}</span>
      </div>)}
    </> : null}
    <small style={s.fieldHelp}>{vi ? "Giờ làm việc theo từng ngày được tự động áp dụng khi tính lương." : "급여 계산에는 날짜별 근무시간이 자동 적용됩니다."}</small>
  </section>;
}
function SummaryItem({ label, value, important = false }: { label: string; value: string; important?: boolean }) {
  return (
    <div style={s.summaryItem}>
      <span>{label}</span>
      <b style={important ? s.summaryImportant : s.summaryValue}>{value}</b>
    </div>
  );
}
function ContractSummary({
  contract,
  levelRaise,
  combined,
  lang,
}: {
  contract: Contract;
  levelRaise: number;
  combined: number;
  lang: PayrollUiLang;
}) {
  const vi = lang === "vi";
  return (
    <div style={s.contractSummary}>
      <SummaryItem label={salaryInputLabel(lang, contract.payType)} value={money(contract.baseSalary)} />
      <SummaryItem label={vi ? "Mức tăng cố định" : "고정 급여인상"} value={`+${money(contract.fixedRaiseAmount)}`} />
      <SummaryItem label={vi ? "Mức tăng theo cấp" : "레벨 인상"} value={`+${money(levelRaise)}`} />
      <SummaryItem label={vi ? "Tổng lương" : "합산급여"} value={money(combined)} important />
      <SummaryItem label={vi ? "Loại lương" : "급여 형태"} value={payrollLabel(lang, contract.payType)} />
      <SummaryItem label={vi ? "Ngày áp dụng" : "적용 시작일"} value={contract.effectiveFrom} />
    </div>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={s.field}>
      <b>{label}</b>
      {children}
    </label>
  );
}
function NumberField({
  label,
  value,
  change,
  step = "1",
}: {
  label: string;
  value: string;
  change: (value: string) => void;
  step?: string;
}) {
  return (
    <Field label={label}>
      <input
        style={s.input}
        required
        type="number"
        min="0"
        step={step}
        value={value}
        onChange={(e) => change(e.target.value)}
      />
    </Field>
  );
}
function MoneyInputField({
  label,
  value,
  change,
  clearZeroOnFocus = false,
  children,
}: {
  label: string;
  value: string;
  change: (value: string) => void;
  clearZeroOnFocus?: boolean;
  children?: ReactNode;
}) {
  return (
    <Field label={label}>
      <input
        style={s.input}
        required
        type="text"
        inputMode="numeric"
        value={formatIntegerInput(value)}
        onFocus={() => { if (clearZeroOnFocus && value === "0") change(""); }}
        onBlur={() => { if (clearZeroOnFocus && value === "") change("0"); }}
        onChange={(event) => change(integerInputDigits(event.target.value))}
      />
      {children}
    </Field>
  );
}
function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return <Field label={label}><div style={s.readOnlyValue}>{value}</div></Field>;
}
function SelectField({
  label,
  value,
  options,
  lang,
  change,
}: {
  label: string;
  value: string;
  options: string[];
  lang: PayrollUiLang;
  change: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <select
        style={s.input}
        value={value}
        onChange={(e) => change(e.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {payrollLabel(lang, option)}
          </option>
        ))}
      </select>
    </Field>
  );
}
const s = {
  cardTitle: { margin: 0, fontSize: 15, fontWeight: 900 },
  sectionHelp: { margin: "3px 0 0", color: "#6b7280", fontSize: 12, lineHeight: 1.4 },
  card: {
    padding: 13,
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    background: "#fff",
    display: "grid",
    gap: 9,
    minWidth: 0,
  },
  error: { margin: 0, padding: "8px 9px", borderRadius: 9, background: "#fef2f2", color: "#b91c1c", fontSize: 12 },
  anchorTarget: { scrollMarginTop: 72, minWidth: 0 },
  notice: { margin: 0, padding: "8px 9px", borderRadius: 9, background: "#f0fdf4", color: "#166534", fontSize: 12 },
  retryButton: { display: "block", minHeight: 30, marginTop: 6, padding: "4px 10px", border: "1px solid #fca5a5", borderRadius: 8, background: "#fff", color: "#b91c1c", fontSize: 12, fontWeight: 800 },
  emptyState: { margin: 0, padding: "10px 11px", border: "1px dashed #d1d5db", borderRadius: 10, color: "#6b7280", fontSize: 12, textAlign: "center" },
  input: {
    width: "100%",
    minHeight: 40,
    padding: "8px 9px",
    border: "1px solid #d1d5db",
    borderRadius: 10,
  },
  readOnlyValue: { minHeight: 40, padding: "9px 10px", border: "1px solid #e5e7eb", borderRadius: 10, background: "#f9fafb", color: "#374151", fontSize: 13, fontWeight: 700 },
  head: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
    flexWrap: "wrap",
  },
  primary: {
    minHeight: 36,
    padding: "7px 10px",
    border: 0,
    borderRadius: 9,
    background: "#111827",
    color: "#fff",
    fontSize: 13,
    fontWeight: 800,
  },
  secondary: { minHeight: 36, padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff", color: "#374151", fontSize: 13, fontWeight: 800 },
  contractActions: { display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" },
  modalSave: { width: "100%", minHeight: 42, padding: "8px 12px", border: 0, borderRadius: 9, background: "#111827", color: "#fff", fontSize: 14, fontWeight: 800 },
  contract: {
    display: "grid",
    gap: 4,
    padding: "8px 9px",
    margin: "5px 0",
    border: "1px solid #e5e7eb",
    borderRadius: 9,
    fontSize: 12,
  },
  auditDetails: { marginTop: 4, paddingTop: 5, borderTop: "1px solid #e5e7eb" },
  auditEntry: { display: "grid", gap: 2, padding: "6px 8px", marginTop: 4, borderRadius: 8, background: "#f9fafb", overflowWrap: "anywhere" },
  scheduleBox: { display: "grid", gap: 5, padding: "9px 10px", border: "1px solid #e5e7eb", borderRadius: 10, background: "#f9fafb", fontSize: 12, minWidth: 0, overflowWrap: "anywhere" },
  scheduleRow: { display: "grid", gap: 2, padding: "6px 8px", borderRadius: 8, background: "#fff" },
  employeeSettings: { display: "grid", gap: 9, minWidth: 0, scrollMarginTop: 72 },
  employeeSummary: { display: "grid", gap: 8, padding: 12, border: "1px solid #bfdbfe", borderRadius: 14, background: "#f8fbff", minWidth: 0 },
  employeeSummaryPlain: { display: "grid", gap: 8, minWidth: 0 },
  summaryHeader: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, flexWrap: "wrap", minWidth: 0 },
  summaryIdentity: { display: "grid", gap: 3, minWidth: 0 },
  summaryName: { fontSize: 16, fontWeight: 900, minWidth: 0, overflowWrap: "anywhere" },
  summaryGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))", gap: 6 },
  summaryItem: { display: "grid", gap: 2, minWidth: 0, padding: "7px 8px", borderRadius: 8, background: "rgba(255,255,255,.72)", fontSize: 11, overflowWrap: "anywhere" },
  summaryValue: { fontSize: 12, fontWeight: 700 },
  summaryImportant: { fontSize: 13, fontWeight: 900 },
  contractSummary: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 6 },
  levelRow: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6, padding: "7px 9px", borderRadius: 9, background: "#eff6ff", fontSize: 12, fontWeight: 700, overflowWrap: "anywhere" },
  details: { paddingTop: 8, borderTop: "1px solid #e5e7eb", fontSize: 12 },
  directorNotice: { padding: 11, border: "1px solid #e5e7eb", borderRadius: 12, background: "#f9fafb", color: "#4b5563", fontSize: 12, lineHeight: 1.45 },
  form: { display: "grid", gap: 8 },
  field: { display: "grid", gap: 5, fontSize: 13 },
  fieldHelp: { color: "#6b7280", fontSize: 12, lineHeight: 1.4 },
  changePreview: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6, padding: 8, borderRadius: 10, background: "#f8fafc" },
  level: {
    display: "block",
    padding: "8px 10px",
    borderRadius: 10,
    background: "#eff6ff",
    fontSize: 12,
  },
} satisfies Record<string, CSSProperties>;
