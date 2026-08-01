"use client";
/* eslint-disable react-hooks/set-state-in-effect */
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
  payrollLabel,
  type PayrollUiLang,
} from "@/lib/payroll/ui-labels";
import type { EmployeeLevelInfo } from "@/lib/employee-level/types";
import { attendanceText } from "@/lib/text";
import { vietnamCurrentMonthStart } from "@/lib/payroll/ui-dates";
import { currencyAmount, formatIntegerInput, hoursInputToMinutes, integerInputDigits, minutesToHoursInput, signedAmount } from "@/lib/payroll/contract-form";
import { ui } from "@/lib/styles/ui";
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
  createdBy?: number | null;
  createdAt?: string | null;
  note?: string | null;
};
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
  calculationBasis: "day",
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
        calculationBasis: contract.calculationBasis === "day" && contract.payType !== "hourly" ? "day" : "minute",
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
export default function PayrollSettingsPage() {
  const { lang } = useLanguage();
  const l = lang as PayrollUiLang;
  const vi = lang === "vi";
  const attendance = attendanceText[lang];
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const tabParam = params.get("tab");
  const activeTab: "common" | "employee" =
    tabParam === "common" || tabParam === "employee"
      ? tabParam
      : params.has("userId")
        ? "employee"
        : "common";
  const [users, setUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState("");
  const [userId, setUserId] = useState<number | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [currentContract, setCurrentContract] = useState<Contract | null>(null);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<FormState>(defaults);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedInsurance, setSelectedInsurance] =
    useState<InsuranceCurrent | null>(null);
  const [selectedInsuranceError, setSelectedInsuranceError] = useState(false);
  const employeeSettingsRef = useRef<HTMLDivElement>(null);
  const clickedUserIdRef = useRef<number | null>(null);
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
    clickedUserIdRef.current = id;
    setUserId(id);
    const next = new URLSearchParams(params.toString());
    next.set("tab", "employee");
    next.set("userId", String(id));
    router.replace(`${pathname}?${next}`, { scroll: false });
    if (id === userId && !contractsLoading) {
      requestAnimationFrame(() => employeeSettingsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }
  useEffect(() => {
    if (activeTab !== "employee") return;
    setUsersLoading(true);
    setUsersError("");
    void fetch("/api/admin/payroll/users", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        setUsers(data.users ?? []);
        const requested = Number(params.get("userId"));
        if (Number.isSafeInteger(requested)) setUserId(requested);
      })
      .catch(() =>
        setUsersError(
          vi
            ? "Không thể tải danh sách nhân viên."
            : "직원 목록을 불러오지 못했습니다.",
        ),
      )
      .finally(() => setUsersLoading(false));
  }, [activeTab, params, vi]);
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
      return;
    }
    const controller = new AbortController();
    setSelectedInsurance(null);
    setSelectedInsuranceError(false);
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
    })().catch(() => undefined);
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
  const visible = useMemo(
    () =>
      users.filter((user) =>
        `${user.name ?? ""} ${user.username} ${user.part ?? ""} ${user.position ?? ""} ${positionLabel(user)}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [positionLabel, query, users],
  );
  const selected = users.find((user) => user.id === userId);
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (!selectedId || contractsLoading || clickedUserIdRef.current !== selectedId) return;
    const frame = requestAnimationFrame(() => {
      if (clickedUserIdRef.current !== selectedId) return;
      employeeSettingsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      clickedUserIdRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [contractsLoading, selectedId]);
  const current = currentContract;
  const levelRaise = selected?.levelInfo.eligible
    ? selected.levelInfo.earnedRaiseCount *
      selected.levelInfo.raiseAmountPerStep
    : 0;
  const combined = current
    ? current.baseSalary + current.fixedRaiseAmount + levelRaise
    : null;
  const currentFixedRaise = current?.fixedRaiseAmount ?? 0;
  const nextFixedRaise = Number(form.fixedRaiseAmount || 0);
  const fixedRaiseChanged = nextFixedRaise !== currentFixedRaise;
  const standardMinutesPreview = hoursInputToMinutes(form.standardHoursPerDay);
  function openForm() {
    setForm(fromContract(current));
    setError("");
    setOpen(true);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!userId) return;
    const standardMinutesPerDay = hoursInputToMinutes(form.standardHoursPerDay);
    if (standardMinutesPerDay === null) {
      setError(vi ? "Giờ làm việc chuẩn phải lớn hơn 0, không quá 24 giờ và quy đổi thành số phút nguyên." : "하루 기준 근무시간은 0시간 초과 24시간 이하이며 정수 분으로 환산되어야 합니다.");
      return;
    }
    if (fixedRaiseChanged && !form.fixedRaiseReason.trim()) {
      setError(vi ? "Cần nhập lý do thay đổi mức tăng lương cố định." : "고정 급여인상 총액 변경 사유를 입력해주세요.");
      return;
    }
    setSaving(true);
    const response = await fetch("/api/admin/payroll/contracts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        timeBlockMinutes: 60,
        roundingMode: "none",
        lateAdjustmentMode: "separate",
        overtimeMode: "ignore",
        earlyLeaveAdjustmentMode: "deduct_minutes",
        paidLeaveMode: "unpaid",
        note: fixedRaiseChanged ? form.fixedRaiseReason.trim() : null,
        userId,
        baseSalary: Number(form.baseSalary),
        fixedRaiseAmount: Number(form.fixedRaiseAmount),
        standardWorkdays:
          form.payType === "monthly" ? Number(form.standardWorkdays) : null,
        standardMinutesPerDay,
      }),
    });
    const data = await response.json();
    setSaving(false);
    if (!response.ok) {
      setError(data.code === "FIXED_RAISE_REASON_REQUIRED" ? (vi ? "Cần nhập lý do thay đổi mức tăng lương cố định." : "고정 급여인상 총액 변경 사유를 입력해주세요.") : (data.code ?? "INVALID_CONTRACT"));
      return;
    }
    await load(userId);
    setOpen(false);
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
                          nameStyle={s.personName}
                        />
                        <small style={s.personMeta}>{user.part ?? "-"} · {positionLabel(user)}</small>
                      </span>
                      <span style={selectedUser ? s.selectedLabel : s.selectMark}>
                        {selectedUser ? (vi ? "Đã chọn" : "선택됨") : "›"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
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
                    nameStyle={s.summaryName}
                  />
                  <span style={s.sectionHelp}>{selected.part ?? "-"} · {positionLabel(selected)}</span>
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
                  <button type="button" style={s.primary} onClick={openForm}>
                    {vi ? "Đăng ký thay đổi" : "계약 변경 등록"}
                  </button>
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
            title={vi ? "Đăng ký hợp đồng lương" : "급여계약 등록"}
            closeLabel={vi ? "Đóng" : "닫기"}
            onClose={() => setOpen(false)}
            footer={
              <button form="contract" style={s.modalSave} disabled={saving}>
                {saving ? (vi ? "Đang lưu" : "저장 중") : vi ? "Lưu" : "저장"}
              </button>
            }
          >
            <form id="contract" style={s.form} onSubmit={submit}>
              <NumberField
                label={vi ? "Lương theo hợp đồng" : "계약급여"}
                value={form.baseSalary}
                change={(value) => setForm({ ...form, baseSalary: value })}
              />
              <Field label={vi ? "Tổng mức tăng lương cố định" : "고정 급여인상 총액"}>
                <input
                  style={s.input}
                  required
                  type="text"
                  inputMode="numeric"
                  value={formatIntegerInput(form.fixedRaiseAmount)}
                  onChange={(event) => setForm({ ...form, fixedRaiseAmount: integerInputDigits(event.target.value) })}
                />
                <small style={s.fieldHelp}>{vi ? "Nhập tổng số tiền tăng cố định hiện áp dụng, không phải riêng mức thay đổi lần này." : "이번 변동액이 아닌 현재 적용할 누적 총액을 입력합니다."}</small>
              </Field>
              <div style={s.changePreview}>
                <SummaryItem label={vi ? "Tổng hiện tại" : "현재 총액"} value={currencyAmount(currentFixedRaise, vi)} />
                <SummaryItem label={vi ? "Tổng sau thay đổi" : "변경 후 총액"} value={currencyAmount(nextFixedRaise, vi)} important />
              </div>
              {fixedRaiseChanged ? <Field label={vi ? "Lý do thay đổi mức tăng lương cố định" : "고정 급여인상 사유"}>
                <textarea style={s.input} required value={form.fixedRaiseReason} onChange={(event) => setForm({ ...form, fixedRaiseReason: event.target.value })} />
              </Field> : null}
              <div style={s.level}>
                <b>{selected.levelInfo.displayLabel ?? (vi ? "Không áp dụng cấp" : "레벨 미적용")} · {vi ? "Tăng theo cấp" : "레벨 인상"} {signedAmount(levelRaise, vi)}</b>
              </div>
              <SelectField
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
                    calculationBasis:
                      value === "hourly" && form.calculationBasis === "day"
                        ? "minute"
                        : form.calculationBasis,
                  })
                }
              />
              <SelectField
                label={vi ? "Cách tính lương" : "급여 산정 방식"}
                value={form.calculationBasis}
                options={
                  form.payType === "hourly" ? ["minute"] : ["minute", "day"]
                }
                lang={l}
                change={(value) =>
                  setForm({ ...form, calculationBasis: value })
                }
              />
              {form.payType === "monthly" && (
                <NumberField
                  label={vi ? "Ngày làm việc chuẩn" : "월 기준 근무일수"}
                  value={form.standardWorkdays}
                  change={(value) =>
                    setForm({ ...form, standardWorkdays: value })
                  }
                  step="0.01"
                />
              )}
              <Field label={vi ? "Giờ làm việc chuẩn mỗi ngày" : "하루 기준 근무시간"}>
                <div style={s.hoursRow}>
                  <input style={s.hoursInput} required type="number" min="0.01" max="24" step="0.01" value={form.standardHoursPerDay} onChange={(event) => setForm({ ...form, standardHoursPerDay: event.target.value })} />
                  <span>{vi ? "giờ" : "시간"}</span>
                  {standardMinutesPreview !== null ? <span style={s.minutesPreview}>{standardMinutesPreview}{vi ? " phút" : "분"}</span> : null}
                </div>
              </Field>
              <Field label={vi ? "Ngày áp dụng" : "적용 시작일"}>
                <input
                  style={s.input}
                  type="date"
                  required
                  value={form.effectiveFrom}
                  onChange={(e) =>
                    setForm({ ...form, effectiveFrom: e.target.value })
                  }
                />
              </Field>
            </form>
          </PayrollModal>
        )}
      </main>
    </Container>
  );
}
function ContractCard({ contract, previous, vi }: { contract: Contract; previous: Contract | null; vi: boolean }) {
  const before = previous?.fixedRaiseAmount ?? 0;
  return (
    <article style={s.contract}>
      <b>{vi ? `Lần thay đổi ${contract.revision}` : `변경번호 ${contract.revision}`}</b>
      <span>
        {vi ? "Lương theo hợp đồng" : "계약급여"} {money(contract.baseSalary)}
      </span>
      <span>
        {vi ? "Tổng mức tăng cố định" : "고정 인상 총액"} {currencyAmount(before, vi)} → {currencyAmount(contract.fixedRaiseAmount, vi)}
      </span>
      {contract.fixedRaiseAmount !== before && contract.note ? <span>{vi ? "Lý do" : "사유"}: {contract.note}</span> : null}
      <span>{vi ? "Ngày áp dụng" : "적용일"} {contract.effectiveFrom}</span>
      {contract.createdBy ? <small>{vi ? "Người tạo" : "생성자"} #{contract.createdBy}</small> : null}
      {contract.createdAt ? <small>{vi ? "Tạo lúc" : "생성 시각"} {new Date(contract.createdAt).toLocaleString(vi ? "vi-VN" : "ko-KR")}</small> : null}
    </article>
  );
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
      <SummaryItem label={vi ? "Lương theo hợp đồng" : "계약급여"} value={money(contract.baseSalary)} />
      <SummaryItem label={vi ? "Mức tăng cố định" : "고정 급여인상"} value={`+${money(contract.fixedRaiseAmount)}`} />
      <SummaryItem label={vi ? "Mức tăng theo cấp" : "레벨 인상"} value={`+${money(levelRaise)}`} />
      <SummaryItem label={vi ? "Tổng lương" : "합산급여"} value={money(combined)} important />
      <SummaryItem label={vi ? "Loại lương" : "급여 형태"} value={payrollLabel(lang, contract.payType)} />
      <SummaryItem label={vi ? "Cách tính lương" : "급여 산정 방식"} value={payrollLabel(lang, contract.calculationBasis)} />
      <SummaryItem label={vi ? "Ngày áp dụng" : "적용 시작일"} value={contract.effectiveFrom} />
      <SummaryItem label="revision" value={`#${contract.revision}`} />
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
  people: {
    display: "grid",
    gap: 6,
    maxHeight: 360,
    overflowY: "auto",
    overflowX: "hidden",
  },
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
