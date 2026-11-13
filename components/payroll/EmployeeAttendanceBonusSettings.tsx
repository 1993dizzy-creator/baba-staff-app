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
import {
  attendanceBonusMonthlyStatus,
  type AttendanceBonusMonthlyStanding,
} from "@/lib/payroll/attendance-bonus-status";
import EmployeeSettingCard from "@/components/payroll/EmployeeSettingCard";
import { BenefitChoice, BenefitField, BenefitModalActions, BenefitStatusLine, m } from "@/components/payroll/BenefitModalParts";
import { pickAttendanceBonus, resolveSettingsSummaryReference, type SettingHistoryState } from "@/lib/payroll/settings-summary";
import { formValuesChanged, useReportDirty } from "@/components/payroll/useReportDirty";
import { useGuardedSubmit } from "@/components/payroll/useGuardedSubmit";
import type { PayrollSettingFormRequest, PayrollSettingFormResult } from "@/components/payroll/settingFormRequest";

export type AttendanceBonusEligibilityHistoryVersion = EligibilityVersion;
type EligibilityVersion = {
  id: number;
  isEligible: boolean;
  effectiveMonth: string;
  revision: number;
  note: string | null;
};

type AttendanceBonusPolicy = {
  effectiveMonth: string;
  minimumActualWorkdays: number;
  allowedLateCount: number;
  allowedEarlyLeaveCount: number;
  bonusAmount: number;
};

type AttendanceBonusState = {
  current: EligibilityVersion | null;
  history: EligibilityVersion[];
  attendanceTrackingEnabled: boolean;
  policy: AttendanceBonusPolicy | null;
  payrollMonth: string;
  monthClosed: boolean;
  standing: AttendanceBonusMonthlyStanding | null;
};

function currentMonth() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).format(new Date()).slice(0, 7);
}

function formatVnd(amount: number) {
  return `${amount.toLocaleString("en-US")} VND`;
}

// 설정 변경 폼을 열 때의 기준값. resetForm과 미저장 판정이 같은 값을 쓴다.
// intent: 스위치로 연 모달의 목표 상태(없으면 현재 상태).
function bonusFormBaseline(current: EligibilityVersion | null, intent: boolean | null = null) {
  return { isEligible: intent ?? current?.isEligible ?? false, effectiveMonth: currentMonth(), note: "" };
}

export default function EmployeeAttendanceBonusSettings({
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
  onHistoryStateChange?: (state: SettingHistoryState<EligibilityVersion>) => void;
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
  // 급여설정 요약에 이미 조회한 이력을 전달한다(추가 조회 없음). ref로 보관해 조회 의존성에 넣지 않는다.
  const reportHistoryRef = useRef(onHistoryStateChange);
  useEffect(() => { reportHistoryRef.current = onHistoryStateChange; });

  const [state, setState] = useState<AttendanceBonusState | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formIntent, setFormIntent] = useState<boolean | null>(null);
  const [isEligible, setEligible] = useState(false);
  const [effectiveMonth, setEffectiveMonth] = useState(currentMonth);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const resetForm = useCallback((current: EligibilityVersion | null, intent: boolean | null = null) => {
    const baseline = bonusFormBaseline(current, intent);
    setEligible(baseline.isEligible);
    setEffectiveMonth(baseline.effectiveMonth);
    setNote(baseline.note);
    setError("");
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    reportHistoryRef.current?.({ status: "loading", history: [] });
    try {
      const payrollMonth = currentMonth();
      const [eligibilityResponse, policyResponse, summaryResponse] = await Promise.all([
        fetch(`/api/admin/payroll/attendance-bonus/eligibility?userId=${userId}`, { cache: "no-store", signal }),
        fetch("/api/admin/payroll/attendance-bonus/policy", { cache: "no-store", signal }),
        fetch(`/api/attendance/monthly-summary?month=${payrollMonth}&userId=${userId}`, { cache: "no-store", signal }),
      ]);
      if (signal?.aborted || !mounted.current) return;
      const [eligibilityData, policyData, summaryData] = await Promise.all([
        eligibilityResponse.json(),
        policyResponse.json(),
        summaryResponse.json(),
      ]);
      if (signal?.aborted || !mounted.current) return;
      if (!eligibilityResponse.ok || !policyResponse.ok || !summaryResponse.ok) {
        setError(vi ? "Không thể tải cài đặt thưởng chuyên cần." : "개근 보너스 설정을 불러오지 못했습니다.");
        // 정책·근태 요약 조회만 실패했어도 대상 이력은 확정할 수 없으므로 요약에도 실패로 전달한다.
        reportHistoryRef.current?.({ status: "error", history: [] });
        return;
      }
      const next: AttendanceBonusState = {
        current: eligibilityData.current ?? null,
        history: eligibilityData.history ?? [],
        attendanceTrackingEnabled: eligibilityData.attendanceTrackingEnabled === true,
        policy: policyData.current ?? null,
        payrollMonth,
        monthClosed: String(summaryData.month) < currentMonth(),
        standing: summaryData.summaries?.find((item: { userId: number }) => item.userId === userId) ?? null,
      };
      setState(next);
      const request = formRequestRef.current;
      if (request && !autoOpenedRef.current) {
        autoOpenedRef.current = true;
        // 근태 미사용이면 대상으로 바꿀 수 없으므로(기존 검증) 목표 상태를 미리 채우지 않는다.
        const intent = request.enable === true && !next.attendanceTrackingEnabled ? null : request.enable;
        resetForm(next.current, intent);
        setFormIntent(intent);
        setFormOpen(true);
      } else {
        resetForm(next.current);
      }
      reportHistoryRef.current?.({ status: "ready", history: next.history });
    } catch (loadError: unknown) {
      if (signal?.aborted || !mounted.current || (loadError instanceof Error && loadError.name === "AbortError")) return;
      setError(vi ? "Không thể tải cài đặt thưởng chuyên cần." : "개근 보너스 설정을 불러오지 못했습니다.");
      reportHistoryRef.current?.({ status: "error", history: [] });
    }
  }, [resetForm, userId, vi]);

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

  useReportDirty(formOpen && (saving || formValuesChanged({ isEligible, effectiveMonth, note }, bonusFormBaseline(state?.current ?? null, formIntent))), onDirtyChange);

  function openForm() {
    resetForm(state?.current ?? null);
    setFormIntent(null);
    setFormOpen(true);
  }

  function cancelForm() {
    setFormOpen(false);
    resetForm(state?.current ?? null);
    setFormIntent(null);
    onFormFinish?.("cancelled");
  }

  // 같은 저장 요청이 두 번 나가지 않게 한다(더블 클릭·Enter 연타는 saving 상태가 반영되기 전에 들어올 수 있다).
  const submit = useGuardedSubmit(saveForm);

  async function saveForm(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    // 모달: 현재 값과 같으면 저장하지 않는다(저장 버튼도 비활성).
    if (modal && !formValuesChanged({ isEligible, effectiveMonth, note }, bonusFormBaseline(state?.current ?? null))) return;
    setSaving(true);
    setError("");
    const response = await fetch("/api/admin/payroll/attendance-bonus/eligibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, isEligible, effectiveMonth, note }),
    });
    if (!mounted.current) return;
    setSaving(false);
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      setError(
        data?.code === "ATTENDANCE_BONUS_REQUIRES_ATTENDANCE_TRACKING"
          ? vi
            ? "Thưởng chuyên cần được đánh giá bằng dữ liệu chấm công, vì vậy nhân viên phải sử dụng chấm công."
            : "개근 보너스는 근태 기록으로 판정하므로 근태 기록 사용이 필요합니다."
          : vi
            ? "Không thể lưu cài đặt thưởng chuyên cần."
            : "개근 보너스 설정을 저장하지 못했습니다.",
      );
      return;
    }
    await load();
    if (!mounted.current) return;
    setFormOpen(false);
    setFormIntent(null);
    onFormFinish?.("saved");
  }

  if (!state) {
    return (
      <EmployeeSettingCard title={vi ? "✨ Thưởng chuyên cần" : "✨ 개근 보너스"} applied={null} vi={vi} defaultOpen={Boolean(formRequest)} bare={modal}>
        {error ? <p role="alert" style={modal ? m.error : s.error}>{error}</p> : <p style={modal ? m.muted : s.empty}>{vi ? "Đang tải…" : "불러오는 중…"}</p>}
        {/* 조회 중·조회 실패에도 취소는 누를 수 있다(저장은 불가). 실패를 미적용으로 표시하지 않는다. */}
        {modal ? <BenefitModalActions target={actionsTarget} formId={formId} vi={vi} saving={false} canSave={false} hint={null} onCancel={cancelForm} /> : null}
      </EmployeeSettingCard>
    );
  }

  const disabledByAttendanceTracking = !state.attendanceTrackingEnabled;
  const eligible = state.current?.isEligible === true;
  const nextScheduled = state.current ? null : [...state.history]
    .filter((item) => item.effectiveMonth > state.payrollMonth)
    .sort((left, right) => left.effectiveMonth.localeCompare(right.effectiveMonth) || right.revision - left.revision)[0] ?? null;
  const statusEligibility = state.current ?? nextScheduled;
  const criteria = state.policy
    ? vi
      ? `${state.policy.minimumActualWorkdays} ngày · đi muộn ${state.policy.allowedLateCount} lần · về sớm ${state.policy.allowedEarlyLeaveCount} lần`
      : `${state.policy.minimumActualWorkdays}일 · 지각 ${state.policy.allowedLateCount}회 · 조퇴 ${state.policy.allowedEarlyLeaveCount}회`
    : vi ? "Chưa thiết lập chính sách chung" : "공통 정책 미설정";
  const monthlyStatus = attendanceBonusMonthlyStatus({
    vi,
    isEligible: statusEligibility?.isEligible === true,
    eligibilityEffectiveMonth: statusEligibility?.effectiveMonth ?? null,
    payrollMonth: state.payrollMonth,
    monthClosed: state.monthClosed,
    policy: state.policy,
    standing: state.standing,
  });
  // 보너스 금액·판정 기준은 공통 설정 값이고(직원별 수정 불가) 이번 달 상태는 참고 정보다. 모달에서는 참고 정보로 접어 둔다.
  const reference = <>
    <Summary label={vi ? "Mức thưởng" : "보너스 금액"} value={eligible && state.policy ? formatVnd(state.policy.bonusAmount) : "-"} />
    <Summary label={vi ? "Điều kiện đánh giá" : "판정 기준"} value={criteria} />
    <Summary label={vi ? "Trạng thái tháng này" : "이번 달 상태"} value={monthlyStatus} />
  </>;
  const help = vi
    ? "Nhân viên thuộc đối tượng sẽ được tự động tính thưởng nếu đáp ứng điều kiện chấm công cuối tháng."
    : "대상 직원은 월말 근태 판정 조건을 충족하면 자동 인센티브가 계산됩니다.";
  const attendanceNotice = vi
    ? "Nhân viên này không sử dụng chấm công nên chưa thể chọn áp dụng thưởng chuyên cần."
    : "이 직원은 근태 기록을 사용하지 않아 개근 보너스 대상으로 설정할 수 없습니다.";
  const historyItems = state.history.map((item) => (
    <article style={s.history} key={item.id}>
      <b>{item.effectiveMonth} · #{item.revision}</b>
      <span>{item.isEligible ? (vi ? "Áp dụng" : "대상") : vi ? "Không áp dụng" : "미대상"}</span>
      {item.note ? <small>{item.note}</small> : null}
    </article>
  ));
  const historyLabel = vi ? `Lịch sử ${state.history.length} mục` : `설정 이력 ${state.history.length}건`;

  if (modal) {
    // 현재 적용 상태와 예약은 스위치·급여 계산과 같은 규칙(pickAttendanceBonus)으로 따로 보여 준다.
    const pick = pickAttendanceBonus(state.history, resolveSettingsSummaryReference(null, `${currentMonth()}-01`));
    const onLabel = vi ? "Áp dụng" : "적용";
    const offLabel = vi ? "Không áp dụng" : "미적용";
    const changed = formValuesChanged({ isEligible, effectiveMonth, note }, bonusFormBaseline(state.current));
    const blockedByAttendance = isEligible && disabledByAttendanceTracking;
    const hint = !formOpen ? null : blockedByAttendance ? attendanceNotice : !changed ? (vi ? "Không có thay đổi để lưu." : "변경된 내용이 없습니다.") : null;
    return (
      <EmployeeSettingCard title={vi ? "✨ Thưởng chuyên cần" : "✨ 개근 보너스"} applied={eligible} vi={vi} defaultOpen={Boolean(formRequest)} bare>
        <BenefitStatusLine
          vi={vi}
          onLabel={onLabel}
          offLabel={offLabel}
          unsetLabel={vi ? "Chưa đặt" : "미설정"}
          status={{
            applied: pick.applied ? { on: pick.applied.isEligible, since: pick.applied.effectiveMonth } : null,
            scheduled: pick.scheduled ? { on: pick.scheduled.isEligible, from: pick.scheduled.effectiveMonth } : null,
          }}
        />
        {disabledByAttendanceTracking ? <p style={m.notice}>{attendanceNotice}</p> : null}
        {formOpen ? (
          <form id={formId} style={m.form} onSubmit={submit}>
            <BenefitChoice label={vi ? "Đối tượng thưởng chuyên cần" : "개근 보너스 대상"} value={isEligible} onChange={setEligible} onLabel={onLabel} offLabel={offLabel} onDisabled={disabledByAttendanceTracking} />
            <BenefitField label={vi ? "Tháng áp dụng" : "적용월"}>
              <input style={m.input} required type="month" min={currentMonth()} value={effectiveMonth} onChange={(event) => setEffectiveMonth(event.target.value)} />
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
    <EmployeeSettingCard title={vi ? "✨ Thưởng chuyên cần" : "✨ 개근 보너스"} applied={eligible} vi={vi} defaultOpen={Boolean(formRequest)}>
      <div style={s.head}>
        <div>
          <p style={s.help}>{help}</p>
        </div>
        <button type="button" style={s.secondary} onClick={openForm}>
          {vi ? "Thay đổi" : "설정 변경"}
        </button>
      </div>

      <div style={s.current}>
        <Summary label={vi ? "Trạng thái hiện tại" : "현재 상태"} value={eligible ? (vi ? "Áp dụng" : "대상") : vi ? "Không áp dụng" : "미대상"} />
        <Summary label={vi ? "Tháng áp dụng" : "적용월"} value={state.current?.effectiveMonth ?? "-"} />
        {reference}
      </div>

      {disabledByAttendanceTracking ? (
        <p style={s.notice}>{attendanceNotice}</p>
      ) : null}

      {formOpen ? (
        <form style={s.form} onSubmit={submit}>
          <div style={s.formRow}>
            <label style={s.field}>
              {vi ? "Đối tượng thưởng chuyên cần" : "개근 보너스 대상"}
              <select
                style={s.select}
                value={isEligible ? "eligible" : "ineligible"}
                disabled={disabledByAttendanceTracking && !isEligible}
                onChange={(event) => setEligible(event.target.value === "eligible")}
              >
                <option value="ineligible">{vi ? "Không áp dụng" : "미대상"}</option>
                <option value="eligible" disabled={disabledByAttendanceTracking}>{vi ? "Áp dụng" : "대상"}</option>
              </select>
            </label>
            <label style={s.field}>
              {vi ? "Tháng áp dụng" : "적용월"}
              <input style={s.input} required type="month" min={currentMonth()} value={effectiveMonth} onChange={(event) => setEffectiveMonth(event.target.value)} />
            </label>
          </div>
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
  return <div style={s.summary}><span>{label}</span><b>{value}</b></div>;
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
  formRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, minWidth: 0 },
  field: { display: "grid", gap: 5, fontSize: 13, fontWeight: 700, minWidth: 0 },
  select: { width: "100%", minWidth: 0, boxSizing: "border-box", minHeight: 40, padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff" },
  input: { width: "100%", minWidth: 0, boxSizing: "border-box", minHeight: 40, padding: 8, border: "1px solid #d1d5db", borderRadius: 9 },
  textarea: { width: "100%", minWidth: 0, boxSizing: "border-box", minHeight: 60, padding: 8, border: "1px solid #d1d5db", borderRadius: 9, resize: "vertical" },
  actions: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  button: { minHeight: 38, padding: "7px 10px", border: 0, borderRadius: 9, background: "#111827", color: "#fff", fontSize: 13, fontWeight: 800 },
  secondary: { minHeight: 36, padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff", color: "#111827", fontSize: 13, fontWeight: 800 },
  error: { margin: 0, padding: "8px 9px", borderRadius: 9, background: "#fef2f2", color: "#b91c1c", fontSize: 12 },
  details: { paddingTop: 8, borderTop: "1px solid #e5e7eb", fontSize: 12 },
  history: { display: "grid", gap: 3, padding: "8px 9px", marginTop: 5, border: "1px solid #e5e7eb", borderRadius: 9, fontSize: 12, overflowWrap: "anywhere" },
} satisfies Record<string, CSSProperties>;
