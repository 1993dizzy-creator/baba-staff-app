"use client";

/* eslint-disable react-hooks/set-state-in-effect */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { money } from "@/lib/payroll/ui-labels";
import type { PayrollInsuranceSettingVersion } from "@/lib/payroll/insurance";
import { formatInsuranceNote } from "@/lib/payroll/insurance-note";
import EmployeeSettingCard from "@/components/payroll/EmployeeSettingCard";
import { formValuesChanged, useReportDirty } from "@/components/payroll/useReportDirty";
import type { PayrollSettingFormRequest, PayrollSettingFormResult } from "@/components/payroll/settingFormRequest";

function currentMonth() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .slice(0, 7);
}

export type EmployeeInsuranceLoadState = {
  current: PayrollInsuranceSettingVersion | null;
  /** 전체 버전 이력(급여설정 요약의 월 기준 판정용). 조회 중·실패면 빈 배열 */
  history: PayrollInsuranceSettingVersion[];
  error: boolean;
  loading: boolean;
};

// 설정 변경 폼을 열 때의 기준값. resetForm과 미저장 판정이 같은 값을 쓴다.
// intent: 스위치로 연 모달의 목표 가입 상태(없으면 현재 상태). 가입으로 채울 때 기준급여가 없으면 폼의 기존 기본값을 쓴다.
function insuranceFormBaseline(setting: PayrollInsuranceSettingVersion | null, intent: boolean | null = null) {
  const enrolled = intent ?? setting?.isEnrolled ?? false;
  const base = setting?.insuranceBaseAmount ?? 0;
  return { enrolled, base: String(intent === true && base < 1 ? 5000000 : base), effectiveMonth: currentMonth(), note: "" };
}

export default function EmployeeInsuranceSettings({
  userId,
  vi,
  onLoadStateChange,
  onDirtyChange,
  formRequest,
  onFormFinish,
}: {
  userId: number;
  vi: boolean;
  onLoadStateChange?: (userId: number, state: EmployeeInsuranceLoadState) => void;
  /** 폼을 연 뒤 값이 바뀌었거나 저장 중이면 true. */
  onDirtyChange?: (dirty: boolean) => void;
  /** /admin/users 설정 모달: 조회가 끝나면 폼을 바로 열고 enable 값으로 미리 채운다(그 값이 미저장 판정 기준). */
  formRequest?: PayrollSettingFormRequest | null;
  /** 모달 모드에서 폼 저장 완료(재조회 후) 또는 취소를 알린다. */
  onFormFinish?: (result: PayrollSettingFormResult) => void;
}) {
  // /admin/users 설정 모달(formRequest가 있으면): 제목·안내·설정 변경 버튼 없이 상태와 폼을 바로 보여 준다.
  const modal = Boolean(formRequest);
  const mounted = useRef(true);
  // 모달 모드: 첫 조회가 끝나면 한 번만 폼을 연다(저장 후 재조회에서는 다시 열지 않음).
  const formRequestRef = useRef(formRequest ?? null);
  const autoOpenedRef = useRef(false);
  const [history, setHistory] = useState<PayrollInsuranceSettingVersion[]>([]);
  const [current, setCurrent] =
    useState<PayrollInsuranceSettingVersion | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formIntent, setFormIntent] = useState<boolean | null>(null);
  const [enrolled, setEnrolled] = useState(false);
  const [base, setBase] = useState("0");
  const [effectiveMonth, setEffectiveMonth] = useState(currentMonth);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const resetForm = useCallback(
    (setting: PayrollInsuranceSettingVersion | null, intent: boolean | null = null) => {
      const baseline = insuranceFormBaseline(setting, intent);
      setEnrolled(baseline.enrolled);
      setBase(baseline.base);
      setEffectiveMonth(baseline.effectiveMonth);
      setNote(baseline.note);
      setError("");
    },
    [],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      onLoadStateChange?.(userId, { current: null, history: [], error: false, loading: true });
      try {
        const response = await fetch(
          `/api/admin/payroll/insurance?userId=${userId}`,
          { cache: "no-store", signal },
        );
        if (signal?.aborted || !mounted.current) return;
        const data = await response.json();
        if (signal?.aborted || !mounted.current) return;
        if (!response.ok) {
          setError(
            vi
              ? "Không thể tải cài đặt bảo hiểm."
              : "보험 설정을 불러오지 못했습니다.",
          );
          onLoadStateChange?.(userId, { current: null, history: [], error: true, loading: false });
          setLoaded(true);
          return;
        }
        const nextCurrent = data.current ?? null;
        setHistory(data.history ?? []);
        setCurrent(nextCurrent);
        const request = formRequestRef.current;
        if (request && !autoOpenedRef.current) {
          autoOpenedRef.current = true;
          resetForm(nextCurrent, request.enable);
          setFormIntent(request.enable);
          setFormOpen(true);
        } else {
          resetForm(nextCurrent);
        }
        onLoadStateChange?.(userId, { current: nextCurrent, history: data.history ?? [], error: false, loading: false });
        setLoaded(true);
      } catch (loadError: unknown) {
        if (
          signal?.aborted ||
          !mounted.current ||
          (loadError instanceof Error && loadError.name === "AbortError")
        ) return;
        setError(
          vi
            ? "Không thể tải cài đặt bảo hiểm."
            : "보험 설정을 불러오지 못했습니다.",
        );
        onLoadStateChange?.(userId, { current: null, history: [], error: true, loading: false });
        setLoaded(true);
      }
    },
    [onLoadStateChange, resetForm, userId, vi],
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setHistory([]);
    setCurrent(null);
    setLoaded(false);
    setFormOpen(false);
    resetForm(null);
    void load(controller.signal).catch((loadError: unknown) => {
      if ((loadError as Error).name !== "AbortError") {
        setError(
          vi
            ? "Không thể tải cài đặt bảo hiểm."
            : "보험 설정을 불러오지 못했습니다.",
        );
      }
    });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [load, resetForm, userId, vi]);

  useReportDirty(formOpen && (saving || formValuesChanged({ enrolled, base, effectiveMonth, note }, insuranceFormBaseline(current, formIntent))), onDirtyChange);

  function openForm() {
    resetForm(current);
    setFormIntent(null);
    setFormOpen(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!enrolled && current?.isEnrolled !== true) return;
    setSaving(true);
    setError("");
    const response = await fetch("/api/admin/payroll/insurance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        isEnrolled: enrolled,
        insuranceBaseAmount: enrolled ? Number(base) : 0,
        effectiveMonth,
        note,
      }),
    });
    if (!mounted.current) return;
    setSaving(false);
    if (!response.ok) {
      setError(
        vi
          ? "Không thể lưu cài đặt bảo hiểm."
          : "보험 설정을 저장하지 못했습니다.",
      );
      return;
    }
    await load();
    if (!mounted.current) return;
    setFormOpen(false);
    setFormIntent(null);
    onFormFinish?.("saved");
  }

  return (
    <EmployeeSettingCard title={vi ? "Bảo hiểm nhân viên" : "직원 보험"} applied={loaded ? current?.isEnrolled === true : null} vi={vi} defaultOpen={Boolean(formRequest)} bare={modal}>
      {/* 설정 모달(/admin/users)에서는 바깥 제목·바로 열린 폼이 있으므로 안내 문구·설정 변경 버튼을 두지 않는다. */}
      {modal ? null : <div style={s.head}>
        <div>
          <p style={s.help}>
            {vi
              ? "Quản lý trạng thái tham gia và mức lương cơ sở bảo hiểm của nhân viên."
              : "직원의 보험 가입 상태와 보험 기준급여를 관리합니다."}
          </p>
        </div>
        <button type="button" style={s.secondary} onClick={openForm}>
          {vi ? "Thay đổi cài đặt bảo hiểm" : "보험 설정 변경"}
        </button>
      </div>}

      {current ? (
        <div style={s.current}>
          <Summary
            label={vi ? "Trạng thái hiện tại" : "현재 가입 상태"}
            value={
              current.isEnrolled
                ? vi
                  ? "Đang tham gia"
                  : "가입"
                : vi
                  ? "Không tham gia"
                  : "미가입"
            }
          />
          <Summary
            label={vi ? "Mức lương cơ sở" : "보험 기준급여"}
            value={money(current.insuranceBaseAmount)}
          />
          <Summary
            label={vi ? "Tháng áp dụng" : "적용 월"}
            value={current.effectiveMonth.slice(0, 7)}
          />
          {/* revision은 설정 이력에도 있으므로 모달에서는 생략한다. */}
          {modal ? null : <Summary label="revision" value={`#${current.revision}`} />}
        </div>
      ) : (
        <p style={s.empty}>
          {vi
            ? "Chưa cài đặt bảo hiểm · xử lý là không tham gia"
            : "보험 미설정 · 미가입 처리"}
        </p>
      )}

      {formOpen ? (
        <form style={s.form} onSubmit={submit}>
          <label style={s.toggleRow}>
            <span>{vi ? "Tham gia bảo hiểm" : "보험 가입 여부"}</span>
            <input
              type="checkbox"
              checked={enrolled}
              onChange={(event) => {
                setEnrolled(event.target.checked);
                if (event.target.checked && Number(base) < 1) setBase("5000000");
              }}
            />
          </label>
          {enrolled ? <label style={s.field}>
            {vi ? "Mức lương cơ sở bảo hiểm" : "보험 기준급여"}
            <input
              style={s.input}
              required
              type="text"
              inputMode="numeric"
              value={Number(base || 0).toLocaleString("en-US")}
              onChange={(event) => setBase(event.target.value.replace(/\D/g, ""))}
            />
          </label> : null}
          {enrolled || current?.isEnrolled === true ? <>
          <label style={s.field}>
            {vi ? "Tháng áp dụng" : "적용 월"}
            <input
              style={s.input}
              required
              type="month"
              value={effectiveMonth}
              onChange={(event) => setEffectiveMonth(event.target.value)}
            />
          </label>
          <label style={s.field}>
            {vi ? "Lý do thay đổi" : "변경 사유"}
            <textarea
              style={s.textarea}
              required
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div style={s.actions}>
            <button
              type="button"
              style={s.secondary}
              onClick={() => {
                setFormOpen(false);
                resetForm(current);
                setFormIntent(null);
                onFormFinish?.("cancelled");
              }}
            >
              {vi ? "Hủy" : "취소"}
            </button>
            <button style={s.button} disabled={saving}>
              {saving
                ? vi
                  ? "Đang lưu…"
                  : "저장 중…"
                : vi
                  ? "Áp dụng cài đặt bảo hiểm"
                  : "보험 설정 적용"}
            </button>
          </div>
          </> : null}
        </form>
      ) : null}

      {error ? (
        <p role="alert" style={s.error}>
          {error}
        </p>
      ) : null}
      <details style={s.details}>
        <summary>
          {vi
            ? `Lịch sử cài đặt ${history.length} mục`
            : `설정 이력 ${history.length}건`}
        </summary>
        {history.map((item) => (
          <article style={s.history} key={item.id}>
            <b>
              {item.effectiveMonth.slice(0, 7)} · #{item.revision}
            </b>
            <span>
              {item.isEnrolled
                ? vi
                  ? "Tham gia"
                  : "가입"
                : vi
                  ? "Không tham gia"
                  : "미가입"}{" "}
              · {money(item.insuranceBaseAmount)}
            </span>
            {formatInsuranceNote(item.note, vi) ? <small>{formatInsuranceNote(item.note, vi)}</small> : null}
          </article>
        ))}
      </details>
    </EmployeeSettingCard>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div style={s.summary}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

const s = {
  card: {
    padding: 13,
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    background: "#fff",
    display: "grid",
    gap: 9,
    minWidth: 0,
  },
  head: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
    flexWrap: "wrap",
  },
  title: { margin: 0, fontSize: 15, fontWeight: 900 },
  help: { margin: "3px 0 0", color: "#6b7280", fontSize: 12, lineHeight: 1.4 },
  current: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
    gap: 6,
    padding: "8px 9px",
    borderRadius: 9,
    background: "#f8fafc",
    fontSize: 12,
  },
  summary: { display: "grid", gap: 3, minWidth: 0 },
  empty: { margin: 0, padding: "10px 11px", border: "1px dashed #d1d5db", borderRadius: 10, color: "#6b7280", fontSize: 12 },
  form: { display: "grid", gap: 8, paddingTop: 8, borderTop: "1px solid #e5e7eb" },
  field: { display: "grid", gap: 5, fontSize: 13, fontWeight: 700 },
  toggleRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, minHeight: 44, padding: "8px 10px", borderRadius: 10, background: "#f9fafb", fontSize: 13, fontWeight: 800 },
  input: { width: "100%", minHeight: 40, padding: 8, border: "1px solid #d1d5db", borderRadius: 9 },
  textarea: { width: "100%", minHeight: 72, padding: 8, border: "1px solid #d1d5db", borderRadius: 9, resize: "vertical" },
  actions: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  button: { minHeight: 38, padding: "7px 10px", border: 0, borderRadius: 9, background: "#111827", color: "#fff", fontSize: 13, fontWeight: 800 },
  secondary: { minHeight: 36, padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff", color: "#111827", fontSize: 13, fontWeight: 800 },
  error: { margin: 0, padding: "8px 9px", borderRadius: 9, background: "#fef2f2", color: "#b91c1c", fontSize: 12 },
  details: { paddingTop: 8, borderTop: "1px solid #e5e7eb", fontSize: 12 },
  history: { display: "grid", gap: 3, padding: "8px 9px", marginTop: 5, border: "1px solid #e5e7eb", borderRadius: 9, fontSize: 12 },
} satisfies Record<string, CSSProperties>;
