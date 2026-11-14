"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { PayrollTaxBurdenMode, PayrollTaxInsuranceDeductionMode, PayrollTaxMode, PayrollTaxSettingVersion } from "@/lib/payroll/tax";
import EmployeeSettingCard from "@/components/payroll/EmployeeSettingCard";
import { BenefitChoice, BenefitField, BenefitModalActions, BenefitStatusLine, m } from "@/components/payroll/BenefitModalParts";
import { pickTax, resolveSettingsSummaryReference, type SettingHistoryState } from "@/lib/payroll/settings-summary";
import { formValuesChanged, useReportDirty } from "@/components/payroll/useReportDirty";
import { useGuardedSubmit } from "@/components/payroll/useGuardedSubmit";
import type { PayrollSettingFormRequest, PayrollSettingFormResult } from "@/components/payroll/settingFormRequest";

function currentMonth() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
}

// 설정 변경 폼을 열 때의 기준값. resetForm과 미저장 판정이 같은 값을 쓴다.
// 모달(이름·스위치 어느 쪽으로 열어도)은 서버에서 확인한 현재 적용 방식으로 시작한다.
function taxFormBaseline(setting: PayrollTaxSettingVersion | null, employeeName: string): {
  taxMode: PayrollTaxMode; dependentCount: string; burdenMode: PayrollTaxBurdenMode; insuranceMode: PayrollTaxInsuranceDeductionMode;
  manualInsurance: string; accountingName: string; effectiveMonth: string; note: string;
} {
  return {
    taxMode: setting?.taxMode ?? "not_applicable",
    dependentCount: String(setting?.dependentCount ?? 0),
    burdenMode: setting?.burdenMode ?? "employee_deducted",
    insuranceMode: setting?.insuranceDeductionMode ?? "none",
    manualInsurance: String(setting?.manualInsuranceDeductionAmount ?? 0),
    accountingName: setting?.accountingName ?? employeeName,
    effectiveMonth: currentMonth(),
    note: "",
  };
}

export default function EmployeeTaxSettings({ userId, employeeName, vi, onHistoryStateChange, onDirtyChange, formRequest, onFormFinish, actionsTarget }: {
  userId: number; employeeName: string; vi: boolean; onHistoryStateChange?: (state: SettingHistoryState<PayrollTaxSettingVersion>) => void; onDirtyChange?: (dirty: boolean) => void;
  /** /admin/users 설정 모달: 조회가 끝나면 폼을 바로 열고 enable 값으로 미리 채운다(그 값이 미저장 판정 기준). */
  formRequest?: PayrollSettingFormRequest | null;
  /** 모달 모드에서 폼 저장 완료(재조회 후) 또는 취소를 알린다. */
  onFormFinish?: (result: PayrollSettingFormResult) => void;
  /** 설정 모달의 하단 취소·저장을 그릴 시트 footer(직원관리 전용). */
  actionsTarget?: HTMLElement | null;
}) {
  // /admin/users 설정 모달(formRequest가 있으면): 바깥 제목만 두고 상태 줄·2분할 선택·필요한 입력·하단 취소/저장 한 세트로 보여 준다.
  const modal = Boolean(formRequest);
  const formId = useId();
  const mounted = useRef(true);
  // 모달 모드: 첫 조회가 끝나면 한 번만 폼을 연다(저장 후 재조회에서는 다시 열지 않음).
  const formRequestRef = useRef(formRequest ?? null);
  const autoOpenedRef = useRef(false);
  // 급여설정 요약에 이미 조회한 이력을 전달한다(추가 조회 없음). ref로 보관해 조회 의존성에 넣지 않는다.
  const reportHistoryRef = useRef(onHistoryStateChange);
  useEffect(() => { reportHistoryRef.current = onHistoryStateChange; });

  const [history, setHistory] = useState<PayrollTaxSettingVersion[]>([]);
  const [current, setCurrent] = useState<PayrollTaxSettingVersion | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [taxMode, setTaxMode] = useState<PayrollTaxMode>("not_applicable");
  const [dependentCount, setDependentCount] = useState("0");
  const [burdenMode, setBurdenMode] = useState<PayrollTaxBurdenMode>("employee_deducted");
  const [insuranceMode, setInsuranceMode] = useState<PayrollTaxInsuranceDeductionMode>("none");
  const [manualInsurance, setManualInsurance] = useState("0");
  const [accountingName, setAccountingName] = useState("");
  const [effectiveMonth, setEffectiveMonth] = useState(currentMonth);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const resetForm = useCallback((setting: PayrollTaxSettingVersion | null) => {
    const baseline = taxFormBaseline(setting, employeeName);
    setTaxMode(baseline.taxMode);
    setDependentCount(baseline.dependentCount);
    setBurdenMode(baseline.burdenMode);
    setInsuranceMode(baseline.insuranceMode);
    setManualInsurance(baseline.manualInsurance);
    setAccountingName(baseline.accountingName);
    setEffectiveMonth(baseline.effectiveMonth);
    setNote(baseline.note);
    setError("");
  }, [employeeName]);

  const load = useCallback(async (signal?: AbortSignal) => {
    reportHistoryRef.current?.({ status: "loading", history: [] });
    try {
      const response = await fetch(`/api/admin/payroll/tax-settings?userId=${userId}`, { cache: "no-store", signal });
      if (signal?.aborted || !mounted.current) return;
      const data = await response.json();
      if (!response.ok) throw new Error("LOAD_FAILED");
      const nextCurrent = data.current ?? null;
      setHistory(data.history ?? []);
      setCurrent(nextCurrent);
      setLoaded(true);
      const request = formRequestRef.current;
      if (request && !autoOpenedRef.current) {
        autoOpenedRef.current = true;
        setFormOpen(true);
      }
      resetForm(nextCurrent);
      reportHistoryRef.current?.({ status: "ready", history: data.history ?? [] });
    } catch (loadError) {
      if (signal?.aborted || !mounted.current || (loadError instanceof Error && loadError.name === "AbortError")) return;
      setError(vi ? "Không thể tải cài đặt thuế TNCN." : "TNCN 설정을 불러오지 못했습니다.");
      setLoaded(true);
      reportHistoryRef.current?.({ status: "error", history: [] });
    }
  }, [resetForm, userId, vi]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setHistory([]);
    setCurrent(null);
    setLoaded(false);
    setFormOpen(false);
    resetForm(null);
    void load(controller.signal);
    return () => { mounted.current = false; controller.abort(); };
  }, [load, resetForm]);

  useReportDirty(formOpen && (saving || formValuesChanged({ taxMode, dependentCount, burdenMode, insuranceMode, manualInsurance, accountingName, effectiveMonth, note }, taxFormBaseline(current, employeeName))), onDirtyChange);

  function cancelForm() {
    setFormOpen(false);
    resetForm(current);
    onFormFinish?.("cancelled");
  }

  // 같은 저장 요청이 두 번 나가지 않게 한다(더블 클릭·Enter 연타는 saving 상태가 반영되기 전에 들어올 수 있다).
  const submit = useGuardedSubmit(saveForm);

  async function saveForm(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    // 모달: 현재 값과 같으면 저장하지 않는다(저장 버튼도 비활성).
    if (modal && !formValuesChanged({ taxMode, dependentCount, burdenMode, insuranceMode, manualInsurance, accountingName, effectiveMonth, note }, taxFormBaseline(current, employeeName))) return;
    setSaving(true);
    setError("");
    const notApplicable = taxMode === "not_applicable";
    try {
      const response = await fetch("/api/admin/payroll/tax-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          taxMode,
          dependentCount: notApplicable ? 0 : Number(dependentCount),
          burdenMode: notApplicable ? "employee_deducted" : burdenMode,
          accountingName: notApplicable ? null : accountingName,
          insuranceDeductionMode: notApplicable ? "none" : insuranceMode,
          manualInsuranceDeductionAmount: !notApplicable && insuranceMode === "manual" ? Number(manualInsurance) : 0,
          effectiveMonth,
          note,
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.code ?? "SAVE_FAILED");
      }
      await load();
      if (mounted.current) {
        setFormOpen(false);
        onFormFinish?.("saved");
      }
    } catch (saveError) {
      if (!mounted.current) return;
      const locked = saveError instanceof Error && saveError.message === "PAYROLL_TAX_SETTING_LOCKED_FOR_PAID_EMPLOYEE";
      setError(locked
        ? vi ? "Không thể thay đổi TNCN của tháng nhân viên đã được trả lương." : "지급 완료된 직원·월의 TNCN 설정은 변경할 수 없습니다."
        : vi ? "Không thể lưu cài đặt thuế TNCN." : "TNCN 설정을 저장하지 못했습니다.");
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const modeLabel = current?.taxMode === "resident_progressive"
    ? vi ? "Lũy tiến từng phần" : "거주자 누진세"
    : vi ? "Không áp dụng TNCN" : "TNCN 미적용";

  const help = vi ? "Lưu từng phiên bản theo tháng áp dụng; tên kế toán không thay đổi danh tính nhân viên." : "적용 월별 새 revision으로 저장하며 회계 명의는 직원 identity를 변경하지 않습니다.";
  const historyItems = history.map((item) => <article style={s.history} key={item.id}><b>{item.effectiveMonth.slice(0, 7)} · #{item.revision}</b><span>{item.taxMode} · {item.burdenMode} · {item.accountingName ?? "—"}</span>{item.note ? <small>{item.note}</small> : null}</article>);
  const historyLabel = vi ? `Lịch sử ${history.length} mục` : `설정 이력 ${history.length}건`;
  const burdenText = (mode: PayrollTaxBurdenMode) => mode === "company_bears" ? vi ? "Công ty chịu (gross-up)" : "회사 부담(gross-up)" : vi ? "Nhân viên chịu" : "직원 부담";
  // 공통 입력(누진세 적용일 때만 표시)
  const residentFields = <>
    <BenefitField label={vi ? "Số người phụ thuộc" : "부양가족 수"}><input style={m.input} type="number" min="0" step="1" required value={dependentCount} onChange={(event) => setDependentCount(event.target.value)} /></BenefitField>
    <BenefitField label={vi ? "Bên chịu thuế" : "부담 방식"}><select style={m.input} value={burdenMode} onChange={(event) => setBurdenMode(event.target.value as PayrollTaxBurdenMode)}><option value="employee_deducted">{vi ? "Nhân viên chịu" : "직원 부담"}</option><option value="company_bears">{vi ? "Công ty chịu (gross-up)" : "회사 부담(gross-up)"}</option></select></BenefitField>
    <BenefitField label={vi ? "Khấu trừ bảo hiểm khi tính thuế" : "세금 보험공제 방식"}><select style={m.input} value={insuranceMode} onChange={(event) => setInsuranceMode(event.target.value as PayrollTaxInsuranceDeductionMode)}><option value="payroll">{vi ? "Theo bảo hiểm bảng lương" : "급여 보험 사용"}</option><option value="manual">{vi ? "Nhập thủ công chỉ để tính thuế" : "세금 계산용 수동 금액"}</option><option value="none">{vi ? "Không khấu trừ" : "공제 없음"}</option></select></BenefitField>
    {insuranceMode === "manual" ? <BenefitField label={vi ? "Bảo hiểm được trừ khi tính thuế" : "세금 계산상 보험공제액"}><input style={m.input} type="text" inputMode="numeric" required value={Number(manualInsurance || 0).toLocaleString("en-US")} onChange={(event) => setManualInsurance(event.target.value.replace(/\D/g, ""))} /></BenefitField> : null}
    <BenefitField label={vi ? "Tên kế toán/TNCN" : "회계/TNCN 명의"}><input style={m.input} required value={accountingName} onChange={(event) => setAccountingName(event.target.value)} /></BenefitField>
  </>;

  if (modal) {
    // 현재 적용 방식과 예약은 스위치·급여 계산과 같은 규칙(pickTax)으로 따로 보여 준다.
    const pick = pickTax(history, resolveSettingsSummaryReference(null, `${currentMonth()}-01`));
    const onLabel = vi ? "Áp dụng" : "적용";
    const offLabel = vi ? "Không áp dụng" : "미적용";
    const applied = pick.applied;
    const changed = formValuesChanged({ taxMode, dependentCount, burdenMode, insuranceMode, manualInsurance, accountingName, effectiveMonth, note }, taxFormBaseline(current, employeeName));
    const hint = formOpen && !changed ? (vi ? "Không có thay đổi để lưu." : "변경된 내용이 없습니다.") : null;
    return <EmployeeSettingCard title={vi ? "Thuế TNCN nhân viên" : "직원 TNCN"} applied={loaded ? current !== null && current.taxMode !== "not_applicable" : null} vi={vi} defaultOpen={Boolean(formRequest)} bare>
      {!loaded ? <p style={m.muted}>{vi ? "Đang tải…" : "불러오는 중…"}</p> : null}
      {/* 조회 실패면 폼이 열리지 않는다: 실패만 알리고 상태를 미적용으로 표시하지 않는다. */}
      {formOpen ? <BenefitStatusLine
        vi={vi}
        onLabel={vi ? "Lũy tiến từng phần" : "거주자 누진세"}
        offLabel={vi ? "Không áp dụng TNCN" : "TNCN 미적용"}
        unsetLabel={vi ? "Chưa có hồ sơ · cần kiểm tra trước khi trả lương" : "미설정 · 지급 전 확인 필요"}
        status={{
          applied: applied ? {
            on: applied.taxMode === "resident_progressive",
            since: applied.effectiveMonth.slice(0, 7),
            detail: applied.taxMode === "resident_progressive"
              ? `${burdenText(applied.burdenMode)} · ${vi ? "Người phụ thuộc" : "부양가족"} ${applied.dependentCount} · ${applied.accountingName ?? "—"}`
              : undefined,
          } : null,
          scheduled: pick.scheduled ? { on: pick.scheduled.taxMode === "resident_progressive", from: pick.scheduled.effectiveMonth.slice(0, 7) } : null,
        }}
      /> : null}
      {formOpen ? <form id={formId} style={m.form} onSubmit={submit}>
        <BenefitChoice label={vi ? "Áp dụng TNCN" : "TNCN 적용 여부"} value={taxMode === "resident_progressive"} onChange={(next) => setTaxMode(next ? "resident_progressive" : "not_applicable")} onLabel={onLabel} offLabel={offLabel} />
        {taxMode === "resident_progressive" ? residentFields : null}
        <BenefitField label={vi ? "Tháng bắt đầu áp dụng" : "적용 시작월"}><input style={m.input} type="month" required value={effectiveMonth} onChange={(event) => setEffectiveMonth(event.target.value)} /></BenefitField>
        <BenefitField label={vi ? "Ghi chú / lý do thay đổi" : "메모 / 변경 사유"}><textarea style={m.textarea} required value={note} onChange={(event) => setNote(event.target.value)} /></BenefitField>
      </form> : null}
      {error ? <p role="alert" style={m.error}>{error}</p> : null}
      <details style={m.details}><summary style={m.summary}>{vi ? "Thông tin tham khảo" : "참고 정보"}</summary><p style={m.muted}>{help}</p></details>
      <details style={m.details}><summary style={m.summary}>{historyLabel}</summary>{historyItems}</details>
      <BenefitModalActions target={actionsTarget} formId={formId} vi={vi} saving={saving} canSave={formOpen && changed} hint={hint} onCancel={cancelForm} />
    </EmployeeSettingCard>;
  }

  return <EmployeeSettingCard title={vi ? "Thuế TNCN nhân viên" : "직원 TNCN"} applied={loaded ? current !== null && current.taxMode !== "not_applicable" : null} vi={vi} defaultOpen={Boolean(formRequest)}>
    <div style={s.head}>
      <p style={s.help}>{help}</p>
      <button type="button" style={s.secondary} onClick={() => { resetForm(current); setFormOpen(true); }}>{vi ? "Thay đổi cài đặt TNCN" : "TNCN 설정 변경"}</button>
    </div>
    {current ? <div style={s.current}>
      <Summary label={vi ? "Nhân viên" : "직원"} value={employeeName} />
      <Summary label={vi ? "Chế độ" : "적용 방식"} value={modeLabel} />
      <Summary label={vi ? "Tên kế toán/TNCN" : "회계/TNCN 명의"} value={current.accountingName ?? "—"} />
      <Summary label={vi ? "Người phụ thuộc" : "부양가족"} value={String(current.dependentCount)} />
      <Summary label={vi ? "Tháng áp dụng" : "적용 월"} value={current.effectiveMonth.slice(0, 7)} />
      <Summary label="revision" value={`#${current.revision}`} />
    </div> : <p style={s.empty}>{vi ? "Chưa có hồ sơ TNCN · cần kiểm tra trước khi trả lương" : "TNCN profile 미설정 · 지급 전 확인 필요"}</p>}
    {formOpen ? <form style={s.form} onSubmit={submit}>
      <Field label={vi ? "Áp dụng TNCN" : "TNCN 적용 여부"}><select style={s.input} value={taxMode} onChange={(event) => setTaxMode(event.target.value as PayrollTaxMode)}><option value="not_applicable">{vi ? "Không áp dụng" : "미적용"}</option><option value="resident_progressive">{vi ? "Cá nhân cư trú · lũy tiến" : "거주자 누진세"}</option></select></Field>
      {taxMode === "resident_progressive" ? <>
        <Field label={vi ? "Số người phụ thuộc" : "부양가족 수"}><input style={s.input} type="number" min="0" step="1" required value={dependentCount} onChange={(event) => setDependentCount(event.target.value)} /></Field>
        <Field label={vi ? "Bên chịu thuế" : "부담 방식"}><select style={s.input} value={burdenMode} onChange={(event) => setBurdenMode(event.target.value as PayrollTaxBurdenMode)}><option value="employee_deducted">{vi ? "Nhân viên chịu" : "직원 부담"}</option><option value="company_bears">{vi ? "Công ty chịu (gross-up)" : "회사 부담(gross-up)"}</option></select></Field>
        <Field label={vi ? "Khấu trừ bảo hiểm khi tính thuế" : "세금 보험공제 방식"}><select style={s.input} value={insuranceMode} onChange={(event) => setInsuranceMode(event.target.value as PayrollTaxInsuranceDeductionMode)}><option value="payroll">{vi ? "Theo bảo hiểm bảng lương" : "급여 보험 사용"}</option><option value="manual">{vi ? "Nhập thủ công chỉ để tính thuế" : "세금 계산용 수동 금액"}</option><option value="none">{vi ? "Không khấu trừ" : "공제 없음"}</option></select></Field>
        {insuranceMode === "manual" ? <Field label={vi ? "Bảo hiểm được trừ khi tính thuế" : "세금 계산상 보험공제액"}><input style={s.input} type="text" inputMode="numeric" required value={Number(manualInsurance || 0).toLocaleString("en-US")} onChange={(event) => setManualInsurance(event.target.value.replace(/\D/g, ""))} /></Field> : null}
        <Field label={vi ? "Tên kế toán/TNCN" : "회계/TNCN 명의"}><input style={s.input} required value={accountingName} onChange={(event) => setAccountingName(event.target.value)} /></Field>
      </> : null}
      <Field label={vi ? "Tháng bắt đầu áp dụng" : "적용 시작월"}><input style={s.input} type="month" required value={effectiveMonth} onChange={(event) => setEffectiveMonth(event.target.value)} /></Field>
      <Field label={vi ? "Ghi chú / lý do thay đổi" : "메모 / 변경 사유"}><textarea style={s.textarea} required value={note} onChange={(event) => setNote(event.target.value)} /></Field>
      <div style={s.actions}><button type="button" style={s.secondary} onClick={cancelForm}>{vi ? "Hủy" : "취소"}</button><button style={s.primary} disabled={saving}>{saving ? vi ? "Đang lưu…" : "저장 중…" : vi ? "Lưu phiên bản mới" : "새 revision 저장"}</button></div>
    </form> : null}
    {error ? <p role="alert" style={s.error}>{error}</p> : null}
    <details style={s.details}><summary>{historyLabel}</summary>{historyItems}</details>
  </EmployeeSettingCard>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label style={s.field}><span>{label}</span>{children}</label>; }
function Summary({ label, value }: { label: string; value: string }) { return <div style={s.summary}><span>{label}</span><b>{value}</b></div>; }

const s = {
  card:{padding:13,border:"1px solid #e5e7eb",borderRadius:14,background:"#fff",display:"grid",gap:9,minWidth:0},head:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,flexWrap:"wrap"},title:{margin:0,fontSize:15,fontWeight:900},help:{margin:"3px 0 0",color:"#6b7280",fontSize:12,lineHeight:1.4},current:{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(130px, 1fr))",gap:6,padding:"8px 9px",borderRadius:9,background:"#f8fafc",fontSize:12},summary:{display:"grid",gap:3,minWidth:0},empty:{margin:0,padding:"10px 11px",border:"1px dashed #d1d5db",borderRadius:10,color:"#9a3412",fontSize:12},form:{display:"grid",gap:8,paddingTop:8,borderTop:"1px solid #e5e7eb"},field:{display:"grid",gap:5,fontSize:13,fontWeight:700},input:{width:"100%",minHeight:40,padding:8,border:"1px solid #d1d5db",borderRadius:9},textarea:{width:"100%",minHeight:72,padding:8,border:"1px solid #d1d5db",borderRadius:9,resize:"vertical"},actions:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8},primary:{minHeight:38,padding:"7px 10px",border:0,borderRadius:9,background:"#111827",color:"#fff",fontSize:13,fontWeight:800},secondary:{minHeight:36,padding:"7px 10px",border:"1px solid #d1d5db",borderRadius:9,background:"#fff",color:"#111827",fontSize:13,fontWeight:800},error:{margin:0,padding:"8px 9px",borderRadius:9,background:"#fef2f2",color:"#b91c1c",fontSize:12},details:{paddingTop:8,borderTop:"1px solid #e5e7eb",fontSize:12},history:{display:"grid",gap:3,padding:"8px 9px",marginTop:5,border:"1px solid #e5e7eb",borderRadius:9,fontSize:12},
} satisfies Record<string, CSSProperties>;
