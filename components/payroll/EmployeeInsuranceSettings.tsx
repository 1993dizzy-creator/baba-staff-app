"use client";

/* eslint-disable react-hooks/set-state-in-effect */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { money } from "@/lib/payroll/ui-labels";
import type { PayrollInsuranceSettingVersion } from "@/lib/payroll/insurance";
import { formatInsuranceNote } from "@/lib/payroll/insurance-note";
import EmployeeSettingCard from "@/components/payroll/EmployeeSettingCard";
import { BenefitChoice, BenefitField, BenefitModalActions, BenefitStatusLine, m } from "@/components/payroll/BenefitModalParts";
import { pickInsurance, resolveSettingsSummaryReference } from "@/lib/payroll/settings-summary";
import { formValuesChanged, useReportDirty } from "@/components/payroll/useReportDirty";
import { useGuardedSubmit } from "@/components/payroll/useGuardedSubmit";
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
// 모달(이름·스위치 어느 쪽으로 열어도)은 서버에서 확인한 현재 가입 상태로 시작한다.
// 가입을 새로 고르면 기준급여가 없을 때 폼의 기존 기본값(5,000,000)을 채운다(선택 onChange).
function insuranceFormBaseline(setting: PayrollInsuranceSettingVersion | null) {
  const enrolled = setting?.isEnrolled ?? false;
  return { enrolled, base: String(setting?.insuranceBaseAmount ?? 0), effectiveMonth: currentMonth(), note: "" };
}

export default function EmployeeInsuranceSettings({
  userId,
  vi,
  onLoadStateChange,
  onDirtyChange,
  formRequest,
  onFormFinish,
  actionsTarget,
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
  const [history, setHistory] = useState<PayrollInsuranceSettingVersion[]>([]);
  const [current, setCurrent] =
    useState<PayrollInsuranceSettingVersion | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  const [base, setBase] = useState("0");
  const [effectiveMonth, setEffectiveMonth] = useState(currentMonth);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const resetForm = useCallback(
    (setting: PayrollInsuranceSettingVersion | null) => {
      const baseline = insuranceFormBaseline(setting);
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
          setFormOpen(true);
        }
        resetForm(nextCurrent);
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

  useReportDirty(formOpen && (saving || formValuesChanged({ enrolled, base, effectiveMonth, note }, insuranceFormBaseline(current))), onDirtyChange);

  function openForm() {
    resetForm(current);
    setFormOpen(true);
  }

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
    // 기존 정책: 가입하지 않은 직원을 미가입으로 저장하지 않는다(저장할 버전 없음).
    if (!enrolled && current?.isEnrolled !== true) return;
    // 모달: 현재 값과 같으면 저장하지 않는다(저장 버튼도 비활성).
    if (modal && !formValuesChanged({ enrolled, base, effectiveMonth, note }, insuranceFormBaseline(current))) return;
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
    onFormFinish?.("saved");
  }

  const help = vi
    ? "Quản lý trạng thái tham gia và mức lương cơ sở bảo hiểm của nhân viên."
    : "직원의 보험 가입 상태와 보험 기준급여를 관리합니다.";
  const historyItems = history.map((item) => (
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
  ));
  const historyLabel = vi ? `Lịch sử cài đặt ${history.length} mục` : `설정 이력 ${history.length}건`;

  if (modal) {
    // 현재 가입 상태와 예약은 스위치·급여 계산과 같은 규칙(pickInsurance)으로 따로 보여 준다.
    const pick = pickInsurance(history, resolveSettingsSummaryReference(null, `${currentMonth()}-01`));
    const onLabel = vi ? "Tham gia" : "가입";
    const offLabel = vi ? "Không tham gia" : "미가입";
    // 가입을 선택했거나(가입·기준급여 변경) 현재 가입 중일 때(해제)만 저장할 버전이 있다(기존 submit 정책과 같다).
    const savable = enrolled || current?.isEnrolled === true;
    const changed = formValuesChanged({ enrolled, base, effectiveMonth, note }, insuranceFormBaseline(current));
    const hint = !formOpen
      ? null
      : !savable
        ? vi
          ? "Nhân viên chưa tham gia nên không có gì để lưu. Chọn Tham gia để nhập lương cơ sở và tháng áp dụng."
          : "미가입 상태는 저장할 내용이 없습니다. 가입을 선택하면 기준급여·적용월을 입력합니다."
        : !changed
          ? vi ? "Không có thay đổi để lưu." : "변경된 내용이 없습니다."
          : null;
    return (
      <EmployeeSettingCard title={vi ? "Bảo hiểm nhân viên" : "직원 보험"} applied={loaded ? current?.isEnrolled === true : null} vi={vi} defaultOpen={Boolean(formRequest)} bare>
        {!loaded ? <p style={m.muted}>{vi ? "Đang tải…" : "불러오는 중…"}</p> : null}
        {/* 조회 실패면 폼이 열리지 않는다: 실패만 알리고 상태를 미가입으로 표시하지 않는다. */}
        {formOpen ? (
          <BenefitStatusLine
            vi={vi}
            onLabel={onLabel}
            offLabel={offLabel}
            unsetLabel={vi ? "Chưa cài đặt · xử lý là không tham gia" : "미설정 · 미가입 처리"}
            status={{
              applied: pick.applied ? {
                on: pick.applied.isEnrolled,
                since: pick.applied.effectiveMonth.slice(0, 7),
                detail: pick.applied.isEnrolled ? `${vi ? "Mức lương cơ sở" : "보험 기준급여"} ${money(pick.applied.insuranceBaseAmount)}` : undefined,
              } : null,
              scheduled: pick.scheduled ? { on: pick.scheduled.isEnrolled, from: pick.scheduled.effectiveMonth.slice(0, 7) } : null,
            }}
          />
        ) : null}
        {formOpen ? (
          <form id={formId} style={m.form} onSubmit={submit}>
            <BenefitChoice
              label={vi ? "Tham gia bảo hiểm" : "보험 가입 여부"}
              value={enrolled}
              onLabel={onLabel}
              offLabel={offLabel}
              onChange={(next) => {
                setEnrolled(next);
                if (next && Number(base) < 1) setBase("5000000");
              }}
            />
            {enrolled ? (
              <BenefitField label={vi ? "Mức lương cơ sở bảo hiểm" : "보험 기준급여"}>
                <input style={m.input} required type="text" inputMode="numeric" value={Number(base || 0).toLocaleString("en-US")} onChange={(event) => setBase(event.target.value.replace(/\D/g, ""))} />
              </BenefitField>
            ) : null}
            {savable ? <>
              <BenefitField label={vi ? "Tháng áp dụng" : "적용 월"}>
                <input style={m.input} required type="month" value={effectiveMonth} onChange={(event) => setEffectiveMonth(event.target.value)} />
              </BenefitField>
              <BenefitField label={vi ? "Lý do thay đổi" : "변경 사유"}>
                <textarea style={m.textarea} required value={note} onChange={(event) => setNote(event.target.value)} />
              </BenefitField>
            </> : null}
          </form>
        ) : null}
        {error ? <p role="alert" style={m.error}>{error}</p> : null}
        <details style={m.details}>
          <summary style={m.summary}>{vi ? "Thông tin tham khảo" : "참고 정보"}</summary>
          <p style={m.muted}>{help}</p>
        </details>
        <details style={m.details}>
          <summary style={m.summary}>{historyLabel}</summary>
          {historyItems}
        </details>
        <BenefitModalActions
          target={actionsTarget}
          formId={formId}
          vi={vi}
          saving={saving}
          canSave={formOpen && savable && changed}
          hint={hint}
          saveLabel={vi ? "Áp dụng cài đặt bảo hiểm" : "보험 설정 적용"}
          onCancel={cancelForm}
        />
      </EmployeeSettingCard>
    );
  }

  return (
    <EmployeeSettingCard title={vi ? "Bảo hiểm nhân viên" : "직원 보험"} applied={loaded ? current?.isEnrolled === true : null} vi={vi} defaultOpen={Boolean(formRequest)}>
      <div style={s.head}>
        <div>
          <p style={s.help}>{help}</p>
        </div>
        <button type="button" style={s.secondary} onClick={openForm}>
          {vi ? "Thay đổi cài đặt bảo hiểm" : "보험 설정 변경"}
        </button>
      </div>

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
          <Summary label="revision" value={`#${current.revision}`} />
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
            <button type="button" style={s.secondary} onClick={cancelForm}>
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
        <summary>{historyLabel}</summary>
        {historyItems}
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
