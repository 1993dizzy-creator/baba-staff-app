"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import EmployeeNameWithLevel from "@/components/employee/EmployeeNameWithLevel";
import PayrollCommonSettings from "@/components/payroll/PayrollCommonSettings";
import EmployeeInsuranceSettings from "@/components/payroll/EmployeeInsuranceSettings";
import PayrollModal from "@/components/payroll/PayrollModal";
import { useLanguage } from "@/lib/language-context";
import {
  money,
  partLabel,
  payrollLabel,
  type PayrollUiLang,
} from "@/lib/payroll/ui-labels";
import type { EmployeeLevelInfo } from "@/lib/employee-level/types";
import { attendanceText } from "@/lib/text";
import { vietnamCurrentMonthStart } from "@/lib/payroll/ui-dates";
import { currencyAmount, formatIntegerInput, integerInputDigits, isMonthFirstDate, minutesToHoursInput, signedAmount } from "@/lib/payroll/contract-form";
import { comparePayrollEmployees } from "@/lib/payroll/employee-sort";
import { ui } from "@/lib/styles/ui";
import { payrollContractErrorMessage } from "@/lib/payroll/contract-errors";
import type { WorkScheduleVersion } from "@/lib/payroll/types";
import { scheduledMinutesPerDay, schedulesActiveOn } from "@/lib/payroll/work-schedule";
type User = {
  id: number;
  name: string | null;
  username: string;
  part: string | null;
  position: string | null;
  levelInfo: EmployeeLevelInfo;
};
type InsuranceCurrent = {
  isEnrolled: boolean;
  insuranceBaseAmount: number;
  effectiveMonth: string;
  revision: number;
};
type Contract = {
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
  auditLogs?: ContractAuditLog[];
};
type ContractAuditLog = { id: number; action: string; actorUserId: number; actorName: string | null; reason: string | null; createdAt: string };
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
export default function PayrollSettingsPage() {
  const { lang } = useLanguage();
  const l = lang as PayrollUiLang;
  const vi = lang === "vi";
  const attendance = attendanceText[lang];
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const tabParam = params.get("tab");
  const requestedUserIdParam = params.get("userId");
  const activeTab: "common" | "employee" =
    tabParam === "common" || tabParam === "employee"
      ? tabParam
      : params.has("userId")
        ? "employee"
        : "common";
  const [users, setUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState("");
  const [employeeListOpen, setEmployeeListOpen] = useState(true);
  const [scrollRequestVersion, setScrollRequestVersion] = useState(0);
  const [userId, setUserId] = useState<number | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [currentContract, setCurrentContract] = useState<Contract | null>(null);
  const [workSchedules, setWorkSchedules] = useState<WorkScheduleVersion[]>([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<FormState>(defaults);
  const [open, setOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "correct">("create");
  const [correctionTarget, setCorrectionTarget] = useState<Contract | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [error, setError] = useState("");
  const [modalError, setModalError] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedInsurance, setSelectedInsurance] =
    useState<InsuranceCurrent | null>(null);
  const [selectedInsuranceError, setSelectedInsuranceError] = useState(false);
  const [selectedInsuranceLoading, setSelectedInsuranceLoading] = useState(false);
  const employeeSettingsRef = useRef<HTMLDivElement>(null);
  const pendingScrollUserIdRef = useRef<number | null>(null);
  const load = useCallback(
    async (id: number, signal?: AbortSignal) => {
      try {
        const response = await fetch(
          `/api/admin/payroll/contracts?userId=${id}`,
          { cache: "no-store", signal },
        );
        if (signal?.aborted) return;
        const data = await response.json();
        if (signal?.aborted) return;
        if (response.ok) {
          setContracts(data.history ?? []);
          setCurrentContract(data.current ?? null);
          setWorkSchedules(data.workSchedules ?? []);
        }
        else
          setError(
            vi
              ? "Không thể tải hợp đồng lương."
              : "급여계약을 불러오지 못했습니다.",
          );
      } catch (loadError: unknown) {
        if (
          signal?.aborted ||
          (loadError instanceof Error && loadError.name === "AbortError")
        ) return;
        setError(
          vi
            ? "Không thể tải hợp đồng lương."
            : "급여계약을 불러오지 못했습니다.",
        );
      }
    },
    [vi],
  );
  function changeTab(tab: "common" | "employee") {
    const next = new URLSearchParams(params.toString());
    next.set("tab", tab);
    router.replace(`${pathname}?${next}`, { scroll: false });
  }
  function selectUser(id: number) {
    pendingScrollUserIdRef.current = id;
    setScrollRequestVersion((version) => version + 1);
    setEmployeeListOpen(false);
    setUserId(id);
    const next = new URLSearchParams(params.toString());
    next.set("tab", "employee");
    next.set("userId", String(id));
    router.replace(`${pathname}?${next}`, { scroll: false });
  }
  useEffect(() => {
    if (activeTab !== "employee") return;
    setUsersLoading(true);
    setUsersError("");
    void fetch("/api/admin/payroll/users", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        setUsers((data.users ?? []).sort(comparePayrollEmployees));
      })
      .catch(() =>
        setUsersError(
          vi
            ? "Không thể tải danh sách nhân viên."
            : "직원 목록을 불러오지 못했습니다.",
        ),
      )
      .finally(() => setUsersLoading(false));
  }, [activeTab, vi]);
  useEffect(() => {
    if (activeTab !== "employee" || usersLoading) return;
    const requested = Number(requestedUserIdParam);
    setUserId(Number.isSafeInteger(requested) && users.some((user) => user.id === requested) ? requested : null);
  }, [activeTab, requestedUserIdParam, users, usersLoading]);
  useEffect(() => {
    if (activeTab !== "employee" || !userId) {
      setContracts([]);
      setCurrentContract(null);
      return;
    }
    const controller = new AbortController();
    setContractsLoading(true);
    setContracts([]);
    setCurrentContract(null);
    setError("");
    void load(userId, controller.signal).finally(() => {
      if (!controller.signal.aborted) setContractsLoading(false);
    });
    return () => controller.abort();
  }, [activeTab, userId, load]);
  useEffect(() => {
    if (activeTab !== "employee" || !userId) {
      setSelectedInsurance(null);
      setSelectedInsuranceError(false);
      setSelectedInsuranceLoading(false);
      return;
    }
    const controller = new AbortController();
    setSelectedInsurance(null);
    setSelectedInsuranceError(false);
    setSelectedInsuranceLoading(true);
    void (async () => {
      try {
        const response = await fetch(`/api/admin/payroll/insurance?userId=${userId}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const data = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setSelectedInsuranceError(true);
          return;
        }
        setSelectedInsurance(data.current ?? null);
      } catch (insuranceError: unknown) {
        if (
          controller.signal.aborted ||
          (insuranceError instanceof Error && insuranceError.name === "AbortError")
        ) return;
        setSelectedInsuranceError(true);
      }
    })().catch(() => undefined).finally(() => {
      if (!controller.signal.aborted) setSelectedInsuranceLoading(false);
    });
    return () => controller.abort();
  }, [activeTab, userId]);
  const positionLabel = useCallback(
    (user: User) =>
      user.position
        ? (attendance.positions[
            user.position as keyof typeof attendance.positions
          ] ?? user.position)
        : user.username,
    [attendance],
  );
  const employeeMetaLabel = useCallback((user: User) => {
    const displayedPart = user.part ? partLabel(l, user.part) : "";
    const displayedPosition = user.position ? positionLabel(user) : "";
    const values = [displayedPart, displayedPosition].filter((value, index, all) => value && all.indexOf(value) === index);
    return values.join(" · ") || user.username;
  }, [l, positionLabel]);
  const visible = useMemo(
    () =>
      users.filter((user) =>
        `${user.name ?? ""} ${user.username} ${user.part ?? ""} ${user.position ?? ""} ${employeeMetaLabel(user)}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ).sort(comparePayrollEmployees),
    [employeeMetaLabel, query, users],
  );
  const selected = users.find((user) => user.id === userId);
  const selectedId = selected?.id ?? null;
  const selectedIsOwner = selected?.position?.toLowerCase() === "owner";
  const effectiveSchedules = schedulesActiveOn(workSchedules, form.effectiveFrom);
  const effectiveSchedule = effectiveSchedules.length === 1 ? effectiveSchedules[0] : null;
  const automaticStandardMinutes = effectiveSchedule ? scheduledMinutesPerDay(effectiveSchedule.startTime, effectiveSchedule.endTime, effectiveSchedule.unpaidBreakMinutes) : null;
  const vietnamToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const currentScheduleMatches = schedulesActiveOn(workSchedules, vietnamToday);
  const currentSchedule = currentScheduleMatches.length === 1 ? currentScheduleMatches[0] : null;
  const effectiveMonthStart = `${form.effectiveFrom.slice(0, 7)}-01`;
  const nextMonth = new Date(`${effectiveMonthStart}T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const effectiveMonthEndExclusive = nextMonth.toISOString().slice(0, 10);
  const effectiveMonthSchedules = workSchedules
    .filter((schedule) => (!schedule.effectiveTo || schedule.effectiveTo > schedule.effectiveFrom) && schedule.effectiveFrom < effectiveMonthEndExclusive && (!schedule.effectiveTo || schedule.effectiveTo > effectiveMonthStart))
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  useEffect(() => {
    if (!selectedId || employeeListOpen || contractsLoading || selectedInsuranceLoading || pendingScrollUserIdRef.current !== selectedId) return;
    const frame = requestAnimationFrame(() => {
      if (pendingScrollUserIdRef.current !== selectedId) return;
      requestAnimationFrame(() => {
        if (pendingScrollUserIdRef.current !== selectedId) return;
        employeeSettingsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        pendingScrollUserIdRef.current = null;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [contractsLoading, employeeListOpen, scrollRequestVersion, selectedId, selectedInsuranceLoading]);
  const current = currentContract;
  const levelRaise = selected?.levelInfo.eligible
    ? selected.levelInfo.earnedRaiseCount *
      selected.levelInfo.raiseAmountPerStep
    : 0;
  const combined = current
    ? current.baseSalary + current.fixedRaiseAmount + levelRaise
    : null;
  const currentFixedRaise = (formMode === "correct" ? correctionTarget : current)?.fixedRaiseAmount ?? 0;
  const nextFixedRaise = Number(form.fixedRaiseAmount || 0);
  const fixedRaiseChanged = nextFixedRaise !== currentFixedRaise;
  function openForm() {
    const next = fromContract(current);
    setForm(selectedIsOwner ? { ...next, payType: "monthly", calculationBasis: "fixed_monthly", standardWorkdays: "26", standardHoursPerDay: "9" } : next);
    setFormMode("create");
    setCorrectionTarget(null);
    setCorrectionReason("");
    setError("");
    setModalError("");
    setOpen(true);
  }
  function openCorrectionForm() {
    const latest = contracts[0] ?? null;
    if (!latest) return;
    const next = { ...fromContract(latest), effectiveFrom: latest.effectiveFrom };
    setForm(selectedIsOwner ? { ...next, payType: "monthly", calculationBasis: "fixed_monthly", standardWorkdays: "26", standardHoursPerDay: "9" } : next);
    setFormMode("correct");
    setCorrectionTarget(latest);
    setCorrectionReason("");
    setError("");
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
    const standardMinutesPerDay = selectedIsOwner ? 540 : automaticStandardMinutes;
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
    setSaving(true);
    try {
      const correcting = formMode === "correct" ? correctionTarget : null;
      const response = await fetch(correcting ? "/api/admin/payroll/contracts/correct" : "/api/admin/payroll/contracts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          calculationBasis: selectedIsOwner ? "fixed_monthly" : "minute",
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
          standardWorkdays: selectedIsOwner ? 26 : form.payType === "monthly" ? Number(form.standardWorkdays) : null,
          standardMinutesPerDay,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setModalError(payrollContractErrorMessage(l, data.code, formMode === "correct" ? "PAYROLL_CONTRACT_CORRECTION_FAILED" : "PAYROLL_CONTRACT_CREATE_FAILED"));
        return;
      }
      await load(userId);
      setOpen(false);
    } catch {
      setModalError(payrollContractErrorMessage(l, formMode === "correct" ? "PAYROLL_CONTRACT_CORRECTION_FAILED" : "PAYROLL_CONTRACT_CREATE_FAILED"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Container noPaddingTop>
      <main style={s.page}>
        <div
          role="tablist"
          aria-label={vi ? "Loại cài đặt lương" : "급여설정 유형"}
          style={s.tabs}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "common"}
            onClick={() => changeTab("common")}
            style={tabStyle(activeTab === "common")}
          >
            {vi ? "Cài đặt chung" : "공통 설정"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "employee"}
            onClick={() => changeTab("employee")}
            style={tabStyle(activeTab === "employee")}
          >
            {vi ? "Cài đặt nhân viên" : "직원 설정"}
          </button>
        </div>

        {activeTab === "common" ? (
          <PayrollCommonSettings vi={vi} />
        ) : (
          <section style={s.section}>
          <section style={s.card}>
            <div style={s.listHeader}>
              <b style={s.listTitle}>
                {vi ? `Danh sách nhân viên ${users.length} người` : `직원 목록 ${users.length}명`}
                {!employeeListOpen && selected ? <span style={s.selectedSummary}> · {vi ? "Đã chọn" : "선택"}: {selected.name ?? selected.username} · {employeeMetaLabel(selected)}</span> : null}
              </b>
              <button
                type="button"
                style={s.listToggle}
                aria-expanded={employeeListOpen}
                aria-controls="payroll-employee-list"
                onClick={() => setEmployeeListOpen((value) => !value)}
              >
                {employeeListOpen ? (vi ? "Thu gọn ▲" : "접기 ▲") : (vi ? "Mở rộng ▼" : "펼치기 ▼")}
              </button>
            </div>
            {employeeListOpen ? <div id="payroll-employee-list" style={s.listBody}>
              <input
                style={s.input}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={vi ? "Tìm nhân viên" : "직원 검색"}
                aria-label={vi ? "Tìm nhân viên" : "직원 검색"}
              />
              {usersError ? (
              <p role="alert" style={s.error}>{usersError}</p>
            ) : usersLoading ? (
              <p style={s.emptyState}>{vi ? "Đang tải danh sách nhân viên…" : "직원 목록을 불러오는 중입니다…"}</p>
            ) : visible.length === 0 ? (
              <p style={s.emptyState}>{vi ? "Không có nhân viên cần cài đặt lương." : "급여 설정 대상 직원이 없습니다."}</p>
            ) : (
              <div style={s.people}>
                {visible.map((user) => {
                  const selectedUser = user.id === userId;
                  return (
                    <button
                      key={user.id}
                      type="button"
                      style={selectedUser ? { ...s.person, ...s.personSelected } : s.person}
                      aria-pressed={selectedUser}
                      onClick={() => selectUser(user.id)}
                    >
                      <span style={s.personIdentity}>
                        <EmployeeNameWithLevel
                          name={user.name ?? user.username}
                          levelInfo={user.levelInfo}
                          lang={lang}
                          showDisabledBadge
                          nameStyle={s.personName}
                        />
                        <small style={s.personMeta}>{employeeMetaLabel(user)}</small>
                      </span>
                      <span style={selectedUser ? s.selectedLabel : s.selectMark}>
                        {selectedUser ? (vi ? "Đã chọn" : "선택됨") : "›"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}</div> : null}
          </section>

          {error ? <p role="alert" style={s.error}>{error}</p> : null}
          {!selected ? (
            <p style={s.emptyState}>
              {vi
                ? "Chọn nhân viên để xem cài đặt lương."
                : "직원을 선택하면 급여 설정을 확인할 수 있습니다."}
            </p>
          ) : (
            <div ref={employeeSettingsRef} style={s.employeeSettings}>
              <section style={s.employeeSummary}>
                <div style={s.summaryIdentity}>
                  <EmployeeNameWithLevel
                    name={selected.name ?? selected.username}
                    levelInfo={selected.levelInfo}
                    lang={lang}
                    showDisabledBadge
                    nameStyle={s.summaryName}
                  />
                  <span style={s.sectionHelp}>{employeeMetaLabel(selected)}</span>
                </div>
                <div style={s.summaryGrid}>
                  <SummaryItem
                    label={vi ? "Tổng lương hiện tại" : "현재 합산급여"}
                    value={combined === null ? (vi ? "Chưa cài đặt hợp đồng lương" : "급여계약 미설정") : money(combined)}
                    important
                  />
                  <SummaryItem
                    label={vi ? "Bảo hiểm" : "보험"}
                    value={
                      selected.username === "mjk"
                        ? vi ? "Quản lý trong cài đặt chung" : "회사 공통 설정에서 관리"
                        : selectedInsuranceError
                          ? vi ? "Không thể tải trạng thái bảo hiểm" : "보험 상태 조회 실패"
                          : selectedInsurance
                          ? selectedInsurance.isEnrolled ? (vi ? "Đang tham gia" : "가입") : (vi ? "Không tham gia" : "미가입")
                          : vi ? "Chưa cài đặt bảo hiểm · xử lý là không tham gia" : "보험 미설정 · 미가입 처리"
                    }
                  />
                </div>
              </section>

              <section style={s.card}>
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
                <details style={s.details}>
                  <summary>{vi ? `Lịch sử hợp đồng ${contracts.length} mục` : `계약 이력 ${contracts.length}건`}</summary>
                  {contracts.map((contract, index) => <ContractCard key={contract.id} contract={contract} previous={contracts[index + 1] ?? null} vi={vi} />)}
                </details>
              </section>

              {selected.username !== "mjk" ? (
                <EmployeeInsuranceSettings key={`insurance-${selected.id}`} userId={selected.id} vi={vi} />
              ) : (
                <aside style={s.directorNotice}>
                  {vi
                    ? "Bảo hiểm giám đốc pháp nhân được quản lý trong phần cài đặt bảo hiểm chung của công ty ở trên."
                    : "법인장 보험은 위의 회사 공통 보험 설정에서 관리합니다."}
                </aside>
              )}
            </div>
          )}
          </section>
        )}
        {open && selected && (
          <PayrollModal
            placement="top"
            title={formMode === "correct" ? (vi ? "Chỉnh sửa hợp đồng lương mới nhất" : "최신 급여계약 정정") : (vi ? "Đăng ký hợp đồng lương" : "급여계약 등록")}
            closeLabel={vi ? "Đóng" : "닫기"}
            onClose={closeForm}
            footer={
              <button form="contract" style={s.modalSave} disabled={saving || (!selectedIsOwner && automaticStandardMinutes === null)}>
                {saving ? (vi ? "Đang lưu" : "저장 중") : vi ? "Lưu" : "저장"}
              </button>
            }
          >
            <form id="contract" style={s.form} onSubmit={submit}>
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
              {selectedIsOwner ? <>
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
              {!selectedIsOwner && form.payType === "monthly" && (
                <NumberField
                  label={vi ? "Ngày làm việc chuẩn" : "월 기준 근무일수"}
                  value={form.standardWorkdays}
                  change={(value) =>
                    setForm({ ...form, standardWorkdays: value })
                  }
                  step="0.01"
                />
              )}
              {!selectedIsOwner ? <ScheduleHistory current={currentSchedule} monthSchedules={effectiveMonthSchedules} month={form.effectiveFrom.slice(0, 7)} vi={vi} /> : null}
            </form>
          </PayrollModal>
        )}
      </main>
    </Container>
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
  page: { display: "grid", gap: 8, padding: "8px 0 30px", minWidth: 0 },
  tabs: { ...ui.card, padding: 4, marginBottom: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 },
  section: { display: "grid", gap: 9, minWidth: 0 },
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
  emptyState: { margin: 0, padding: "10px 11px", border: "1px dashed #d1d5db", borderRadius: 10, color: "#6b7280", fontSize: 12, textAlign: "center" },
  input: {
    width: "100%",
    minHeight: 40,
    padding: "8px 9px",
    border: "1px solid #d1d5db",
    borderRadius: 10,
  },
  readOnlyValue: { minHeight: 40, padding: "9px 10px", border: "1px solid #e5e7eb", borderRadius: 10, background: "#f9fafb", color: "#374151", fontSize: 13, fontWeight: 700 },
  people: {
    display: "grid",
    gap: 6,
    maxHeight: 360,
    overflowY: "auto",
    overflowX: "hidden",
  },
  listHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minWidth: 0 },
  listTitle: { minWidth: 0, fontSize: 13, overflowWrap: "anywhere" },
  selectedSummary: { color: "#4b5563", fontWeight: 600 },
  listToggle: { flexShrink: 0, minHeight: 34, padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 8, background: "#fff", color: "#374151", fontSize: 12, fontWeight: 800 },
  listBody: { display: "grid", gap: 9, minWidth: 0 },
  person: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    minHeight: 52,
    padding: "9px 10px",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    background: "#fff",
    textAlign: "left",
    alignItems: "center",
    minWidth: 0,
    color: "#111827",
  },
  personSelected: { border: "1px solid #2563eb", background: "#eff6ff" },
  personIdentity: { display: "grid", gap: 3, minWidth: 0 },
  personName: { fontSize: 13, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 },
  personMeta: { color: "#6b7280", fontSize: 12, whiteSpace: "normal", overflowWrap: "anywhere" },
  selectedLabel: { flexShrink: 0, color: "#1d4ed8", fontSize: 12, fontWeight: 900 },
  selectMark: { flexShrink: 0, color: "#9ca3af", fontSize: 20 },
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
  summaryIdentity: { display: "grid", gap: 3, minWidth: 0 },
  summaryName: { fontSize: 16, fontWeight: 900, minWidth: 0, overflowWrap: "anywhere" },
  summaryGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))", gap: 6 },
  summaryItem: { display: "grid", gap: 2, minWidth: 0, padding: "7px 8px", borderRadius: 8, background: "rgba(255,255,255,.72)", fontSize: 11, overflowWrap: "anywhere" },
  summaryValue: { fontSize: 12, fontWeight: 700 },
  summaryImportant: { fontSize: 13, fontWeight: 900 },
  contractSummary: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 6 },
  details: { paddingTop: 8, borderTop: "1px solid #e5e7eb", fontSize: 12 },
  directorNotice: { padding: 11, border: "1px solid #e5e7eb", borderRadius: 12, background: "#f9fafb", color: "#4b5563", fontSize: 12, lineHeight: 1.45 },
  form: { display: "grid", gap: 8 },
  field: { display: "grid", gap: 5, fontSize: 13 },
  fieldHelp: { color: "#6b7280", fontSize: 12, lineHeight: 1.4 },
  hoursRow: { display: "grid", gridTemplateColumns: "minmax(80px, 50%) auto minmax(0, 1fr)", alignItems: "center", gap: 7, fontSize: 13 },
  hoursInput: { width: "100%", minWidth: 0, height: 40, boxSizing: "border-box", padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff", color: "#111827", fontSize: 14 },
  minutesPreview: { color: "#6b7280", fontSize: 12, whiteSpace: "nowrap" },
  changePreview: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6, padding: 8, borderRadius: 10, background: "#f8fafc" },
  level: {
    display: "block",
    padding: "8px 10px",
    borderRadius: 10,
    background: "#eff6ff",
    fontSize: 12,
  },
} satisfies Record<string, CSSProperties>;

function tabStyle(active: boolean): CSSProperties {
  return {
    minHeight: 36,
    border: active ? "1px solid #93c5fd" : "1px solid transparent",
    borderRadius: 8,
    background: active ? "#eff6ff" : "transparent",
    color: active ? "#1d4ed8" : "#6b7280",
    fontSize: 13,
    fontWeight: 900,
    cursor: "pointer",
  };
}
