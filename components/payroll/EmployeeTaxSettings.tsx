"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { PayrollTaxBurdenMode, PayrollTaxInsuranceDeductionMode, PayrollTaxMode, PayrollTaxSettingVersion } from "@/lib/payroll/tax";

function currentMonth() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
}

export default function EmployeeTaxSettings({ userId, employeeName, vi }: { userId: number; employeeName: string; vi: boolean }) {
  const mounted = useRef(true);
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

  const resetForm = useCallback((setting: PayrollTaxSettingVersion | null) => {
    setTaxMode(setting?.taxMode ?? "not_applicable");
    setDependentCount(String(setting?.dependentCount ?? 0));
    setBurdenMode(setting?.burdenMode ?? "employee_deducted");
    setInsuranceMode(setting?.insuranceDeductionMode ?? "none");
    setManualInsurance(String(setting?.manualInsuranceDeductionAmount ?? 0));
    setAccountingName(setting?.accountingName ?? employeeName);
    setEffectiveMonth(currentMonth());
    setNote("");
    setError("");
  }, [employeeName]);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/admin/payroll/tax-settings?userId=${userId}`, { cache: "no-store", signal });
      if (signal?.aborted || !mounted.current) return;
      const data = await response.json();
      if (!response.ok) throw new Error("LOAD_FAILED");
      const nextCurrent = data.current ?? null;
      setHistory(data.history ?? []);
      setCurrent(nextCurrent);
      resetForm(nextCurrent);
    } catch (loadError) {
      if (signal?.aborted || !mounted.current || (loadError instanceof Error && loadError.name === "AbortError")) return;
      setError(vi ? "Không thể tải cài đặt thuế TNCN." : "TNCN 설정을 불러오지 못했습니다.");
    }
  }, [resetForm, userId, vi]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setHistory([]);
    setCurrent(null);
    setFormOpen(false);
    resetForm(null);
    void load(controller.signal);
    return () => { mounted.current = false; controller.abort(); };
  }, [load, resetForm]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
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
      if (mounted.current) setFormOpen(false);
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

  return <section style={s.card}>
    <div style={s.head}>
      <div><h2 style={s.title}>{vi ? "Thuế TNCN nhân viên" : "직원 TNCN"}</h2><p style={s.help}>{vi ? "Lưu từng phiên bản theo tháng áp dụng; tên kế toán không thay đổi danh tính nhân viên." : "적용 월별 새 revision으로 저장하며 회계 명의는 직원 identity를 변경하지 않습니다."}</p></div>
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
      <div style={s.actions}><button type="button" style={s.secondary} onClick={() => { setFormOpen(false); resetForm(current); }}>{vi ? "Hủy" : "취소"}</button><button style={s.primary} disabled={saving}>{saving ? vi ? "Đang lưu…" : "저장 중…" : vi ? "Lưu phiên bản mới" : "새 revision 저장"}</button></div>
    </form> : null}
    {error ? <p role="alert" style={s.error}>{error}</p> : null}
    <details style={s.details}><summary>{vi ? `Lịch sử ${history.length} mục` : `설정 이력 ${history.length}건`}</summary>{history.map((item) => <article style={s.history} key={item.id}><b>{item.effectiveMonth.slice(0, 7)} · #{item.revision}</b><span>{item.taxMode} · {item.burdenMode} · {item.accountingName ?? "—"}</span>{item.note ? <small>{item.note}</small> : null}</article>)}</details>
  </section>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label style={s.field}><span>{label}</span>{children}</label>; }
function Summary({ label, value }: { label: string; value: string }) { return <div style={s.summary}><span>{label}</span><b>{value}</b></div>; }

const s = {
  card:{padding:13,border:"1px solid #e5e7eb",borderRadius:14,background:"#fff",display:"grid",gap:9,minWidth:0},head:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,flexWrap:"wrap"},title:{margin:0,fontSize:15,fontWeight:900},help:{margin:"3px 0 0",color:"#6b7280",fontSize:12,lineHeight:1.4},current:{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(130px, 1fr))",gap:6,padding:"8px 9px",borderRadius:9,background:"#f8fafc",fontSize:12},summary:{display:"grid",gap:3,minWidth:0},empty:{margin:0,padding:"10px 11px",border:"1px dashed #d1d5db",borderRadius:10,color:"#9a3412",fontSize:12},form:{display:"grid",gap:8,paddingTop:8,borderTop:"1px solid #e5e7eb"},field:{display:"grid",gap:5,fontSize:13,fontWeight:700},input:{width:"100%",minHeight:40,padding:8,border:"1px solid #d1d5db",borderRadius:9},textarea:{width:"100%",minHeight:72,padding:8,border:"1px solid #d1d5db",borderRadius:9,resize:"vertical"},actions:{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8},primary:{minHeight:38,padding:"7px 10px",border:0,borderRadius:9,background:"#111827",color:"#fff",fontSize:13,fontWeight:800},secondary:{minHeight:36,padding:"7px 10px",border:"1px solid #d1d5db",borderRadius:9,background:"#fff",color:"#111827",fontSize:13,fontWeight:800},error:{margin:0,padding:"8px 9px",borderRadius:9,background:"#fef2f2",color:"#b91c1c",fontSize:12},details:{paddingTop:8,borderTop:"1px solid #e5e7eb",fontSize:12},history:{display:"grid",gap:3,padding:"8px 9px",marginTop:5,border:"1px solid #e5e7eb",borderRadius:9,fontSize:12},
} satisfies Record<string, CSSProperties>;
