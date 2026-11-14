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
import EmployeeSettingCard from "@/components/payroll/EmployeeSettingCard";
import { BenefitChoice, BenefitField, BenefitModalActions, BenefitStatusLine, m } from "@/components/payroll/BenefitModalParts";
import { pickMealAllowance, resolveSettingsSummaryReference, type SettingHistoryState } from "@/lib/payroll/settings-summary";
import { formValuesChanged, useReportDirty } from "@/components/payroll/useReportDirty";
import { useGuardedSubmit } from "@/components/payroll/useGuardedSubmit";
import type { PayrollSettingFormRequest, PayrollSettingFormResult } from "@/components/payroll/settingFormRequest";

export type MealAllowanceVersion = {
  id: number;
  userId: number;
  isEligible: boolean;
  effectiveFrom: string;
  revision: number;
  note: string | null;
};

type MealAllowanceState = {
  current: MealAllowanceVersion | null;
  history: MealAllowanceVersion[];
  attendanceTrackingEnabled: boolean;
  standardWorkdays: number | null;
  dailyAmount: number | null;
  projectedMealAllowance: { amount: number; warningCode: "STANDARD_WORKDAYS_MISSING" | null };
};

// 설정 변경 폼을 열 때의 기준값. resetForm과 미저장 판정이 같은 값을 쓴다.
// 모달(이름·스위치 어느 쪽으로 열어도)은 서버에서 확인한 현재 적용 상태로 시작한다.
function mealFormBaseline(current: MealAllowanceVersion | null) {
  return { isEligible: current?.isEligible ?? false, effectiveFrom: vietnamToday(), note: "" };
}

function vietnamToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export default function EmployeeMealAllowanceSettings({
  userId,
  vi,
  onHistoryStateChange,
  onDirtyChange,
  formRequest,
  onFormFinish,
  actionsTarget,
}: {
  userId: number;
  vi: boolean;
  onHistoryStateChange?: (state: SettingHistoryState<MealAllowanceVersion>) => void;
  /** 폼을 연 뒤 값이 바뀌었거나 저장 중이면 true. */
  onDirtyChange?: (dirty: boolean) => void;
  /** /admin/users 설정 모달: 조회가 끝나면 폼을 바로 열고 현재 적용 상태로 채운다(그 값이 미저장 판정 기준). */
  formRequest?: PayrollSettingFormRequest | null;
  /** 모달 모드에서 폼 저장 완료(재조회 후) 또는 취소를 알린다. */
  onFormFinish?: (result: PayrollSettingFormResult) => void;
  /** 설정 모달의 하단 취소·저장을 그릴 시트 footer(직원관리 전용). */
  actionsTarget?: HTMLElement | null;
}) {
  const mounted = useRef(true);
  // /admin/users 설정 모달(formRequest가 있으면): 바깥 제목만 두고 상태 줄·2분할 선택·필요한 입력·하단 취소/저장 한 세트로 보여 준다.
  const modal = Boolean(formRequest);
  const formId = useId();
  // 모달 모드: 첫 조회가 끝나면 한 번만 폼을 연다(저장 후 재조회에서는 다시 열지 않음).
  const formRequestRef = useRef(formRequest ?? null);
  const autoOpenedRef = useRef(false);
  // 급여설정 요약에 이미 조회한 이력을 전달한다(추가 조회 없음). ref로 보관해 조회 의존성에 넣지 않는다.
  const reportHistoryRef = useRef(onHistoryStateChange);
  useEffect(() => { reportHistoryRef.current = onHistoryStateChange; });

  const [state, setState] = useState<MealAllowanceState | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [isEligible, setIsEligible] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(vietnamToday);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [blockedCode, setBlockedCode] = useState("");

  const resetForm = useCallback((current: MealAllowanceVersion | null) => {
    const baseline = mealFormBaseline(current);
    setIsEligible(baseline.isEligible);
    setEffectiveFrom(baseline.effectiveFrom);
    setNote(baseline.note);
    setError("");
    setBlockedCode("");
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      reportHistoryRef.current?.({ status: "loading", history: [] });
      try {
        const response = await fetch(`/api/admin/payroll/meal-allowance/eligibility?userId=${userId}`, {
          cache: "no-store",
          signal,
        });
        if (signal?.aborted || !mounted.current) return;
        const data = await response.json();
        if (signal?.aborted || !mounted.current) return;
        if (!response.ok) {
          setError(vi ? "Không thể tải cài đặt trợ cấp ăn." : "식대 대상 설정을 불러오지 못했습니다.");
          reportHistoryRef.current?.({ status: "error", history: [] });
          return;
        }
        const next: MealAllowanceState = {
          current: data.current ?? null,
          history: data.history ?? [],
          attendanceTrackingEnabled: data.attendanceTrackingEnabled !== false,
          standardWorkdays: data.standardWorkdays ?? null,
          dailyAmount: data.dailyAmount ?? null,
          projectedMealAllowance: data.projectedMealAllowance ?? { amount: 0, warningCode: null },
        };
        setState(next);
        const request = formRequestRef.current;
        if (request && !autoOpenedRef.current) {
          autoOpenedRef.current = true;
          setFormOpen(true);
        }
        resetForm(next.current);
        reportHistoryRef.current?.({ status: "ready", history: next.history });
      } catch (loadError: unknown) {
        if (signal?.aborted || !mounted.current || (loadError instanceof Error && loadError.name === "AbortError")) return;
        setError(vi ? "Không thể tải cài đặt trợ cấp ăn." : "식대 대상 설정을 불러오지 못했습니다.");
        reportHistoryRef.current?.({ status: "error", history: [] });
      }
    },
    [resetForm, userId, vi],
  );

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setState(null);
    setFormOpen(false);
    void load(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [load]);

  useReportDirty(formOpen && (saving || formValuesChanged({ isEligible, effectiveFrom, note }, mealFormBaseline(state?.current ?? null))), onDirtyChange);

  function openForm() {
    resetForm(state?.current ?? null);
    setFormOpen(true);
  }

  function cancelForm() {
    setFormOpen(false);
    resetForm(state?.current ?? null);
    onFormFinish?.("cancelled");
  }

  // 같은 저장 요청이 두 번 나가지 않게 한다(더블 클릭·Enter 연타는 saving 상태가 반영되기 전에 들어올 수 있다).
  const submit = useGuardedSubmit(saveForm);

  async function saveForm(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    // 모달: 현재 값과 같으면 저장하지 않는다(저장 버튼도 비활성).
    if (modal && !formValuesChanged({ isEligible, effectiveFrom, note }, mealFormBaseline(state?.current ?? null))) return;
    setSaving(true);
    setError("");
    setBlockedCode("");
    const response = await fetch("/api/admin/payroll/meal-allowance/eligibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, isEligible, effectiveFrom, note }),
    });
    if (!mounted.current) return;
    setSaving(false);
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      if (data?.code === "MEAL_ALLOWANCE_REQUIRES_ATTENDANCE_TRACKING") {
        setBlockedCode(data.code);
      } else {
        setError(vi ? "Không thể lưu cài đặt trợ cấp ăn." : "식대 대상 설정을 저장하지 못했습니다.");
      }
      return;
    }
    await load();
    if (!mounted.current) return;
    setFormOpen(false);
    onFormFinish?.("saved");
  }

  if (!state) {
    return (
      <EmployeeSettingCard title={vi ? "Trợ cấp ăn" : "🍚 식대"} applied={null} vi={vi} defaultOpen={Boolean(formRequest)} bare={modal}>
        {error ? <p role="alert" style={modal ? m.error : s.error}>{error}</p> : <p style={modal ? m.muted : s.empty}>{vi ? "Đang tải…" : "불러오는 중…"}</p>}
        {/* 조회 중·조회 실패에도 취소는 누를 수 있다(저장은 불가). 실패를 미적용으로 표시하지 않는다. */}
        {modal ? <BenefitModalActions target={actionsTarget} formId={formId} vi={vi} saving={false} canSave={false} hint={null} onCancel={cancelForm} /> : null}
      </EmployeeSettingCard>
    );
  }

  const disabledByAttendanceTracking = !state.attendanceTrackingEnabled;
  // 기준 근무일수·예상 식대는 공통 설정에서 오는 참고 정보다(직원별 수정 불가). 모달에서는 참고 정보로 접어 둔다.
  const reference = <>
    <Summary
      label={vi ? "Số ngày làm việc tiêu chuẩn/tháng" : "한 달 기준 근무일수"}
      value={state.standardWorkdays !== null ? (vi ? `${state.standardWorkdays} ngày` : `${state.standardWorkdays}일`) : "-"}
    />
    <Summary
      label={vi ? "Chi phí ăn dự kiến" : "예상 식대"}
      value={
        state.current?.isEligible
          ? state.projectedMealAllowance.warningCode === "STANDARD_WORKDAYS_MISSING"
            ? vi
              ? "Cần thiết lập số ngày làm việc trong tháng"
              : "월 근무일수 설정 필요"
            : state.dailyAmount === null
              ? vi
                ? "Chưa thiết lập trợ cấp ăn mỗi ngày"
                : "1일 기본 식대 미설정"
              : money(state.projectedMealAllowance.amount)
          : vi
            ? "Không áp dụng"
            : "미대상"
      }
    />
  </>;
  const help = vi
    ? "Nhân viên thuộc đối tượng nhận trợ cấp ăn sẽ được tính chi phí ăn theo ngày đi làm thực tế."
    : "식대 대상 직원은 실제 출근일을 기준으로 식대비용이 계산됩니다.";
  const attendanceNotice = vi
    ? "Nhân viên này không sử dụng chấm công nên chưa thể chọn thuộc đối tượng nhận trợ cấp ăn."
    : "이 직원은 근태 기록을 사용하지 않아 식대 대상으로 설정할 수 없습니다.";
  const historyItems = state.history.map((item) => (
    <article style={s.history} key={item.id}>
      <b>{item.effectiveFrom} · #{item.revision}</b>
      <span>{item.isEligible ? (vi ? "Áp dụng" : "대상") : vi ? "Không áp dụng" : "미대상"}</span>
      {item.note ? <small>{item.note}</small> : null}
    </article>
  ));
  const historyLabel = vi ? `Lịch sử ${state.history.length} mục` : `설정 이력 ${state.history.length}건`;

  if (modal) {
    // 현재 적용 상태와 예약은 스위치·급여 계산과 같은 규칙(pickMealAllowance)으로 따로 보여 준다.
    const pick = pickMealAllowance(state.history, resolveSettingsSummaryReference(null, vietnamToday()));
    const onLabel = vi ? "Áp dụng" : "적용";
    const offLabel = vi ? "Không áp dụng" : "미적용";
    const changed = formValuesChanged({ isEligible, effectiveFrom, note }, mealFormBaseline(state.current));
    const blockedByAttendance = isEligible && disabledByAttendanceTracking;
    const hint = !formOpen ? null : blockedByAttendance ? attendanceNotice : !changed ? (vi ? "Không có thay đổi để lưu." : "변경된 내용이 없습니다.") : null;
    return (
      <EmployeeSettingCard title={vi ? "Trợ cấp ăn" : "🍚 식대"} applied={state.current?.isEligible === true} vi={vi} defaultOpen={Boolean(formRequest)} bare>
        <BenefitStatusLine
          vi={vi}
          onLabel={onLabel}
          offLabel={offLabel}
          unsetLabel={vi ? "Chưa đặt" : "미설정"}
          status={{
            applied: pick.applied ? { on: pick.applied.isEligible, since: pick.applied.effectiveFrom } : null,
            scheduled: pick.scheduled ? { on: pick.scheduled.isEligible, from: pick.scheduled.effectiveFrom } : null,
          }}
        />
        {disabledByAttendanceTracking ? <p style={m.notice}>{attendanceNotice}</p> : null}
        {formOpen ? (
          <form id={formId} style={m.form} onSubmit={submit}>
            <BenefitChoice label={vi ? "Đối tượng được trợ cấp ăn" : "식대 대상"} value={isEligible} onChange={setIsEligible} onLabel={onLabel} offLabel={offLabel} onDisabled={disabledByAttendanceTracking} />
            {blockedCode === "MEAL_ALLOWANCE_REQUIRES_ATTENDANCE_TRACKING" ? (
              <p role="alert" style={m.error}>
                {vi
                  ? "Chi phí ăn được tính theo dữ liệu chấm công thực tế, vì vậy nhân viên phải sử dụng chấm công."
                  : "식대비용은 실제 출근 기록을 기준으로 계산하므로 근태 기록 사용이 필요합니다."}
              </p>
            ) : null}
            <BenefitField label={vi ? "Ngày áp dụng" : "적용일"}>
              <input style={m.input} required type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} />
            </BenefitField>
            <BenefitField label={vi ? "Ghi chú (không bắt buộc)" : "메모(선택)"}>
              <textarea style={m.textarea} value={note} onChange={(event) => setNote(event.target.value)} />
            </BenefitField>
            {error ? <p role="alert" style={m.error}>{error}</p> : null}
          </form>
        ) : error ? <p role="alert" style={m.error}>{error}</p> : null}
        <details style={m.details}>
          <summary style={m.summary}>{vi ? "Thông tin tham khảo" : "참고 정보"}</summary>
          <p style={m.muted}>{help}</p>
          <div style={m.reference}>{reference}</div>
        </details>
        <details style={m.details}>
          <summary style={m.summary}>{historyLabel}</summary>
          {historyItems}
        </details>
        <BenefitModalActions target={actionsTarget} formId={formId} vi={vi} saving={saving} canSave={formOpen && changed && !blockedByAttendance} hint={hint} onCancel={cancelForm} />
      </EmployeeSettingCard>
    );
  }

  return (
    <EmployeeSettingCard title={vi ? "Trợ cấp ăn" : "🍚 식대"} applied={state.current?.isEligible === true} vi={vi} defaultOpen={Boolean(formRequest)}>
      <div style={s.head}>
        <div>
          <p style={s.help}>{help}</p>
        </div>
        <button type="button" style={s.secondary} onClick={openForm}>
          {vi ? "Thay đổi" : "설정 변경"}
        </button>
      </div>

      <div style={s.current}>
        <Summary
          label={vi ? "Trạng thái hiện tại" : "현재 상태"}
          value={state.current?.isEligible ? (vi ? "Áp dụng" : "대상") : vi ? "Không áp dụng" : "미대상"}
        />
        <Summary label={vi ? "Ngày áp dụng" : "적용일"} value={state.current?.effectiveFrom ?? "-"} />
        {reference}
      </div>

      {disabledByAttendanceTracking ? (
        <p style={s.notice}>{attendanceNotice}</p>
      ) : null}

      {formOpen ? (
        <form style={s.form} onSubmit={submit}>
          <label style={s.toggleRow}>
            <span>{vi ? "Đối tượng được trợ cấp ăn" : "식대 대상"}</span>
            <select
              style={s.select}
              value={isEligible ? "eligible" : "ineligible"}
              disabled={disabledByAttendanceTracking && !isEligible}
              onChange={(event) => setIsEligible(event.target.value === "eligible")}
            >
              <option value="ineligible">{vi ? "Không áp dụng" : "미대상"}</option>
              <option value="eligible" disabled={disabledByAttendanceTracking}>
                {vi ? "Áp dụng" : "대상"}
              </option>
            </select>
          </label>
          {blockedCode === "MEAL_ALLOWANCE_REQUIRES_ATTENDANCE_TRACKING" ? (
            <p role="alert" style={s.error}>
              {vi
                ? "Chi phí ăn được tính theo dữ liệu chấm công thực tế, vì vậy nhân viên phải sử dụng chấm công."
                : "식대비용은 실제 출근 기록을 기준으로 계산하므로 근태 기록 사용이 필요합니다."}
            </p>
          ) : null}
          <label style={s.field}>
            {vi ? "Ngày áp dụng" : "적용일"}
            <input
              style={s.input}
              required
              type="date"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </label>
          <label style={s.field}>
            {vi ? "Ghi chú (không bắt buộc)" : "메모(선택)"}
            <textarea style={s.textarea} value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          {error ? <p role="alert" style={s.error}>{error}</p> : null}
          <div style={s.actions}>
            <button type="button" style={s.secondary} onClick={cancelForm}>
              {vi ? "Hủy" : "취소"}
            </button>
            <button style={s.button} disabled={saving}>
              {saving ? (vi ? "Đang lưu…" : "저장 중…") : vi ? "Lưu" : "저장"}
            </button>
          </div>
        </form>
      ) : null}

      {!formOpen && error ? <p role="alert" style={s.error}>{error}</p> : null}

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
  card: { padding: 13, border: "1px solid #e5e7eb", borderRadius: 14, background: "#fff", display: "grid", gap: 9, minWidth: 0 },
  head: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" },
  title: { margin: 0, fontSize: 15, fontWeight: 900 },
  help: { margin: "3px 0 0", color: "#6b7280", fontSize: 12, lineHeight: 1.4 },
  current: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 6, padding: "8px 9px", borderRadius: 9, background: "#f8fafc", fontSize: 12, minWidth: 0 },
  summary: { display: "grid", gap: 3, minWidth: 0, overflowWrap: "anywhere" },
  empty: { margin: 0, padding: "10px 11px", border: "1px dashed #d1d5db", borderRadius: 10, color: "#6b7280", fontSize: 12 },
  notice: { margin: 0, padding: "8px 9px", borderRadius: 9, background: "#fffbeb", color: "#92400e", fontSize: 12, lineHeight: 1.4 },
  form: { display: "grid", gap: 8, paddingTop: 8, borderTop: "1px solid #e5e7eb" },
  field: { display: "grid", gap: 5, fontSize: 13, fontWeight: 700, minWidth: 0 },
  toggleRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, minHeight: 44, padding: "8px 10px", borderRadius: 10, background: "#f9fafb", fontSize: 13, fontWeight: 800, minWidth: 0 },
  select: { minWidth: 0, minHeight: 38, padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff" },
  input: { width: "100%", minWidth: 0, boxSizing: "border-box", minHeight: 40, padding: 8, border: "1px solid #d1d5db", borderRadius: 9 },
  textarea: { width: "100%", minWidth: 0, boxSizing: "border-box", minHeight: 60, padding: 8, border: "1px solid #d1d5db", borderRadius: 9, resize: "vertical" },
  actions: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  button: { minHeight: 38, padding: "7px 10px", border: 0, borderRadius: 9, background: "#111827", color: "#fff", fontSize: 13, fontWeight: 800 },
  secondary: { minHeight: 36, padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff", color: "#111827", fontSize: 13, fontWeight: 800 },
  error: { margin: 0, padding: "8px 9px", borderRadius: 9, background: "#fef2f2", color: "#b91c1c", fontSize: 12 },
  details: { paddingTop: 8, borderTop: "1px solid #e5e7eb", fontSize: 12 },
  history: { display: "grid", gap: 3, padding: "8px 9px", marginTop: 5, border: "1px solid #e5e7eb", borderRadius: 9, fontSize: 12, overflowWrap: "anywhere" },
} satisfies Record<string, CSSProperties>;
